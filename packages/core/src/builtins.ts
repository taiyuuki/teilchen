/**
 * 内置模块的参数 schema
 * runtime 目前支持的子集实现 GPU 化；其余标记 unsupported（保留解析、导入导出兼容）。
 */
import { registerModule } from './registry.ts'

/** runtime 侧已实现 GPU 化的模块名。 */
export const GPU_SUPPORTED = new Set<string>([

    // emitters
    'emitter:boxrandom',
    'emitter:sphererandom',

    // initializers
    'initializer:lifetimerandom',
    'initializer:sizerandom',
    'initializer:alpharandom',
    'initializer:colorrandom',
    'initializer:velocityrandom',
    'initializer:rotationrandom',
    'initializer:angularvelocityrandom',

    // operators
    'operator:movement',
    'operator:angularmovement',
    'operator:alphafade',
    'operator:alphachange',
    'operator:sizechange',
    'operator:colorchange',
    'operator:oscillatealpha',
    'operator:oscillatesize',
    'operator:oscillateposition',
    'operator:turbulence',
    'operator:vortex',
    'operator:controlpointattract',

    // renderers
    'renderer:sprite',
])

export function registerBuiltins(): void {

    // ---------- emitters ----------
    registerModule({
        kind:        'emitter',
        name:        'boxrandom',
        label:       'Box Random',
        description: '在盒范围内随机取点；初速沿位置向量方向（径向）',
        params:      [
            { key: 'rate', label: 'Rate', type: 'float', default: 10, min: 0, step: 0.1 },
            { key: 'origin', label: 'Origin', type: 'vec3', default: [0, 0, 0] },
            { key: 'directions', label: 'Directions', type: 'vec3', default: [1, 1, 1] },
            { key: 'distancemin', label: 'Distance Min', type: 'vec3', default: [0, 0, 0] },
            { key: 'distancemax', label: 'Distance Max', type: 'vec3', default: [100, 100, 0] },
            { key: 'speedmin', label: 'Speed Min', type: 'float', default: 0 },
            { key: 'speedmax', label: 'Speed Max', type: 'float', default: 0 },
            { key: 'sign', label: 'Sign', type: 'vec3', default: [1, 1, 1] },
            { key: 'instantaneous', label: 'Instantaneous', type: 'int', default: 0, min: 0 },
            { key: 'maxtoemitperperiod', label: 'Max Per Period', type: 'int', default: 0, min: 0 },
            { key: 'duration', label: 'Duration', type: 'float', default: 0, min: 0 },
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: -1, min: -1, max: 7 },
        ],
    })
    registerModule({
        kind:        'emitter',
        name:        'sphererandom',
        label:       'Sphere Random',
        description: '球/圆内随机方向发射（distancemin/max 为半径）',
        params:      [
            { key: 'rate', label: 'Rate', type: 'float', default: 10, min: 0, step: 0.1 },
            { key: 'origin', label: 'Origin', type: 'vec3', default: [0, 0, 0] },
            { key: 'directions', label: 'Directions', type: 'vec3', default: [1, 1, 1] },
            { key: 'distancemin', label: 'Radius Min', type: 'float', default: 0, min: 0 },
            { key: 'distancemax', label: 'Radius Max', type: 'float', default: 100, min: 0 },
            { key: 'speedmin', label: 'Speed Min', type: 'float', default: 0 },
            { key: 'speedmax', label: 'Speed Max', type: 'float', default: 0 },
            { key: 'sign', label: 'Sign', type: 'vec3', default: [1, 1, 1] },
            { key: 'instantaneous', label: 'Instantaneous', type: 'int', default: 0, min: 0 },
            { key: 'maxtoemitperperiod', label: 'Max Per Period', type: 'int', default: 0, min: 0 },
            { key: 'duration', label: 'Duration', type: 'float', default: 0, min: 0 },
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: -1, min: -1, max: 7 },
        ],
    })

    // ---------- initializers ----------
    const randomRange = (label: string, defMin: number, defMax: number, type: 'color255' | 'float' = 'float') => [
        { key: 'min', label: `${label} Min`, type, default: type === 'color255' ? [defMin, defMin, defMin] : defMin },
        { key: 'max', label: `${label} Max`, type, default: type === 'color255' ? [defMax, defMax, defMax] : defMax },
        { key: 'exponent', label: 'Exponent', type: 'float', default: 1 },
    ] as const

    registerModule({ kind: 'initializer', name: 'lifetimerandom', label: 'Lifetime Random', params: [...randomRange('Lifetime', 1, 2)] as never })
    registerModule({ kind: 'initializer', name: 'sizerandom', label: 'Size Random', params: [...randomRange('Size', 20, 50)] as never })
    registerModule({ kind: 'initializer', name: 'alpharandom', label: 'Alpha Random', params: [...randomRange('Alpha', 1, 1)] as never })
    registerModule({ kind: 'initializer', name: 'colorrandom', label: 'Color Random', params: [...randomRange('Color', 255, 255, 'color255')] as never })
    registerModule({
        kind:   'initializer',
        name:   'velocityrandom',
        label:  'Velocity Random',
        params: [
            { key: 'min', label: 'Min', type: 'vec3', default: [0, 0, 0] },
            { key: 'max', label: 'Max', type: 'vec3', default: [0, 0, 0] },
            { key: 'exponent', label: 'Exponent', type: 'float', default: 1 },
        ],
    })
    registerModule({
        kind:   'initializer',
        name:   'rotationrandom',
        label:  'Rotation Random',
        params: [
            { key: 'min', label: 'Min', type: 'vec3', default: [0, 0, 0] },
            { key: 'max', label: 'Max', type: 'vec3', default: [0, 0, 0] },
            { key: 'exponent', label: 'Exponent', type: 'float', default: 1 },
        ],
    })
    registerModule({
        kind:   'initializer',
        name:   'angularvelocityrandom',
        label:  'Angular Velocity Random',
        params: [
            { key: 'min', label: 'Min', type: 'vec3', default: [0, 0, 0] },
            { key: 'max', label: 'Max', type: 'vec3', default: [0, 0, 0] },
            { key: 'exponent', label: 'Exponent', type: 'float', default: 1 },
        ],
    })
    registerModule({
        kind:   'initializer',
        name:   'turbulentvelocityrandom',
        label:  'Turbulent Velocity Random',
        params: [
            { key: 'normal', label: 'Normal', type: 'vec3', default: [0, 0, 0] },
            { key: 'forward', label: 'Forward', type: 'vec3', default: [0, 0, 0] },
        ],
    })
    registerModule({
        kind:   'initializer',
        name:   'mapsequencebetweencontrolpoints',
        label:  'Map Sequence Between CPs',
        params: [
            { key: 'controlpointstart', label: 'CP Start', type: 'int', default: 0 },
            { key: 'controlpointend', label: 'CP End', type: 'int', default: 1 },
            { key: 'count', label: 'Count', type: 'int', default: 100 },
            { key: 'limitbehavior', label: 'Limit', type: 'int', default: 0 },
        ],
    })
    registerModule({
        kind:   'initializer',
        name:   'mapsequencearoundcontrolpoint',
        label:  'Map Sequence Around CP',
        params: [
            { key: 'controlpoint', label: 'CP', type: 'int', default: 0 },
            { key: 'count', label: 'Count', type: 'int', default: 100 },
            { key: 'bounds', label: 'Bounds', type: 'vec3', default: [0, 0, 0] },
            { key: 'axis', label: 'Axis', type: 'vec3', default: [0, 0, 1] },
            { key: 'limitbehavior', label: 'Limit', type: 'int', default: 0 },
        ],
    })

    // ---------- operators ----------
    registerModule({
        kind:        'operator',
        name:        'movement',
        label:       'Movement',
        description: '重力 + 阻力，半隐式欧拉积分',
        params:      [
            { key: 'gravity', label: 'Gravity', type: 'vec3', default: [0, 0, 0] },
            { key: 'drag', label: 'Drag', type: 'float', default: 0, min: 0 },
        ],
    })
    registerModule({
        kind:   'operator',
        name:   'angularmovement',
        label:  'Angular Movement',
        params: [
            { key: 'force', label: 'Force', type: 'vec3', default: [0, 0, 0] },
            { key: 'drag', label: 'Drag', type: 'float', default: 0, min: 0 },
        ],
    })
    registerModule({
        kind:        'operator',
        name:        'alphafade',
        label:       'Alpha Fade',
        description: '生命周期首尾淡入淡出',
        params:      [
            { key: 'fadeintime', label: 'Fade In', type: 'float', default: 0, min: 0 },
            { key: 'fadeouttime', label: 'Fade Out', type: 'float', default: 0, min: 0 },
        ],
    })
    const changeParams = (label: string, sv: number, ev: number, isColor = false) => [
        { key: 'starttime', label: 'Start Time', type: 'float', default: 0 },
        { key: 'endtime', label: 'End Time', type: 'float', default: 1 },
        { key: 'startvalue', label: `${label} Start`, type: isColor ? 'vec3' : 'float', default: isColor ? [sv, sv, sv] : sv },
        { key: 'endvalue', label: `${label} End`, type: isColor ? 'vec3' : 'float', default: isColor ? [ev, ev, ev] : ev },
    ] as never
    registerModule({ kind: 'operator', name: 'alphachange', label: 'Alpha Change', params: changeParams('Alpha', 1, 1) })
    registerModule({ kind: 'operator', name: 'sizechange', label: 'Size Change', params: changeParams('Size', 20, 20) })
    registerModule({ kind: 'operator', name: 'colorchange', label: 'Color Change', params: changeParams('Color', 1, 1, true) })
    const oscillateParams = (vec = false) => [
        { key: 'frequencymin', label: 'Freq Min', type: vec ? 'vec3' : 'float', default: vec ? [1, 1, 1] : 1 },
        { key: 'frequencymax', label: 'Freq Max', type: vec ? 'vec3' : 'float', default: vec ? [1, 1, 1] : 1 },
        { key: 'scalemin', label: 'Scale Min', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 0 },
        { key: 'scalemax', label: 'Scale Max', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 0 },
        { key: 'phasemin', label: 'Phase Min', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 0 },
        { key: 'phasemax', label: 'Phase Max', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 0 },
    ] as never
    registerModule({ kind: 'operator', name: 'oscillatealpha', label: 'Oscillate Alpha', params: oscillateParams() })
    registerModule({ kind: 'operator', name: 'oscillatesize', label: 'Oscillate Size', params: oscillateParams() })
    registerModule({ kind: 'operator', name: 'oscillateposition', label: 'Oscillate Position', params: oscillateParams(true) })
    registerModule({
        kind:        'operator',
        name:        'turbulence',
        label:       'Turbulence',
        description: 'Curl noise 流场扰动',
        params:      [
            { key: 'phasemin', label: 'Phase Min', type: 'float', default: 0 },
            { key: 'phasemax', label: 'Phase Max', type: 'float', default: 100 },
            { key: 'speedmin', label: 'Speed Min', type: 'float', default: 0 },
            { key: 'speedmax', label: 'Speed Max', type: 'float', default: 100 },
            { key: 'timescale', label: 'Time Scale', type: 'float', default: 1 },
            { key: 'scale', label: 'Noise Scale', type: 'float', default: 0.01 },
            { key: 'mask', label: 'Mask', type: 'vec3', default: [1, 1, 1] },
        ],
    })
    registerModule({
        kind:        'operator',
        name:        'vortex',
        label:       'Vortex',
        description: '绕控制点轴的环形速度场',
        params:      [
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0 },
            { key: 'axis', label: 'Axis', type: 'vec3', default: [0, 0, 1] },
            { key: 'distanceinner', label: 'Distance Inner', type: 'float', default: 10 },
            { key: 'distanceouter', label: 'Distance Outer', type: 'float', default: 100 },
            { key: 'speedinner', label: 'Speed Inner', type: 'float', default: 100 },
            { key: 'speedouter', label: 'Speed Outer', type: 'float', default: 100 },
        ],
    })
    registerModule({
        kind:        'operator',
        name:        'controlpointattract',
        label:       'Control Point Attract',
        description: '控制点排斥/吸引（scale<0 远离控制点，如 cursor avoid；>0 吸向控制点）',
        params:      [
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0 },
            { key: 'scale', label: 'Scale', type: 'float', default: 0 },
            { key: 'threshold', label: 'Threshold', type: 'float', default: 0 },
            { key: 'origin', label: 'Origin', type: 'vec3', default: [0, 0, 0] },
        ],
    })

    // ---------- renderers ----------
    registerModule({ kind: 'renderer', name: 'sprite', label: 'Sprite', params: [] })
    registerModule({
        kind:   'renderer',
        name:   'spritetrail',
        label:  'Sprite Trail',
        params: [
            { key: 'length', label: 'Length', type: 'float', default: 0.02 },
            { key: 'maxlength', label: 'Max Length', type: 'float', default: 5 },
        ],
    })
    registerModule({ kind: 'renderer', name: 'rope', label: 'Rope', params: [{ key: 'length', label: 'Length', type: 'float', default: 1 }] })
    registerModule({
        kind:   'renderer',
        name:   'ropetrail',
        label:  'Rope Trail',
        params: [
            { key: 'length', label: 'Length', type: 'float', default: 0.02 },
            { key: 'maxlength', label: 'Max Length', type: 'float', default: 5 },
            { key: 'segments', label: 'Segments', type: 'int', default: 8 },
            { key: 'subdivision', label: 'Subdivision', type: 'int', default: 4 },
        ],
    })
}

registerBuiltins()
