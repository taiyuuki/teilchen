/**
 * teilchen core — 粒子系统数据模型。
 *
 * 字段命名严格对齐 Wallpaper Engine 的 particle JSON schema，
 * 以便与官方 .pkg 中的 particles/*.json 互相导入导出。
 */

export type Vec3 = [number, number, number]

/** 模块（emitter/initializer/operator/renderer 之一）的参数值。 */
export type ParamValue = Vec3 | boolean | number | string

/** 一个具体模块实例：名字 + 扁平参数（与 WE JSON 同构，便于 round-trip）。 */
export interface ParticleModule {

    /** 注册表中的模块名，如 "boxrandom"、"movement"。 */
    name:          string;
    [key: string]: ParamValue | string | undefined;
}

export type BlendMode = 'additive' | 'alphatocoverage' | 'disabled' | 'normal' | 'translucent'

export interface MaterialDef {

    /** WE 材质 json 的 passes[0].blending。 */
    blending: BlendMode;

    /** WE 材质 json 的 passes[0].textures（贴图路径列表，第 0 张为粒子 sprite）。 */
    textures:   string[];
    depthTest:  boolean;
    depthWrite: boolean;
}

export interface ControlPointDef {
    id:            number;
    flags:         number;
    offset:        Vec3;
    lockToPointer: boolean;
}

export type SpawnType = 'eventdeath' | 'eventfollow' | 'eventspawn' | 'static'

export interface ChildDef {
    name:                   string;
    type:                   SpawnType;
    maxCount:               number;
    controlPointStartIndex: number;
    probability:            number;
    origin:                 Vec3;
    scale:                  Vec3;
    angles:                 Vec3;
}

export type RendererKind = 'rope' | 'ropetrail' | 'sprite' | 'spritetrail'

export interface RendererDef extends ParticleModule {

    /** 允许未知渲染器名（保留 round-trip；runtime 对未实现项告警跳过）。 */
    name:         string;
    length?:      number;
    maxLength?:   number;
    segments?:    number;
    subdivision?: number;
}

/** 粒子系统定义（对应 WE 的一份 particles/xxx.json + 所属层的 material 引用）。 */
export interface ParticleSystemDef {
    name:     string;
    material: MaterialDef;
    maxCount: number;

    /** > 0 时表示预热秒数（WE starttime，编辑器里显示为已播放时间）。 */
    startTime:          number;
    animationMode:      'randomframe' | 'sequence';
    sequenceMultiplier: number;

    /** WE flags 位掩码：1=worldspace, 2=spritenoframeblending, 4=perspective, 8..128=禁用各类 override。 */
    flags: number;

    emitters:     ParticleModule[];
    initializers: ParticleModule[];
    operators:    ParticleModule[];
    renderers:    RendererDef[];

    /** 固定 8 个（WE 硬编码）。 */
    controlPoints: ControlPointDef[];
    children:      ChildDef[];

    /** 层变换（对应 scene.json 里 particle 对象的 origin/scale/angles）。 */
    origin: Vec3;
    scale:  Vec3;
    angles: Vec3;
}

export const MAX_CONTROL_POINTS = 8

export function defaultMaterial(): MaterialDef {
    return { blending: 'additive', textures: [], depthTest: false, depthWrite: false }
}

export function defaultControlPoints(): ControlPointDef[] {
    return Array.from({ length: MAX_CONTROL_POINTS }, (_, i) => ({
        id:            i,
        flags:         0,
        offset:        [0, 0, 0],
        lockToPointer: false,
    }))
}

export function defaultSystem(name = 'system'): ParticleSystemDef {
    return {
        name,
        material:           defaultMaterial(),
        maxCount:           20000,
        startTime:          0,
        animationMode:      'sequence',
        sequenceMultiplier: 1,
        flags:              0,
        emitters:           [],
        initializers:       [],
        operators:          [],
        renderers:          [{ name: 'sprite' }],
        controlPoints:      defaultControlPoints(),
        children:           [],
        origin:             [0, 0, 0],
        scale:              [1, 1, 1],
        angles:             [0, 0, 0],
    }
}
