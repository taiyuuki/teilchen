/**
 * 编辑器 i18n：轻量 reactive 方案，不引第三方库。
 * locale 挂在 reactive 上，t() 在渲染中调用即随 locale 切换刷新；
 * 持久化到 localStorage，首次进入跟随浏览器语言。
 * core 注册表的模块描述/混合中英标签不做侵入式改造，en 侧用 SPEC_EN 覆盖层翻译。
 */
import { reactive } from 'vue'
import type { ModuleKind, ParamSpec } from '@teilchen/core'

export type Locale = 'en' | 'zh'

const STORAGE_KEY = 'teilchen.locale.v1'

function initialLocale(): Locale {
    try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved === 'zh' || saved === 'en') return saved
    }
    catch { /* 隐私模式等存取异常忽略 */ }

    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const i18n = reactive({ locale: initialLocale() })

export function setLocale(locale: Locale): void {
    i18n.locale = locale
    try { localStorage.setItem(STORAGE_KEY, locale) }
    catch { /* 忽略 */ }
}

const messages: Record<Locale, Record<string, string>> = {
    zh: {

        // 工具栏
        'toolbar.presets':             '预设…',
        'toolbar.groupProgram':        '程序预设',
        'toolbar.groupWe':             'WE 预设',
        'toolbar.import':              '导入 WE JSON',
        'toolbar.export':              '导出',
        'toolbar.texHalo':             '贴图：halo',
        'toolbar.texWhite':            '贴图：white',
        'toolbar.texUpload':           '贴图：上传图片…',
        'toolbar.texImport':           '贴图：导入 .tex（WE）…',

        // 预设
        'preset.fountain':             'fountain',
        'preset.galaxy':               'galaxy',
        'preset.snow':                 'snow',
        'preset.cursor-avoid':         'cursor avoid',
        'preset.empty':                '空白系统',
        'we.magic_vortex_orb':         'magic vortex orb · 控制点/涡旋/拖尾',
        'we.fireworks2':               'fireworks · 子粒子/事件',
        'we.fireflies':                'fireflies · 湍流/振荡',
        'we.dripping_water':           'dripping water · ropetrail/折射',
        'we.bubbles1':                 'bubbles · 半透明基础',
        'we.dna':                      'dna · 涡旋/变色',

        // 左侧树
        'sec.emitter':                 '发射器',
        'sec.initializer':             '初始化器',
        'sec.operator':                '操作符',
        'sec.renderer':                '渲染器',
        'add.emitter':                 '+ 添加发射器…',
        'add.initializer':             '+ 添加初始化器…',
        'add.operator':                '+ 添加操作符…',
        'add.renderer':                '+ 添加渲染器…',
        'tree.controlPoints':          '控制点',
        'tree.unimplementedSuffix':    '（未实现）',
        'badge.unimplemented':         '未实现',
        'badge.unimplementedTip':      'GPU 未实现，将跳过',
        'badge.idle':                  '空闲',
        'badge.idleTip':               '未被引用且无偏移/角度',
        'badge.notLoaded':             '未加载',
        'badge.notLoadedTip':          '子定义未加载（本地 /we 资产缺失）',
        'action.delete':               '删除',

        // 时间栏
        'timeline.step':               '单步',
        'timeline.reset':              '重置',
        'timeline.showAllCps':         '全部控制点',
        'timeline.showAllCpsTip':      '关闭时只显示被引用/有偏移/锁定的控制点',

        // 属性面板：系统
        'panel.system':                '系统',
        'panel.name':                  '名称',
        'panel.maxCount':              '最大数量',
        'panel.startTime':             '预热时间',
        'panel.animationMode':         '动画模式',
        'panel.animationModeTip':      'WE animationmode：序列播放或随机帧',
        'anim.sequence':               'sequence 序列',
        'anim.randomframe':            'randomframe 随机帧',
        'panel.sequenceMultiplier':    '序列倍率',
        'panel.sequenceMultiplierTip': 'WE sequencemultiplier：序列播放速率倍数',
        'panel.blending':              '混合',
        'panel.colorBlending':         '颜色混合',
        'panel.colorBlendingTip':      '颜色混合 BlendMode（colorBlendMode）',
        'panel.origin':                '原点',
        'panel.systemTip':             '控制点在左侧树「控制点」一栏选择编辑',

        // 属性面板：控制点
        'panel.controlPoint':          '控制点',
        'panel.cpTip':                 'lock = 跟随鼠标（WE locktopointer）；角度 = WE「控制点角度」（°，ZYX），旋转 vortex 轴/attract 原点；自转 = 角度进动速度（°/s，预览扩展）',
        'panel.referencedBy':          '引用：{usage}',
        'panel.notReferenced':         '未被任何模块引用',
        'panel.lockMouse':             '锁定鼠标',
        'panel.followPointer':         '跟随指针（locktopointer）',
        'panel.offset':                '偏移',
        'panel.angles':                '角度',
        'panel.anglesTip':             '控制点角度（°，ZYX 欧拉）——旋转 vortex 轴/attract 原点',
        'panel.spin':                  '自转',
        'panel.spinTip':               '角度自转速度（°/s）——线性进动，对应 WE controlpointangle 动画轨道',

        // 属性面板：child
        'panel.childTip':              '子系统声明（WE children 项）；子定义作为独立资产，点下方按钮载入编辑器单独修改与导出。',
        'panel.openChild':             '在编辑器中打开（独立编辑）',
        'panel.childSummary':          '子定义概要',
        'panel.type':                  '类型',
        'panel.probability':           '出现概率',
        'panel.cpStart':               '控制点起始',
        'panel.scale':                 '缩放',
        'panel.maxCountTip':           'event 类实例数上限',

        // 属性面板：模块
        'kind.emitter':                '发射器',
        'kind.initializer':            '初始化器',
        'kind.operator':               '操作符',
        'kind.renderer':               '渲染器',
        'panel.properties':            '属性',
        'panel.unregistered':          '未注册的模块 "{name}"：字段保留（兼容 WE round-trip），但无参数面板。',
        'param.tip':                   '{label}（{key}）',

        // 警告
        'warn.wePresetUnavailable':    'WE 预设 {file} 不可用（需要 dev 模式的 /we 资产托管）',
        'warn.wePresetFailed':         'WE 预设 {file} 加载失败: {msg}',
        'warn.texDescFailed':          '.tex.json 描述解析失败: {msg}，按默认通道语义',
        'warn.texFailed':              '.tex 解析失败: {msg}',
        'warn.texLoadFailed':          '贴图 {tex} 加载失败: {msg}',

        // 通用
        'sep': '、',
    },
    en: {

        // toolbar
        'toolbar.presets':             'Presets…',
        'toolbar.groupProgram':        'Built-in presets',
        'toolbar.groupWe':             'WE presets',
        'toolbar.import':              'Import WE JSON',
        'toolbar.export':              'Export',
        'toolbar.texHalo':             'Texture: halo',
        'toolbar.texWhite':            'Texture: white',
        'toolbar.texUpload':           'Texture: upload image…',
        'toolbar.texImport':           'Texture: import .tex (WE)…',

        // presets
        'preset.fountain':             'fountain',
        'preset.galaxy':               'galaxy',
        'preset.snow':                 'snow',
        'preset.cursor-avoid':         'cursor avoid',
        'preset.empty':                'Empty system',
        'we.magic_vortex_orb':         'magic vortex orb · control points/vortex/trail',
        'we.fireworks2':               'fireworks · child particles/events',
        'we.fireflies':                'fireflies · turbulence/oscillation',
        'we.dripping_water':           'dripping water · ropetrail/refraction',
        'we.bubbles1':                 'bubbles · translucent basics',
        'we.dna':                      'dna · vortex/color shift',

        // module tree
        'sec.emitter':                 'Emitters',
        'sec.initializer':             'Initializers',
        'sec.operator':                'Operators',
        'sec.renderer':                'Renderers',
        'add.emitter':                 '+ Add emitter…',
        'add.initializer':             '+ Add initializer…',
        'add.operator':                '+ Add operator…',
        'add.renderer':                '+ Add renderer…',
        'tree.controlPoints':          'Control Points',
        'tree.unimplementedSuffix':    ' (not implemented)',
        'badge.unimplemented':         'N/A',
        'badge.unimplementedTip':      'Not GPU-implemented, will be skipped',
        'badge.idle':                  'idle',
        'badge.idleTip':               'Not referenced, no offset/angles',
        'badge.notLoaded':             'not loaded',
        'badge.notLoadedTip':          'Child definition not loaded (local /we assets missing)',
        'action.delete':               'Delete',

        // timeline
        'timeline.step':               'Step',
        'timeline.reset':              'Reset',
        'timeline.showAllCps':         'All control points',
        'timeline.showAllCpsTip':      'When off, only referenced/offset/locked control points are shown',

        // property panel: system
        'panel.system':                'System',
        'panel.name':                  'Name',
        'panel.maxCount':              'Max Count',
        'panel.startTime':             'Start Time (warmup)',
        'panel.animationMode':         'Animation Mode',
        'panel.animationModeTip':      'WE animationmode: sequence playback or random frame',
        'anim.sequence':               'sequence',
        'anim.randomframe':            'random frame',
        'panel.sequenceMultiplier':    'Sequence Multiplier',
        'panel.sequenceMultiplierTip': 'WE sequencemultiplier: sequence playback rate multiplier',
        'panel.blending':              'Blending',
        'panel.colorBlending':         'Color Blending',
        'panel.colorBlendingTip':      'Color blend mode (colorBlendMode)',
        'panel.origin':                'Origin',
        'panel.systemTip':             'Control points are edited in the "Control Points" section of the tree on the left',

        // property panel: control point
        'panel.controlPoint':          'Control Point',
        'panel.cpTip':                 'lock = follow the mouse (WE locktopointer); angles = WE control point angles (°, ZYX), rotating the vortex axis / attract origin; spin = angle precession speed (°/s, preview extension)',
        'panel.referencedBy':          'Referenced by: {usage}',
        'panel.notReferenced':         'Not referenced by any module',
        'panel.lockMouse':             'Lock to mouse',
        'panel.followPointer':         'Follow pointer (locktopointer)',
        'panel.offset':                'Offset',
        'panel.angles':                'Angles',
        'panel.anglesTip':             'Control point angles (°, ZYX Euler) — rotates the vortex axis / attract origin',
        'panel.spin':                  'Spin',
        'panel.spinTip':               'Angular spin speed (°/s) — linear precession, maps to the WE controlpointangle track',

        // property panel: child
        'panel.childTip':              'Child system declaration (WE children entry); the child definition is an independent asset — click the button below to load it into the editor for separate editing and export.',
        'panel.openChild':             'Open in editor (edit independently)',
        'panel.childSummary':          'Child definition summary',
        'panel.type':                  'Type',
        'panel.probability':           'Probability',
        'panel.cpStart':               'CP Start',
        'panel.scale':                 'Scale',
        'panel.maxCountTip':           'Max instances for event-type children',

        // property panel: module
        'kind.emitter':                'Emitter',
        'kind.initializer':            'Initializer',
        'kind.operator':               'Operator',
        'kind.renderer':               'Renderer',
        'panel.properties':            'Properties',
        'panel.unregistered':          'Unregistered module "{name}": fields are kept (WE round-trip compatible) but there is no parameter panel.',
        'param.tip':                   '{label} ({key})',

        // warnings
        'warn.wePresetUnavailable':    'WE preset {file} unavailable (requires the dev-mode /we asset hosting)',
        'warn.wePresetFailed':         'Failed to load WE preset {file}: {msg}',
        'warn.texDescFailed':          'Failed to parse .tex.json descriptor: {msg}; falling back to default channel semantics',
        'warn.texFailed':              'Failed to parse .tex: {msg}',
        'warn.texLoadFailed':          'Failed to load texture {tex}: {msg}',

        // common
        'sep': ', ',
    },
}

/** 取文案（缺失回退 zh，再回退 key 本身）；params 替换 {name} 占位。 */
export function t(key: string, params?: Record<string, number | string>): string {
    let s = messages[i18n.locale][key] ?? messages.zh[key] ?? key
    if (params) {
        for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v))
    }

    return s
}

// ---------------------------------------------------------------- core 注册表文案（en/zh 覆盖层）

/** zh 下的模块名（添加模块下拉）；en 剔除标签里的中文。key = `${kind}:${name}`。 */
const LABEL_ZH: Record<string, string> = {

    // emitters
    'emitter:boxrandom':                           '盒随机',
    'emitter:sphererandom':                        '球随机',

    // initializers
    'initializer:lifetimerandom':                  '随机生命周期',
    'initializer:sizerandom':                      '随机大小',
    'initializer:alpharandom':                     '随机透明度',
    'initializer:colorrandom':                     '随机颜色',
    'initializer:velocityrandom':                  '随机速度',
    'initializer:rotationrandom':                  '随机旋转',
    'initializer:angularvelocityrandom':           '随机角速度',
    'initializer:turbulentvelocityrandom':         '随机湍流速度',
    'initializer:hsvcolorrandom':                  'HSV 随机颜色',
    'initializer:mapsequencebetweencontrolpoints': '控制点间序列映射',
    'initializer:mapsequencearoundcontrolpoint':   '控制点环绕序列映射',

    // operators
    'operator:movement':                           '移动',
    'operator:angularmovement':                    '角运动',
    'operator:alphafade':                          '透明度淡入淡出',
    'operator:alphachange':                        '透明度变化（乘数）',
    'operator:sizechange':                         '大小变化（乘数）',
    'operator:colorchange':                        '颜色变化（乘数）',
    'operator:oscillatealpha':                     '透明度振荡',
    'operator:oscillatesize':                      '大小振荡',
    'operator:oscillateposition':                  '位置振荡',
    'operator:turbulence':                         '湍流',
    'operator:vortex':                             '涡旋',
    'operator:vortex_v2':                          '涡旋 V2',
    'operator:maintaindistancetocontrolpoint':     '保持控制点距离',
    'operator:boids':                              '群集（Boids）',
    'operator:controlpointattract':                '控制点吸引',

    // renderers
    'renderer:sprite':                             '精灵',
    'renderer:spritetrail':                        '精灵拖尾',
    'renderer:rope':                               '绳索',
    'renderer:ropetrail':                          '绳索拖尾',
}

/** zh 下的参数标签：按参数 key 的通用表（同名 key 各模块含义一致）。 */
const PARAM_ZH: Record<string, string> = {
    rate:               '速率',
    origin:             '原点',
    directions:         '方向',
    distancemin:        '最小距离',
    distancemax:        '最大距离',
    speedmin:           '最小速度',
    speedmax:           '最大速度',
    sign:               '符号（0 保留 / ±1 强制）',
    instantaneous:      '瞬时发射',
    maxtoemitperperiod: '每周期上限',
    duration:           '持续时间',
    controlpoint:       '控制点',
    flags:              '标志位',
    cone:               '锥角',
    exponent:           '指数',
    min:                '最小值',
    max:                '最大值',
    huemin:             '最小色相',
    huemax:             '最大色相',
    saturationmin:      '最小饱和度',
    saturationmax:      '最大饱和度',
    valuemin:           '最小明度',
    valuemax:           '最大明度',
    count:              '数量',
    limitbehavior:      '上限行为',
    forward:            '前向',
    phasemax:           '最大相位',
    timescale:          '时间缩放',
    gravity:            '重力',
    drag:               '阻力',
    force:              '力',
    fadeintime:         '淡入时间',
    fadeouttime:        '淡出时间',
    starttime:          '开始时间（寿命进度）',
    endtime:            '结束时间（寿命进度）',
    frequencymin:       '最小频率',
    frequencymax:       '最大频率',
    scalemin:           '最小幅度',
    scalemax:           '最大幅度',
    phasemin:           '最小相位',
    mask:               '掩码',
    blendinstart:       '淡入开始',
    blendinend:         '淡入结束',
    axis:               '轴',
    offset:             '偏移',
    ringradius:         '环半径',
    ringwidth:          '环宽度',
    ringpulldistance:   '环拉力距离',
    distanceinner:      '内圈距离',
    distanceouter:      '外圈距离',
    speedinner:         '内圈速度',
    speedouter:         '外圈速度',
    distance:           '距离',
    variablestrength:   '可变强度',
    neighborthreshold:  '邻居阈值',
    separationfactor:   '分离',
    alignmentfactor:    '对齐',
    cohesionfactor:     '聚合',
    threshold:          '阈值',
    orientation:        '朝向',
    length:             '长度',
    maxlength:          '最大长度',
    minlength:          '最小长度',
    uvscale:            'UV 缩放',
    uvscrolling:        'UV 滚动',
    uvsmoothing:        'UV 平滑',
    segments:           '分段数',
    fadealpha:          '透明度衰减',
}

/** zh 下通用表不适用时的按模块覆盖；key = `${kind}:${name}.${paramKey}`。 */
const PARAM_ZH_OVERRIDE: Record<string, string> = {

    // sphererandom 的 distance 是半径
    'emitter:sphererandom.distancemin':                              '最小半径',
    'emitter:sphererandom.distancemax':                              '最大半径',

    // randomRange 生成的 min/max 按模块含义不同
    'initializer:lifetimerandom.min':                                '最小生命周期',
    'initializer:lifetimerandom.max':                                '最大生命周期',
    'initializer:sizerandom.min':                                    '最小大小',
    'initializer:sizerandom.max':                                    '最大大小',
    'initializer:alpharandom.min':                                   '最小透明度',
    'initializer:alpharandom.max':                                   '最大透明度',
    'initializer:colorrandom.min':                                   '最小颜色',
    'initializer:colorrandom.max':                                   '最大颜色',
    'initializer:turbulentvelocityrandom.scale':                     '锥角比例（0-1）',
    'initializer:turbulentvelocityrandom.offset':                    '偏移（绕 right 旋转）',
    'initializer:mapsequencebetweencontrolpoints.controlpointstart': '控制点起始',
    'initializer:mapsequencebetweencontrolpoints.controlpointend':   '控制点结束',
    'initializer:mapsequencearoundcontrolpoint.count':               '数量（圈数/扭转）',
    'initializer:mapsequencearoundcontrolpoint.bounds':              '范围（角度范围·圈）',

    // changeParams 的起止值按模块属性而异
    'operator:alphachange.startvalue':                               '透明度起始值',
    'operator:alphachange.endvalue':                                 '透明度结束值',
    'operator:sizechange.startvalue':                                '大小起始值',
    'operator:sizechange.endvalue':                                  '大小结束值',
    'operator:colorchange.startvalue':                               '颜色起始值',
    'operator:colorchange.endvalue':                                 '颜色结束值',

    // attract 的 scale 是力强度
    'operator:controlpointattract.scale': '强度',

    // 湍流的 scale 是噪声尺度
    'operator:turbulence.scale':                                     '噪声缩放',
    'renderer:ropetrail.length':                                     '长度（拖尾时长·秒）',
}

/** en 下的模块描述/参数标签覆盖（zh 直接用注册表源文案）；key = `${kind}:${name}`。 */
const SPEC_EN: Record<string, { desc?: string, params?: Record<string, string> }> = {
    'emitter:boxrandom': {
        desc:   'Random points inside a box; initial velocity is radial (along the position vector)',
        params: { sign: 'Sign' },
    },
    'emitter:sphererandom': {
        desc:   'Random-direction emission inside a sphere/disc (distancemin/max are radii)',
        params: { sign: 'Sign' },
    },
    'initializer:turbulentvelocityrandom':       { params: { scale: 'Cone Scale (0-1)', offset: 'Offset (around right)' } },
    'initializer:mapsequencearoundcontrolpoint': { params: { count: 'Count (turns)', bounds: 'Bounds (angle range, turns)' } },
    'operator:movement':                         { desc: 'Gravity + drag, semi-implicit Euler integration' },
    'operator:alphafade':                        { desc: 'Fade in/out at the start/end of lifetime (time is normalized lifetime progress 0-1)' },
    'operator:alphachange':                      { params: { starttime: 'Start Time (lifetime)', endtime: 'End Time (lifetime)' } },
    'operator:sizechange':                       { params: { starttime: 'Start Time (lifetime)', endtime: 'End Time (lifetime)' } },
    'operator:colorchange':                      { params: { starttime: 'Start Time (lifetime)', endtime: 'End Time (lifetime)' } },
    'operator:turbulence':                       { desc: 'Curl-noise flow field perturbation' },
    'operator:vortex':                           { desc: 'Tangential force field around the control point axis (axis/offset rotate with the control point angles)' },
    'operator:vortex_v2':                        { desc: 'WE v2 vortex (ring pull + tangential velocity replace; same GPU path as vortex)' },
    'operator:controlpointattract':              { desc: 'Control point repulsion/attraction (scale<0 pushes away from the point, scale>0 pulls toward it)' },
    'renderer:ropetrail':                        { params: { length: 'Length (seconds)' } },
}

/** 去掉标签里的中文部分（「Darken 变暗」→「Darken」；「无（None）」→「None」）。 */
function stripCjk(s: string): string {
    return s.replace(/[\u4e00-\u9fff]/g, '').replace(/[（）]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/** 模块名（添加下拉等）：zh 取覆盖表，en 剔除中文（如「Alpha Change（乘数）」→「Alpha Change」）。 */
export function moduleLabel(kind: ModuleKind, name: string, fallback: string): string {
    if (i18n.locale === 'zh') return LABEL_ZH[`${kind}:${name}`] ?? fallback

    return stripCjk(fallback)
}

/** 模块描述：en 优先取覆盖层（zh 用注册表源文案）。 */
export function moduleDescription(kind: ModuleKind, name: string, fallback?: string): string | undefined {
    if (i18n.locale !== 'en') return fallback

    return SPEC_EN[`${kind}:${name}`]?.desc ?? fallback
}

/** 参数标签：zh 走覆盖表/通用表；en 优先取覆盖层，否则剔除中文。 */
export function paramLabel(kind: ModuleKind, name: string, p: ParamSpec): string {
    if (i18n.locale === 'zh') {
        return PARAM_ZH_OVERRIDE[`${kind}:${name}.${p.key}`] ?? PARAM_ZH[p.key] ?? p.label
    }

    return SPEC_EN[`${kind}:${name}`]?.params?.[p.key] ?? stripCjk(p.label)
}

/** colorBlendMode 选项标签。 */
export function blendModeLabel(m: { value: number, label: string }): string {
    return i18n.locale === 'en' ? stripCjk(m.label) : m.label
}
