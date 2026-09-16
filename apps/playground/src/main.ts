import { type ParticleSystemDef, defaultSystem, parseWeParticleJson } from '@teilchen/core'
import { ParticleRuntime } from '@teilchen/runtime'

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

// ---------------------------------------------------------------- 示例库

function fountain(): ParticleSystemDef {
    const def = defaultSystem('fountain')
    def.material.blending = 'translucent'
    def.maxCount = 20000
    def.emitters = [
        {
            name:        'boxrandom',
            rate:        400,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
            distancemin: [-16, 0, 0],
            distancemax: [16, 8, 0],
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 1.5, max: 3.0 },
        { name: 'sizerandom', min: 6, max: 22, exponent: 2 },
        { name: 'velocityrandom', min: [-40, 380, 0], max: [40, 620, 0] },
        { name: 'colorrandom', min: [255, 190, 120], max: [130, 170, 255] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, -420, 0], drag: 0.6 },
        { name: 'alphafade', fadeintime: 0.15, fadeouttime: 0.6 },
        { name: 'sizechange', starttime: 0, endtime: 2.5, startvalue: 20, endvalue: 3 },
    ]

    return def
}

function galaxy(): ParticleSystemDef {
    const def = defaultSystem('galaxy')
    def.material.blending = 'additive'
    def.maxCount = 30000
    def.emitters = [
        {
            name:        'sphererandom',
            rate:        600,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
            distancemin: 180,
            distancemax: 220,
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 6, max: 10 },
        { name: 'sizerandom', min: 4, max: 14, exponent: 2 },
        { name: 'velocityrandom', min: [-20, -20, 0], max: [20, 20, 0] },
        { name: 'colorrandom', min: [255, 190, 110], max: [140, 170, 255] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, 0, 0], drag: 1.2 },
        {
            name:          'vortex',
            controlpoint:  0,
            axis:          [0, 0, 1],
            distanceinner: 60,
            distanceouter: 320,
            speedinner:    420,
            speedouter:    90,
        },
        {
            name:      'turbulence',
            phasemin:  0,
            phasemax:  100,
            speedmin:  40,
            speedmax:  120,
            timescale: 0.4,
            scale:     0.004,
            mask:      [1, 1, 0],
        },
        { name: 'alphafade', fadeintime: 1.0, fadeouttime: 1.5 },
    ]

    return def
}

function snow(): ParticleSystemDef {
    const def = defaultSystem('snow')
    def.material.blending = 'translucent'
    def.maxCount = 8000
    def.startTime = 6 // 预热：开场就有满屏雪
    def.emitters = [
        {
            name:        'boxrandom',
            rate:        220,
            origin:      [0, 0, 0],
            directions:  [0, -1, 0],
            distancemin: [-1100, 620, 0],
            distancemax: [1100, 700, 0],
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 14, max: 18 },
        { name: 'sizerandom', min: 3, max: 9, exponent: 1.5 },
        { name: 'velocityrandom', min: [-14, -70, 0], max: [14, -30, 0] },
        { name: 'colorrandom', min: [200, 220, 255], max: [255, 255, 255] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, -30, 0], drag: 1.0 },
        {
            name:         'oscillateposition',
            frequencymin: [0.12, 0.1, 0],
            frequencymax: [0.35, 0.2, 0],
            scalemin:     [14, 0, 0],
            scalemax:     [46, 0, 0],
            phasemin:     [0, 0, 0],
            phasemax:     [6.28, 6.28, 0],
        },
        { name: 'alphafade', fadeintime: 0.8, fadeouttime: 2.0 },
    ]

    return def
}

function cursorAvoid(): ParticleSystemDef {
    const def = defaultSystem('cursor-avoid')
    def.material.blending = 'additive'
    def.maxCount = 4000
    def.controlPoints[1].lockToPointer = true
    def.emitters = [
        {
            name:        'boxrandom',
            rate:        260,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
            distancemin: [-500, -300, 0],
            distancemax: [500, 300, 0],
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 3, max: 6 },
        { name: 'sizerandom', min: 8, max: 20, exponent: 1.5 },
        { name: 'colorrandom', min: [90, 220, 255], max: [180, 130, 255] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, 0, 0], drag: 2.5 },
        { name: 'alphafade', fadeintime: 0.5 },
        { name: 'controlpointattract', controlpoint: 1, scale: -6000, threshold: 110 },
    ]

    return def
}

async function weImport(file: string, name: string): Promise<ParticleSystemDef> {
    const [particleJson, materialJson] = await Promise.all([
        fetch(`/we/${file}`).then(r => r.json()),
        fetch('/we/halo.material.json').then(r => r.json()),
    ])
    const { def, warnings: ws } = parseWeParticleJson(particleJson, materialJson, name)
    for (const w of ws) warn(`[${name}] ${w}`)

    return def
}

const EXAMPLES: { id: string; label: string; load: () => ParticleSystemDef | Promise<ParticleSystemDef> }[] = [
    { id: 'fountain', label: 'fountain（boxrandom + gravity + fade）', load: fountain },
    { id: 'galaxy', label: 'galaxy（vortex + turbulence + additive）', load: galaxy },
    { id: 'snow', label: 'snow（oscillateposition + warmup）', load: snow },
    { id: 'cursor-avoid', label: 'cursor avoid（controlpointattract + 鼠标）', load: cursorAvoid },
    { id: 'we-example', label: 'WE example.json（导入）', load: () => weImport('example.json', 'we-example') },
    {
        id:    'we-turbolence',
        label: 'WE exampleturbolence.json（15k rate 压测）',
        load:  () => weImport('exampleturbolence.json', 'we-turbolence'),
    },
]

// ---------------------------------------------------------------- 启动

async function main(): Promise<void> {
    if (!navigator.gpu) {
        document.getElementById('unsupported')!.style.display = 'grid'

        return
    }
    const runtime = await ParticleRuntime.create({ canvas, onWarning: warn })

    let current: { destroy(): void } | null = null
    async function loadExample(id: string): Promise<void> {
        if (current) current.destroy()
        const ex = EXAMPLES.find(e => e.id === id) ?? EXAMPLES[0]
        const def = await ex.load()
        const handle = runtime.addSystem(def)
        current = handle
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
}

main().catch(err => {
    warn(`启动失败: ${err?.message ?? err}`)
    console.error(err)
})
