import { PRESETS, type ParticleSystemDef, attachChildDefs, defaultSystem, parseWeParticleJson } from '@teilchen/core'
import { ParticleRuntime, type TextureAsset, createTextureFromTex } from '@teilchen/runtime'

const canvas = document.getElementById('view') as HTMLCanvasElement
const warnEl = document.getElementById('warn') as HTMLDivElement
const statsEl = document.getElementById('stats') as HTMLDivElement
const selectEl = document.getElementById('example') as HTMLSelectElement

const warnings: string[] = []
function warn(msg: string): void {
    warnings.push(msg)
    warnEl.textContent = warnings.slice(-6).join('\n')
}

window.addEventListener('error', e => warn(`JS 错误: ${e.message}`))
window.addEventListener('unhandledrejection', e => warn(`Promise 拒绝: ${e.reason?.message ?? e.reason}`))

// ---------------------------------------------------------------- WE 官方样例导入

async function weImport(file: string, name: string, materialFile = 'halo.material.json'): Promise<ParticleSystemDef> {
    const [particleJson, materialJson] = await Promise.all([
        fetch(`/we/${file}`).then(r => r.json()),
        fetch(`/we/${materialFile}`).then(r => r.json()),
    ])
    const { def, warnings: ws } = parseWeParticleJson(particleJson, materialJson, name)
    for (const w of ws) warn(`[${name}] ${w}`)

    return def
}

// WE 内置预设（projects/myprojects/particles）：材质按引用 basename 从 materials/ 子目录配对
// 子系统贴图（key = ChildDef.name）与根 def 关联，loadExample 时随 addSystem 传入
const childTexByRoot = new WeakMap<ParticleSystemDef, Record<string, TextureAsset>>()

async function wePresetImport(file: string): Promise<ParticleSystemDef> {
    const def = await weLoadPreset(file)
    await resolveChildDefs(def)
    await attachChildTextures(def)

    return def
}

/** 递归收集各层 children 的材质贴图（同路径共享一个 TextureAsset）。 */
async function attachChildTextures(def: ParticleSystemDef): Promise<void> {
    if (!def.children.length) return
    const texByPath = new Map<string, TextureAsset>()
    const collect = async(d: ParticleSystemDef, out: Record<string, TextureAsset>): Promise<void> => {
        for (const child of d.children) {
            if (!child.def) continue
            const texPath = child.def.material.textures[0]
            if (texPath) {
                let asset = texByPath.get(texPath)
                if (!asset) {
                    const loaded = await loadTex(`/we/tex/${texPath}.tex`)
                    if (loaded) {
                        asset = loaded
                        texByPath.set(texPath, asset)
                    }
                }
                if (asset) out[child.name] = asset
            }
            await collect(child.def, out)
        }
    }
    const out: Record<string, TextureAsset> = {}
    await collect(def, out)
    if (Object.keys(out).length) childTexByRoot.set(def, out)
}

async function weLoadPreset(file: string): Promise<ParticleSystemDef> {
    const particleJson = await fetch(`/we/presets/${file}`).then(r => r.json())
    const matFile = String(particleJson.material ?? '').split('/')
        .pop()
    const materialJson = matFile
        ? await fetch(`/we/presets/materials/${matFile}`).then(r => r.ok ? r.json() : undefined)
        : undefined
    const { def, warnings: ws } = parseWeParticleJson(particleJson, materialJson, file.replace('.json', ''))
    for (const w of ws) warn(`[${file}] ${w}`)

    return def
}

/** children 递归解析走 core 的 attachChildDefs（child.name 取 basename，预设同目录）。 */
async function resolveChildDefs(def: ParticleSystemDef): Promise<void> {
    await attachChildDefs(def, async name => weLoadPreset(name.split('/').pop()!))
}

// 只列顶层效果；部件文件（被 children 引用的 flare/stars/swirl 等）不单独演示，仍会被递归加载
const WE_PRESETS = [
    'bubbles1', 'dna', 'dripping_water', 'ember_beams', 'fireflies', 'fireworks2', 'fog1',
    'leaves5', 'lightning1', 'magic_color_sparkle', 'magic_glyphs_0', 'magic_vortex_orb',
    'rainperspective', 'smoke1', 'snowflat', 'starfield', 'torch', 'trail_0', 'trail_1',
    'trail_2', 'water_faucet', 'water_impact',
] as const

/** WE 场景里粒子对象可拖放到任意位置；烟花/喷泉类通常摆在画布下部（否则火箭冲出顶部）。 */
function placeAtBottom(def: ParticleSystemDef, canvas: HTMLCanvasElement): ParticleSystemDef {

    // def.origin 经控制点 0 流入全部发射器（emitter.controlpoint 默认 0，WE 语义）
    def.origin[1] = -canvas.clientHeight * 0.38

    return def
}

// device 延迟获取（runtime 创建后才有）
let sharedDevice: GPUDevice | null = null

interface Example {
    id:    string
    label: string

    /** 返回单系统或多个系统（同帧叠加演示）。 */
    load:   () => ParticleSystemDef | ParticleSystemDef[] | Promise<ParticleSystemDef | ParticleSystemDef[]>
    asset?: () => Promise<TextureAsset | null>
}

const EXAMPLES: Example[] = [
    ...PRESETS.map((p): Example => ({ id: p.id, label: p.label, load: p.load })),
    { id: 'we-example', label: 'WE example.json（导入）', load: () => weImport('example.json', 'we-example') },
    { id: 'we-example3d', label: 'WE example3d.json（导入）', load: () => weImport('example3d.json', 'we-example3d', 'halo_translucent.json') },
    { id: 'we-cursoravoid', label: 'WE examplecursoravoid.json（鼠标避开）', load: () => weImport('examplecursoravoid.json', 'we-cursoravoid') },
    { id: 'we-cursorfollow', label: 'WE examplecursorfollow.json（鼠标跟随）', load: () => weImport('examplecursorfollow.json', 'we-cursorfollow') },
    {
        id:    'we-turbolence',
        label: 'WE exampleturbolence.json（15k rate 压测）',
        load:  () => weImport('exampleturbolence.json', 'we-turbolence'),
    },
    { id: 'we-turbolence3d', label: 'WE exampleturbolence3d.json（导入）', load: () => weImport('exampleturbolence3d.json', 'we-turbolence3d', 'halo_translucent.json') },
    {
        id:     'we-tex-sprite',
        label:  'WE fish1.tex（.tex 解码 + sprite sequence 动画）',
        load:   () => fishDef(),
        asset:  () => loadTex('/we/fish1.tex'),
    },
    {
        id:    'blend-modes',
        label: 'blend modes（colorBlendMode 双系统合成）',
        load:  () => [blendFieldDef(), blenderDef()],
    },
    {
        id:     'we-tex-halo',
        label:  'WE halo.tex（.tex LZ4+BC 解码）',
        load:   () => weImport('example.json', 'we-tex-halo'),
        asset:  () => loadTex('/we/halo.tex'),
    },
]

function fishDef(): ParticleSystemDef {
    const def = defaultSystem('fish-sprite')
    def.material.blending = 'translucent'
    def.maxCount = 60
    def.animationMode = 'sequence'
    def.emitters = [
        {
            name:        'sphererandom',
            rate:        8,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
            distancemin: 300,
            distancemax: 340,
            speedmin:    20,
            speedmax:    60,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 8, max: 12 },
        { name: 'sizerandom', min: 120, max: 180 },
        { name: 'rotationrandom', min: [0, 0, -0.5], max: [0, 0, 0.5] },
        { name: 'velocityrandom', min: [-30, -20, 0], max: [30, 20, 0] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, 0, 0], drag: 0.3 },
        { name: 'alphafade', fadeintime: 0.5, fadeouttime: 0.8 },
    ]

    return def
}

async function loadTex(url: string): Promise<TextureAsset | null> {
    if (!sharedDevice) return null
    try {
        const buf = await fetch(url).then(r => {
            if (!r.ok) throw new Error(String(r.status))

            return r.arrayBuffer()
        })

        return await createTextureFromTex(sharedDevice, buf)
    }
    catch(err) {
        warn(`.tex 加载失败: ${(err as Error).message}`)

        return null
    }
}

// ---------------------------------------------------------------- 启动

async function main(): Promise<void> {
    if (!navigator.gpu) {
        document.getElementById('unsupported')!.style.display = 'grid'

        return
    }
    const runtime = await ParticleRuntime.create({ canvas, onWarning: warn })
    sharedDevice = runtime.device

    const currentHandles: { destroy(): void }[] = []
    async function loadExample(id: string): Promise<void> {
        for (const h of currentHandles) h.destroy()
        currentHandles.length = 0
        const ex = EXAMPLES.find(e => e.id === id) ?? EXAMPLES[0]
        const result = await ex.load()
        const defs = Array.isArray(result) ? result : [result]
        const asset = ex.asset ? await ex.asset() : await texFromMaterial(defs)
        runtime.setCamera(PRESET_CAMERA[id.startsWith('preset:') ? id.slice(7) : ''] ?? null)
        for (const def of defs) {
            const childTextures = childTexByRoot.get(def)
            currentHandles.push(runtime.addSystem(def, { ...asset ? { texture: asset } : {}, ...childTextures ? { childTextures } : {} }))
        }
    }

    // 3D 空间预设的透视相机（WE 预览场景的倾斜视角；其余预设走 2D 正交）
    const PRESET_CAMERA: Record<string, { eye: [number, number, number], target: [number, number, number], fov: number }> = {
        'magic_vortex_orb': { eye: [0, -620, 540], target: [0, 0, 0], fov: 50 },
    }

    /** 材质里第一个贴图路径（如 "particle/fire/fire1"）→ /we/tex/<path>.tex 解码。 */
    async function texFromMaterial(defs: ParticleSystemDef[]): Promise<TextureAsset | null> {
        const texPath = defs.map(d => d.material.textures[0]).find(Boolean)
        if (!texPath) return null

        return loadTex(`/we/tex/${texPath}.tex`)
    }

    for (const ex of EXAMPLES) {
        const opt = document.createElement('option')
        opt.value = ex.id
        opt.textContent = ex.label
        selectEl.appendChild(opt)
    }
    {
        const group = document.createElement('optgroup')
        group.label = 'WE 内置预设（34）'
        for (const p of WE_PRESETS) {
            const opt = document.createElement('option')
            opt.value = `preset:${p}`
            opt.textContent = p
            group.appendChild(opt)
        }
        selectEl.appendChild(group)
    }

    // preset:<name> 统一走 wePresetImport（须在 change 监听注册前就位）
    EXAMPLES.push(...WE_PRESETS.map(p => ({
        id:    `preset:${p}`,
        label: p,
        load:  async() => {
            const def = await wePresetImport(`${p}.json`)

            return p === 'fireworks2' ? placeAtBottom(def, canvas) : def
        },
    })))
    selectEl.addEventListener('change', () => void loadExample(selectEl.value))
    await loadExample('fountain')
    runtime.start()

    const playBtn = document.getElementById('play') as HTMLButtonElement
    let paused = false
    playBtn.addEventListener('click', () => {
        paused = !paused
        runtime.setPaused(paused)
        playBtn.textContent = paused ? '▶' : '⏸'
        playBtn.classList.toggle('active', paused)
    })
    document.getElementById('step')!.addEventListener('click', () => {
        if (!paused) {
            paused = true
            runtime.setPaused(true)
            playBtn.textContent = '▶'
        }
        runtime.step()
    })
    document.getElementById('reset')!.addEventListener('click', () => runtime.reset())

    canvas.addEventListener('pointermove', e => {
        const rect = canvas.getBoundingClientRect()
        runtime.setPointer(e.clientX - rect.left, e.clientY - rect.top)
    })

    setInterval(() => {
        const s = runtime.stats
        const parts = Object.values(s.systems).reduce(
            (acc, x) => ({ alive: acc.alive + x.alive, rendered: acc.rendered + x.rendered }),
            { alive: 0, rendered: 0 },
        )
        statsEl.innerHTML = `fps <b>${s.fps || '—'}</b> · alive <b>${parts.alive.toLocaleString()}</b> · drawn <b>${parts.rendered.toLocaleString()}</b>`
    }, 250)

    // 调试/自动化句柄（页面隐藏时 RAF 停转，可用 step() 同步步进）
    Object.assign(window, { __teilchen: { runtime, warnings } })
}

main().catch(err => {
    warn(`启动失败: ${err?.message ?? err}`)
    console.error(err)
})

// ---------------------------------------------------------------- colorBlendMode 演示

/** 背景场：大尺寸半透明色块铺出可被合成的底图。 */
function blendFieldDef(): ParticleSystemDef {
    const def = defaultSystem('blend-field')
    def.material.blending = 'translucent'
    def.maxCount = 60
    def.emitters = [
        {
            name:        'boxrandom',
            rate:        6,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
            distancemin: [-560, -320, 0],
            distancemax: [560, 320, 0],
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 10, max: 16 },
        { name: 'sizerandom', min: 240, max: 420, exponent: 1 },
        { name: 'velocityrandom', min: [-12, -8, 0], max: [12, 8, 0] },
        { name: 'colorrandom', min: [255, 120, 60], max: [80, 60, 255] },
    ]
    def.operators = [{ name: 'alphafade', fadeintime: 1.5, fadeouttime: 2.0 }]

    return def
}

/** 前景：Difference 混合的涡流粒子（对背景快照做差值合成）。 */
function blenderDef(): ParticleSystemDef {
    const def = defaultSystem('blend-difference')
    def.material.blending = 'translucent'
    def.material.colorBlendMode = 18 // Difference
    def.maxCount = 4000
    def.emitters = [
        {
            name:        'sphererandom',
            rate:        320,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
            distancemin: 120,
            distancemax: 300,
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 4, max: 8 },
        { name: 'sizerandom', min: 20, max: 60, exponent: 1.5 },
        { name: 'colorrandom', min: [255, 255, 255], max: [255, 255, 255] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, 0, 0], drag: 1.2 },
        {
            name:           'vortex',
            controlpoint:   0,
            axis:           [0, 0, 1],
            distanceinner:  60,
            distanceouter:  340,
            speedinner:     380,
            speedouter:     90,
        },
        { name: 'alphafade', fadeintime: 0.5, fadeouttime: 1.0 },
    ]

    return def
}
