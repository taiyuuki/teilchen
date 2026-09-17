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
    'initializer:turbulentvelocityrandom',
    'initializer:hsvcolorrandom',
    'initializer:mapsequencebetweencontrolpoints',
    'initializer:mapsequencearoundcontrolpoint',

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
    'operator:vortex_v2',
    'operator:controlpointattract',
    'operator:maintaindistancetocontrolpoint',
    'operator:boids',

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
            { key: 'sign', label: 'Sign（0 保留 / ±1 强制）', type: 'vec3', default: [0, 0, 0] },
            { key: 'instantaneous', label: 'Instantaneous', type: 'int', default: 0, min: 0 },
            { key: 'maxtoemitperperiod', label: 'Max Per Period', type: 'int', default: 0, min: 0 },
            { key: 'duration', label: 'Duration', type: 'float', default: 0, min: 0 },
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0, min: -1, max: 7 },
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
            { key: 'sign', label: 'Sign（0 保留 / ±1 强制）', type: 'vec3', default: [0, 0, 0] },
            { key: 'flags', label: 'Flags', type: 'int', default: 0 },
            { key: 'cone', label: 'Cone', type: 'float', default: 0 },
            { key: 'instantaneous', label: 'Instantaneous', type: 'int', default: 0, min: 0 },
            { key: 'maxtoemitperperiod', label: 'Max Per Period', type: 'int', default: 0, min: 0 },
            { key: 'duration', label: 'Duration', type: 'float', default: 0, min: 0 },
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0, min: -1, max: 7 },
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
            { key: 'scale', label: 'Noise Scale', type: 'float', default: 0.2 },
            { key: 'speedmin', label: 'Speed Min', type: 'float', default: 0 },
            { key: 'speedmax', label: 'Speed Max', type: 'float', default: 100 },
            { key: 'offset', label: 'Offset', type: 'float', default: 0 },
            { key: 'phasemax', label: 'Phase Max', type: 'float', default: 0 },
            { key: 'timescale', label: 'Time Scale', type: 'float', default: 0 },
        ],
    })
    registerModule({
        kind:   'initializer',
        name:   'hsvcolorrandom',
        label:  'HSV Color Random',
        params: [
            { key: 'huemin', label: 'Hue Min', type: 'float', default: 0 },
            { key: 'huemax', label: 'Hue Max', type: 'float', default: 1 },
            { key: 'saturationmin', label: 'Saturation Min', type: 'float', default: 1 },
            { key: 'saturationmax', label: 'Saturation Max', type: 'float', default: 1 },
            { key: 'valuemin', label: 'Value Min', type: 'float', default: 1 },
            { key: 'valuemax', label: 'Value Max', type: 'float', default: 1 },
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
            { key: 'flags', label: 'Flags', type: 'int', default: 0 },
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
        description: '生命周期首尾淡入淡出（时间为寿命归一化进度 0-1）',
        params:      [
            { key: 'fadeintime', label: 'Fade In', type: 'float', default: 0.5, min: 0, max: 1 },
            { key: 'fadeouttime', label: 'Fade Out', type: 'float', default: 0.5, min: 0, max: 1 },
        ],
    })
    const changeParams = (label: string, sv: number, ev: number, isColor = false) => [
        { key: 'starttime', label: 'Start Time（寿命进度）', type: 'float', default: 0, min: 0, max: 1 },
        { key: 'endtime', label: 'End Time（寿命进度）', type: 'float', default: 1, min: 0, max: 1 },
        { key: 'startvalue', label: `${label} Start`, type: isColor ? 'vec3' : 'float', default: isColor ? [sv, sv, sv] : sv },
        { key: 'endvalue', label: `${label} End`, type: isColor ? 'vec3' : 'float', default: isColor ? [ev, ev, ev] : ev },
    ] as never
    registerModule({ kind: 'operator', name: 'alphachange', label: 'Alpha Change（乘数）', params: changeParams('Alpha ×', 1, 0) })
    registerModule({ kind: 'operator', name: 'sizechange', label: 'Size Change（乘数）', params: changeParams('Size ×', 1, 0) })
    registerModule({ kind: 'operator', name: 'colorchange', label: 'Color Change（乘数）', params: changeParams('Color ×', 1, 0, true) })
    const oscillateParams = (vec = false, scaleDefaults: [number, number] = [0, 1]) => [
        { key: 'frequencymin', label: 'Freq Min', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 0 },
        { key: 'frequencymax', label: 'Freq Max', type: vec ? 'vec3' : 'float', default: vec ? [5, 5, 5] : 10 },
        { key: 'scalemin', label: 'Scale Min', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : scaleDefaults[0] },
        { key: 'scalemax', label: 'Scale Max', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : scaleDefaults[1] },
        { key: 'phasemin', label: 'Phase Min', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 0 },
        { key: 'phasemax', label: 'Phase Max', type: vec ? 'vec3' : 'float', default: vec ? [0, 0, 0] : 6.283 },
        ...vec ? [{ key: 'mask', label: 'Mask', type: 'vec3', default: [1, 1, 1] }] : [],
    ] as never
    registerModule({
        kind:   'operator',
        name:   'oscillatealpha',
        label:  'Oscillate Alpha',
        params: [
            ...oscillateParams(),
            { key: 'blendinstart', label: 'Blend In Start', type: 'float', default: 0 },
            { key: 'blendinend', label: 'Blend In End', type: 'float', default: 0 },
        ] as never,
    })
    registerModule({ kind: 'operator', name: 'oscillatesize', label: 'Oscillate Size', params: oscillateParams(false, [0.8, 1.2]) })
    registerModule({ kind: 'operator', name: 'oscillateposition', label: 'Oscillate Position', params: oscillateParams(true) })
    registerModule({
        kind:        'operator',
        name:        'turbulence',
        label:       'Turbulence',
        description: 'Curl noise 流场扰动',
        params:      [
            { key: 'phasemin', label: 'Phase Min', type: 'float', default: 0 },
            { key: 'phasemax', label: 'Phase Max', type: 'float', default: 0 },
            { key: 'speedmin', label: 'Speed Min', type: 'float', default: 500 },
            { key: 'speedmax', label: 'Speed Max', type: 'float', default: 1000 },
            { key: 'timescale', label: 'Time Scale', type: 'float', default: 20 },
            { key: 'scale', label: 'Noise Scale', type: 'float', default: 0.01 },
            { key: 'mask', label: 'Mask', type: 'vec3', default: [1, 1, 1] },
        ],
    })
    registerModule({
        kind:        'operator',
        name:        'vortex',
        label:       'Vortex',
        description: '绕控制点轴的切向力场（轴/offset 受控制点角度旋转）',
        params:      [
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0 },
            { key: 'axis', label: 'Axis', type: 'vec3', default: [0, 0, 1] },
            { key: 'offset', label: 'Offset', type: 'vec3', default: [0, 0, 0] },
            { key: 'ringradius', label: 'Ring Radius', type: 'float', default: 0 },
            { key: 'ringwidth', label: 'Ring Width', type: 'float', default: 0 },
            { key: 'ringpulldistance', label: 'Ring Pull', type: 'float', default: 0 },
            { key: 'distanceinner', label: 'Distance Inner', type: 'float', default: 10 },
            { key: 'distanceouter', label: 'Distance Outer', type: 'float', default: 100 },
            { key: 'speedinner', label: 'Speed Inner', type: 'float', default: 100 },
            { key: 'speedouter', label: 'Speed Outer', type: 'float', default: 100 },
            { key: 'flags', label: 'Flags', type: 'int', default: 0 },
        ],
    })
    registerModule({
        kind:        'operator',
        name:        'vortex_v2',
        label:       'Vortex V2',
        description: 'WE v2 涡旋（环拉力 + 切向速度替换；与 vortex 同一 GPU 路径）',
        params:      [
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0 },
            { key: 'axis', label: 'Axis', type: 'vec3', default: [0, 0, 1] },
            { key: 'offset', label: 'Offset', type: 'vec3', default: [0, 0, 0] },
            { key: 'distanceinner', label: 'Distance Inner', type: 'float', default: 0 },
            { key: 'distanceouter', label: 'Distance Outer', type: 'float', default: 1 },
            { key: 'speedinner', label: 'Speed Inner', type: 'float', default: 0 },
            { key: 'speedouter', label: 'Speed Outer', type: 'float', default: 100 },
            { key: 'ringradius', label: 'Ring Radius', type: 'float', default: 0 },
            { key: 'ringwidth', label: 'Ring Width', type: 'float', default: 0 },
            { key: 'ringpulldistance', label: 'Ring Pull', type: 'float', default: 0 },
            { key: 'fadeintime', label: 'Fade In', type: 'float', default: 0 },
            { key: 'fadeouttime', label: 'Fade Out', type: 'float', default: 0 },
            { key: 'flags', label: 'Flags', type: 'int', default: 0 },
        ],
    })
    registerModule({
        kind:   'operator',
        name:   'maintaindistancetocontrolpoint',
        label:  'Maintain Distance To CP',
        params: [
            { key: 'controlpoint', label: 'Control Point', type: 'int', default: 0 },
            { key: 'distance', label: 'Distance', type: 'float', default: 256 },
            { key: 'variablestrength', label: 'Variable Strength', type: 'float', default: 0 },
        ],
    })
    registerModule({
        kind:   'operator',
        name:   'boids',
        label:  'Boids',
        params: [
            { key: 'neighborthreshold', label: 'Neighbor Threshold', type: 'float', default: 100 },
            { key: 'separationfactor', label: 'Separation', type: 'float', default: 1 },
            { key: 'alignmentfactor', label: 'Alignment', type: 'float', default: 1 },
            { key: 'cohesionfactor', label: 'Cohesion', type: 'float', default: 1 },
            { key: 'flags', label: 'Flags', type: 'int', default: 0 },
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
            { key: 'flags', label: 'Flags', type: 'int', default: 0 },
        ],
    })

    // ---------- renderers ----------
    registerModule({
        kind:   'renderer',
        name:   'sprite',
        label:  'Sprite',
        params: [
            { key: 'axis', label: 'Axis', type: 'vec3', default: [0, 0, 1] },
            { key: 'orientation', label: 'Orientation', type: 'int', default: 0 },
        ],
    })
    registerModule({
        kind:   'renderer',
        name:   'spritetrail',
        label:  'Sprite Trail',
        params: [
            { key: 'length', label: 'Length', type: 'float', default: 0.05 },
            { key: 'maxlength', label: 'Max Length', type: 'float', default: 10 },
            { key: 'minlength', label: 'Min Length', type: 'float', default: 0 },
        ],
    })
    registerModule({
        kind:   'renderer',
        name:   'rope',
        label:  'Rope',
        params: [
            { key: 'length', label: 'Length', type: 'float', default: 1 },
            { key: 'uvscale', label: 'UV Scale', type: 'float', default: 1 },
            { key: 'uvscrolling', label: 'UV Scrolling', type: 'float', default: 0 },
            { key: 'uvsmoothing', label: 'UV Smoothing', type: 'float', default: 1 },
        ],
    })
    registerModule({
        kind:   'renderer',
        name:   'ropetrail',
        label:  'Rope Trail',
        params: [
            { key: 'length', label: 'Length（拖尾时长·秒）', type: 'float', default: 0.05 },
            { key: 'segments', label: 'Segments', type: 'int', default: 8 },
            { key: 'fadealpha', label: 'Fade Alpha', type: 'float', default: 1 },
            { key: 'uvscale', label: 'UV Scale', type: 'float', default: 1 },
            { key: 'uvscrolling', label: 'UV Scrolling', type: 'float', default: 0 },
        ],
    })
}

registerBuiltins()

/** WE colorBlendMode 编号 → 名称（与 shader applyBlend 一致；0 = 无）。 */
export const COLOR_BLEND_MODES: { value: number, label: string }[] = [
    { value: 0, label: '无（None）' },
    { value: 1, label: 'Darken 变暗' },
    { value: 2, label: 'Multiply 正片叠底' },
    { value: 3, label: 'Color Burn 颜色加深' },
    { value: 4, label: 'Linear Burn 线性加深' },
    { value: 5, label: 'Darker Color 深色' },
    { value: 6, label: 'Lighten 变亮' },
    { value: 7, label: 'Screen 滤色' },
    { value: 8, label: 'Color Dodge 颜色减淡' },
    { value: 9, label: 'Linear Dodge 线性减淡' },
    { value: 10, label: 'Lighter Color 浅色' },
    { value: 11, label: 'Overlay 叠加' },
    { value: 12, label: 'Soft Light 柔光' },
    { value: 13, label: 'Hard Light 强光' },
    { value: 14, label: 'Vivid Light 亮光' },
    { value: 15, label: 'Linear Light 线性光' },
    { value: 16, label: 'Pin Light 点光' },
    { value: 17, label: 'Hard Mix 实色混合' },
    { value: 18, label: 'Difference 差值' },
    { value: 19, label: 'Exclusion 排除' },
    { value: 20, label: 'Subtract 减去' },
    { value: 21, label: 'Reflect' },
    { value: 22, label: 'Glow' },
    { value: 23, label: 'Phoenix' },
    { value: 24, label: 'Average' },
    { value: 25, label: 'Negation' },
    { value: 26, label: 'Hue 色相' },
    { value: 27, label: 'Saturation 饱和度' },
    { value: 28, label: 'Color 颜色' },
    { value: 29, label: 'Luminosity 明度' },
    { value: 30, label: 'Tint' },
    { value: 31, label: 'A+B（附加）' },
]
