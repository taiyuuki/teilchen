/**
 * Wallpaper Engine particle JSON ⇄ 内部 ParticleSystemDef。
 *
 * 兼容 WE 的松散类型：vec3 为空格分隔字符串（也可能是数组/标量），
 * 数值字段可能是字符串，布尔有 true/false 两种写法。
 */
import type { BlendMode, ChildDef, ParticleModule, ParticleSystemDef, SpawnType, Vec3 } from './types.ts'
import { defaultControlPoints, defaultMaterial, defaultSystem } from './types.ts'
import { formatWeVec3, parseWeBool, parseWeFloat, parseWeInt, parseWeVec3 } from './value.ts'
import { type ModuleKind, normalizeModule } from './registry.ts'

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

        const combos = pass.combos as Record<string, unknown> | undefined
        if (combos && Number(combos.REFRACT ?? 0) > 0) {
            def.material.refract = true

            // 纯折射：基色 util/white + 法线贴图，WE 中只扭曲背景、无可视粒子，近似渲染只会是白色巨块
            if (def.material.textures[0] === 'util/white') {
                def.material.refractOnly = true
                warnings.push('material: 纯折射 pass（util/white+REFRACT）无基色，跳过渲染')
            }
            else {
                warnings.push('material: REFRACT 折射未支持，仅渲染基色贴图近似')
            }
        }
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
            cps[id].angles = parseWeVec3(raw.angles, [0, 0, 0])
            cps[id].lockToPointer = parseWeBool(raw.locktopointer, (cps[id].flags & 1) !== 0)
        }
    }
    def.controlPoints = cps

    // --- children：缺省 type 为 static（WE ParseSpawnType 同语义——glyphs/torch 的
    //     伴随光晕等不带 type 的 children 同样会实例化） ---
    if (Array.isArray(src.children)) {
        def.children = (src.children as Record<string, unknown>[]).map(c => {
            const type = (c.type === undefined ? 'static' : String(c.type)) as SpawnType

            if (!['static', 'eventfollow', 'eventspawn', 'eventdeath'].includes(type)) {
                warnings.push(`child "${String(c.name ?? '')}": 未知 type "${String(c.type)}"，已忽略`)

                return null
            }

            return {
                name:                   String(c.name ?? ''),
                type:                   type as SpawnType,
                maxCount:               parseWeInt(c.maxcount, 100),
                controlPointStartIndex: parseWeInt(c.controlpointstartindex, 0),
                probability:            parseWeFloat(c.probability, 1),
                origin:                 parseWeVec3(c.origin, [0, 0, 0]),
                scale:                  parseWeVec3(c.scale, [1, 1, 1]),
                angles:                 parseWeVec3(c.angles, [0, 0, 0]),
            } satisfies ChildDef
        })
            .filter((c): c is ChildDef => c !== null)
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

const MODULE_KIND_TO_KEY = {
    emitter:      'emitters',
    initializer:  'initializers',
    operator:     'operators',
    renderer:     'renderers',
} as const

/** 把手工构造/预设的 def 也过一遍注册表规范化（填默认值、统一 vec3 形态），编辑器面板用。 */
export function normalizeDef(def: ParticleSystemDef): ParticleSystemDef {
    const out = { ...def }
    for (const [kind, key] of Object.entries(MODULE_KIND_TO_KEY) as [ModuleKind, 'emitters' | 'initializers' | 'operators' | 'renderers'][]) {
        out[key] = def[key].map(m => {
            const { params } = normalizeModule(kind, m as Record<string, unknown> & { name: string })

            return { ...m, ...params }
        })
    }

    return out
}

/**
 * 递归解析 children 引用的子系统定义（child.name 为 WE 资产根相对路径）。
 * load 由调用方提供（fetch/文件系统皆可）；失败静默跳过（保持 child.def 为空）。
 */
export async function attachChildDefs(
    root: ParticleSystemDef,
    load: (wePath: string) => Promise<ParticleSystemDef | undefined>,
): Promise<void> {
    const keep: typeof root.children = []
    for (const child of root.children) {
        if (!child.def && child.name.endsWith('.json')) {
            try {
                child.def = await load(child.name)
            }
            catch {

                // 子定义加载失败由 load 方自行上报
            }
        }
        if (child.def?.material.refractOnly) continue // 纯折射子系统无可视基色，跳过
        if (child.def) await attachChildDefs(child.def, load)
        keep.push(child)
    }
    root.children = keep
}

/**
 * static 子系统的层变换（children 声明里的 origin/scale/angles）烘进独立 def 副本。
 * scale 作用于全部空间量（发射半径/速度/尺寸/重力/拖尾长度/控制点偏移）；origin 平移发射原点。
 * 返回深拷贝，不影响共享的子定义。
 */
export function applyChildLayerTransform(def: ParticleSystemDef, origin: Vec3, scale: Vec3, angles: Vec3): ParticleSystemDef {
    const out = structuredClone(def)
    const uniform = (scale[0] + scale[1] + scale[2]) / 3

    // 保持形状的缩放：vec3 逐维缩放；标量（sphererandom 的半径等）按均匀缩放；缺省按 fallback
    const sv = (v: Vec3 | number | undefined, fallback: Vec3 | number = [0, 0, 0]): Vec3 | number => {
        if (typeof v === 'number') return v * uniform
        const src = Array.isArray(v) ? v : Array.isArray(fallback) ? fallback : [fallback, fallback, fallback]

        return [src[0] * scale[0], src[1] * scale[1], src[2] * scale[2]]
    }
    const sf = (n: number): number => n * uniform

    out.origin = [
        out.origin[0] * scale[0] + origin[0],
        out.origin[1] * scale[1] + origin[1],
        out.origin[2] * scale[2] + origin[2],
    ]
    out.angles = [out.angles[0] + angles[0], out.angles[1] + angles[1], out.angles[2] + angles[2]]

    for (const em of out.emitters) {
        const e = em as Record<string, unknown>
        e.origin = sv(e.origin as Vec3 | number | undefined, [0, 0, 0])
        e.distancemin = sv(e.distancemin as Vec3 | number | undefined, 0)
        e.distancemax = sv(e.distancemax as Vec3 | number | undefined, 0)
        e.speedmin = sf(Number(e.speedmin ?? 0))
        e.speedmax = sf(Number(e.speedmax ?? 0))
    }
    for (const ini of out.initializers) {
        const m = ini as Record<string, unknown>
        if (m.name === 'sizerandom') {
            m.min = sf(Number(m.min ?? 0))
            m.max = sf(Number(m.max ?? 0))
        }
        else if (m.name === 'velocityrandom') {
            m.min = sv((m.min as Vec3) ?? [0, 0, 0])
            m.max = sv((m.max as Vec3) ?? [0, 0, 0])
        }
    }
    for (const op of out.operators) {
        const m = op as Record<string, unknown>
        switch (m.name) {
            case 'movement':
                m.gravity = sv((m.gravity as Vec3) ?? [0, 0, 0])
                break
            case 'turbulence':
                m.speedmin = sf(Number(m.speedmin ?? 0))
                m.speedmax = sf(Number(m.speedmax ?? 0))
                break
            case 'vortex':
            case 'vortex_v2':
                m.distanceinner = sf(Number(m.distanceinner ?? 0))
                m.distanceouter = sf(Number(m.distanceouter ?? 0))
                m.speedinner = sf(Number(m.speedinner ?? 0))
                m.speedouter = sf(Number(m.speedouter ?? 0))
                if (m.name === 'vortex_v2') m.ringradius = sf(Number(m.ringradius ?? 0))
                break
            case 'controlpointattract':
                m.threshold = sf(Number(m.threshold ?? 0))
                m.origin = sv((m.origin as Vec3) ?? [0, 0, 0])
                break
            case 'oscillateposition':
                m.scalemin = sv((m.scalemin as Vec3) ?? [0, 0, 0])
                m.scalemax = sv((m.scalemax as Vec3) ?? [0, 0, 0])
                break
            case 'maintaindistancetocontrolpoint':
                m.distance = sf(Number(m.distance ?? 0))
                break
        }
    }
    for (const rnd of out.renderers) {
        const m = rnd as Record<string, unknown>
        if (m.length !== undefined) m.length = sf(Number(m.length))
        if (m.maxlength !== undefined) m.maxlength = sf(Number(m.maxlength))
    }
    out.controlPoints = out.controlPoints.map(cp => ({
        ...cp,
        offset: sv(cp.offset, [0, 0, 0]) as Vec3,
    }))

    return out
}
