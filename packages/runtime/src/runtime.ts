/**
 * ParticleRuntime —— WebGPU GPU 粒子模拟运行时。
 *
 * 模拟完全在 compute shader 中进行（free-list 槽位分配 + 原子计数），
 * CPU 侧零回读；渲染走 indirect instanced billboard，实例数由 GPU 写出。
 */
import { type ChildDef, type ParticleSystemDef, type SpawnType, type Vec3, applyChildLayerTransform } from '@teilchen/core'
import { burstLifetime, compileChildren, compileProgram, compileRenderer } from './compile.ts'
import type { SpriteFrame } from './tex.ts'
import {
    CHILDREN_OFFSET,
    COUNTS_OFFSET,
    ChildType,
    FRAME_UNIFORM_SIZE,
    INDIRECT_SIZE,
    INSTANCE_SPAWN_THREADS,
    MAX_CAPACITY,
    MAX_CHILDREN,
    MAX_EVENTS,
    MAX_SPRITE_FRAMES,
    MAX_TRAIL_SEGMENTS,
    MAX_WORKGROUPS_FOR_EVENTS,
    PROGRAM_BUFFER_SIZE,
    RENDERER_OFFSET,
    RendererMode,
    SPAWN_WORKGROUPS,
    SPRITE_UNIFORM_SIZE,
    SYS_BUFFER_SIZE,
    SYS_UNIFORM_SIZE,
    WORKGROUP_SIZE,
} from './layout.ts'
import { BILLBOARD_WGSL, BLIT_WGSL } from './shaders/billboard.wgsl.ts'
import { COMPUTE_WGSL } from './shaders/compute.wgsl.ts'
import { type TextureAsset, createHaloTexture, createWhiteTexture } from './texture.ts'

export interface RuntimeOptions {
    canvas:      HTMLCanvasElement;
    device?:     GPUDevice;
    clearColor?: { r: number; g: number; b: number; a: number };
    onWarning?:  (msg: string) => void;
}

export interface AddSystemOptions {

    /** 粒子 sprite 贴图；缺省用程序化 halo。可传 TextureAsset（含 .tex 的帧表/采样器）。 */
    texture?: GPUTexture | TextureAsset;
    sampler?: GPUSampler;

    /** 子系统贴图（key = ChildDef.name，即 WE json 引用路径）；缺省子系统退回默认贴图。 */
    childTextures?: Record<string, TextureAsset>;
}

export interface SystemStats {
    alive:    number;
    rendered: number;
}

export interface RuntimeStats {
    fps:     number;
    systems: Record<string, SystemStats>;
}

export interface UpdateSystemOptions {

    /** 同时清空粒子并重跑 warmup。 */
    reset?: boolean

    /** 替换 sprite 贴图/采样器（TextureAsset 同时更新 sprite 帧表）。 */
    texture?: GPUTexture | TextureAsset
    sampler?: GPUSampler

    /** 子系统贴图（children 结构重建时生效）。 */
    childTextures?: Record<string, TextureAsset>
}

export interface SystemHandle {
    readonly id:       number
    readonly def:      ParticleSystemDef
    readonly warnings: string[]
    readonly capacity: number

    /** 热更新定义：重编译 program 表立即生效；maxCount 变化时自动重建缓冲。返回编译警告。 */
    update(def: ParticleSystemDef, opts?: UpdateSystemOptions): string[]
    destroy(): void
}

interface ChildRole {

    /** 父系统 res（借用其实例/事件缓冲）。 */
    parent: SystemRes

    /** WE 类型码（ChildType）。 */
    type:    number
    cpStart: number

    /** 在父合并实例缓冲里的区域起点（元素下标）。 */
    instanceBase: number

    /** 区域容量（follow = 父容量；death/spawn = childDef.maxCount）。 */
    instanceCap: number
    lifetime:    number
    probability: number
}

interface SystemRes {
    handle:         SystemHandle
    def:            ParticleSystemDef
    warnings:       string[]
    capacity:       number
    program:        GPUBuffer
    particles:      GPUBuffer
    sys:            GPUBuffer
    freeList:       GPUBuffer
    renderIndices:  GPUBuffer
    sysUniform:     GPUBuffer
    spriteUniform:  GPUBuffer
    spriteFrames:   SpriteFrame[] | undefined
    indirect:       GPUBuffer
    statsStaging:   GPUBuffer | null
    statsPending:   boolean
    stats:          SystemStats
    bgCompute:      GPUBindGroup
    bgRender:       GPUBindGroup
    pipelineRender: GPURenderPipeline
    textureView:    GPUTextureView
    sampler:        GPUSampler
    texAspect:      number

    // ---- children（父持有合并实例/事件缓冲；子借用） ----
    role:         ChildRole | null
    children:     SystemRes[]
    childrenSig:  string
    instances:    GPUBuffer | null
    events:       GPUBuffer | null
    instanceFree: GPUBuffer | null
    burstCap:     number

    // ---- 渲染器（trail/rope） ----
    rendererMode: number
    trailHistory: GPUBuffer | null
    sortN:        number // rope bitonic 排序的 2 的幂长度
}

export class ParticleRuntime {
    readonly device:            GPUDevice
    readonly canvas:            HTMLCanvasElement
    private readonly ctx:       GPUCanvasContext
    private readonly format:    GPUTextureFormat
    private clearColor:         GPUColor
    private readonly onWarning: (msg: string) => void

    private readonly frameUniform:  GPUBuffer
    private readonly computeModule: GPUShaderModule
    private readonly pipelines: {
        prepare:       GPUComputePipeline;
        spawn:         GPUComputePipeline;
        simulate:      GPUComputePipeline;
        finalize:      GPUComputePipeline;
        childInstance: GPUComputePipeline;
        childEvent:    GPUComputePipeline;
        childSpawn:    GPUComputePipeline;
        ropeSort:      GPUComputePipeline;
        ropeSortInit:  GPUComputePipeline;
    }
    private readonly dummyStorages:      GPUBuffer[]
    private readonly sortParams:         GPUBuffer
    private readonly bglCompute:         GPUBindGroupLayout
    private readonly renderPipelines:    Map<string, GPURenderPipeline>
    private readonly defaultTextureView: GPUTextureView
    private readonly whiteTexture:       GPUTexture
    private bglBg:                       GPUBindGroupLayout
    private bgTexture:                   GPUTexture | null = null
    private bgSnapshotGroup:             GPUBindGroup | null = null
    private blitPipeline:                GPURenderPipeline
    private blitGroup:                   GPUBindGroup | null = null
    private bgPlaceholderGroup:          GPUBindGroup | null = null
    private readonly defaultSampler:     GPUSampler

    private systems: SystemRes[] = []
    private nextId = 1

    private raf = 0
    private running = false
    private playing = true
    private simTime = 0
    private lastNow = 0
    private pointerWorld:   [number, number] = [0, 0]
    private resizeObserver: ResizeObserver | null = null

    /** 可选透视相机（null = 既有 2D 正交路径，行为不变）。 */
    private camera: { eye: Vec3, target: Vec3, up: Vec3, fov: number } | null = null

    /** 播放速度倍率（WE 预览工程的 instanceoverride.speed；1 = 实时）。 */
    private speedMul = 1

    /** 控制点角度驱动器（WE 场景实例的 controlpointangleN 动画）。 */
    private cpAngleDriver: { index: number, fn: (simTime: number) => Vec3 } | null = null

    // stats
    private fpsFrames = 0
    private fpsLast = 0
    private fps = 0
    private statsClock = 0

    private constructor(opts: RuntimeOptions, device: GPUDevice, ctx: GPUCanvasContext, format: GPUTextureFormat) {
        this.device = device
        this.canvas = opts.canvas
        this.ctx = ctx
        this.format = format
        this.clearColor = opts.clearColor ?? { r: 0.016, g: 0.02, b: 0.03, a: 1 }
        this.onWarning = opts.onWarning ?? (m => console.warn('[teilchen]', m))

        this.frameUniform = device.createBuffer({ size: FRAME_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

        this.computeModule = device.createShaderModule({ code: COMPUTE_WGSL, label: 'compute' })

        this.bglCompute = device.createBindGroupLayout({
            label:   'compute-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        })
        const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bglCompute] })
        const mk = (entryPoint: string) =>
            device.createComputePipeline({ layout: computeLayout, compute: { module: this.computeModule, entryPoint } })
        this.pipelines = {
            prepare:       mk('prepareMain'),
            spawn:         mk('spawnMain'),
            simulate:      mk('simulateMain'),
            finalize:      mk('finalizeMain'),
            childInstance: mk('childInstanceMain'),
            childEvent:    mk('childEventMain'),
            childSpawn:    mk('childSpawnMain'),
            ropeSort:      mk('ropeSortMain'),
            ropeSortInit:  mk('ropeSortInitMain'),
        }
        this.dummyStorages = Array.from({ length: 5 }, () => device.createBuffer({ size: 128, usage: GPUBufferUsage.STORAGE }))
        this.sortParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

        // render
        const billboardModule = device.createShaderModule({ code: BILLBOARD_WGSL, label: 'billboard' })
        const bglRender = device.createBindGroupLayout({
            label:   'render-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            ],
        })
        this.bglBg = device.createBindGroupLayout({
            label:   'render-bg-bgl',
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }],
        })
        const renderLayout = device.createPipelineLayout({ bindGroupLayouts: [bglRender, this.bglBg] })
        this.renderPipelines = new Map()
        for (const [name, blend] of [
            ['additive', { color: { srcFactor: 'src-alpha' as GPUBlendFactor, dstFactor: 'one' as GPUBlendFactor, operation: 'add' as GPUBlendOperation }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } }],
            ['translucent', {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            }],
            ['normal', null],
        ] as const) {
            this.renderPipelines.set(
                name,
                device.createRenderPipeline({
                    layout:   renderLayout,
                    vertex:   { module: billboardModule, entryPoint: 'vs' },
                    fragment: {
                        module:     billboardModule,
                        entryPoint: 'fs',
                        targets:    [{ format: this.format, blend: blend ?? undefined }],
                    },
                    primitive: { topology: 'triangle-list' },
                }),
            )
        }

        const halo = createHaloTexture(device)
        this.defaultTextureView = halo.createView()
        this.whiteTexture = createWhiteTexture(device)

        // 全屏 blit：离屏场景 → 画布（pass B 的底图）
        const blitShader = device.createShaderModule({ code: BLIT_WGSL, label: 'blit' })
        this.blitPipeline = device.createRenderPipeline({
            layout:   'auto',
            vertex:   { module: blitShader, entryPoint: 'vs' },
            fragment: { module: blitShader, entryPoint: 'fs', targets: [{ format: this.format }] },
        })
        this.defaultSampler = device.createSampler({
            magFilter:    'linear',
            minFilter:    'linear',
            mipmapFilter: 'linear',
        })

        device.addEventListener?.('uncapturederror', e => {
            this.onWarning(`GPU 错误: ${(e as GPUUncapturedErrorEvent).error.message}`)
        })

        window.addEventListener('resize', this.resize)

        // 容器级尺寸变化（布局定型、面板拖宽）不触发 window resize，
        // 用 ResizeObserver 盯画布元素本身，保证背板尺寸与 CSS 尺寸一致
        this.resizeObserver = new ResizeObserver(() => this.resize())
        this.resizeObserver.observe(this.canvas)
        this.resize()
        this.ensureBgTexture()

        // pass A（无混合）绑白色占位 —— fs 分支不采样，仅满足布局
        this.bgPlaceholderGroup = this.device.createBindGroup({
            layout:  this.bglBg,
            entries: [{ binding: 0, resource: this.whiteTexture.createView() }],
        })
    }

    static async create(opts: RuntimeOptions): Promise<ParticleRuntime> {
        if (!navigator.gpu) throw new Error('此浏览器不支持 WebGPU（需要 Chrome 113+ / Safari 26+）')
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!adapter) throw new Error('无法获取 WebGPU adapter')

        // compute shader 需要 9 个 storage binding（粒子/程序表/自由列表/渲染索引/indirect
        // + 实例/事件/实例自由列表），超过默认限制 8，按 adapter 上限申请
        const device = opts.device ?? await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } })
        const ctx = opts.canvas.getContext('webgpu')
        if (!ctx) throw new Error('无法获取 webgpu canvas context')
        const format = navigator.gpu.getPreferredCanvasFormat()
        ctx.configure({ device, format, alphaMode: 'opaque' })

        return new ParticleRuntime(opts, device, ctx, format)
    }

    // ---------------------------------------------------------------- systems

    addSystem(def: ParticleSystemDef, opts: AddSystemOptions = {}): SystemHandle {
        const res = this.createSystem(def, opts, null)
        this.wireChildren(res, def, opts)

        // warmup（starttime：以 1/60s 预跑，GPU 空转不渲染；子系统同帧预热）
        if (def.startTime > 0) this.warmup(res)

        return res.handle
    }

    /** 创建一个系统（root 或子）。static 子系统按普通系统创建（无父子接线）。 */
    private createSystem(def: ParticleSystemDef, opts: AddSystemOptions, role: ChildRole | null): SystemRes {
        const device = this.device
        const capacity = Math.min(MAX_CAPACITY, Math.max(1, Math.round(def.maxCount)))

        const compiled = compileProgram(def)
        for (const w of compiled.warnings) this.onWarning(`[${def.name}] ${w}`)

        const program = device.createBuffer({ size: PROGRAM_BUFFER_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        const particles = device.createBuffer({ size: capacity * 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
        const sys = device.createBuffer({ size: SYS_BUFFER_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
        const freeList = device.createBuffer({ size: capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        const idxPerParticle = compiled.renderer.mode === RendererMode.RopeTrail ? MAX_TRAIL_SEGMENTS : 1
        const renderIndices = device.createBuffer({ size: capacity * idxPerParticle * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        const sysUniform = device.createBuffer({ size: SYS_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
        const spriteUniform = device.createBuffer({ size: SPRITE_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        const indirect = device.createBuffer({ size: INDIRECT_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })

        const trailHistory = compiled.renderer.mode === RendererMode.RopeTrail
            ? device.createBuffer({ size: capacity * MAX_TRAIL_SEGMENTS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
            : null
        if (trailHistory && capacity > 100_000) this.onWarning(`[${def.name}] ropetrail 容量 ${capacity.toLocaleString()} 的历史缓冲较大（${(capacity * MAX_TRAIL_SEGMENTS * 16 / 1048576).toFixed(0)}MB）`)
        let sortN = 2
        if (compiled.renderer.mode === RendererMode.Rope) {
            sortN = 1 << Math.ceil(Math.log2(Math.max(2, capacity)))
            if (sortN > 65536) this.onWarning(`[${def.name}] rope 容量过大（${capacity}），排序 pass 开销高`)
        }

        // 父持有合并实例缓冲 + 事件缓冲；子持有爆发实例自由列表
        const instances: GPUBuffer | null = null
        const events: GPUBuffer | null = null
        let instanceFree: GPUBuffer | null = null
        let burstCap = 0
        if (role) {
            if (role.type !== ChildType.EventFollow) {
                burstCap = role.instanceCap
                instanceFree = device.createBuffer({ size: Math.max(4, burstCap) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
            }
        }

        const tex = this.resolveTexture(opts)
        const res: SystemRes = {
            handle:         null!,
            def,
            warnings:       compiled.warnings,
            capacity,
            program,
            particles,
            sys,
            freeList,
            renderIndices,
            sysUniform,
            spriteUniform,
            spriteFrames:   tex.frames,
            indirect,
            statsStaging:   device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            statsPending:   false,
            stats:          { alive: 0, rendered: 0 },
            bgCompute:      null!,
            bgRender:       null!,
            pipelineRender: this.pickRenderPipeline(def),
            textureView:    tex.view,
            sampler:        opts.sampler ?? tex.sampler ?? this.defaultSampler,
            texAspect:      tex.aspect,
            role,
            children:       [],
            childrenSig:    '',
            instances,
            events,
            instanceFree,
            burstCap,
            rendererMode:   compiled.renderer.mode,
            trailHistory,
            sortN,
        }
        res.handle = {
            id:                        this.nextId++,
            get def() { return res.def },
            get warnings() { return res.warnings },
            get capacity() { return res.capacity },
            update:  (d, o) => this.updateSystem(res, d, o),
            destroy: () => this.removeSystem(res.handle.id),
        }
        this.writeProgramBuffer(res, compiled, capacity)
        this.makeBindGroups(res)
        this.writeSpriteUniform(res)
        this.initAliveState(res)
        this.systems.push(res)

        return res
    }

    /** 为父系统接线 children：分配实例区域、创建子系统（按声明顺序入列，保证 dispatch/渲染序）。 */
    private wireChildren(res: SystemRes, def: ParticleSystemDef, opts?: AddSystemOptions): void {
        const device = this.device
        const eventChildren = def.children.filter(c => c.def && c.type !== 'static').slice(0, 4)
        let base = 0
        const regions: Array<{ child: ChildDef, base: number, cap: number }> = []
        for (const child of eventChildren) {
            const cap = child.type === 'eventfollow'
                ? res.capacity
                : Math.max(1, Math.trunc(child.maxCount) || 32)
            regions.push({ child, base, cap })
            base += cap
        }
        res.childrenSig = childrenSignature(def, res.capacity)

        // 父缓冲：合并实例 + 事件（ChildInstance = 4×vec4 = 64B）
        res.instances?.destroy()
        res.events?.destroy()
        res.instances = base > 0
            ? device.createBuffer({ size: base * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
            : null
        res.events = device.createBuffer({ size: MAX_EVENTS * 32 + 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })

        // 写父侧 children 描述表 + childMeta
        const compiledChildren = compileChildren(def)
        for (const w of compiledChildren.warnings) this.onWarning(`[${def.name}] ${w}`)
        const table = new Uint32Array(new ArrayBuffer(MAX_CHILDREN * 32 + 32))
        regions.forEach((r, i) => {
            const code = CHILD_TYPE_CODE[r.child.type]
            table[i * 8 + 0] = code
            table[i * 8 + 1] = Math.max(0, Math.trunc(r.child.controlPointStartIndex))
            table[i * 8 + 2] = 1
            table[i * 8 + 3] = Math.round(Math.min(1, Math.max(0, r.child.probability || 1)) * 1000)
            table[i * 8 + 4] = r.base
            table[i * 8 + 5] = r.cap
        })
        table[MAX_CHILDREN * 8 + 0] = 0
        table[MAX_CHILDREN * 8 + 1] = regions.length
        device.queue.writeBuffer(res.program, CHILDREN_OFFSET, table)

        // 父 bindgroup 需要新缓冲 → 重建
        this.makeBindGroups(res)

        // 创建子系统（static 也记入 children 列表便于整体重建/移除）
        for (const child of def.children) {
            if (!child.def) continue
            const childTex = opts?.childTextures?.[child.name]
            if (child.type === 'static') {

                // static 子的层变换（children 声明的 origin/scale/angles）烘进独立副本
                const layered = applyChildLayerTransform(child.def, child.origin, child.scale, child.angles)
                res.children.push(this.createSystem(layered, childTex ? { texture: childTex } : {}, null))
                continue
            }
            const region = regions.find(r => r.child === child)
            if (!region) continue
            const role: ChildRole = {
                parent:          res,
                type:            CHILD_TYPE_CODE[child.type],
                cpStart:         Math.max(0, Math.trunc(child.controlPointStartIndex)),
                instanceBase:    region.base,
                instanceCap:     region.cap,
                lifetime:        burstLifetime(child.def),
                probability:     Math.min(1, Math.max(0, child.probability || 1)),
            }
            const childRes = this.createSystem(child.def, childTex ? { texture: childTex } : {}, role)

            // 子系统 childMeta：A=(1,myType,cpStart,base) B=(lifetime,cap,prob,0)
            const meta = new Uint32Array(new ArrayBuffer(32))
            const metaF = new Float32Array(meta.buffer)
            meta[0] = 1
            meta[1] = role.type
            meta[2] = role.cpStart
            meta[3] = role.instanceBase
            metaF[4] = role.lifetime
            metaF[5] = role.instanceCap
            metaF[6] = role.probability
            device.queue.writeBuffer(childRes.program, CHILDREN_OFFSET + MAX_CHILDREN * 32, meta)
            this.makeBindGroups(childRes)
            if (childRes.instanceFree && role.type !== ChildType.EventFollow) {
                this.initInstanceFree(childRes)
            }
            res.children.push(childRes)
        }
    }

    private initInstanceFree(res: SystemRes): void {
        if (!res.instanceFree) return
        const free = new Uint32Array(Math.max(4, res.burstCap))
        for (let i = 0; i < res.burstCap; i++) free[i] = i
        this.device.queue.writeBuffer(res.instanceFree, 0, free)
        const counters = new Uint32Array(SYS_BUFFER_SIZE / 4)
        counters[21] = res.burstCap // instFreeCount（偏移 84）
        this.device.queue.writeBuffer(res.sys, 84, counters, 21, 1)
    }

    private updateSystem(
        res: SystemRes,
        def: ParticleSystemDef,
        opts: UpdateSystemOptions = {},
    ): string[] {
        const capacity = Math.min(MAX_CAPACITY, Math.max(1, Math.round(def.maxCount)))
        const compiled = compileProgram(def)
        for (const w of compiled.warnings) this.onWarning(`[${def.name}] ${w}`)

        // children 结构变化 → 整体重建子系统（事件缓冲/实例区域随之重排）
        if (!res.role) {
            const sig = childrenSignature(def, capacity)
            if (sig !== res.childrenSig) {
                for (const c of [...res.children]) this.removeSystem(c.handle.id)
                res.children = []
                this.wireChildren(res, def, opts)
            }
        }

        const tex = opts.texture === undefined ? null : this.resolveTexture(opts)

        // 渲染器模式变化需要重建索引/历史缓冲（容量不同构）
        const rendererChanged = compiled.renderer.mode !== res.rendererMode
        if (capacity === res.capacity && !rendererChanged) {
            this.writeProgramBuffer(res, compiled, capacity)
            if (tex || opts.sampler) {
                if (tex) {
                    res.textureView = tex.view
                    res.spriteFrames = tex.frames
                    res.texAspect = tex.aspect
                    if (!opts.sampler && tex.sampler) res.sampler = tex.sampler
                }
                if (opts.sampler) res.sampler = opts.sampler
                this.makeBindGroups(res)
            }
        }
        else {

            // 容量/渲染器变化：重建缓冲与 bindgroup（粒子状态不可保留）
            for (const b of [res.program, res.particles, res.sys, res.freeList, res.renderIndices, res.sysUniform, res.trailHistory, res.indirect]) b?.destroy()
            const device = this.device
            const idxPerParticle = compiled.renderer.mode === RendererMode.RopeTrail ? MAX_TRAIL_SEGMENTS : 1
            res.program = device.createBuffer({ size: PROGRAM_BUFFER_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
            res.particles = device.createBuffer({ size: capacity * 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
            res.sys = device.createBuffer({ size: SYS_BUFFER_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
            res.freeList = device.createBuffer({ size: capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
            res.renderIndices = device.createBuffer({ size: capacity * idxPerParticle * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
            res.sysUniform = device.createBuffer({ size: SYS_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
            res.trailHistory = compiled.renderer.mode === RendererMode.RopeTrail
                ? device.createBuffer({ size: capacity * MAX_TRAIL_SEGMENTS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
                : null
            res.indirect = device.createBuffer({ size: INDIRECT_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST })
            res.capacity = capacity
            res.rendererMode = compiled.renderer.mode
            res.sortN = compiled.renderer.mode === RendererMode.Rope
                ? 1 << Math.ceil(Math.log2(Math.max(2, capacity)))
                : 2
            if (tex) {
                res.textureView = tex.view
                res.spriteFrames = tex.frames
                res.texAspect = tex.aspect
                if (!opts.sampler && tex.sampler) res.sampler = tex.sampler
            }
            if (opts.sampler) res.sampler = opts.sampler
            this.makeBindGroups(res)
            this.writeProgramBuffer(res, compiled, capacity)
            this.initAliveState(res)
        }

        res.def = def
        res.warnings = compiled.warnings
        res.pipelineRender = this.pickRenderPipeline(def)
        this.writeSpriteUniform(res)

        if (opts.reset) {
            this.initAliveState(res)
            if (def.startTime > 0) this.warmup(res)
        }

        return compiled.warnings
    }

    /** 归一化贴图参数：GPUTexture 或带帧表的 TextureAsset（aspect = 高/宽，WE textureRatio）。 */
    private resolveTexture(opts: { texture?: GPUTexture | TextureAsset }): { view: GPUTextureView, sampler?: GPUSampler, frames?: SpriteFrame[], aspect: number } {
        const t = opts.texture
        if (!t) return { view: this.defaultTextureView, aspect: 1 }
        if ('createView' in t) return { view: t.createView(), aspect: t.height / t.width }

        return { view: t.texture.createView(), sampler: t.sampler, frames: t.frames, aspect: t.texture.height / t.texture.width }
    }

    /** 把 def 的动画模式 + 帧表写进 sprite uniform（仅渲染侧使用）。 */
    private writeSpriteUniform(res: SystemRes): void {
        const def = res.def
        const frames = (res.spriteFrames ?? []).slice(0, MAX_SPRITE_FRAMES)
        const u = new Float32Array(SPRITE_UNIFORM_SIZE / 4)
        const u32 = new Uint32Array(u.buffer)
        if (frames.length) {
            u32[0] = frames.length
            u32[1] = def.animationMode === 'randomframe' ? 2 : 1
            const avg = frames.reduce((a, f) => a + Math.max(f.frametime, 1e-4), 0) / frames.length
            u[4] = avg
            u[5] = def.sequenceMultiplier || 1
            frames.forEach((f, i) => {
                const o = 8 + i * 8
                u[o] = f.x
                u[o + 1] = f.y
                u[o + 2] = f.xAxis[0]
                u[o + 3] = f.xAxis[1]
                u[o + 4] = f.yAxis[0]
                u[o + 5] = f.yAxis[1]
                u[o + 6] = f.frametime
            })
        }
        else {
            u32[0] = 0
        }

        // anim.z = 贴图高/宽比（WE textureRatio，spritetrail 拖尾长度乘子）
        u[6] = Number.isFinite(res.texAspect) && res.texAspect > 0 ? res.texAspect : 1

        // 渲染器参数（mode/length/maxlength/segments；与 compileRenderer 一致）
        // mode 2（ropetrail）的 length 槽写采样间隔 interval（秒）；blend.yzw = fadealpha/uvscale/uvscrolling
        const renderer = compileRenderer(def)
        const ro = (32 + MAX_SPRITE_FRAMES * 2 * 16) / 4
        u[ro] = renderer.mode
        u[ro + 1] = renderer.mode === 2 ? renderer.interval : renderer.length
        u[ro + 2] = renderer.maxlength
        u[ro + 3] = renderer.segments
        u[ro + 4] = Math.min(31, Math.max(0, Math.trunc(def.material.colorBlendMode) || 0))
        const rnd = def.renderers[0] as Record<string, unknown> | undefined
        u[ro + 5] = rnd && (rnd.fadealpha === true || Number(rnd.fadealpha) > 0) ? 1 : 0
        u[ro + 6] = rnd ? Math.max(1e-3, Number(rnd.uvscale) || 1) : 1
        u[ro + 7] = rnd && (rnd.uvscrolling === true || Number(rnd.uvscrolling) > 0) ? 1 : 0
        this.device.queue.writeBuffer(res.spriteUniform, 0, u)
    }

    private writeProgramBuffer(res: SystemRes, compiled: { data: Uint8Array }, capacity: number): void {
        const progData = new Uint8Array(compiled.data)
        new Uint32Array(progData.buffer, COUNTS_OFFSET + 12, 4)[0] = capacity // counts.w
        // 两段写入：children/childMeta 区由 wireChildren 维护，renderer 表在尾段
        this.device.queue.writeBuffer(res.program, 0, progData.buffer, 0, CHILDREN_OFFSET)
        this.device.queue.writeBuffer(res.program, RENDERER_OFFSET, progData.buffer, RENDERER_OFFSET, PROGRAM_BUFFER_SIZE - RENDERER_OFFSET)
    }

    private makeBindGroups(res: SystemRes): void {

        // 父：own instances/events + dummy free；子：父的 instances/events + own instanceFree
        const instancesBuf = res.role ? res.role.parent.instances : res.instances
        const eventsBuf = res.role ? res.role.parent.events : res.events
        const freeBuf = res.instanceFree ?? this.dummyStorages[0]

        res.bgCompute = this.device.createBindGroup({
            layout:  this.bglCompute,
            entries: [
                { binding: 0, resource: { buffer: this.frameUniform } },
                { binding: 1, resource: { buffer: res.sysUniform } },
                { binding: 2, resource: { buffer: res.sys } },
                { binding: 3, resource: { buffer: res.particles } },
                { binding: 4, resource: { buffer: res.program } },
                { binding: 5, resource: { buffer: res.freeList } },
                { binding: 6, resource: { buffer: res.renderIndices } },
                { binding: 7, resource: { buffer: res.indirect } },
                { binding: 8, resource: { buffer: instancesBuf ?? this.dummyStorages[1] } },
                { binding: 9, resource: { buffer: eventsBuf ?? this.dummyStorages[2] } },
                { binding: 10, resource: { buffer: freeBuf } },
                { binding: 12, resource: { buffer: res.trailHistory ?? this.dummyStorages[4] } },
                { binding: 13, resource: { buffer: this.sortParams } },
            ],
        })
        const bglRender = this.renderPipelines.get('additive')!.getBindGroupLayout(0)
        res.bgRender = this.device.createBindGroup({
            layout:  bglRender,
            entries: [
                { binding: 0, resource: { buffer: this.frameUniform } },
                { binding: 1, resource: { buffer: res.sysUniform } },
                { binding: 2, resource: { buffer: res.particles } },
                { binding: 3, resource: { buffer: res.renderIndices } },
                { binding: 4, resource: res.textureView },
                { binding: 5, resource: res.sampler },
                { binding: 6, resource: { buffer: res.spriteUniform } },
                { binding: 7, resource: { buffer: res.trailHistory ?? this.dummyStorages[4] } },
            ],
        })
    }

    private initAliveState(
        b: Pick<SystemRes, 'capacity' | 'freeList' | 'particles' | 'sys'>,
        zeroParticles = true,
    ): void {
        const capacity = b.capacity
        const free = new Uint32Array(capacity)
        for (let i = 0; i < capacity; i++) free[i] = i
        this.device.queue.writeBuffer(b.freeList, 0, free)
        const counters = new Uint32Array(SYS_BUFFER_SIZE / 4)
        counters[3] = capacity // freeCount
        this.device.queue.writeBuffer(b.sys, 0, counters)
        if (zeroParticles) {

            // 清掉所有槽的 state（WebGPU 新建缓冲本为零，但 reset 时槽里有旧数据）
            const zeros = new Uint32Array(256 * 1024) // 1MB 块
            const total = capacity * 128
            for (let off = 0; off < total; off += zeros.byteLength) {
                const n = Math.min(zeros.byteLength, total - off)
                this.device.queue.writeBuffer(b.particles, off, zeros.buffer, 0, n)
            }
        }
    }

    private removeSystem(id: number): void {
        const idx = this.systems.findIndex(s => s.handle.id === id)
        if (idx < 0) return
        const s = this.systems[idx]

        // 先递归移除子系统（子借用父的缓冲，不能先销毁）
        for (const c of [...s.children]) this.removeSystem(c.handle.id)
        for (const b of [s.program, s.particles, s.sys, s.freeList, s.renderIndices, s.sysUniform, s.spriteUniform, s.indirect, s.instances, s.events, s.instanceFree, s.trailHistory, s.statsStaging]) b?.destroy()
        this.systems.splice(idx, 1)
    }

    /** 重置所有系统（清空粒子、重建 free-list、时间归零、重跑 warmup）。 */
    reset(): void {
        this.simTime = 0
        for (const s of this.systems) {
            this.initAliveState(s, true)
            if (s.role && s.instanceFree) this.initInstanceFree(s)
            if (s.instances) {
                const zeros = new Uint32Array(256 * 1024)
                const total = s.instances.size
                for (let off = 0; off < total; off += zeros.byteLength) {
                    const n = Math.min(zeros.byteLength, total - off)
                    this.device.queue.writeBuffer(s.instances, off, zeros.buffer, 0, n)
                }
            }
            if (s.events) this.device.queue.writeBuffer(s.events, 0, new Uint32Array(64))
            if (s.handle.def.startTime > 0) this.warmup(s)
        }
    }

    private warmup(res: SystemRes): void {
        const steps = Math.min(240 * 10, Math.ceil(res.handle.def.startTime * 60))
        this.writeFrameUniform(res.handle.def.startTime, 1 / 60)
        const all = [res, ...res.children]
        for (const s of all) this.writeSysUniform(s)
        const encoder = this.device.createCommandEncoder()
        for (let i = 0; i < steps; i++) {
            for (const s of all) this.dispatchSystemPasses(encoder, s)
        }
        this.device.queue.submit([encoder.finish()])
    }

    // ---------------------------------------------------------------- frame

    start(): void {
        if (this.running) return
        this.running = true
        this.lastNow = performance.now()
        let errored = false
        const loop = (now: number) => {
            if (!this.running) return
            try {
                this.tick(now)
                errored = false
            }
            catch(err) {

                // 帧内异常不能杀死循环（编辑器场景需要持续出帧），只上报一次
                if (!errored) {
                    errored = true
                    this.onWarning(`帧循环异常: ${err instanceof Error ? err.message : String(err)}`)
                }
            }
            this.raf = requestAnimationFrame(loop)
        }
        this.raf = requestAnimationFrame(loop)
    }

    stop(): void {
        this.running = false
        cancelAnimationFrame(this.raf)
    }

    setPaused(paused: boolean): void {
        this.playing = !paused
    }

    /** 暂停时单步一帧（固定 1/60s × 速度倍率）。 */
    step(): void {
        const dt = 1 / 60 * this.speedMul
        this.simTime += dt

        // cpAngleDriver 由 renderFrame 内逐系统应用
        this.renderFrame(dt, true)
        this.sampleStats(performance.now())
    }

    /**
     * 设置透视相机（null 恢复 2D 正交）。eye/target/up 为粒子世界坐标（像素单位，+y 向上），
     * fov 为垂直视场角（度）。
     */
    setCamera(cam: { eye: Vec3, target: Vec3, up?: Vec3, fov?: number } | null): void {
        this.camera = cam
            ? { eye: cam.eye, target: cam.target, up: cam.up ?? [0, 0, 1], fov: cam.fov ?? 50 }
            : null
    }

    /** 播放速度倍率（发射率/运动/时间统一缩放；对应 WE instanceoverride.speed）。 */
    setSpeed(multiplier: number): void {
        this.speedMul = Math.max(0, multiplier)
    }

    /** 背景色（渲染 pass 的 clear 值）。 */
    setClearColor(color: { r: number; g: number; b: number; a: number }): void {
        this.clearColor = color
    }

    /** 控制点角度动画驱动器（每帧以 simTime 求值写入 cpAngles；null 清除）。 */
    setControlPointAngleDriver(index: number, fn: ((simTime: number) => Vec3) | null): void {
        this.cpAngleDriver = fn && index >= 0 && index < 8 ? { index, fn } : null
    }

    /**
     * 每帧角度写入：def.controlPoints[i].spin 的线性进动（angles + spin·t）全量重写，
     * 手动驱动器（setControlPointAngleDriver）随后覆盖对应槽位。
     */
    private applyCpAngleDriver(s: SystemRes): void {
        const def = s.handle.def
        const u = new Float32Array(8 * 4)
        let hasSpin = false
        for (let i = 0; i < 8; i++) {
            const cp = def.controlPoints[i]
            if (!cp) continue
            const spin = cp.spin
            if (!spin || spin[0] === 0 && spin[1] === 0 && spin[2] === 0) continue
            hasSpin = true
            u[i * 4] = cp.angles[0] + spin[0] * this.simTime
            u[i * 4 + 1] = cp.angles[1] + spin[1] * this.simTime
            u[i * 4 + 2] = cp.angles[2] + spin[2] * this.simTime
        }
        if (hasSpin) this.device.queue.writeBuffer(s.sysUniform, 40 * 4, u)

        if (!this.cpAngleDriver) return
        const a = this.cpAngleDriver.fn(this.simTime)
        const o = new Float32Array([a[0], a[1], a[2], 0])
        const byteOffset = (40 + this.cpAngleDriver.index * 4) * 4
        this.device.queue.writeBuffer(s.sysUniform, byteOffset, o)
    }

    setPointer(canvasX: number, canvasY: number): void {
        const dpr = this.canvas.width / this.canvas.clientWidth || 1
        const px = canvasX * dpr
        const py = canvasY * dpr
        this.pointerWorld = [px - this.canvas.width / 2, this.canvas.height / 2 - py]
    }

    get stats(): RuntimeStats {
        return { fps: this.fps, systems: Object.fromEntries(this.systems.map(s => [s.handle.def.name, s.stats])) }
    }

    get time(): number {
        return this.simTime
    }

    private tick(now: number): void {
        const dt = Math.min(1 / 30, Math.max(0, (now - this.lastNow) / 1000)) * this.speedMul
        this.lastNow = now

        this.fpsFrames++
        if (now - this.fpsLast > 500) {
            this.fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsLast))
            this.fpsFrames = 0
            this.fpsLast = now
        }

        if (this.playing) this.simTime += dt

        // cpAngleDriver 由 renderFrame 内逐系统应用
        this.renderFrame(dt, this.playing)
        this.sampleStats(now)
    }

    private renderFrame(dt: number, simulate: boolean): void {
        if (!this.systems.length || !this.bgTexture || !this.blitGroup) {

            // 仍然要出帧（离屏清屏 + blit）
            const encoder = this.device.createCommandEncoder()
            this.drawSystems(encoder, [], this.bgTexture?.createView() ?? this.ctx.getCurrentTexture().createView(), this.clearColor, this.bgPlaceholderGroup!)
            if (this.blitGroup && this.bgTexture) {
                this.beginRender(encoder, pass => {
                    pass.setPipeline(this.blitPipeline)
                    pass.setBindGroup(0, this.blitGroup)
                    pass.draw(3)
                })
            }
            this.device.queue.submit([encoder.finish()])

            return
        }
        this.writeFrameUniform(this.time, simulate ? dt : 0)
        const encoder = this.device.createCommandEncoder()
        const ropeSystems: SystemRes[] = []
        for (const s of this.systems) {
            this.writeSysUniform(s)

            // 驱动器在 writeSysUniform 之后覆盖（每帧全量重写 def 角度会冲掉动画值）
            this.applyCpAngleDriver(s)
            if (simulate) {
                this.dispatchSystemPasses(encoder, s)
                if (s.rendererMode === RendererMode.Rope) ropeSystems.push(s)
            }
        }
        this.device.queue.submit([encoder.finish()])

        // rope bitonic 排序：每 pass 依赖 CPU 写参（writeBuffer 在 submit 时生效，须逐 pass 提交）
        if (simulate && ropeSystems.length) {
            for (const s of ropeSystems) this.runRopeSort(s)
        }

        // pass A：正常系统 → 离屏场景纹理；pass B：blit 底图 + colorBlendMode 系统（采样离屏合成）
        const blended = this.systems.filter(s => s.def.material.colorBlendMode > 0)
        const normal = this.systems.filter(s => s.def.material.colorBlendMode === 0)
        const renderEncoder = this.device.createCommandEncoder()
        this.drawSystems(renderEncoder, normal, this.bgTexture!.createView(), this.clearColor, this.bgPlaceholderGroup!)
        this.beginRender(renderEncoder, pass => {
            pass.setPipeline(this.blitPipeline)
            pass.setBindGroup(0, this.blitGroup!)
            pass.draw(3)
            if (blended.length && this.bgSnapshotGroup) {
                pass.setBindGroup(1, this.bgSnapshotGroup)
                for (const s of blended) {
                    pass.setPipeline(s.pipelineRender)
                    pass.setBindGroup(0, s.bgRender)
                    pass.drawIndirect(s.indirect, 0)
                }
            }
        })
        this.device.queue.submit([renderEncoder.finish()])
    }

    private drawSystems(encoder: GPUCommandEncoder, systems: SystemRes[], target: GPUTextureView, clearValue: GPUColor, bgGroup: GPUBindGroup): void {
        this.beginRenderOn(encoder, target, clearValue, pass => {
            pass.setBindGroup(1, bgGroup)
            for (const s of systems) {
                pass.setPipeline(s.pipelineRender)
                pass.setBindGroup(0, s.bgRender)
                pass.drawIndirect(s.indirect, 0)
            }
        })
    }

    /** rope 排序：init（count 之后置 INVALID）+ bitonic 全网络（按 spawnSequence 升序）。 */
    private runRopeSort(s: SystemRes): void {
        const params = new Uint32Array(4)
        const sortWg = Math.ceil(s.sortN / WORKGROUP_SIZE)

        // init
        let encoder = this.device.createCommandEncoder()
        let pass = encoder.beginComputePass()
        pass.setBindGroup(0, s.bgCompute)
        pass.setPipeline(this.pipelines.ropeSortInit)
        pass.dispatchWorkgroups(Math.ceil(s.capacity / WORKGROUP_SIZE))
        pass.end()
        this.device.queue.submit([encoder.finish()])

        // bitonic 网络：for k in [2,4..N] for j in [k/2 .. 1]
        for (let k = 2; k <= s.sortN; k <<= 1) {
            for (let j = k >> 1; j > 0; j >>= 1) {
                params[0] = k
                params[1] = j
                params[2] = s.sortN
                this.device.queue.writeBuffer(this.sortParams, 0, params)
                encoder = this.device.createCommandEncoder()
                pass = encoder.beginComputePass()
                pass.setBindGroup(0, s.bgCompute)
                pass.setPipeline(this.pipelines.ropeSort)
                pass.dispatchWorkgroups(sortWg)
                pass.end()
                this.device.queue.submit([encoder.finish()])
            }
        }
    }

    private dispatchSystemPasses(encoder: GPUCommandEncoder, s: SystemRes): void {
        const capacity = s.handle.capacity
        const pass = encoder.beginComputePass()
        pass.setBindGroup(0, s.bgCompute)
        pass.setPipeline(this.pipelines.prepare)
        pass.dispatchWorkgroups(1)
        if (s.role) {

            // 子系统：实例老化 → 父事件分配 → 每实例发射 → 模拟
            const instanceWg = Math.ceil(s.role.instanceCap / WORKGROUP_SIZE)
            pass.setPipeline(this.pipelines.childInstance)
            pass.dispatchWorkgroups(instanceWg)
            pass.setPipeline(this.pipelines.childEvent)
            pass.dispatchWorkgroups(MAX_WORKGROUPS_FOR_EVENTS)
            pass.setPipeline(this.pipelines.childSpawn)
            pass.dispatchWorkgroups(Math.ceil(s.role.instanceCap * INSTANCE_SPAWN_THREADS / WORKGROUP_SIZE))
        }
        else {
            pass.setPipeline(this.pipelines.spawn)
            pass.dispatchWorkgroups(SPAWN_WORKGROUPS)
        }
        pass.setPipeline(this.pipelines.simulate)
        pass.dispatchWorkgroups(Math.ceil(capacity / WORKGROUP_SIZE))
        pass.setPipeline(this.pipelines.finalize)
        pass.dispatchWorkgroups(1)
        pass.end()
    }

    /** colorBlendMode > 0 的系统：合成在 shader 内完成后按 translucent 上屏。 */
    private pickRenderPipeline(def: ParticleSystemDef): GPURenderPipeline {
        if (def.material.colorBlendMode > 0) return this.renderPipelines.get('translucent')!

        return this.renderPipelines.get(def.material.blending) ?? this.renderPipelines.get('additive')!
    }

    private beginRender(encoder: GPUCommandEncoder, draw: (pass: GPURenderPassEncoder) => void): void {
        this.beginRenderOn(encoder, this.ctx.getCurrentTexture().createView(), this.clearColor, draw)
    }

    private beginRenderOn(encoder: GPUCommandEncoder, target: GPUTextureView, clearValue: GPUColor, draw: (pass: GPURenderPassEncoder) => void): void {
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view:       target,
                    clearValue,
                    loadOp:     'clear',
                    storeOp:    'store',
                },
            ],
        })
        draw(pass)
        pass.end()
    }

    private writeFrameUniform(time: number, dt: number): void {
        const f = new Float32Array(FRAME_UNIFORM_SIZE / 4)
        f[0] = time
        f[1] = dt
        f[2] = this.canvas.width
        f[3] = this.canvas.height
        if (this.camera) {

            // 透视：view(lookAt) × perspective，列主序写 vp；camRight/camUp 供面向相机的 quad 轴
            const { eye, target, up, fov } = this.camera
            const zx = eye[0] - target[0], 
                zy = eye[1] - target[1], 
                zz = eye[2] - target[2]
            const zl = Math.hypot(zx, zy, zz) || 1
            const z = [zx / zl, zy / zl, zz / zl] as Vec3
            const xx = up[1] * z[2] - up[2] * z[1], 
                xy = up[2] * z[0] - up[0] * z[2], 
                xz = up[0] * z[1] - up[1] * z[0]
            const xl = Math.hypot(xx, xy, xz) || 1
            const x = [xx / xl, xy / xl, xz / xl] as Vec3
            const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]] as Vec3
            const aspect = this.canvas.width / Math.max(1, this.canvas.height)
            const t = Math.tan(fov * Math.PI / 180 / 2)
            const near = 1, 
                far = 100000
            const tf = near * t, 
                nf = 1 / (near - far)

            // perspective（行主序推导，按列写出）
            const p = [tf / aspect, 0, 0, 0, 0, tf, 0, 0, 0, 0, far * nf, -1, 0, 0, 2 * far * near * nf, 0]

            // view = [x|y|z]^T 平移
            const v = [
                x[0], y[0], z[0], 0,
                x[1], y[1], z[1], 0,
                x[2], y[2], z[2], 0,
                -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
                -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
                -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1,
            ]

            // vp = p × v（投影作用于视图坐标；列主序 4×4 乘法）
            const vp = new Array(16).fill(0)
            for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) vp[c * 4 + r] = p[r] * v[c * 4] + p[4 + r] * v[c * 4 + 1] + p[8 + r] * v[c * 4 + 2] + p[12 + r] * v[c * 4 + 3]
            f.set(vp, 4)
            f.set([eye[0], eye[1], eye[2], this.canvas.height / 2 / t], 20)
            f.set([x[0], x[1], x[2], 1], 24) // camRight + persp 标志
            f.set([y[0], y[1], y[2], 0], 28) // camUp
        }
        else {

            // 正交（默认）：camRight/camUp = 世界 X/Y，与旧路径逐位一致
            f.set([0, 0, -10000, 0], 20)
            f.set([1, 0, 0, 0], 24)
            f.set([0, 1, 0, 0], 28)
        }
        this.device.queue.writeBuffer(this.frameUniform, 0, f)
    }

    private writeSysUniform(s: SystemRes): void {
        const u = new Float32Array(SYS_UNIFORM_SIZE / 4)
        const def = s.handle.def
        u[0] = def.origin[0]
        u[1] = def.origin[1]
        u[2] = def.origin[2]
        u[4] = this.pointerWorld[0]
        u[5] = this.pointerWorld[1]

        // control points：世界坐标 = origin + offset (+ 指针跟随)；angles（WE 控制点角度）
        for (let i = 0; i < 8; i++) {
            const cp = def.controlPoints[i]
            const o = 8 + i * 4
            u[o] = def.origin[0] + cp.offset[0] + (cp.lockToPointer ? this.pointerWorld[0] : 0)
            u[o + 1] = def.origin[1] + cp.offset[1] + (cp.lockToPointer ? this.pointerWorld[1] : 0)
            u[o + 2] = def.origin[2] + cp.offset[2]
            const a = 40 + i * 4
            u[a] = cp.angles[0]
            u[a + 1] = cp.angles[1]
            u[a + 2] = cp.angles[2]
        }
        this.device.queue.writeBuffer(s.sysUniform, 0, u)
    }

    private sampleStats(now: number): void {
        if (now - this.statsClock < 500) return
        this.statsClock = now
        for (const s of this.systems) {
            if (s.statsPending || !s.statsStaging) continue
            s.statsPending = true
            const encoder = this.device.createCommandEncoder()
            encoder.copyBufferToBuffer(s.sys, 0, s.statsStaging, 0, 16)
            this.device.queue.submit([encoder.finish()])
            s.statsStaging
                .mapAsync(GPUMapMode.READ)
                .then(() => {
                    const data = new Uint32Array(s.statsStaging!.getMappedRange(), 0, 4)
                    s.stats = { alive: data[0], rendered: data[1] }
                    s.statsStaging!.unmap()
                    s.statsPending = false
                })
                .catch(() => {
                    s.statsPending = false
                })
        }
    }

    private resize = (): void => {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
        const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w
            this.canvas.height = h
            this.ensureBgTexture()
        }
    }

    /** 离屏场景纹理：pass A 的渲染目标，也是混合模式系统的采样源。 */
    private ensureBgTexture(): void {
        const w = this.canvas.width
        const h = this.canvas.height
        if (this.bgTexture && this.bgTexture.width === w && this.bgTexture.height === h) return
        this.bgTexture?.destroy()
        this.bgTexture = this.device.createTexture({
            size:   [w, h],
            format: this.format,
            usage:  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.bgSnapshotGroup = this.device.createBindGroup({
            layout:  this.bglBg,
            entries: [{ binding: 0, resource: this.bgTexture.createView() }],
        })
        this.blitGroup = this.device.createBindGroup({
            layout:  this.blitPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.bgTexture.createView() },
                { binding: 1, resource: this.defaultSampler },
            ],
        })
    }

    destroy(): void {
        this.stop()
        this.resizeObserver?.disconnect()
        window.removeEventListener('resize', this.resize)
        for (const s of [...this.systems]) this.removeSystem(s.handle.id)
    }
}

/** WE SpawnType → GPU 类型码。 */
const CHILD_TYPE_CODE: Record<SpawnType, number> = {
    static:      ChildType.Static,
    eventdeath:  ChildType.EventDeath,
    eventspawn:  ChildType.EventSpawn,
    eventfollow: ChildType.EventFollow,
}

/** children 结构签名：变化时触发子系统重建。 */
function childrenSignature(def: ParticleSystemDef, capacity: number): string {
    return JSON.stringify([
        capacity,
        def.children.map(c => [c.name, c.type, c.maxCount, c.controlPointStartIndex, c.probability]),
    ])
}
