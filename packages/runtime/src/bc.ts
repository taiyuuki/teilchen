/**
 * BC1(DXT1)/BC2(DXT3)/BC3(DXT5) 块压缩解码 → RGBA8。
 * CPU 一次性解码（贴图通常 ≤1024²，成本可忽略）；GPU 原生 BC 上传留作优化。
 */

const EXPAND5 = new Uint8Array(32)
const EXPAND6 = new Uint8Array(64)
for (let i = 0; i < 32; i++) EXPAND5[i] = i << 3 | i >> 2
for (let i = 0; i < 64; i++) EXPAND6[i] = i << 2 | i >> 4

function rgb565(v: number, out: [number, number, number]): void {
    out[0] = EXPAND5[v >> 11 & 0x1f]!
    out[1] = EXPAND6[v >> 5 & 0x3f]!
    out[2] = EXPAND5[v & 0x1f]!
}

/** 解出一个 4×4 块的颜色部分（BC1 色块，8 字节）。mode3 = 允许 index3 透明（BC1 独有）。 */
function decodeBC1Colors(
    data: Uint8Array, offset: number, x0: number, y0: number, width: number, height: number,
    rgba: Uint8Array, mode3: boolean,
): void {
    const c0 = data[offset]! | data[offset + 1]! << 8
    const c1 = data[offset + 2]! | data[offset + 3]! << 8
    const a: [number, number, number] = [0, 0, 0]
    const b: [number, number, number] = [0, 0, 0]
    rgb565(c0, a)
    rgb565(c1, b)
    const palette: [number, number, number, number][] = [
        [a[0], a[1], a[2], 255],
        [b[0], b[1], b[2], 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
    ]
    if (c0 > c1 || !mode3) {
        palette[2] = [(a[0] * 2 + b[0]) / 3, (a[1] * 2 + b[1]) / 3, (a[2] * 2 + b[2]) / 3, 255]
        palette[3] = [(a[0] + b[0] * 2) / 3, (a[1] + b[1] * 2) / 3, (a[2] + b[2] * 2) / 3, 255]
    }
    else {
        palette[2] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 255]
        palette[3] = [0, 0, 0, 0]
    }
    const bits = data[offset + 4]! | data[offset + 5]! << 8 | data[offset + 6]! << 16 | data[offset + 7]! << 24
    for (let py = 0; py < 4; py++) {
        const y = y0 + py
        if (y >= height) break
        for (let px = 0; px < 4; px++) {
            const x = x0 + px
            if (x >= width) continue
            const idx = bits >>> (py * 4 + px) * 2 & 3
            const c = palette[idx]!
            const o = (y * width + x) * 4
            rgba[o] = c[0]
            rgba[o + 1] = c[1]
            rgba[o + 2] = c[2]
            rgba[o + 3] = c[3]
        }
    }
}

function decodeBC2Alpha(data: Uint8Array, offset: number, x0: number, y0: number, width: number, height: number, rgba: Uint8Array): void {
    for (let py = 0; py < 4; py++) {
        const y = y0 + py
        if (y >= height) break
        for (let px = 0; px < 4; px++) {
            const x = x0 + px
            if (x >= width) continue
            const nibble = data[offset + (py * 4 + px >> 1)]! >>> (px & 1) * 4 & 0xf
            rgba[(y * width + x) * 4 + 3] = nibble * 17
        }
    }
}

function decodeBC3Alpha(data: Uint8Array, offset: number, x0: number, y0: number, width: number, height: number, rgba: Uint8Array): void {
    const a0 = data[offset]!
    const a1 = data[offset + 1]!
    const palette = new Uint8Array(8)
    palette[0] = a0
    palette[1] = a1
    if (a0 > a1) {
        for (let i = 1; i < 7; i++) palette[i + 1] = ((7 - i) * a0 + i * a1) / 7
    }
    else {
        for (let i = 1; i < 5; i++) palette[i + 1] = ((5 - i) * a0 + i * a1) / 5
        palette[6] = 0
        palette[7] = 255
    }

    // 16 个 3bit 索引，按小端拼成 48bit
    let bits = 0n
    for (let i = 0; i < 6; i++) bits |= BigInt(data[offset + 2 + i]!) << BigInt(i * 8)
    for (let py = 0; py < 4; py++) {
        const y = y0 + py
        if (y >= height) break
        for (let px = 0; px < 4; px++) {
            const x = x0 + px
            if (x >= width) continue
            const idx = Number(bits >> BigInt((py * 4 + px) * 3) & 7n)
            rgba[(y * width + x) * 4 + 3] = palette[idx]!
        }
    }
}

export type BcFormat = 'bc1' | 'bc2' | 'bc3'

export function decodeBC(data: Uint8Array, width: number, height: number, format: BcFormat): Uint8Array {
    const rgba = new Uint8Array(width * height * 4)
    const blockW = Math.ceil(width / 4)
    const blockH = Math.ceil(height / 4)
    const stride = format === 'bc1' ? 8 : 16
    for (let by = 0; by < blockH; by++) {
        for (let bx = 0; bx < blockW; bx++) {
            const blockOff = (by * blockW + bx) * stride
            const x0 = bx * 4
            const y0 = by * 4
            if (format === 'bc2') {
                decodeBC2Alpha(data, blockOff, x0, y0, width, height, rgba)
                decodeBC1Colors(data, blockOff + 8, x0, y0, width, height, rgba, false)
            }
            else if (format === 'bc3') {
                decodeBC3Alpha(data, blockOff, x0, y0, width, height, rgba)
                decodeBC1Colors(data, blockOff + 8, x0, y0, width, height, rgba, false)
            }
            else {
                decodeBC1Colors(data, blockOff, x0, y0, width, height, rgba, true)
            }
        }
    }

    return rgba
}
