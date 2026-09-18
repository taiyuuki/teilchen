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

export type Selection = { kind: 'child', index: number } | { kind: 'system' } | { kind: ModuleKind, index: number }

let runtime: ParticleRuntime | null = null
let handle: SystemHandle | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null
let currentTexture: GPUTexture | null = null

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
    { id: 'fountain', label: 'fountain', load: fountainPreset },
    { id: 'galaxy', label: 'galaxy', load: galaxyPreset },
    { id: 'snow', label: 'snow', load: snowPreset },
    { id: 'cursor-avoid', label: 'cursor avoid', load: cursorAvoidPreset },
    { id: 'empty', label: '空白系统', load: emptyPreset },
]

/** 精选 WE 预设（覆盖不同特性轴；完整清单不进编辑器，需要时用「导入 WE JSON」）。 */
export const WE_PRESET_DEFS = [
    { file: 'magic_vortex_orb', label: 'magic vortex orb · 控制点/涡旋/拖尾' },
    { file: 'fireworks2', label: 'fireworks · 子粒子/事件' },
    { file: 'fireflies', label: 'fireflies · 湍流/振荡' },
    { file: 'dripping_water', label: 'dripping water · ropetrail/折射' },
    { file: 'bubbles1', label: 'bubbles · 半透明基础' },
    { file: 'dna', label: 'dna · 涡旋/变色' },
]

export const editor = reactive({
    def:          normalizeDef(fountainPreset()),
    selected:     { kind: 'system' } as Selection,
    stats:        { fps: 0, alive: 0, drawn: 0, time: 0 },
    warnings:     [] as string[],
    gizmos:       true,
    paused:       false,
    textureName:  'halo' as TextureChoice | 'tex-sprite',
    runtimeReady: false,

    /** 鼠标世界坐标（gizmo 绘制用，与 runtime.setPointer 同步）。 */
    pointer: [0, 0] as [number, number],
})

// ---------------------------------------------------------------- runtime 生命周期

export async function attachRuntime(canvas: HTMLCanvasElement): Promise<void> {
    if (runtime) return
    runtime = await ParticleRuntime.create({ canvas, onWarning: pushWarning })
    handle = runtime.addSystem(editor.def)
    runtime.start()
    editor.runtimeReady = true
    setInterval(pollStats, 250)
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
        if (!handle) return
        const ws = handle.update(editor.def)
        for (const w of ws) pushWarning(`[${editor.def.name}] ${w}`)
    }, 120)
}

/** 整体替换 def（预设/导入），reset 重跑。 */
export function loadDef(def: ParticleSystemDef): void {
    const normalized = normalizeDef(def)
    editor.selected = { kind: 'system' }
    editor.def = normalized
    if (handle) handle.update(normalized, { reset: true })
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

/** 加载精选 WE 预设（走与导入相同的解析链路；依赖 dev 模式的 /we 资产托管）。 */
export async function loadWePreset(file: string): Promise<void> {
    try {
        const res = await fetch(`/we/presets/${file}.json`)
        if (!res.ok) {
            pushWarning(`WE 预设 ${file} 不可用（需要 dev 模式的 /we 资产托管）`)

            return
        }
        await importWeJson(await res.text())
    }
    catch(err) {
        pushWarning(`WE 预设 ${file} 加载失败: ${(err as Error).message}`)
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
    loadDef(def)

    // 贴图是 runtime 侧状态（不在 def 里）：切到子定义材质引用的 sprite
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
    loadDef(def)

    // 材质引用的 sprite 贴图自动加载（/we/tex/<path>.tex）
    const texPath = def.material.textures[0]
    if (texPath) await loadWeTexture(texPath)
}

/** 从本地 WE 资产加载 .tex 贴图并应用到当前系统（导入预设后自动套用）。 */
export async function loadWeTexture(texPath: string): Promise<boolean> {
    if (!runtime || !handle) return false
    try {
        const res = await fetch(`/we/tex/${texPath}.tex`)
        if (!res.ok) return false
        const tex = await createTextureFromTex(runtime.device, await res.arrayBuffer(), texPath)
        const old = currentTexture
        handle.update(editor.def, { texture: tex })
        currentTexture = 'texture' in tex ? tex.texture : tex
        editor.textureName = 'texture' in tex && tex.frames?.length ? 'tex-sprite' : 'tex'
        old?.destroy()

        return true
    }
    catch(err) {
        pushWarning(`[import] 贴图 ${texPath} 加载失败: ${(err as Error).message}`)

        return false
    }
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
    if (!runtime || !handle) return
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
                pushWarning(`.tex.json 描述解析失败: ${(err as Error).message}，按默认通道语义`)
            }
        }
        try {
            tex = await createTextureFromTex(runtime.device, await file.arrayBuffer(), file.name, alphaPriority)
        }
        catch(err) {
            pushWarning(`.tex 解析失败: ${(err as Error).message}`)

            return
        }
    }
    else {
        if (!file) return
        tex = await createTextureFromUrl(runtime.device, URL.createObjectURL(file))
    }
    const old = currentTexture
    handle.update(editor.def, { texture: tex })
    currentTexture = 'texture' in tex ? tex.texture : tex
    editor.textureName = name === 'tex' && 'texture' in tex && tex.frames?.length ? 'tex-sprite' : name
    old?.destroy()
}
