/**
 * VFXPlayer —— @teilchen/runtime 的高层入口（库化发布面）。
 *
 * 把"解析 → 子定义递归 → 贴图解码 → 建系统"整条链路收进一个 API，
 * 集成方（网页/壁纸壳/导出的独立 HTML）只需提供画布与资产源：
 *
 *   const player = await VFXPlayer.create({ canvas })
 *   await player.load(sceneJson, { assets: fetchSource('/assets') })
 *   player.start()
 *
 * load 接受三种输入：原生 ParticleSystemDef、WE particle JSON（自动识别并按
 * 路径从资产源拉材质/子定义）、场景文件 SceneFile（本产品格式，可含多系统）。
 */
import {
    type ParticleSystemDef,
    attachChildDefs,
    defaultControlPoints,
    defaultMaterial,
    defaultSystem,
    normalizeDef,
    parseWeParticleJson,
} from '@teilchen/core'
import {
    ParticleRuntime,
    type RuntimeOptions,
    type RuntimeStats,
    type SystemHandle,
} from './runtime.ts'
import {
    type TextureAsset,
    createTextureFromTex,
    imageToTexture,
} from './texture.ts'

// ---------------------------------------------------------------- 资产源

/** 场景资产源：按路径读文件字节；不存在返回 null（缺省贴图/子定义会回退默认并告警）。 */
export interface AssetSource { read(path: string): Promise<ArrayBuffer | null> }

const EMPTY_SOURCE: AssetSource = { read: async() => null }

/** 串联多个资产源，命中即返回（先声明的优先）。 */
export function chainSource(...sources: (AssetSource | null | undefined)[]): AssetSource {
    const list = sources.filter(Boolean) as AssetSource[]
    if (list.length === 1) return list[0]!

    return {
        async read(path) {
            for (const s of list) {
                const bytes = await s.read(path)
                if (bytes) return bytes
            }

            return null
        },
    }
}

/** HTTP(S) 目录资产源：baseUrl 为目录（尾随 / 可省），path 相对其拼接。 */
export function fetchSource(baseUrl: string): AssetSource {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`

    return {
        async read(path) {
            try {
                const res = await fetch(new URL(path.replace(/^\/+/, ''), base))

                return res.ok ? await res.arrayBuffer() : null
            }
            catch {
                return null
            }
        },
    }
}

/**
 * 内嵌资产源：路径 → 字节（ArrayBuffer/Uint8Array/UTF-8 文本字符串）。
 * 查找带大小写不敏感与 basename 兜底（WE 资产引用常带目录前缀，导出产物常平铺）；
 * base64 编码字节请先自行解码（见 global.ts 的嵌入资产引导）。
 */
export function bufferSource(files: Record<string, ArrayBuffer | Uint8Array | string>): AssetSource {
    const exact = new Map<string, ArrayBuffer>()
    const lower = new Map<string, ArrayBuffer>()
    for (const [k, v] of Object.entries(files)) {
        let buf: ArrayBuffer
        if (typeof v === 'string') buf = new TextEncoder().encode(v).buffer as ArrayBuffer
        else if (v instanceof Uint8Array) buf = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength
            ? v.buffer as ArrayBuffer
            : v.slice().buffer as ArrayBuffer
        else buf = v
        exact.set(k, buf)
        if (!lower.has(k.toLowerCase())) lower.set(k.toLowerCase(), buf)
    }

    return {
        async read(path) {
            const hit = exact.get(path) ?? lower.get(path.toLowerCase())
            if (hit) return hit
            const p = path.toLowerCase().replace(/^\/+/, '')
            const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
            if (!base) return null
            for (const [k, v] of lower) {
                const kb = k.includes('/') ? k.slice(k.lastIndexOf('/') + 1) : k
                if (kb === base) return v
            }

            return null
        },
    }
}

// ---------------------------------------------------------------- 路径与格式识别

/**
 * 资产路径候选序列：原路径 → 附扩展名变体 → basename 兜底。
 * WE 材质里贴图路径不带扩展名（"particle/fire/fire1" 实为 .tex），扩展名变体按序尝试。
 */
export function pathCandidates(path: string, extraExtensions: string[] = []): string[] {
    const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
        .replace(/^\/+/, '')
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''
    const base = p.slice(dir.length)
    const out = [p]
    for (const ext of extraExtensions) out.push(dir + base + ext)
    if (base !== p) out.push(base)

    return [...new Set(out)]
}

/** 依次尝试候选路径，返回首个命中的字节。 */
async function readAsset(
    source: AssetSource,
    path: string,
    extraExtensions: string[] = [],
): Promise<{ bytes: ArrayBuffer, path: string } | null> {
    for (const p of pathCandidates(path, extraExtensions)) {
        const bytes = await source.read(p)
        if (bytes) return { bytes, path: p }
    }

    return null
}

/** 场景文件（teilchen 产品格式，编辑器「导出」的产物）：一个文件可带多个粒子系统。 */
export interface SceneFile {
    format:  'teilchen/scene'
    version: 1

    /** 背景色；缺省用运行时默认。 */
    clearColor?: { r: number; g: number; b: number; a: number }

    /** 加载后自动播放（缺省 true）。 */
    autostart?: boolean

    /** 系统条目：原生 def 或 WE particle JSON（逐条自动识别）。 */
    systems: unknown[]
}

export function looksLikeSceneFile(src: Record<string, unknown>): boolean {
    return src.format === 'teilchen/scene' || Array.isArray(src.systems)
}

/** WE particle JSON 识别：material 为路径字符串，或单数模块表（emitter/...）而无双数 renderers。 */
export function looksLikeWeParticleJson(src: Record<string, unknown>): boolean {
    if (typeof src.material === 'string') return true

    return !('renderers' in src) && ('emitter' in src || 'initializer' in src || 'operator' in src)
}

// ---------------------------------------------------------------- 解析管线

interface ParsedSystem {
    def:      ParticleSystemDef
    warnings: string[]
}

/** @internal 解析单系统输入（原生 def / WE particle JSON），材质引用按路径从资产源补齐。 */
export async function parseSystemInput(
    input: unknown,
    source: AssetSource,
    name: string,
): Promise<ParsedSystem> {
    const src = typeof input === 'string' ? JSON.parse(input) : input
    if (!src || typeof src !== 'object') throw new Error('load: 系统条目不是对象或 JSON 文本')
    const obj = src as Record<string, unknown>

    if (!looksLikeWeParticleJson(obj)) {

        // 原生 def（场景文件条目/编辑器产物）：缺失字段按默认值补齐（控制点恒 8 槽）
        const raw = src as Partial<ParticleSystemDef>
        const def: ParticleSystemDef = {
            ...defaultSystem(name),
            ...raw,
            material: { ...defaultMaterial(), ...raw.material },
        }
        const cps = Array.isArray(raw.controlPoints) ? raw.controlPoints : []
        def.controlPoints = [...cps, ...defaultControlPoints()].slice(0, 8)

        return { def: normalizeDef(def), warnings: [] }
    }

    // WE JSON：material 引用从资产源拉取（完整路径 → basename）
    let materialJson: unknown
    const matRef = typeof obj.material === 'string' ? obj.material : undefined
    if (matRef) {
        const mat = await readAsset(source, matRef)
        if (mat) {
            try {
                materialJson = JSON.parse(new TextDecoder().decode(mat.bytes))
            }
            catch { /* 解析失败交给 parseWeParticleJson 走默认材质告警 */ }
        }
    }
    const { def, warnings } = parseWeParticleJson(obj, materialJson, name)

    return { def, warnings }
}

/** @internal 解析 WE 材质贴图引用：按字节嗅探 .tex（TEXV 魔数）/常规图片并上传 GPU。 */
export async function loadTextureAsset(
    device: GPUDevice,
    source: AssetSource,
    texPath: string,
): Promise<TextureAsset | null> {
    const hit = await readAsset(source, texPath, ['.tex', '.png', '.jpg', '.jpeg', '.webp'])
    if (!hit) return null

    const magic = new TextDecoder().decode(new Uint8Array(hit.bytes, 0, 4))
    if (magic === 'TEXV') {

        // WE .tex：同路径 .json 描述声明 rg88/r8 的 alphachannelpriority 通道语义
        let alphaPriority = true
        const desc = await readAsset(source, `${hit.path}.json`)
        if (desc) {
            try {
                const j = JSON.parse(new TextDecoder().decode(desc.bytes)) as { alphachannelpriority?: unknown }
                if (typeof j.alphachannelpriority === 'boolean') alphaPriority = j.alphachannelpriority
            }
            catch { /* 描述缺失/损坏按默认 */ }
        }

        return await createTextureFromTex(device, hit.bytes, hit.path, alphaPriority)
    }

    return { texture: imageToTexture(device, await createImageBitmap(new Blob([hit.bytes]))), label: hit.path }
}

/** @internal 递归收集 def 树的贴图：根系统一张 + 各层 children（按 child.name 键入）。 */
async function collectTextures(
    def: ParticleSystemDef,
    source: AssetSource,
    device: GPUDevice,
    warn: (msg: string) => void,
): Promise<{ texture?: TextureAsset, childTextures?: Record<string, TextureAsset> }> {
    const cache = new Map<string, TextureAsset | null>()
    const loadTex = async(p: string): Promise<TextureAsset | null> => {
        if (!cache.has(p)) cache.set(p, await loadTextureAsset(device, source, p))

        return cache.get(p) ?? null
    }
    const childTextures: Record<string, TextureAsset> = {}
    const walk = async(d: ParticleSystemDef, assign: (t: TextureAsset) => void): Promise<void> => {
        const texPath = d.material.textures[0]
        if (texPath) {
            const t = await loadTex(texPath)
            if (t) assign(t)
            else warn(`[${d.name}] 贴图 "${texPath}" 未在资产源中找到，使用默认贴图`)
        }
        for (const child of d.children) {
            if (!child.def) continue
            await walk(child.def, t => { childTextures[child.name] = t })
        }
    }
    let texture: TextureAsset | undefined
    await walk(def, t => { texture = t })

    return { texture, childTextures: Object.keys(childTextures).length ? childTextures : undefined }
}

// ---------------------------------------------------------------- VFXPlayer

export interface LoadedSystem {
    name:     string
    warnings: string[]
    handle:   SystemHandle
}

export interface VFXPlayerLoadOptions {

    /** 资产源（材质/子定义/贴图按路径读取）；缺省视为无外部资产。 */
    assets?: AssetSource

    /** 系统/多系统条目的名字前缀（WE JSON 解析名；原生 def 用自身 name）。 */
    name?: string

    /** 默认 true：载入前清空既有系统（场景语义）；false = 追加。 */
    replace?: boolean
}

export class VFXPlayer {
    private readonly rt:        ParticleRuntime
    private readonly onWarning: (msg: string) => void
    private loaded:             LoadedSystem[] = []

    private constructor(rt: ParticleRuntime, onWarning: (msg: string) => void) {
        this.rt = rt
        this.onWarning = onWarning
    }

    static async create(opts: RuntimeOptions): Promise<VFXPlayer> {
        const onWarning = opts.onWarning ?? (m => console.warn('[teilchen]', m))

        return new VFXPlayer(await ParticleRuntime.create({ ...opts, onWarning }), onWarning)
    }

    /** 底层运行时（高级用法：addSystem/setCamera/逐系统 handle）。 */
    get runtime(): ParticleRuntime {
        return this.rt
    }

    get systems(): readonly LoadedSystem[] {
        return this.loaded
    }

    get stats(): RuntimeStats {
        return this.rt.stats
    }

    get time(): number {
        return this.rt.time
    }

    /** 载入：场景文件 / 原生 def / WE particle JSON（对象或 JSON 字符串均可）。 */
    async load(input: unknown, opts: VFXPlayerLoadOptions = {}): Promise<LoadedSystem[]> {
        const source = opts.assets ?? EMPTY_SOURCE
        const src = typeof input === 'string' ? JSON.parse(input) : input
        if (!src || typeof src !== 'object') throw new Error('load: 输入不是对象或 JSON 文本')
        const obj = src as Record<string, unknown>

        const entries = looksLikeSceneFile(obj) ? obj.systems as unknown[] : [src]
        if (looksLikeSceneFile(obj) && obj.clearColor && typeof obj.clearColor === 'object') {
            this.rt.setClearColor(obj.clearColor as NonNullable<RuntimeOptions['clearColor']>)
        }

        if (opts.replace !== false) this.clear()

        const loaded: LoadedSystem[] = []
        for (let i = 0; i < entries.length; i++) {
            const name = entries.length > 1
                ? `${opts.name ?? 'system'}-${i + 1}`
                : opts.name ?? 'system'
            const parsed = await parseSystemInput(entries[i], source, name)
            for (const w of parsed.warnings) this.onWarning(`[${parsed.def.name}] ${w}`)

            await attachChildDefs(parsed.def, async wePath => {
                const hit = await readAsset(source, wePath)
                if (!hit) return undefined
                const sub = await parseSystemInput(new TextDecoder().decode(hit.bytes), source, hit.path.split('/').pop()!.replace(/\.json$/, ''))
                for (const w of sub.warnings) this.onWarning(`[${sub.def.name}] ${w}`)

                return sub.def
            })

            const tex = await collectTextures(parsed.def, source, this.rt.device, this.onWarning)
            const handle = this.rt.addSystem(parsed.def, {
                ...tex.texture ? { texture: tex.texture } : {},
                ...tex.childTextures ? { childTextures: tex.childTextures } : {},
            })
            loaded.push({ name: parsed.def.name, warnings: parsed.warnings, handle })
        }
        this.loaded = loaded

        return loaded
    }

    /** 直接登记一个已构造的 def（绕过解析管线，与 runtime.addSystem 同参）。 */
    add(def: ParticleSystemDef, opts?: Parameters<ParticleRuntime['addSystem']>[1]): SystemHandle {
        const handle = this.rt.addSystem(def, opts)
        this.loaded.push({ name: def.name, warnings: handle.warnings, handle })

        return handle
    }

    /** 清空场景（销毁全部系统）。 */
    clear(): void {
        for (const l of this.loaded) l.handle.destroy()
        this.loaded = []
    }

    start(): void {
        this.rt.start()
    }

    stop(): void {
        this.rt.stop()
    }

    setPaused(paused: boolean): void {
        this.rt.setPaused(paused)
    }

    step(): void {
        this.rt.step()
    }

    reset(): void {
        this.rt.reset()
    }

    /** 指针位置（画布内 CSS 像素；lockToPointer 控制点与指针圈跟随）。 */
    setPointer(canvasX: number, canvasY: number): void {
        this.rt.setPointer(canvasX, canvasY)
    }

    setSpeed(multiplier: number): void {
        this.rt.setSpeed(multiplier)
    }

    setCamera(cam: Parameters<ParticleRuntime['setCamera']>[0]): void {
        this.rt.setCamera(cam)
    }

    destroy(): void {
        this.clear()
        this.rt.destroy()
    }
}
