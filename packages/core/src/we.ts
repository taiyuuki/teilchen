/**
 * Wallpaper Engine particle JSON ⇄ 内部 ParticleSystemDef。
 *
 * 兼容 WE 的松散类型：vec3 为空格分隔字符串（也可能是数组/标量），
 * 数值字段可能是字符串，布尔有 true/false 两种写法。
 */
import type { BlendMode, ChildDef, ParticleModule, ParticleSystemDef, SpawnType } from './types.ts'
import { defaultControlPoints, defaultMaterial, defaultSystem } from './types.ts'
import { formatWeVec3, parseWeBool, parseWeFloat, parseWeInt, parseWeVec3 } from './value.ts'
import { normalizeModule } from './registry.ts'

export interface WeParseResult {
    def:      ParticleSystemDef;
    warnings: string[];
}

/** 解析一份 WE particles/*.json（对象或 JSON 字符串）。material 参数可为材质 json 的内容。 */
export function parseWeParticleJson(
    json: unknown,
    materialJson?: unknown,
    name = 'we-import',
): WeParseResult {
    const warnings: string[] = []
    const src: Record<string, unknown>
        = typeof json === 'string' ? JSON.parse(json) : (json as Record<string, unknown>)

    const def = defaultSystem(name)

    // --- material（外部传入或内嵌引用） ---
    if (materialJson) {
        const m = (Array.isArray(materialJson) ? materialJson[0] : materialJson) as Record<string, unknown>
        const pass = (m.passes as Record<string, unknown>[] | undefined)?.[0] ?? m
        const blending = String(pass.blending ?? 'translucent') as BlendMode
        if (['translucent', 'additive', 'normal', 'alphatocoverage', 'disabled'].includes(blending)) {
            def.material.blending = blending
        }
        else {
            warnings.push(`material: 未知 blending "${blending}"，回退 translucent`)
            def.material.blending = 'translucent'
        }
        const tex = pass.textures
        if (Array.isArray(tex)) def.material.textures = tex.map(String)
        else if (typeof tex === 'object' && tex) def.material.textures = Object.values(tex).map(String)
        def.material.depthTest = parseWeBool(pass.depthtest, false) && String(pass.depthtest) !== 'disabled'
        def.material.depthWrite = parseWeBool(pass.depthwrite, false) && String(pass.depthwrite) !== 'disabled'
    }
    else if (typeof src.material === 'string') {
        warnings.push(`material "${src.material}" 未提供内容，使用默认 additive/白贴图`)
        def.material = defaultMaterial()
    }

    def.maxCount = clampInt(parseWeInt(src.maxcount, 20000), 1, 1_000_000)
    def.startTime = Math.max(0, parseWeFloat(src.starttime, 0))
    def.flags = parseWeInt(src.flags, 0)
    const am = String(src.animationmode ?? 'sequence')
    def.animationMode = am === 'randomframe' ? 'randomframe' : 'sequence'
    def.sequenceMultiplier = parseWeFloat(src.sequencemultiplier, 1)
    def.origin = parseWeVec3(src.origin, [0, 0, 0])
    def.scale = parseWeVec3(src.scale, [1, 1, 1])
    def.angles = parseWeVec3(src.angles, [0, 0, 0])

    // --- 各类模块数组：滤掉 name 缺失的项，未知模块名保留（导出 round-trip）但记 warning ---
    def.emitters = parseModuleList(src.emitter, 'emitter', warnings)
    def.initializers = parseModuleList(src.initializer, 'initializer', warnings)
    def.operators = parseModuleList(src.operator, 'operator', warnings)

    const renderers = parseModuleList(src.renderer, 'renderer', warnings)
    def.renderers = (renderers.length ? renderers : [{ name: 'sprite' }]) as ParticleSystemDef['renderers']

    // --- controlpoints（WE 固定 8 槽） ---
    const cps = defaultControlPoints()
    if (Array.isArray(src.controlpoint)) {
        for (const raw of src.controlpoint as Record<string, unknown>[]) {
            const id = parseWeInt(raw.id, -1)
            if (id < 0 || id >= 8) continue
            cps[id].flags = parseWeInt(raw.flags, 0)
            cps[id].offset = parseWeVec3(raw.offset, [0, 0, 0])
            cps[id].lockToPointer = parseWeBool(raw.locktopointer, (cps[id].flags & 1) !== 0)
        }
    }
    def.controlPoints = cps

    // --- children（本阶段只解析不模拟） ---
    if (Array.isArray(src.children)) {
        def.children = (src.children as Record<string, unknown>[]).map(c => {
            const type = String(c.type ?? 'static') as SpawnType

            return {
                name:                   String(c.name ?? ''),
                type:                   (['static', 'eventfollow', 'eventspawn', 'eventdeath'].includes(type) ? type : 'static') as SpawnType,
                maxCount:               parseWeInt(c.maxcount, 100),
                controlPointStartIndex: parseWeInt(c.controlpointstartindex, 0),
                probability:            parseWeFloat(c.probability, 1),
                origin:                 parseWeVec3(c.origin, [0, 0, 0]),
                scale:                  parseWeVec3(c.scale, [1, 1, 1]),
                angles:                 parseWeVec3(c.angles, [0, 0, 0]),
            } satisfies ChildDef
        })
    }

    if (!def.emitters.length) warnings.push('没有可用的 emitter（需要 boxrandom/sphererandom）')

    return { def, warnings }
}

function parseModuleList(raw: unknown, kind: 'emitter' | 'initializer' | 'operator' | 'renderer', warnings: string[]): ParticleModule[] {
    if (!Array.isArray(raw)) return []
    const out: ParticleModule[] = []
    for (const item of raw as Record<string, unknown>[]) {
        const name = String(item.name ?? '')
        if (!name) continue
        const { params, unknownParams } = normalizeModule(kind, { ...item, name })
        if (unknownParams.length) warnings.push(`${kind} "${name}": 未识别字段 ${unknownParams.join(', ')}`)
        out.push({ name, ...params })
    }

    return out
}

function clampInt(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, Math.trunc(v)))
}

/** 序列化回 WE particle JSON（vec3 写成 "x y z" 字符串）。 */
export function serializeWeParticleJson(def: ParticleSystemDef): Record<string, unknown> {
    const out: Record<string, unknown> = {
        material:           `materials/particle/${def.name}.json`,
        maxcount:           def.maxCount,
        starttime:          def.startTime,
        animationmode:      def.animationMode,
        sequencemultiplier: def.sequenceMultiplier,
        flags:              def.flags,
        emitter:            def.emitters.map(e => serializeModule(e)),
        initializer:        def.initializers.map(e => serializeModule(e)),
        operator:           def.operators.map(e => serializeModule(e)),
        renderer:           def.renderers.map(e => serializeModule(e)),
        controlpoint:       def.controlPoints.map((cp, i) => ({
            id:            i,
            flags:         cp.lockToPointer ? 1 : cp.flags,
            locktopointer: cp.lockToPointer,
            offset:        formatWeVec3(cp.offset),
        })),
        children: def.children.length
            ? def.children.map(c => ({
                name:                   c.name,
                type:                   c.type,
                maxcount:               c.maxCount,
                controlpointstartindex: c.controlPointStartIndex,
                probability:            c.probability,
                origin:                 formatWeVec3(c.origin),
                scale:                  formatWeVec3(c.scale),
                angles:                 formatWeVec3(c.angles),
            }))
            : null,
    }

    return out
}

function serializeModule(mod: ParticleModule): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(mod)) {
        if (k === 'name') continue
        out[k] = Array.isArray(v) ? formatWeVec3(v) : v
    }

    // WE 文件习惯按字母序排 key，尽量贴近官方导出观感
    out.name = mod.name

    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}
