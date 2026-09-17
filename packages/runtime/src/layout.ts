/**
 * GPU 侧数据布局 —— TS 与 WGSL 共享的常量。
 * 所有结构体按 16 字节对齐设计，TS 写入端必须与 simulate.wgsl 中的声明严格一致。
 */

export const MAX_EMITTERS = 4
export const MAX_INITIALIZERS = 16
export const MAX_OPERATORS = 16
export const MAX_CHILDREN = 4

/** 每帧 spawn 线程上限（工作 组数 × 64）。覆盖 rate ≤ 6 万/秒 @60fps。 */
export const SPAWN_WORKGROUPS = 16
export const SPAWN_THREADS = SPAWN_WORKGROUPS * 64

export const WORKGROUP_SIZE = 64

/** 粒子槽位无效标记。 */
export const SLOT_INVALID = 0xffffffff

// ---- Program buffer（只读数据表，编译期一次性写入） ----
export const EMITTER_STRIDE = 112 // 字节：vec4u + 6×vec4f
export const INITIALIZER_STRIDE = 48 // u32×4 + 2×vec4f
export const OPERATOR_STRIDE = 112 // u32×4 + 6×vec4f

export const EMITTERS_OFFSET = 0
export const INITIALIZERS_OFFSET = EMITTERS_OFFSET + MAX_EMITTERS * EMITTER_STRIDE // 448
export const OPERATORS_OFFSET = INITIALIZERS_OFFSET + MAX_INITIALIZERS * INITIALIZER_STRIDE // 1216
export const COUNTS_OFFSET = OPERATORS_OFFSET + MAX_OPERATORS * OPERATOR_STRIDE // 3008
// children 描述表（4×vec4u）+ childMeta（count/isChild/instanceCap/burstCap）
export const CHILDREN_OFFSET = COUNTS_OFFSET + 16 // 3024
/** 父侧 children 描述表（每 child 2×vec4u）+ 子侧元数据（2×vec4）。 */
export const CHILD_META_OFFSET = CHILDREN_OFFSET + MAX_CHILDREN * 32 // 3152
/** 渲染器信息（2×vec4）：R0 = (mode, segments, 0, 0) u32；R1 = (length, maxlength, interval, 0) f32。 */
export const RENDERER_OFFSET = CHILD_META_OFFSET + 32 // 3184
export const PROGRAM_BUFFER_SIZE = RENDERER_OFFSET + 32 // 3216

// ---- 计数器（sysBuffer，原子区；80B 基础 + eventCount/instFreeCount = 96B） ----
export const SYS_BUFFER_SIZE = 96

// ---- 每系统 uniform（每帧更新：origin/pointer/controlpoints + mode） ----
export const SYS_UNIFORM_SIZE = 16 + 16 + 8 * 16 + 16 // 176

// ---- Frame uniform（全局） ----
// time/dt/res(vec4) + vp 矩阵(64) + eye.xyz/focal(16) + camRight.xyz/persp(16) + camUp.xyz(16)
export const FRAME_UNIFORM_SIZE = 144

// ---- draw indirect ----
export const INDIRECT_SIZE = 16 // vertexCount, instanceCount, firstVertex, firstInstance

/** 粒子容量上限（128B/粒子 × 500k = 64MB，低于默认 maxStorageBufferBindingSize）。 */
export const MAX_CAPACITY = 500_000

// ---- children（父子粒子系统） ----
/** 每系统事件缓冲容量（父粒子 spawn/death 事件）。 */
export const MAX_EVENTS = 4096

/** ChildInstance 32B：posAge vec4f + meta vec4u + emitted vec4u。 */
export const INSTANCE_STRIDE = 32

/** 每实例每帧发射线程预算。 */
export const INSTANCE_SPAWN_THREADS = 64

/** 事件处理 pass 的工作组数（MAX_EVENTS / 64）。 */
export const MAX_WORKGROUPS_FOR_EVENTS = MAX_EVENTS / 64

/** 实例槽位无效标记。 */
export const INSTANCE_INVALID = 0xffffffff

// ---- trail/rope 渲染器 ----
/** 每粒子历史采样点数上限（WE segments 默认 8，上限 256；v1 取 64 并作 stride）。 */
export const MAX_TRAIL_SEGMENTS = 64

/** sprite 动画 + 渲染器参数 uniform（render 侧）。 */
export const MAX_SPRITE_FRAMES = 128

/** params vec4u + anim vec4f + 每帧 2×vec4f + renderer vec4f + blend vec4f。 */
export const SPRITE_UNIFORM_SIZE = 32 + MAX_SPRITE_FRAMES * 2 * 16 + 32

// ---- 模块 kind 枚举（与 WGSL switch 一致） ----
export const EmitterKind = { BoxRandom: 0, SphereRandom: 1 } as const

export const InitializerKind = {
    LifetimeRandom:            0,
    SizeRandom:                1,
    AlphaRandom:               2,
    ColorRandom:               3,
    VelocityRandom:            4,
    RotationRandom:            5,
    AngularVelocityRandom:     6,
    TurbulentVelocityRandom:   7,
    HsvColorRandom:            8,
    MapSequenceBetweenCPs:     9,
    MapSequenceAroundCP:       10,
} as const

export const OperatorKind = {
    Movement:             0,
    AngularMovement:      1,
    AlphaFade:            2,
    AlphaChange:          3,
    SizeChange:           4,
    ColorChange:          5,
    OscillateAlpha:       6,
    OscillateSize:        7,
    OscillatePosition:    8,
    Turbulence:              9,
    Vortex:                  10,
    ControlPointAttract:     11,
    MaintainDistanceToCP:    12,
    Boids:                   13,
} as const

/** 子粒子系统类型（与 WGSL/ChildDesc 一致）。 */
export const ChildType = { Static: 0, EventDeath: 1, EventSpawn: 2, EventFollow: 3 } as const

/** 渲染器模式（与 WGSL/billboard 分支一致）。 */
export const RendererMode = { Sprite: 0, SpriteTrail: 1, RopeTrail: 2, Rope: 3 } as const
