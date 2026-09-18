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

export type Selection = { kind: 'system' } | { kind: ModuleKind, index: number }

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
    ;(window as unknown as Record<string, unknown>).__ed = { getRuntime, get editor() { return editor } }
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

// ---------------------------------------------------------------- WE JSON 导入导出

/** 导入 WE particle JSON（可选 material JSON 文本；children 引用尝试从 playground 资产路径解析）。 */
export async function importWeJson(text: string, materialText?: string): Promise<void> {
    const { def, warnings } = parseWeParticleJson(text, materialText ? JSON.parse(materialText) : undefined, 'imported')
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
