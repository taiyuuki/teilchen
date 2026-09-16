/**
 * WE（Valve KeyValues 风格 JSON）的标量格式转换。
 * vec3 字段在 WE json 里是空格分隔字符串 "x y z"，也可能是数组或标量。
 */
import type { ParamValue, Vec3 } from './types.ts'

export function parseWeVec3(v: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 {
    if (typeof v === 'number') return [v, v, v]
    if (Array.isArray(v) && v.length >= 3) {
        return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
    }
    if (typeof v === 'string') {
        const parts = v.trim().split(/\s+/)
            .map(Number)
        if (parts.length >= 3) return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
        if (parts.length === 1) return [parts[0] || 0, parts[0] || 0, parts[0] || 0]
    }

    return [...fallback]
}

/** WE 的 distancemin/distancemax 等字段可为标量（各维同值）或 vec3。 */
export function parseWeVec3OrScalar(v: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 {
    return parseWeVec3(v, fallback)
}

export function parseWeFloat(v: unknown, fallback = 0): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
        const n = Number(v)
        if (Number.isFinite(n)) return n
    }

    return fallback
}

export function parseWeInt(v: unknown, fallback = 0): number {
    return Math.trunc(parseWeFloat(v, fallback))
}

export function parseWeBool(v: unknown, fallback = false): boolean {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') return v === 'true' || v === '1'

    return fallback
}

/** WE colorrandom 的颜色是 0-255；归一化到 0-1。 */
export function parseWeColor(v: unknown, fallback: Vec3 = [255, 255, 255]): Vec3 {
    const c = parseWeVec3(v, fallback)

    return [c[0] / 255, c[1] / 255, c[2] / 255]
}

export function formatWeVec3(v: Vec3): string {
    return `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`
}

/** 与 WE 一致的浮点序列化：整数不带小数点，其余保留足够精度。 */
export function fmt(n: number): string {
    if (Number.isInteger(n)) return String(n)

    return String(Number(n.toFixed(6)))
}

export function isVec3(v: ParamValue): v is Vec3 {
    return Array.isArray(v)
}
