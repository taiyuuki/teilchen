/**
 * GPU 侧数据布局 —— TS 与 WGSL 共享的常量。
 * 所有结构体按 16 字节对齐设计，TS 写入端必须与 simulate.wgsl 中的声明严格一致。
 */

export const MAX_EMITTERS = 4
export const MAX_INITIALIZERS = 16
export const MAX_OPERATORS = 16

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
export const PROGRAM_BUFFER_SIZE = COUNTS_OFFSET + 16 // 3024

// ---- 计数器（sysBuffer，原子区；4 atomic + 3×vec4 + 1×vec4 padding = 80B） ----
export const SYS_BUFFER_SIZE = 80

// ---- 每系统 uniform（每帧更新：origin/pointer/controlpoints） ----
export const SYS_UNIFORM_SIZE = 16 + 16 + 8 * 16 // 160

// ---- Frame uniform（全局） ----
export const FRAME_UNIFORM_SIZE = 16 // time, dt, resX, resY

// ---- draw indirect ----
export const INDIRECT_SIZE = 16 // vertexCount, instanceCount, firstVertex, firstInstance

/** 粒子容量上限（128B/粒子 × 500k = 64MB，低于默认 maxStorageBufferBindingSize）。 */
export const MAX_CAPACITY = 500_000

// ---- 模块 kind 枚举（与 WGSL switch 一致） ----
export const EmitterKind = { BoxRandom: 0, SphereRandom: 1 } as const

export const InitializerKind = {
    LifetimeRandom:        0,
    SizeRandom:            1,
    AlphaRandom:           2,
    ColorRandom:           3,
    VelocityRandom:        4,
    RotationRandom:        5,
    AngularVelocityRandom: 6,
} as const

export const OperatorKind = {
    Movement:            0,
    AngularMovement:     1,
    AlphaFade:           2,
    AlphaChange:         3,
    SizeChange:          4,
    ColorChange:         5,
    OscillateAlpha:      6,
    OscillateSize:       7,
    OscillatePosition:   8,
    Turbulence:          9,
    Vortex:              10,
    ControlPointAttract: 11,
} as const
