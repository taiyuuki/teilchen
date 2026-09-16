/** 纹理工具：程序化 halo 贴图 + 图片加载 + 手写 mipmap。 */

export function createHaloTexture(device: GPUDevice): GPUTexture {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)')
    grad.addColorStop(0.6, 'rgba(255,255,255,0.12)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)

    return imageToTexture(device, canvas)
}

export function createWhiteTexture(device: GPUDevice): GPUTexture {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 8, 8)

    return imageToTexture(device, canvas)
}

export async function createTextureFromUrl(device: GPUDevice, url: string): Promise<GPUTexture> {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error(`贴图加载失败: ${url}`))
        img.src = url
    })

    return imageToTexture(device, img)
}

export function imageToTexture(device: GPUDevice, img: HTMLCanvasElement | HTMLImageElement | ImageBitmap): GPUTexture {
    const w = 'naturalWidth' in img ? img.naturalWidth : img.width
    const h = 'naturalHeight' in img ? img.naturalHeight : img.height
    const mipLevelCount = Math.max(1, Math.floor(Math.log2(Math.max(w, h))))
    const texture = device.createTexture({
        size:   [w, h],
        format: 'rgba8unorm',
        usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount,
    })
    device.queue.copyExternalImageToTexture({ source: img }, { texture }, [w, h])
    generateMips(device, texture, mipLevelCount)

    return texture
}

/** 用 blit pass 生成 mipmap（WebGPU 无内置生成）。 */
function generateMips(device: GPUDevice, texture: GPUTexture, mipLevelCount: number): void {
    const shader = /* wgsl */ `
    @group(0) @binding(0) var srcTex: texture_2d<f32>;
    @group(0) @binding(1) var srcSamp: sampler;
    struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
    @vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
      var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
      let c = corners[vi];
      var o: VOut;
      o.pos = vec4f(c, 0.0, 1.0);
      o.uv = c * 0.5 + vec2f(0.5);
      // texture坐标 y 向下，翻转与 copyExternalImageToTexture 保持一致
      o.uv = vec2f(o.uv.x, 1.0 - o.uv.y);
      return o;
    }
    @fragment fn fs(in: VOut) -> @location(0) vec4f {
      return textureSample(srcTex, srcSamp, in.uv);
    }
  `
    const module = device.createShaderModule({ code: shader })
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
    const pipeline = device.createRenderPipeline({
        layout:   'auto',
        vertex:   { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    })
    for (let level = 1; level < mipLevelCount; level++) {
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view:       texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
                    loadOp:     'clear',
                    storeOp:    'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout:  pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
                    { binding: 1, resource: sampler },
                ],
            }),
        )
        pass.draw(3)
        pass.end()
        device.queue.submit([encoder.finish()])
    }
}
