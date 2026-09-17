/**
 * Wallpaper Engine `.tex` 容器解析（纯函数，无 DOM 依赖，可在 node 中测试）。
 *
 * 布局（与 refs/open-wallpaper-engine TexImageParser 对齐）：
 *   "TEXV%04d\0"(9B) "TEXI%04d\0"(9B)
 *   i32 imageType(0=RGBA8,4=BC3,6=BC2,7=BC1,8=RG8,9=R8)  u32 flags(bit0 nearest,bit1 clamp,bit2 sprite)
 *   i32 width height mapWidth mapHeight unknown
 *   "TEXB%04d\0"(9B)  i32 imageCount
 *   [texb>=3] i32 内嵌容器类型（-1 = 原始像素）
 *   [texb>=4] u32 conditionCount + 记录（12B + cstring）
 *   每个 image：i32 mipCount；每个 mip：i32 w h [texb>=2: i32 lz4 i32 解压大小] i32 srcSize 数据
 *   [sprite] "TEXS%04d\0"(9B) i32 frameCount [texs>=3: i32 w h]
 *     每帧：i32 imageId f32 frametime 6×(i32 if texs==1 else f32)
 */
import { decodeBC } from './bc.ts'
import { lz4Decompress } from './lz4.ts'

/** 归一化 UV 坐标的 sprite 帧（xAxis/yAxis 支持 WE 的旋转打包）。 */
export interface SpriteFrame {
    x:     number
    y:     number
    xAxis: [number, number]
    yAxis: [number, number]

    /** 帧时长（秒）。 */
    frametime: number

    /** 帧像素宽高（gizmo/编辑器用）。 */
    width:  number
    height: number
}

/** 内嵌的普通图片容器（PNG/JPEG/GIF…），由浏览器侧异步解码。 */
export interface EmbeddedContainer {
    mime:  string
    bytes: Uint8Array
}

export interface TexImage {
    width:  number
    height: number

    /** mip0 的 RGBA8（内嵌容器时为空，用 container 解码）。 */
    rgba:            Uint8Array
    container:       EmbeddedContainer | null
    frames:          SpriteFrame[]
    noInterpolation: boolean
    clampUVs:        boolean
    isSprite:        boolean
}

class Reader {
    offset = 0
    readonly data: Uint8Array

    constructor(data: Uint8Array) {
        this.data = data
    }

    remaining(): number {
        return this.data.length - this.offset
    }

    i32(): number {
        const v = this.data[this.offset]! | this.data[this.offset + 1]! << 8 | this.data[this.offset + 2]! << 16 | this.data[this.offset + 3]! << 24
        this.offset += 4

        return v
    }

    f32(): number {
        const v = this.i32()

        return new Float32Array(new Int32Array([v]).buffer)[0]!
    }

    bytes(n: number): Uint8Array {
        if (n < 0 || this.offset + n > this.data.length) throw new Error(`tex: 越界读取 offset=${this.offset} n=${n}`)
        const v = this.data.subarray(this.offset, this.offset + n)
        this.offset += n

        return v
    }

    version(magic: string): number {
        const s = String.fromCharCode(...this.bytes(9))
        if (!s.startsWith(magic)) throw new Error(`tex: 版本戳不符 期望 ${magic} 实得 ${s.slice(0, 6)}`)

        return Number(s.slice(4, 8))
    }

    /** 读 null 结尾字符串（conditions 用）。 */
    cstring(): string {
        let end = this.offset
        while (end < this.data.length && this.data[end] !== 0) end++
        const s = String.fromCharCode(...this.data.subarray(this.offset, end))
        this.offset = end + 1

        return s
    }
}

function detectEmbeddedMime(data: Uint8Array): string | null {
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
    if (data.length >= 6 && (String.fromCharCode(...data.subarray(0, 6)) === 'GIF87a' || String.fromCharCode(...data.subarray(0, 6)) === 'GIF89a')) return 'image/gif'
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'

    return null
}

/** 跳过条件补丁组（texb>=4；跟随每个 mip 之后，含未应用的）。header 条件数为 0 时整体不存在。 */
function skipConditionalPatches(r: Reader, conditionCount: number): void {
    if (conditionCount === 0) return
    const groups = r.i32()
    if (groups < 0 || groups > r.remaining() / 4) throw new Error('tex: 非法补丁组数')
    for (let g = 0; g < groups; g++) {
        const patches = r.i32()
        if (patches < 0 || patches > r.remaining() / 32) throw new Error('tex: 非法补丁数')
        for (let p = 0; p < patches; p++) {
            r.bytes(24) // unknown + condition id + x y w h
            r.i32() // image type
            const payload = r.i32()
            if (payload < 0 || payload > r.remaining()) throw new Error('tex: 非法补丁载荷')
            r.bytes(payload)
        }
    }
}

export function parseTex(input: ArrayBuffer | Uint8Array, alphaChannelPriority = true): TexImage {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (data.length < 64) throw new Error('tex: 文件过小')
    const r = new Reader(data)

    const texv = r.version('TEXV')
    const texi = r.version('TEXI')
    void texi
    const format = r.i32()
    const flags = r.i32()
    r.i32() // width（头部尺寸，以 mip0 为准）
    r.i32() // height
    r.i32() // mapWidth
    r.i32() // mapHeight
    r.i32() // unknown
    // 3D LUT（lut/*.tex）在 unknown 后还有一个 depth i32；对不上时回退跳 4 字节重试一次
    const texbMark = r.offset
    let texb: number
    try {
        texb = r.version('TEXB')
    }
    catch {
        r.offset = texbMark + 4 // 跳过 depth（3D 体积贴图；按 2D 用 mip0 处理）
        texb = r.version('TEXB')
    }

    const isSprite = (flags & 4) !== 0
    const noInterpolation = (flags & 1) !== 0
    const clampUVs = (flags & 2) !== 0

    const imageCount = r.i32()
    if (imageCount <= 0 || imageCount > 4096) throw new Error(`tex: 非法 image count ${imageCount}`)
    if (texb >= 3) r.i32() // 内嵌容器类型（-1 = 原始像素；实际以字节嗅探为准）
    let conditionCount = 0
    if (texb >= 4) {
        conditionCount = r.i32()
        if (conditionCount < 0 || conditionCount > r.remaining() / 13) throw new Error('tex: 非法条件数')
        for (let i = 0; i < conditionCount; i++) {
            r.bytes(12)
            r.cstring()
        }
    }

    // 每张图的 mip0（多图仅 sprite 场景出现；普通贴图取第一张）
    const imageDims: Array<[number, number]> = []
    let mip0: { w: number, h: number, pixels: Uint8Array } | null = null
    let container: EmbeddedContainer | null = null

    for (let img = 0; img < imageCount; img++) {
        const mipCount = Math.max(0, r.i32())
        for (let mip = 0; mip < mipCount; mip++) {
            const w = r.i32()
            const h = r.i32()
            let lz4 = false
            let decomp = 0
            if (texb >= 2) {
                lz4 = r.i32() === 1
                decomp = r.i32()
            }
            const srcSize = r.i32()
            if (srcSize < 0 || srcSize > r.remaining()) throw new Error('tex: 非法 mip 尺寸')
            const raw = r.bytes(srcSize)
            if (mip === 0) {
                imageDims.push([w, h])
                if (!mip0) {
                    const payload = lz4 ? lz4Decompress(raw, decomp) : raw
                    const mime = detectEmbeddedMime(payload)
                    if (mime) {
                        container = { mime, bytes: payload }
                    }
                    else {
                        mip0 = { w, h, pixels: payload }
                    }
                }
            }
            if (texb >= 4) skipConditionalPatches(r, conditionCount)
        }
    }

    // sprite 帧表
    const frames: SpriteFrame[] = []
    if (isSprite) {
        const texs = r.version('TEXS')
        const frameCount = r.i32()
        if (frameCount <= 0 || frameCount > 4096) throw new Error(`tex: 非法帧数 ${frameCount}`)
        if (texs >= 3) {
            r.i32()
            r.i32()
        }
        const coordsInt = texs === 1
        for (let i = 0; i < frameCount; i++) {
            const imageId = r.i32()
            const frametime = r.f32()
            const dims = imageDims[imageId]
            if (!dims || imageId !== 0) continue // 毒 imageId / 多图 sprite（MVP 仅支持单图集）
            const readCoord = () => coordsInt ? r.i32() : r.f32()
            const fx = readCoord()
            const fy = readCoord()
            const xAxis: [number, number] = [readCoord(), readCoord()]
            const yAxis: [number, number] = [readCoord(), readCoord()]
            const [sw, sh] = dims
            const width = Math.hypot(xAxis[0], xAxis[1])
            const height = Math.hypot(yAxis[0], yAxis[1])

            // 半像素内缩：图集相邻帧的 bilinear 渗色会在帧边缘产生淡框
            const hU = 0.5 / Math.max(1, width)
            const hV = 0.5 / Math.max(1, height)
            const xa: [number, number] = [xAxis[0] / sw, xAxis[1] / sw]
            const ya: [number, number] = [yAxis[0] / sh, yAxis[1] / sh]
            frames.push({
                x:     fx / sw + xa[0] * hU + ya[0] * hV,
                y:     fy / sh + xa[1] * hU + ya[1] * hV,
                xAxis: [xa[0] * (1 - 2 * hU), xa[1] * (1 - 2 * hU)],
                yAxis: [ya[0] * (1 - 2 * hV), ya[1] * (1 - 2 * hV)],
                frametime,
                width,
                height,
            })
        }
        if (!frames.length) throw new Error('tex: 无有效 sprite 帧')
    }

    // 像素格式 → RGBA
    let rgba: Uint8Array = new Uint8Array(0)
    let width = 0
    let height = 0
    if (mip0) {
        width = mip0.w
        height = mip0.h
        const p = mip0.pixels
        switch (format) {
            case 0: { // RGBA8888
                if (p.length < width * height * 4) throw new Error('tex: RGBA 数据不足')
                rgba = p.slice(0, width * height * 4)
                break
            }
            case 4:
                rgba = decodeBC(p, width, height, 'bc3')
                break
            case 6:
                rgba = decodeBC(p, width, height, 'bc2')
                break
            case 7:
                rgba = decodeBC(p, width, height, 'bc1')
                break
            case 8: { // RG88：通道语义由贴图描述（.tex.json）的 alphachannelpriority 声明
                //   true（glyph/beam）：R=alpha、G=灰度图案
                //   false（smoke2）：R=恒定灰度底色、G=柔和 alpha 遮罩
                if (p.length < width * height * 2) throw new Error('tex: RG88 数据不足')
                rgba = new Uint8Array(width * height * 4)
                for (let i = 0, j = 0; i < width * height; i++, j += 4) {
                    const b0 = p[i * 2]!, b1 = p[i * 2 + 1]!
                    if (alphaChannelPriority) {
                        rgba[j] = rgba[j + 1] = rgba[j + 2] = b1
                        rgba[j + 3] = b0
                    }
                    else {
                        rgba[j] = rgba[j + 1] = rgba[j + 2] = b0
                        rgba[j + 3] = b1
                    }
                }
                break
            }
            case 9: { // R8：alphachannelpriority 时单通道即 alpha（RGB=白，光晕遮罩）；否则灰度不透明
                if (p.length < width * height) throw new Error('tex: R8 数据不足')
                rgba = new Uint8Array(width * height * 4)
                for (let i = 0, j = 0; i < width * height; i++, j += 4) {
                    if (alphaChannelPriority) {
                        rgba[j] = rgba[j + 1] = rgba[j + 2] = 255
                        rgba[j + 3] = p[i]!
                    }
                    else {
                        rgba[j] = rgba[j + 1] = rgba[j + 2] = p[i]!
                        rgba[j + 3] = 255
                    }
                }
                break
            }
            default:
                throw new Error(`tex: 不支持的像素格式 ${format}`)
        }
    }
    else if (!container && !imageDims.length) {
        throw new Error('tex: 无图像数据')
    }
    void texv

    // sprite 的图集：width/height 取 mip0 全图尺寸
    if (isSprite && !width && imageDims[0]) {
        width = imageDims[0][0]
        height = imageDims[0][1]
    }

    return { width, height, rgba, container, frames, noInterpolation, clampUVs, isSprite }
}
