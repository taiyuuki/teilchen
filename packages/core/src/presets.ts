/**
 * 内置效果预设（editor 预设菜单 / playground 示例共用）。
 */
import type { ParticleSystemDef } from './types.ts'
import { defaultSystem } from './types.ts'

export function fountainPreset(): ParticleSystemDef {
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

export function galaxyPreset(): ParticleSystemDef {
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
            name:           'vortex',
            controlpoint:   0,
            axis:           [0, 0, 1],
            distanceinner:  60,
            distanceouter:  320,
            speedinner:     420,
            speedouter:     90,
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

export function snowPreset(): ParticleSystemDef {
    const def = defaultSystem('snow')
    def.material.blending = 'translucent'
    def.maxCount = 8000
    def.startTime = 6 // 预热：开场就有满屏雪
    def.emitters = [
        {
            name:        'boxrandom',
            rate:        220,
            origin:      [0, 0, 0],
            directions:  [1, 1, 0],
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
            name:          'oscillateposition',
            frequencymin:  [0.12, 0.1, 0],
            frequencymax:  [0.35, 0.2, 0],
            scalemin:      [14, 0, 0],
            scalemax:      [46, 0, 0],
            phasemin:      [0, 0, 0],
            phasemax:      [6.28, 6.28, 0],
        },
        { name: 'alphafade', fadeintime: 0.8, fadeouttime: 2.0 },
    ]

    return def
}

export function cursorAvoidPreset(): ParticleSystemDef {
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

export function fireworksPreset(): ParticleSystemDef {

    // 父：上升的火箭拖尾；eventdeath 子：死亡点爆开的火花
    const def = defaultSystem('fireworks')
    def.material.blending = 'additive'
    def.maxCount = 2000
    def.emitters = [
        {
            name:        'boxrandom',
            rate:        2,
            origin:      [0, -420, 0],
            directions:  [1, 1, 0],
            distancemin: [-30, 0, 0],
            distancemax: [30, 10, 0],
            speedmin:    0,
            speedmax:    0,
        },
    ]
    def.initializers = [
        { name: 'lifetimerandom', min: 1.4, max: 1.9 },
        { name: 'sizerandom', min: 3, max: 7 },
        { name: 'velocityrandom', min: [-40, 520, 0], max: [40, 680, 0] },
        { name: 'colorrandom', min: [255, 220, 160], max: [255, 250, 230] },
    ]
    def.operators = [
        { name: 'movement', gravity: [0, -180, 0], drag: 0.15 },
        { name: 'alphafade', fadeintime: 0.05, fadeouttime: 0.3 },
    ]

    const child = defaultSystem('fireworks-burst')
    child.material.blending = 'additive'
    child.maxCount = 8000
    child.emitters = [
        {
            name:          'sphererandom',
            rate:          0,
            origin:        [0, 0, 0],
            directions:    [1, 1, 0],
            distancemin:   4,
            distancemax:   8,
            speedmin:      90,
            speedmax:      320,
            instantaneous: 180,
        },
    ]
    child.initializers = [
        { name: 'lifetimerandom', min: 0.7, max: 1.5 },
        { name: 'sizerandom', min: 3, max: 8 },
        { name: 'colorrandom', min: [255, 240, 200], max: [255, 170, 80] },
    ]
    child.operators = [
        { name: 'movement', gravity: [0, -70, 0], drag: 1.1 },
        { name: 'alphafade', fadeintime: 0.03, fadeouttime: 0.6 },
        { name: 'colorchange', starttime: 0.2, endtime: 1.2, startvalue: [1, 0.95, 0.8], endvalue: [1, 0.35, 0.1] },
    ]
    def.children = [
        {
            name:                   'particles/fireworks-burst.json',
            type:                   'eventdeath',
            maxCount:               32,
            controlPointStartIndex: 0,
            probability:            1,
            origin:                 [0, 0, 0],
            scale:                  [1, 1, 1],
            angles:                 [0, 0, 0],
            def:                    child,
        },
    ]

    return def
}

export const PRESETS: { id: string, label: string, load: () => ParticleSystemDef }[] = [
    { id: 'fountain', label: 'fountain（boxrandom + gravity + fade）', load: fountainPreset },
    { id: 'galaxy', label: 'galaxy（vortex + turbulence + additive）', load: galaxyPreset },
    { id: 'snow', label: 'snow（oscillateposition + warmup）', load: snowPreset },
    { id: 'cursor-avoid', label: 'cursor avoid（controlpointattract + 鼠标）', load: cursorAvoidPreset },
    { id: 'fireworks', label: 'fireworks（eventdeath 子粒子系统）', load: fireworksPreset },
]
