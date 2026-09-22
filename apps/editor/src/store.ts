/**
 * 编辑器状态：def/选中项/stats 走 Vue reactive；
 * runtime / handle 是 GPU 对象，保持在模块级非响应式变量里。
 * def 深度变化 → 防抖 120ms → handle.update() 热更新（不 reset，粒子状态保留）。
 */
import { reactive, watch } from 'vue'
import {
    type ModuleKind,
    type ParticleSystemDef,
    attachChildDefs,
    cursorAvoidPreset,
    fountainPreset,
    galaxyPreset,
    getModuleSpec,
    normalizeDef,
    parseWeParticleJson,
    serializeWeParticleJson,
    snowPreset,
} from '@teilchen/core'
import { ParticleRuntime, type SystemHandle, type TextureAsset, createHaloTexture, createTextureFromTex, createTextureFromUrl, createWhiteTexture  } from '@teilchen/runtime'
import { t } from './i18n.ts'

export type Selection = { kind: 'child', index: number } | { kind: 'cp', index: number } | { kind: 'system' } | { kind: ModuleKind, index: number }

let runtime: ParticleRuntime | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 场景条目的 GPU 侧元数据（非响应式；def 本体在 editor.systems 里）。
 * handle = runtime 系统句柄；texture/texturePath = 根系统贴图与登记键；
 * childTextures = children 贴图（key = ChildDef.name）。
 */
interface SceneMeta {
    handle:        SystemHandle | null
    texture:       GPUTexture | TextureAsset | null
    textureKind:   TextureChoice | 'tex-sprite'
    texturePath:   string | null
    childTextures: Record<string, TextureAsset>
}
const sceneMeta = new Map<number, SceneMeta>()

function metaFor(id: number): SceneMeta {
    let m = sceneMeta.get(id)
    if (!m) {
        m = { handle: null, texture: null, textureKind: 'halo', texturePath: null, childTextures: {} }
        sceneMeta.set(id, m)
    }

    return m
}

/** 释放无人引用的 GPU 贴图（复制系统会共享 texture 对象，不能贸然销毁）。 */
function releaseTexture(tex: GPUTexture | TextureAsset | null): void {
    if (!tex) return
    const gpu = 'texture' in tex ? tex.texture : tex
    for (const m of sceneMeta.values()) {
        if (!m.texture) continue
        if (('texture' in m.texture ? m.texture.texture : m.texture) === gpu) return
    }
    gpu?.destroy()
}

/**
 * 贴图源字节登记表（导出独立 HTML 时内嵌用；GPU 贴图无法回读源数据）。
 * key = 材质引用路径（WE 贴图）或文件名（上传图）；halo/white 程序化贴图不登记。
 */
export interface TextureSourceInfo {
    path: string
    data: ArrayBuffer

    /** 仅 .tex：rg88/r8 的通道语义描述（false 时导出产物附带 .json 描述）。 */
    alphaPriority?: boolean
}
const textureAssets = new Map<string, TextureSourceInfo>()

/** 登记一份贴图源字节（loadWeTexture/setTexture/children 收集共用）。 */
export function registerTextureAsset(info: TextureSourceInfo): void {
    textureAssets.set(info.path, info)
}

/** 全部已登记贴图（含各系统的根贴图与各层 children）。 */
export function getTextureAssets(): TextureSourceInfo[] {
    return [...textureAssets.values()]
}

/** 活跃系统当前贴图的登记键（null = halo/white/未加载）。 */
export function getRootTexturePath(): string | null {
    return metaFor(editor.activeId).texturePath
}

/** 供测试/工具流程设置活跃系统贴图登记键。 */
export function setRootTexturePath(path: string | null): void {
    metaFor(editor.activeId).texturePath = path
}

/** 解码一份 /we/tex 贴图（同路径 .tex.json 描述覆盖通道语义），源字节进导出登记表。 */
async function loadWeTextureAsset(texPath: string): Promise<TextureAsset | null> {
    if (!runtime) return null
    try {
        const res = await fetch(`/we/tex/${texPath}.tex`)
        if (!res.ok) return null
        const data = await res.arrayBuffer()
        let alphaPriority = true
        try {
            const desc = await fetch(`/we/tex/${texPath}.tex.json`).then(r => r.ok ? r.json() : null)
            if (desc && typeof desc.alphachannelpriority === 'boolean') alphaPriority = desc.alphachannelpriority
        }
        catch { /* 描述缺失按默认 */ }
        registerTextureAsset({ path: texPath, data, alphaPriority })

        return await createTextureFromTex(runtime.device, data, texPath, alphaPriority)
    }
    catch {
        return null
    }
}

/** 递归收集 def 树 children 的材质贴图（按材质路径共享解码，key = ChildDef.name）。 */
async function attachChildTextures(def: ParticleSystemDef): Promise<Record<string, TextureAsset>> {
    if (!runtime) return {}
    const out: Record<string, TextureAsset> = {}
    const byPath = new Map<string, TextureAsset>()
    const collect = async(d: ParticleSystemDef): Promise<void> => {
        for (const child of d.children) {
            if (!child.def) continue
            const texPath = child.def.material.textures[0]
            if (texPath) {
                let asset = byPath.get(texPath)
                if (!asset) {
                    asset = await loadWeTextureAsset(texPath) ?? undefined
                    if (asset) byPath.set(texPath, asset)
                    else pushWarning(t('warn.texLoadFailed', { tex: texPath, msg: '404' }))
                }
                if (asset) out[child.name] = asset
            }
            await collect(child.def)
        }
    }
    await collect(def)

    return out
}

function emptyPreset(): ParticleSystemDef {
    const def = normalizeDef(fountainPreset())
    def.name = 'untitled'
    def.maxCount = 5000
    def.startTime = 0
    def.emitters = []
    def.initializers = []
    def.operators = []

    return def
}

export const PRESET_DEFS = [
    { id: 'fountain', labelKey: 'preset.fountain', load: fountainPreset },
    { id: 'galaxy', labelKey: 'preset.galaxy', load: galaxyPreset },
    { id: 'snow', labelKey: 'preset.snow', load: snowPreset },
    { id: 'cursor-avoid', labelKey: 'preset.cursor-avoid', load: cursorAvoidPreset },
    { id: 'empty', labelKey: 'preset.empty', load: emptyPreset },
]

/** 精选 WE 预设（覆盖不同特性轴；完整清单不进编辑器，需要时用「导入 WE JSON」）。 */
export const WE_PRESET_DEFS = [
    { file: 'magic_vortex_orb', labelKey: 'we.magic_vortex_orb' },
    { file: 'fireworks2', labelKey: 'we.fireworks2' },
    { file: 'fireflies', labelKey: 'we.fireflies' },
    { file: 'dripping_water', labelKey: 'we.dripping_water' },
    { file: 'bubbles1', labelKey: 'we.bubbles1' },
    { file: 'dna', labelKey: 'we.dna' },
]

let nextSystemId = 1

export interface SceneSystem {
    id:   number
    name: string
    def:  ParticleSystemDef
}

export const editor = reactive({

    /** 活跃系统的 def（与 systems 中活跃项的 def 是同一 reactive 对象）。 */
    def:          null as unknown as ParticleSystemDef,
    activeId:     0,
    systems:      [] as SceneSystem[],
    selected:     { kind: 'system' } as Selection,
    stats:        { fps: 0, alive: 0, drawn: 0, time: 0 },
    warnings:     [] as string[],
    gizmos:       true,
    paused:       false,

    /** gizmo 只显示活跃控制点（被引用/有偏移/锁定）；开启后显示全部 8 个。 */
    showAllCps:   false,
    textureName:  'halo' as TextureChoice | 'tex-sprite',
    runtimeReady: false,

    /** 鼠标世界坐标（gizmo 绘制用，与 runtime.setPointer 同步）。 */
    pointer: [0, 0] as [number, number],
})

// ---------------------------------------------------------------- 场景（多系统）

/** 场景条目入列；runtime 就绪时立即建系统（新建/复制/初始各一）。 */
function createSceneEntry(def: ParticleSystemDef, from?: { id: number }): number {
    const id = nextSystemId++
    const normalized = normalizeDef(def)
    editor.systems.push({ id, name: normalized.name, def: normalized })
    const meta = metaFor(id)
    if (from) {
        const src = metaFor(from.id)

        // 复制：贴图 GPU 对象与登记键共享引用
        meta.texture = src.texture
        meta.textureKind = src.textureKind
        meta.texturePath = src.texturePath
        meta.childTextures = { ...src.childTextures }
    }
    if (runtime) {
        meta.handle = runtime.addSystem(normalized, {
            ...meta.texture ? { texture: meta.texture } : {},
            ...Object.keys(meta.childTextures).length ? { childTextures: meta.childTextures } : {},
        })
    }

    return id
}

/** 选中切换：editor.def 指向目标系统的 def（同一 reactive 代理，面板/热编辑无缝衔接）。 */
export function selectSystem(id: number): void {
    const entry = editor.systems.find(s => s.id === id)
    if (!entry) return
    editor.activeId = id
    editor.def = editor.systems.find(s => s.id === id)!.def
    editor.selected = { kind: 'system' }
    editor.textureName = metaFor(id).textureKind
}

/** 新建空系统并选中。 */
export function addSystemToScene(): void {
    const def = emptyPreset()
    def.name = `system-${editor.systems.length + 1}`
    selectSystem(createSceneEntry(def))
}

/** 复制系统（def 深拷贝；贴图/children 贴图共享）并选中副本。 */
export function duplicateSystem(id: number): void {
    const src = editor.systems.find(s => s.id === id)
    if (!src) return
    const def = JSON.parse(JSON.stringify(src.def)) as ParticleSystemDef
    def.name = `${src.def.name}-copy`
    selectSystem(createSceneEntry(def, { id }))
}

/** 移除系统（至少保留 1 个）；销毁其 handle 与 GPU 贴图。 */
export function removeSystem(id: number): void {
    if (editor.systems.length <= 1) return
    const idx = editor.systems.findIndex(s => s.id === id)
    if (idx < 0) return
    const meta = metaFor(id)
    meta.handle?.destroy()
    releaseTexture(meta.texture)
    sceneMeta.delete(id)
    editor.systems.splice(idx, 1)
    if (editor.activeId === id) selectSystem(editor.systems[Math.max(0, idx - 1)]!.id)
}

/** 场景快照（导出 HTML/自动化用；def 为响应式代理，调用方自行深拷贝）。 */
export interface SceneSystemInfo {
    id:          number
    name:        string
    def:         ParticleSystemDef
    texturePath: string | null
}

export function getSceneSystems(): SceneSystemInfo[] {
    return editor.systems.map(s => ({ id: s.id, name: s.name, def: s.def, texturePath: metaFor(s.id).texturePath }))
}

// ---------------------------------------------------------------- 初始场景

{
    const first = normalizeDef(fountainPreset())
    editor.systems.push({ id: nextSystemId, name: first.name, def: first })
    editor.activeId = nextSystemId
    editor.def = editor.systems[0]!.def
    nextSystemId++
}

// ---------------------------------------------------------------- 自动保存（localStorage）

const SCENE_STORAGE_KEY = 'teilchen.scene.v2'
const LEGACY_DEF_KEY = 'teilchen.def.v1'

// 启动恢复上次编辑现场（整场景多系统；贴图为 GPU 资源不持久化，attach 后按材质引用尽力恢复）
try {
    const saved = localStorage.getItem(SCENE_STORAGE_KEY)
    if (saved) {
        const scene = JSON.parse(saved) as { systems?: { name: string, def: ParticleSystemDef }[] }
        if (Array.isArray(scene.systems) && scene.systems.length) {
            editor.systems.length = 0
            for (const s of scene.systems) {
                const def = normalizeDef(s.def)
                editor.systems.push({ id: nextSystemId++, name: s.name || def.name, def })
            }
            editor.activeId = editor.systems[0]!.id
            editor.def = editor.systems[0]!.def
        }
    }
    else {
        const legacy = localStorage.getItem(LEGACY_DEF_KEY)
        if (legacy) {
            const def = normalizeDef(JSON.parse(legacy) as ParticleSystemDef)
            editor.systems[0]!.def = def
            editor.def = editor.systems[0]!.def
            editor.systems[0]!.name = def.name
        }
    }
}
catch { /* 存档损坏则忽略，使用默认预设 */ }

let saveTimer: ReturnType<typeof setTimeout> | null = null
watch(() => editor.def, () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify({ systems: editor.systems.map(s => ({ name: s.name, def: s.def })) }))
        }
        catch { /* 容量超限等异常忽略 */ }
    }, 400)
}, { deep: true })

// ---------------------------------------------------------------- runtime 生命周期

export async function attachRuntime(canvas: HTMLCanvasElement): Promise<void> {
    if (runtime) return
    runtime = await ParticleRuntime.create({ canvas, onWarning: pushWarning })

    // 恢复现场：逐系统收集 children 贴图并建系统；根贴图按材质引用尽力加载
    for (const entry of editor.systems) {
        const meta = metaFor(entry.id)
        meta.childTextures = await attachChildTextures(entry.def)
        meta.handle = runtime.addSystem(entry.def, Object.keys(meta.childTextures).length ? { childTextures: meta.childTextures } : {})
        const texPath = entry.def.material.textures[0]
        if (texPath) {
            const asset = await loadWeTextureAsset(texPath)
            if (asset) {
                meta.texture = asset
                meta.textureKind = asset.frames?.length ? 'tex-sprite' : 'tex'
                meta.texturePath = texPath
                meta.handle.update(entry.def, { texture: asset })
            }
        }
    }
    runtime.start()
    editor.runtimeReady = true
    setInterval(pollStats, 250)
    editor.textureName = metaFor(editor.activeId).textureKind
}

export function getRuntime(): ParticleRuntime | null {
    return runtime
}

// 调试/自动化句柄（与 playground 的 __teilchen 同职责）
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__ed = {
        getRuntime,
        get editor() { return editor },
        importWeJson,
        serializeWe: () => serializeWeParticleJson(editor.def),
        addSystemToScene,
        duplicateSystem,
        removeSystem,
        selectSystem,
    }
}

function pollStats(): void {
    if (!runtime) return
    const s = runtime.stats
    const all = Object.values(s.systems).reduce(
        (acc, x) => ({ alive: acc.alive + x.alive, drawn: acc.drawn + x.rendered }),
        { alive: 0, drawn: 0 },
    )
    editor.stats = { fps: s.fps, ...all, time: runtime.time }
}

export function pushWarning(msg: string): void {
    editor.warnings.push(msg)
    if (editor.warnings.length > 30) editor.warnings.splice(0, editor.warnings.length - 30)
}

// ---------------------------------------------------------------- def 同步（热编辑）

watch(() => editor.def, () => scheduleSync(), { deep: true })

function scheduleSync(): void {
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
        const meta = metaFor(editor.activeId)
        if (!meta.handle) return
        const ws = meta.handle.update(editor.def)
        for (const w of ws) pushWarning(`[${editor.def.name}] ${w}`)
    }, 120)
}

/** 整体替换活跃系统的 def（预设/导入），reset 重跑；children 结构重建时套用其 children 贴图。 */
export function loadDef(def: ParticleSystemDef): void {
    const normalized = normalizeDef(def)
    editor.selected = { kind: 'system' }
    const entry = editor.systems.find(s => s.id === editor.activeId)
    if (!entry) return
    entry.def = normalized
    entry.name = normalized.name
    editor.def = entry.def
    const meta = metaFor(entry.id)
    if (meta.handle) {
        meta.handle.update(normalized, {
            reset: true,
            ...Object.keys(meta.childTextures).length ? { childTextures: meta.childTextures } : {},
        })
    }
}

export function resetSystem(): void {
    runtime?.reset()
}

export function togglePaused(): void {
    editor.paused = !editor.paused
    runtime?.setPaused(editor.paused)
}

export function stepFrame(): void {
    if (!editor.paused) togglePaused()
    runtime?.step()
    pollStats()
}

// ---------------------------------------------------------------- 模块编辑

function listFor(kind: ModuleKind): { name: string }[] {
    return kind === 'emitter'
        ? editor.def.emitters
        : kind === 'initializer'
            ? editor.def.initializers
            : kind === 'operator'
                ? editor.def.operators
                : editor.def.renderers
}

export function addModule(kind: ModuleKind, name: string): void {
    const spec = getModuleSpec(kind, name)
    if (!spec) return
    const params = Object.fromEntries(spec.params.map(p => [p.key, p.default]))
    const list = listFor(kind)
    list.push({ name, ...params })
    editor.selected = { kind, index: list.length - 1 }
}

export function removeModule(kind: ModuleKind, index: number): void {
    const list = listFor(kind)
    list.splice(index, 1)
    const sel = editor.selected
    if (sel.kind === kind) {
        if (list.length === 0) editor.selected = { kind: 'system' }
        else if (sel.index >= list.length) editor.selected = { kind, index: list.length - 1 }
    }
}

export function selectModule(kind: ModuleKind, index: number): void {
    editor.selected = { kind, index }
}

/** 控制点是否「活跃」：被任意模块/子声明引用、有偏移/角度/自转、或锁定跟随。 */
export function isCpActive(i: number): boolean {
    const def = editor.def
    const cp = def.controlPoints[i]
    if (!cp) return false
    if (cp.lockToPointer) return true
    if (cp.offset.some(v => v !== 0) || cp.angles.some(v => v !== 0) || cp.spin.some(v => v !== 0)) return true
    const referenced = [def.emitters, def.initializers, def.operators].some(list =>
        list.some(m => Object.keys(m).some(k => k.startsWith('controlpoint') && Number(m[k]) === i)))

    return referenced || def.children.some(c => c.controlPointStartIndex === i)
}

/** 加载精选 WE 预设（走与导入相同的解析链路；依赖 dev 模式的 /we 资产托管）。 */
export async function loadWePreset(file: string): Promise<void> {
    try {
        const res = await fetch(`/we/presets/${file}.json`)
        if (!res.ok) {
            pushWarning(t('warn.wePresetUnavailable', { file }))

            return
        }
        await importWeJson(await res.text())
    }
    catch(err) {
        pushWarning(t('warn.wePresetFailed', { file, msg: (err as Error).message }))
    }
}

/**
 * 把选中的 child 子定义作为当前系统打开（资产模型：子系统独立编辑、独立导出，
 * 不回写父引用——与 WE 的文件级引用语义一致）。
 */
export async function openChildAsSystem(index: number): Promise<void> {
    const child = editor.def.children[index]
    if (!child?.def) return
    const def = normalizeDef(JSON.parse(JSON.stringify(child.def)) as ParticleSystemDef)
    def.name = child.name.split('/').pop()!.replace(/\.json$/, '') || 'child'

    // 贴图是 runtime 侧状态（不在 def 里）：按新 def 树收集 children 贴图与根贴图
    metaFor(editor.activeId).childTextures = await attachChildTextures(def)
    loadDef(def)
    const texPath = def.material.textures[0]
    if (texPath) await loadWeTexture(texPath)
}

// ---------------------------------------------------------------- WE JSON 导入导出

/** 导入 WE particle JSON（可选 material JSON 文本；material/children 引用从本地 WE 资产路径解析）。 */
export async function importWeJson(text: string, materialText?: string): Promise<void> {
    let materialJson: unknown | undefined
    if (materialText) {
        materialJson = JSON.parse(materialText)
    }
    else {

        // 根材质引用自动解析（与 children 同源：/we/presets/materials/<basename>）
        try {
            const src = JSON.parse(text) as Record<string, unknown>
            const matFile = typeof src.material === 'string' ? src.material.split('/').pop() : undefined
            if (matFile) materialJson = await fetch(`/we/presets/materials/${matFile}`).then(r => r.ok ? r.json() : undefined)
        }
        catch { /* material 解析失败交给 parseWeParticleJson 上报 */ }
    }
    const { def, warnings } = parseWeParticleJson(text, materialJson, 'imported')
    for (const w of warnings) pushWarning(`[import] ${w}`)
    await attachChildDefs(def, async wePath => {
        const base = wePath.split('/')
            .pop()!
        try {
            const particleJson = await fetch(`/we/presets/${base}`).then(r => r.json())
            const matFile = String(particleJson.material ?? '').split('/')
                .pop()
            const materialJson = matFile
                ? await fetch(`/we/presets/materials/${matFile}`).then(r => r.ok ? r.json() : undefined)
                : undefined
            const sub = parseWeParticleJson(particleJson, materialJson, base.replace('.json', ''))
            for (const w of sub.warnings) pushWarning(`[import:child] ${w}`)

            return sub.def
        }
        catch {
            return undefined
        }
    })
    metaFor(editor.activeId).childTextures = await attachChildTextures(def)
    loadDef(def)

    // 材质引用的 sprite 贴图自动加载（/we/tex/<path>.tex）
    const texPath = def.material.textures[0]
    if (texPath) await loadWeTexture(texPath)
}

/** 从本地 WE 资产加载 .tex 贴图并应用到活跃系统（导入预设后自动套用）。 */
export async function loadWeTexture(texPath: string): Promise<boolean> {
    if (!runtime) return false
    const meta = metaFor(editor.activeId)
    if (!meta.handle) return false
    const asset = await loadWeTextureAsset(texPath)
    if (!asset) return false
    meta.handle.update(editor.def, { texture: asset })
    releaseTexture(meta.texture)
    meta.texture = asset
    meta.textureKind = asset.frames?.length ? 'tex-sprite' : 'tex'
    meta.texturePath = texPath
    editor.textureName = meta.textureKind

    return true
}

export function exportWeJson(): void {
    const json = serializeWeParticleJson(editor.def)
    const blob = new Blob([JSON.stringify(json, null, '\t')], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${editor.def.name || 'particles'}.json`
    a.click()
    URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------- 贴图

export type TextureChoice = 'halo' | 'tex' | 'upload' | 'white'

export async function setTexture(name: TextureChoice, file?: File, descriptorFile?: File): Promise<void> {
    if (!runtime) return
    const meta = metaFor(editor.activeId)
    if (!meta.handle) return
    let tex: GPUTexture | TextureAsset
    if (name === 'halo') {
        tex = createHaloTexture(runtime.device)
    }
    else if (name === 'white') {
        tex = createWhiteTexture(runtime.device)
    }
    else if (name === 'tex') {
        if (!file) return

        // 同名 .tex.json 描述（WE 的 .tex-json）：rg88/r8 的 alphachannelpriority 通道语义
        let alphaPriority = true
        if (descriptorFile) {
            try {
                const desc = JSON.parse(await descriptorFile.text())
                if (typeof desc.alphachannelpriority === 'boolean') alphaPriority = desc.alphachannelpriority
            }
            catch(err) {
                pushWarning(t('warn.texDescFailed', { msg: (err as Error).message }))
            }
        }
        try {
            const data = await file.arrayBuffer()
            tex = await createTextureFromTex(runtime.device, data, file.name, alphaPriority)
            registerTextureAsset({ path: file.name, data, alphaPriority })
            meta.texturePath = file.name
        }
        catch(err) {
            pushWarning(t('warn.texFailed', { msg: (err as Error).message }))

            return
        }
    }
    else {
        if (!file) return
        tex = await createTextureFromUrl(runtime.device, URL.createObjectURL(file))
        registerTextureAsset({ path: file.name, data: await file.arrayBuffer() })
        meta.texturePath = file.name
    }
    meta.handle.update(editor.def, { texture: tex })
    releaseTexture(meta.texture)
    meta.texture = tex
    meta.textureKind = name === 'tex' && 'frames' in tex && (tex as TextureAsset).frames?.length ? 'tex-sprite' : name
    if (name === 'halo' || name === 'white') meta.texturePath = null
    editor.textureName = meta.textureKind
}
