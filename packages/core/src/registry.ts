/**
 * 模块注册表：每种 emitter/initializer/operator/renderer 声明自己的参数 schema。
 * Editor 据此自动生成属性面板；runtime 据此校验与编码到 GPU 表。
 */
import type { ParamValue } from './types.ts'

export type ModuleKind = 'emitter' | 'initializer' | 'operator' | 'renderer'

export type ParamType = 'bool' | 'color255' | 'enum' | 'float' | 'int' | 'vec3'

export interface ParamSpec {
    key:     string;
    label:   string;
    type:    ParamType;
    default: ParamValue;
    min?:    number;
    max?:    number;
    step?:   number;

    /** enum 类型的取值。 */
    options?: { value: number | string; label: string }[];

    /** 生成 GPU 表时需要并入哪个分量槽，由 runtime 编码器自行读取，这里只作编辑器提示。 */
    group?: string;
}

export interface ModuleSpec {
    kind:         ModuleKind;
    name:         string;
    label:        string;
    description?: string;
    params:       ParamSpec[];
}

const registry = new Map<string, ModuleSpec>()

function key(kind: ModuleKind, name: string): string {
    return `${kind}:${name}`
}

export function registerModule(spec: ModuleSpec): void {
    registry.set(key(spec.kind, spec.name), spec)
}

export function getModuleSpec(kind: ModuleKind, name: string): ModuleSpec | undefined {
    return registry.get(key(kind, name))
}

export function getModulesByKind(kind: ModuleKind): ModuleSpec[] {
    return [...registry.values()].filter(s => s.kind === kind)
}

/** 按注册表把模块实例的参数规范化（填默认值、裁掉未知 key）。 */
export function normalizeModule(kind: ModuleKind, mod: Record<string, unknown> & { name: string }): {
    name:          string;
    params:        Record<string, ParamValue>;
    unknownParams: string[];
} {
    const spec = getModuleSpec(kind, mod.name)
    if (!spec) return { name: mod.name, params: {}, unknownParams: Object.keys(mod).filter(k => k !== 'name') }
    const params: Record<string, ParamValue> = {}
    const unknownParams: string[] = []
    for (const p of spec.params) {
        const v = mod[p.key]
        params[p.key] = v === undefined ? p.default : coerce(v, p.type, p.default)
    }
    for (const k of Object.keys(mod)) {
        if (k === 'name' || k === 'id' || spec.params.some(p => p.key === k)) continue
        unknownParams.push(k)
    }

    return { name: mod.name, params, unknownParams }
}

function coerce(v: unknown, type: ParamType, fallback: ParamValue): ParamValue {
    switch (type) {
        case 'float': {
            const n = typeof v === 'number' ? v : Number(v)

            return Number.isFinite(n) ? n : (fallback as number)
        }
        case 'int': {
            const n = Math.trunc(typeof v === 'number' ? v : Number(v))

            return Number.isFinite(n) ? n : (fallback as number)
        }
        case 'bool':
            return v === true || v === 'true' || v === 1
        case 'vec3':
        case 'color255': {
            if (typeof v === 'number') return [v, v, v]
            if (typeof v === 'string' || Array.isArray(v)) {
                const parts = (typeof v === 'string' ? v.trim().split(/\s+/) : v).map(Number)
                if (parts.length === 1) return [parts[0], parts[0], parts[0]]
                if (parts.length >= 3) return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
            }

            return [...(fallback as [number, number, number])]
        }
        case 'enum': {
            const s = typeof v === 'string' ? v : String(v)

            return s
        }
    }
}
