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

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> sysUniform: SysUniform;
@group(0) @binding(2) var<storage, read> particles: array<Particle>;
@group(0) @binding(3) var<storage, read> renderIndices: array<u32>;
@group(0) @binding(4) var tex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

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
  o.uv = c * 0.5 + vec2f(0.5);
  o.color = vec4f(p.color, clamp(p.alpha, 0.0, 1.0));
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, in.uv);
  return vec4f(in.color.rgb * t.rgb, in.color.a * t.a);
}
`
