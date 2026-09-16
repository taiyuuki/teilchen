/**
 * 编译：ParticleSystemDef → GPU Program 表（Float32/Uint32 视图按 layout.ts 偏移写入）。
 * 未知/超出上限的模块跳过并记入 warnings。
 */
import type { ParticleModule, ParticleSystemDef, Vec3 } from '@teilchen/core'
import { getModuleSpec, normalizeModule } from '@teilchen/core'
import {
    COUNTS_OFFSET,
    EMITTERS_OFFSET,
    EMITTER_STRIDE,
    EmitterKind,
    INITIALIZERS_OFFSET,
    INITIALIZER_STRIDE,
    InitializerKind,
    MAX_EMITTERS,
    MAX_INITIALIZERS,
    MAX_OPERATORS,
    OPERATORS_OFFSET,
    OPERATOR_STRIDE,
    OperatorKind,
    PROGRAM_BUFFER_SIZE,
} from './layout.ts'

export interface CompiledProgram {
    data:             Uint8Array;
    emitterCount:     number;
    initializerCount: number;
    operatorCount:    number;
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
            lifetimerandom:        InitializerKind.LifetimeRandom,
            sizerandom:            InitializerKind.SizeRandom,
            alpharandom:           InitializerKind.AlphaRandom,
            colorrandom:           InitializerKind.ColorRandom,
            velocityrandom:        InitializerKind.VelocityRandom,
            rotationrandom:        InitializerKind.RotationRandom,
            angularvelocityrandom: InitializerKind.AngularVelocityRandom,
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
            movement:            OperatorKind.Movement,
            angularmovement:     OperatorKind.AngularMovement,
            alphafade:           OperatorKind.AlphaFade,
            alphachange:         OperatorKind.AlphaChange,
            sizechange:          OperatorKind.SizeChange,
            colorchange:         OperatorKind.ColorChange,
            oscillatealpha:      OperatorKind.OscillateAlpha,
            oscillatesize:       OperatorKind.OscillateSize,
            oscillateposition:   OperatorKind.OscillatePosition,
            turbulence:          OperatorKind.Turbulence,
            vortex:              OperatorKind.Vortex,
            controlpointattract: OperatorKind.ControlPointAttract,
        }
        const kind = kindMap[raw.name]
        if (kind === undefined) {
            warnings.push(`不支持的 operator "${raw.name}"，已跳过`)
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
                put4(f32, a, num(p.fadeintime), num(p.fadeouttime), 0, 0)
                break
            case OperatorKind.AlphaChange:
            case OperatorKind.SizeChange:
                put4(f32, a, num(p.starttime), num(p.endtime, 1), num(p.startvalue), num(p.endvalue))
                break
            case OperatorKind.ColorChange: {
                const sv = vec(p.startvalue, [1, 1, 1])
                const ev = vec(p.endvalue, [1, 1, 1])
                put4(f32, a, num(p.starttime), num(p.endtime, 1), 0, 0)
                put4(f32, b, sv[0], sv[1], sv[2], 0)
                put4(f32, c, ev[0], ev[1], ev[2], 0)
                break
            }
            case OperatorKind.OscillateAlpha:
            case OperatorKind.OscillateSize:
                put4(f32, a, num(p.frequencymin, 1), num(p.frequencymax, 1), num(p.scalemin), num(p.scalemax))
                put4(f32, b, num(p.phasemin), num(p.phasemax), 0, 0)
                break
            case OperatorKind.OscillatePosition: {
                const fm = vec(p.frequencymin, [1, 1, 1])
                const fx = vec(p.frequencymax, [1, 1, 1])
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
                put4(f32, a, num(p.phasemin), num(p.phasemax, 100), num(p.speedmin), num(p.speedmax, 100))
                put4(f32, b, num(p.timescale, 1), num(p.scale, 0.01), 0, 0)
                put4(f32, c, mask[0], mask[1], mask[2], 0)
                break
            }
            case OperatorKind.Vortex: {
                const axis = vec(p.axis, [0, 0, 1])
                put4(f32, a, num(p.distanceinner, 10), num(p.distanceouter, 100), num(p.speedinner, 100), num(p.speedouter, 100))
                put4(f32, b, axis[0], axis[1], axis[2], Math.trunc(num(p.controlpoint)))
                break
            }
            case OperatorKind.ControlPointAttract: {
                const origin = vec(p.origin, [0, 0, 0])
                put4(f32, a, num(p.scale), num(p.threshold), 0, 0)
                put4(f32, b, origin[0], origin[1], origin[2], Math.trunc(num(p.controlpoint)))
                break
            }
        }
        operatorCount++
    }

    u32[COUNTS_OFFSET / 4 + 0] = emitterCount
    u32[COUNTS_OFFSET / 4 + 1] = initializerCount
    u32[COUNTS_OFFSET / 4 + 2] = operatorCount
    u32[COUNTS_OFFSET / 4 + 3] = 0 // capacity 由运行时填

    return { data, emitterCount, initializerCount, operatorCount, warnings }
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

    return [...fallback]
}

function put4(f32: Float32Array, o: number, x: number, y: number, z: number, w: number): void {
    f32[o] = x
    f32[o + 1] = y
    f32[o + 2] = z
    f32[o + 3] = w
}
