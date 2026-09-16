import { PRESETS, type ParticleSystemDef, defaultSystem, parseWeParticleJson } from '@teilchen/core'
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

async function weImport(file: string, name: string): Promise<ParticleSystemDef> {
    const [particleJson, materialJson] = await Promise.all([
        fetch(`/we/${file}`).then(r => r.json()),
        fetch('/we/halo.material.json').then(r => r.json()),
    ])
    const { def, warnings: ws } = parseWeParticleJson(particleJson, materialJson, name)
    for (const w of ws) warn(`[${name}] ${w}`)

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
    {
        id:    'we-turbolence',
        label: 'WE exampleturbolence.json（15k rate 压测）',
        load:  () => weImport('exampleturbolence.json', 'we-turbolence'),
    },
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
        const asset = ex.asset ? await ex.asset() : null
        for (const def of defs) currentHandles.push(runtime.addSystem(def, asset ? { texture: asset } : {}))
    }

    for (const ex of EXAMPLES) {
        const opt = document.createElement('option')
        opt.value = ex.id
        opt.textContent = ex.label
        selectEl.appendChild(opt)
    }
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
