/** billboard 渲染：instanced quad，从 storage buffer 直读粒子（无顶点缓冲上传）。 */

// prettier-ignore
export const BILLBOARD_WGSL = /* wgsl */ `
struct Frame {
  time: f32, dt: f32, resX: f32, resY: f32,
};
struct SysUniform {
  origin: vec4f,
  pointer: vec4f,
  controlPoints: array<vec4f, 8>,
};
struct Particle {
  position: vec3f, lifetime: f32,
  simPos: vec3f, initLifetime: f32,
  velocity: vec3f, random: f32,
  rotation: vec3f, size: f32,
  angularVelocity: vec3f, initSize: f32,
  color: vec3f, alpha: f32,
  initColor: vec3f, initAlpha: f32,
  age: f32, spawnSequence: u32, state: u32, _pad: u32,
};
struct SpriteUniform {
  params: vec4u,                    // x: frameCount  y: mode(0 无 / 1 sequence / 2 randomframe)
  anim: vec4f,                      // x: 平均帧时长  y: sequenceMultiplier
  frames: array<vec4f, 256>,        // [2i] = (x, y, xAxis.x, xAxis.y)  [2i+1] = (yAxis.x, yAxis.y, frametime, 0)
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> sysUniform: SysUniform;
@group(0) @binding(2) var<storage, read> particles: array<Particle>;
@group(0) @binding(3) var<storage, read> renderIndices: array<u32>;
@group(0) @binding(4) var tex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var<uniform> sprite: SpriteUniform;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let pi = renderIndices[ii];
  let p = particles[pi];

  // 两个三角形拼 quad（6 顶点，无索引缓冲）
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let c = corners[vi];

  // 面向摄像机的 2D 旋转（roll = rotation.z）
  let rot = p.rotation.z;
  let cs = cos(rot);
  let sn = sin(rot);
  let rc = vec2f(c.x * cs - c.y * sn, c.x * sn + c.y * cs);

  let world = p.position.xy + rc * max(p.size, 0.0) * 0.5;
  // 世界坐标（像素，原点在画布中心，+y 向上）→ NDC（WebGPU NDC +y 也朝上，无需翻转）
  let ndc = vec2f(world.x / frame.resX * 2.0, world.y / frame.resY * 2.0);

  var o: VOut;
  o.pos = vec4f(ndc, 0.0, 1.0);

  // sprite sheet：quad uv → 图集 uv（xAxis/yAxis 支持 WE 的旋转打包）
  var uv = c * 0.5 + vec2f(0.5);
  let fc = sprite.params.x;
  if (fc > 0u) {
    var fi = 0u;
    if (sprite.params.y == 2u) {
      // randomframe：以粒子的 random 值选帧
      fi = u32(min(p.random, 0.999) * f32(fc));
    } else {
      // sequence：按寿命循环播放（sequencemultiplier 加速）
      let t = p.age * max(sprite.anim.y, 1e-4) / max(sprite.anim.x, 1e-4);
      fi = u32(t) % fc;
    }
    let f0 = sprite.frames[fi * 2u];
    let f1 = sprite.frames[fi * 2u + 1u];
    uv = vec2f(f0.x, f0.y) + uv.x * vec2f(f0.z, f0.w) + uv.y * vec2f(f1.x, f1.y);
  }
  o.uv = uv;
  o.color = vec4f(p.color, clamp(p.alpha, 0.0, 1.0));
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, in.uv);
  return vec4f(in.color.rgb * t.rgb, in.color.a * t.a);
}
`
