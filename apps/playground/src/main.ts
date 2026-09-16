import { PRESETS, type ParticleSystemDef, parseWeParticleJson } from '@teilchen/core'
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

const EXAMPLES: { id: string, label: string, load: () => ParticleSystemDef | Promise<ParticleSystemDef> }[] = [
    ...PRESETS.map(p => ({ id: p.id, label: p.label, load: p.load })),
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
