/**
 * 编译：ParticleSystemDef → GPU Program 表（Float32/Uint32 视图按 layout.ts 偏移写入）。
 * 未知/超出上限的模块跳过并记入 warnings。
 */
import type { ParticleModule, ParticleSystemDef, Vec3 } from '@teilchen/core'
import { getModuleSpec, normalizeModule } from '@teilchen/core'
import {
    CHILDREN_OFFSET,
    COUNTS_OFFSET,
    EMITTERS_OFFSET,
    EMITTER_STRIDE,
    EmitterKind,
    INITIALIZERS_OFFSET,
    INITIALIZER_STRIDE,
    InitializerKind,
    MAX_CHILDREN,
    MAX_EMITTERS,
    MAX_INITIALIZERS,
    MAX_OPERATORS,
    MAX_TRAIL_SEGMENTS,
    OPERATORS_OFFSET,
    OPERATOR_STRIDE,
    OperatorKind,
    PROGRAM_BUFFER_SIZE,
    RENDERER_OFFSET,
} from './layout.ts'

/** WE oscillate 系列的相位默认上界（弧度，参考实现 phasemax 默认 τ）。 */
const TAU = Math.PI * 2

export interface CompiledProgram {
    data:             Uint8Array;
    emitterCount:     number;
    initializerCount: number;
    operatorCount:    number;
    renderer:         CompiledRenderer;
    warnings:         string[];
}

type Params = Record<string, Vec3 | boolean | number>

export function compileProgram(def: ParticleSystemDef): CompiledProgram {
    const warnings: string[] = []
    const data = new Uint8Array(PROGRAM_BUFFER_SIZE)
    const f32 = new Float32Array(data.buffer)
    const u32 = new Uint32Array(data.buffer)

    // ---- emitters ----
    // EmitterGpu 布局：kindActive(0) rateDur(4) origin(8) distMin(12) distMax(16) dirSign(20) sign(24)
    let emitterCount = 0
    for (const raw of def.emitters) {
        if (emitterCount >= MAX_EMITTERS) {
            warnings.push(`emitter 超过 ${MAX_EMITTERS} 个，多余的被忽略`)
            break
        }
        const kind
            = raw.name === 'boxrandom' ? EmitterKind.BoxRandom : raw.name === 'sphererandom' ? EmitterKind.SphereRandom : -1
        if (kind < 0) {
            warnings.push(`不支持的 emitter "${raw.name}"（v1 仅 boxrandom/sphererandom）`)
            continue
        }
        const p = norm('emitter', raw, warnings)
        const flags = Math.trunc(num(p.flags)) || 0
        const cp = Math.trunc(num(p.controlpoint))
        const origin = vec(p.origin, [0, 0, 0])
        const distMin = vec(p.distancemin, [0, 0, 0])
        const distMax = vec(p.distancemax, [0, 0, 0])
        const dir = vec(p.directions, [1, 1, 1])
        const sign = vec(p.sign, [1, 1, 1])
        const o = EMITTERS_OFFSET / 4 + emitterCount * (EMITTER_STRIDE / 4)
        u32[o + 0] = kind
        u32[o + 1] = 1
        u32[o + 2] = flags & 1
        u32[o + 3] = Math.max(0, Math.trunc(num(p.instantaneous)))
        put4(f32, o + 4, num(p.rate), num(p.duration), num(p.speedmin), num(p.speedmax))
        put4(f32, o + 8, origin[0], origin[1], origin[2], cp) // w: controlpoint 索引（f32 存整数）
        put4(f32, o + 12, distMin[0], distMin[1], distMin[2], 0)
        put4(f32, o + 16, distMax[0], distMax[1], distMax[2], 0)
        put4(f32, o + 20, dir[0], dir[1], dir[2], 0)
        put4(f32, o + 24, sign[0], sign[1], sign[2], Math.trunc(num(p.maxtoemitperperiod)) || 0)
        emitterCount++
    }

    // ---- initializers ----
    let initializerCount = 0
    for (const raw of def.initializers) {
        if (initializerCount >= MAX_INITIALIZERS) {
            warnings.push(`initializer 超过 ${MAX_INITIALIZERS} 个`)
            break
        }
        const kindMap: Record<string, number> = {
            lifetimerandom:                  InitializerKind.LifetimeRandom,
            sizerandom:                      InitializerKind.SizeRandom,
            alpharandom:                     InitializerKind.AlphaRandom,
            colorrandom:                     InitializerKind.ColorRandom,
            velocityrandom:                  InitializerKind.VelocityRandom,
            rotationrandom:                  InitializerKind.RotationRandom,
            angularvelocityrandom:           InitializerKind.AngularVelocityRandom,
            turbulentvelocityrandom:         InitializerKind.TurbulentVelocityRandom,
            hsvcolorrandom:                  InitializerKind.HsvColorRandom,
            mapsequencebetweencontrolpoints: InitializerKind.MapSequenceBetweenCPs,
            mapsequencearoundcontrolpoint:   InitializerKind.MapSequenceAroundCP,
        }
        const kind = kindMap[raw.name]
        if (kind === undefined) {
            warnings.push(`不支持的 initializer "${raw.name}"，已跳过`)
            continue
        }
        const p = norm('initializer', raw, warnings)
        const o = INITIALIZERS_OFFSET / 4 + initializerCount * (INITIALIZER_STRIDE / 4)
        u32[o + 0] = kind
        if (kind === InitializerKind.ColorRandom) {
            const mn = vec(p.min, [255, 255, 255]).map(c => c / 255)
            const mx = vec(p.max, [255, 255, 255]).map(c => c / 255)
            put4(f32, o + 4, mn[0], mn[1], mn[2], num(p.exponent, 1))
            put4(f32, o + 8, mx[0], mx[1], mx[2], 0)
        }
        else if (
            kind === InitializerKind.VelocityRandom
            || kind === InitializerKind.RotationRandom
            || kind === InitializerKind.AngularVelocityRandom
        ) {
            const mn = vec(p.min, [0, 0, 0])
            const mx = vec(p.max, [0, 0, 0])
            put4(f32, o + 4, mn[0], mn[1], mn[2], num(p.exponent, 1))
            put4(f32, o + 8, mx[0], mx[1], mx[2], 0)
        }
        else if (kind === InitializerKind.TurbulentVelocityRandom) {

            // WE 语义：噪声方向钳制在 forward（默认 +Y 向上）周围 scale/2·π 的圆锥内，
            // 再绕 right（默认 +Z）旋转 offset，×speed 累加到初速度
            const fwd = vec(p.forward, [0, 1, 0])
            put4(f32, o + 4, num(p.speedmin, 0), num(p.speedmax, 100), num(p.scale, 0.2), num(p.offset, 0))
            put4(f32, o + 8, fwd[0], fwd[1], fwd[2], 0)
        }
        else if (kind === InitializerKind.HsvColorRandom) {

            // a=(huemin, huemax, satmin, satmax)  b=(valmin, valmax, -, -)
            put4(f32, o + 4, num(p.huemin, 0), num(p.huemax, 1), num(p.saturationmin, 1), num(p.saturationmax, 1))
            put4(f32, o + 8, num(p.valuemin, 1), num(p.valuemax, 1), 0, 0)
        }
        else if (kind === InitializerKind.MapSequenceBetweenCPs) {

            // 按 spawn 序号沿线段 cs→ce 布点：pos += (ce-cs) × fract(seq/count)
            put4(f32, o + 4, Math.trunc(num(p.controlpointstart)), Math.trunc(num(p.controlpointend, 1)), num(p.count, 100), 0)
            put4(f32, o + 8, 0, 0, 0, 0)
        }
        else if (kind === InitializerKind.MapSequenceAroundCP) {

            // 按 spawn 序号绕 cp 转角（axis 取主分量：0=x/1=y/2=z）；
            // bounds = 角度范围（圈，WE float[2] 默认 0..1）：angle = 2π·(b0 + seq/count·(b1-b0))
            const axis = vec(p.axis, [0, 1, 0])
            const main = axis[1] >= axis[0] && axis[1] >= axis[2] ? 1 : axis[0] >= axis[2] ? 0 : 2
            const bounds = vec(p.bounds, [0, 1, 0])
            put4(f32, o + 4, Math.trunc(num(p.controlpoint)), num(p.count, 100), main, bounds[0])
            put4(f32, o + 8, bounds[1], 0, 0, 0)
        }
        else {
            put4(f32, o + 4, num(p.min), num(p.max), num(p.exponent, 1), 0)
            put4(f32, o + 8, 0, 0, 0, 0)
        }
        initializerCount++
    }

    // ---- operators ----
    let operatorCount = 0
    for (const raw of def.operators) {
        if (operatorCount >= MAX_OPERATORS) {
            warnings.push(`operator 超过 ${MAX_OPERATORS} 个`)
            break
        }
        const kindMap: Record<string, number> = {
            movement:                       OperatorKind.Movement,
            angularmovement:                OperatorKind.AngularMovement,
            alphafade:                      OperatorKind.AlphaFade,
            alphachange:                    OperatorKind.AlphaChange,
            sizechange:                     OperatorKind.SizeChange,
            colorchange:                    OperatorKind.ColorChange,
            oscillatealpha:                 OperatorKind.OscillateAlpha,
            oscillatesize:                  OperatorKind.OscillateSize,
            oscillateposition:              OperatorKind.OscillatePosition,
            turbulence:                     OperatorKind.Turbulence,
            vortex:                         OperatorKind.Vortex,
            vortex_v2:                      OperatorKind.Vortex,
            controlpointattract:            OperatorKind.ControlPointAttract,
            maintaindistancetocontrolpoint: OperatorKind.MaintainDistanceToCP,
            boids:                          OperatorKind.Boids,
        }
        const kind = kindMap[raw.name]
        if (kind === undefined) {
            warnings.push(`不支持的 operator "${raw.name}"，已跳过`)
            continue
        }
        if (raw.name === 'boids' && def.maxCount > 256) {
            warnings.push(`operator "boids"：容量 ${def.maxCount} 过大（O(N²) 邻居搜索限 256），已跳过`)
            continue
        }
        const p = norm('operator', raw, warnings)
        const o = OPERATORS_OFFSET / 4 + operatorCount * (OPERATOR_STRIDE / 4)
        u32[o + 0] = kind
        const a = o + 4,
            b = o + 8,
            c = o + 12,
            d = o + 16,
            e = o + 20,
            f = o + 24
        switch (kind) {
            case OperatorKind.Movement: {
                const g = vec(p.gravity, [0, 0, 0])
                put4(f32, a, g[0], g[1], g[2], num(p.drag))
                break
            }
            case OperatorKind.AngularMovement: {
                const fo = vec(p.force, [0, 0, 0])
                put4(f32, a, fo[0], fo[1], fo[2], num(p.drag))
                break
            }
            case OperatorKind.AlphaFade:

                // WE：fadeintime/fadeouttime 为寿命归一化进度 [0,1]（默认各 0.5）
                put4(f32, a, num(p.fadeintime, 0.5), num(p.fadeouttime, 0.5), 0, 0)
                break
            case OperatorKind.AlphaChange:
            case OperatorKind.SizeChange:

                // WE ValueChange 默认：starttime 0 / endtime 1 / startvalue 1 / endvalue 0
                put4(f32, a, num(p.starttime), num(p.endtime, 1), num(p.startvalue, 1), num(p.endvalue))
                break
            case OperatorKind.ColorChange: {
                const sv = vec(p.startvalue, [1, 1, 1])
                const ev = vec(p.endvalue, [0, 0, 0])
                put4(f32, a, num(p.starttime), num(p.endtime, 1), 0, 0)
                put4(f32, b, sv[0], sv[1], sv[2], 0)
                put4(f32, c, ev[0], ev[1], ev[2], 0)
                break
            }
            case OperatorKind.OscillateAlpha:

                // WE FrequencyValue 默认：freq 0-10、scale 0-1、phase 0-τ（振荡 scale 用于 alpha/size）
                put4(f32, a, num(p.frequencymin), num(p.frequencymax, 10), num(p.scalemin), num(p.scalemax, 1))
                put4(f32, b, num(p.phasemin), num(p.phasemax, TAU), 0, 0)
                break
            case OperatorKind.OscillateSize:

                // oscillatesize 的 scale 默认 0.8-1.2（绕初始值脉动）
                put4(f32, a, num(p.frequencymin), num(p.frequencymax, 10), num(p.scalemin, 0.8), num(p.scalemax, 1.2))
                put4(f32, b, num(p.phasemin), num(p.phasemax, TAU), 0, 0)
                break
            case OperatorKind.OscillatePosition: {
                const fm = vec(p.frequencymin, [0, 0, 0])
                const fx = vec(p.frequencymax, [5, 5, 5])
                const sm = vec(p.scalemin, [0, 0, 0])
                const sx = vec(p.scalemax, [0, 0, 0])
                const pm = vec(p.phasemin, [0, 0, 0])
                const px = vec(p.phasemax, [0, 0, 0])
                put4(f32, a, fm[0], fm[1], fm[2], 0)
                put4(f32, b, fx[0], fx[1], fx[2], 0)
                put4(f32, c, sm[0], sm[1], sm[2], 0)
                put4(f32, d, sx[0], sx[1], sx[2], 0)
                put4(f32, e, pm[0], pm[1], pm[2], 0)
                put4(f32, f, px[0], px[1], px[2], 0)
                break
            }
            case OperatorKind.Turbulence: {
                const mask = vec(p.mask, [1, 1, 1])

                // WE 参考：phasemin/max 0、speed 500-1000、timescale 20、scale 0.01
                put4(f32, a, num(p.phasemin), num(p.phasemax), num(p.speedmin, 500), num(p.speedmax, 1000))
                put4(f32, b, num(p.timescale, 20), num(p.scale, 0.01), 0, 0)
                put4(f32, c, mask[0], mask[1], mask[2], 0)
                break
            }
            case OperatorKind.Vortex: {
                const axis = vec(p.axis, [0, 0, 1])
                const offset = vec(p.offset, [0, 0, 0])

                // a=(dInner,dOuter,sIn,sOut) b=(flags,cpIdx) c=(ringR,ringW,pullD) d=offset e=axis
                // flags: bit0=infinite_axis bit1=maintain_distance_to_center（环语义）
                put4(f32, a, num(p.distanceinner, 10), num(p.distanceouter, 100), num(p.speedinner, 100), num(p.speedouter, 100))
                put4(f32, b, num(p.flags), Math.trunc(num(p.controlpoint)), 0, 0)
                put4(f32, c, num(p.ringradius), num(p.ringwidth), num(p.ringpulldistance), 0)
                put4(f32, d, offset[0], offset[1], offset[2], 0)
                put4(f32, e, axis[0], axis[1], axis[2], 0)
                break
            }
            case OperatorKind.ControlPointAttract: {
                const origin = vec(p.origin, [0, 0, 0])
                put4(f32, a, num(p.scale), num(p.threshold), 0, 0)
                put4(f32, b, origin[0], origin[1], origin[2], Math.trunc(num(p.controlpoint)))
                break
            }
            case OperatorKind.MaintainDistanceToCP: {
                put4(f32, a, num(p.distance, 256), num(p.variablestrength), 0, 0)
                put4(f32, b, 0, 0, 0, Math.trunc(num(p.controlpoint)))
                break
            }
            case OperatorKind.Boids: {

                // a=(neighborthreshold, -, -, -)  b=(alignment, cohesion, separation, 0)
                put4(f32, a, num(p.neighborthreshold, 100), 0, 0, 0)
                put4(f32, b, num(p.alignmentfactor), num(p.cohesionfactor), num(p.separationfactor), 0)
                break
            }
        }

        operatorCount++
    }

    u32[COUNTS_OFFSET / 4 + 0] = emitterCount
    u32[COUNTS_OFFSET / 4 + 1] = initializerCount
    u32[COUNTS_OFFSET / 4 + 2] = operatorCount
    u32[COUNTS_OFFSET / 4 + 3] = 0 // capacity 由运行时填

    // ---- renderer（取 renderers[0]）----
    const compiled = compileRenderer(def)
    warnings.push(...compiled.warnings)
    u32[RENDERER_OFFSET / 4 + 0] = compiled.mode
    u32[RENDERER_OFFSET / 4 + 1] = compiled.segments
    put4(f32, RENDERER_OFFSET / 4 + 4, compiled.length, compiled.maxlength, compiled.interval, 0)

    return { data, emitterCount, initializerCount, operatorCount, warnings, renderer: compiled }
}

export interface CompiledRenderer {
    mode:      number
    segments:  number
    length:    number
    maxlength: number

    /** ropetrail 采样间隔 = maxlength / segments（对齐 WE）。 */
    interval: number
    warnings: string[]
}

const RENDERER_CODES: Record<string, number> = { sprite: 0, spritetrail: 1, ropetrail: 2, rope: 3 }

export function compileRenderer(def: ParticleSystemDef): CompiledRenderer {
    const r = def.renderers[0] ?? { name: 'sprite' }
    const mode = RENDERER_CODES[r.name] ?? 0
    const warnings: string[] = []
    if (RENDERER_CODES[r.name] === undefined) warnings.push(`未知渲染器 "${r.name}"，降级 sprite`)

    // WE：spritetrail length×speed 拉伸（maxlength 钳位，默认 0.05/10）；
    //     ropetrail length = 拖尾时长（秒），采样间隔 = length/segments
    //     （segments 引擎内部默认参考实现估 4，观感偏折线；取 8 平滑曲线，显式声明不受影响）
    const segments = mode === 2 ? Math.min(MAX_TRAIL_SEGMENTS, Math.max(2, Math.trunc(num(r.segments)) || 8)) : 0
    const length = mode === 1 || mode === 2 ? Math.max(0.001, num(r.length, 0.05)) : 0
    const maxlength = mode === 1 ? Math.max(0.01, num(r.maxlength, 10)) : 0
    const interval = mode === 2 ? Math.max(1e-3, length / Math.max(segments, 1)) : 0

    return { mode, segments, length, maxlength, interval, warnings }
}

const CHILD_TYPE_CODES = { static: 0, eventdeath: 1, eventspawn: 2, eventfollow: 3 } as const

export interface CompiledChildren {
    data:     Uint8Array
    count:    number
    warnings: string[]
}

/**
 * 编译父侧 children 描述表（写入 program buffer 尾部）。
 * 每项 vec4u = (type, cpStart, active, probability)。
 * static 子系统不进表（由运行时作为兄弟系统独立创建）。
 */
export function compileChildren(parentDef: ParticleSystemDef): CompiledChildren {
    const warnings: string[] = []
    const data = new Uint8Array(PROGRAM_BUFFER_SIZE - CHILDREN_OFFSET)
    const u32 = new Uint32Array(data.buffer)
    const f32 = new Float32Array(data.buffer)

    let count = 0
    for (const child of parentDef.children) {
        if (count >= MAX_CHILDREN) {
            warnings.push(`children 超过 ${MAX_CHILDREN} 个，多余的被忽略`)
            break
        }
        if (!child.def) {
            warnings.push(`child "${child.name}" 未解析子定义，已跳过`)
            continue
        }
        if (child.def.children.some(c => c.type !== 'static')) {
            warnings.push(`child "${child.name}"：嵌套 event 子系统暂不支持`)
        }
        const type = CHILD_TYPE_CODES[child.type] ?? 0
        const o = count * 4
        u32[o + 0] = type
        u32[o + 1] = Math.max(0, Math.trunc(child.controlPointStartIndex))
        u32[o + 2] = 1
        f32[o + 3] = Math.min(1, Math.max(0, child.probability || 1))
        count++
    }

    return { data, count, warnings }
}

/** 爆发实例的寿命：子定义里最长 lifetime + 发射窗口，CPU 常量近似。 */
export function burstLifetime(def: ParticleSystemDef): number {
    let maxLife = 1
    for (const ini of def.initializers) {
        if (ini.name === 'lifetimerandom') {
            const p = ini as Record<string, unknown>
            maxLife = Math.max(maxLife, typeof p.max === 'number' ? p.max : 1)
        }
    }
    let duration = 0
    for (const em of def.emitters) {
        const p = em as Record<string, unknown>
        if (typeof p.duration === 'number') duration = Math.max(duration, p.duration)
    }

    return maxLife + duration + 0.25
}

function norm(kind: 'emitter' | 'initializer' | 'operator', mod: ParticleModule, warnings: string[]): Params {
    const spec = getModuleSpec(kind, mod.name)
    if (!spec) {
        warnings.push(`未注册的模块 "${mod.name}"`)

        return {}
    }
    const { params, unknownParams } = normalizeModule(kind, mod as Record<string, unknown> & { name: string })
    if (unknownParams.length) warnings.push(`${kind} "${mod.name}": 未识别字段 ${unknownParams.join(', ')}`)

    return params as Params
}

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function vec(v: unknown, fallback: Vec3): Vec3 {
    if (Array.isArray(v) && v.length >= 3) return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])]

    // 标量（sphererandom 的半径、WE 单值字段）按各维同值展开
    if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v]

    return [...fallback]
}

function put4(f32: Float32Array, o: number, x: number, y: number, z: number, w: number): void {
    f32[o] = x
    f32[o + 1] = y
    f32[o + 2] = z
    f32[o + 3] = w
}
