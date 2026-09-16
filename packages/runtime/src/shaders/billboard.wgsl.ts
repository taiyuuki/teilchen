/**
 * billboard 渲染：instanced quad，从 storage buffer 直读粒子（无顶点缓冲上传）。
 * 四种渲染模式（SpriteUniform.renderer.x）：
 *   0 sprite      —— 相机面向 quad（rotation.z 旋转）
 *   1 spritetrail —— 沿速度方向拉伸的 quad（运动拖影，头锚定粒子位置）
 *   2 ropetrail   —— 历史环上相邻采样点连段（条目 = slot*64 + j）
 *   3 rope        —— 排序后相邻粒子连段（条目 = 裸槽位）
 */

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
  age: f32, spawnSequence: u32, state: u32, instanceId: u32,
};
struct SpriteUniform {
  params: vec4u,                    // x: frameCount  y: mode(0 无 / 1 sequence / 2 randomframe)
  anim: vec4f,                      // x: 平均帧时长  y: sequenceMultiplier
  frames: array<vec4f, 256>,        // [2i] = (x, y, xAxis.x, xAxis.y)  [2i+1] = (yAxis.x, yAxis.y, frametime, 0)
  renderer: vec4f,                  // x: 渲染模式  y: length  z: maxlength  w: segments
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> sysUniform: SysUniform;
@group(0) @binding(2) var<storage, read> particles: array<Particle>;
@group(0) @binding(3) var<storage, read> renderIndices: array<u32>;
@group(0) @binding(4) var tex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var<uniform> sprite: SpriteUniform;
// ropetrail 历史环（渲染侧只读）
@group(0) @binding(7) var<storage, read> trailHistory: array<vec4f>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

const INVALID: u32 = 4294967295u;
const TRAIL_STRIDE: u32 = 64u;

/** ropetrail：粒子 slot 的历史采样点。k=0 为当前位置；k≥1 取第 (bin-k+1) 桶。 */
fn trailPoint(slot: u32, bin: u32, segs: u32, k: u32, head: vec3f) -> vec3f {
  if (k == 0u) { return head; }
  let b = bin - (k - 1u);
  let s = trailHistory[slot * TRAIL_STRIDE + (b % segs)];
  if (u32(s.w) != b) { return head; } // 桶号不符（早于出生）→ 收缩到头部
  return s.xyz;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  // 两个三角形拼 quad（6 顶点，无索引缓冲）；mode 决定 quad 的世界空间含义
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let c = corners[vi];
  let mode = u32(sprite.renderer.x);

  var world = vec2f(0.0);
  var uv = c * 0.5 + vec2f(0.5);
  var color = vec4f(1.0);

  if (mode == 0u || mode == 1u) {
    // ---- sprite / spritetrail：每实例一个粒子 ----
    let p = particles[renderIndices[ii]];
    color = vec4f(p.color, clamp(p.alpha, 0.0, 1.0));

    // sprite sheet：quad uv → 图集 uv（xAxis/yAxis 支持 WE 的旋转打包）
    let fc = sprite.params.x;
    if (fc > 0u) {
      var fi = 0u;
      if (sprite.params.y == 2u) {
        fi = u32(min(p.random, 0.999) * f32(fc));
      } else {
        let t = p.age * max(sprite.anim.y, 1e-4) / max(sprite.anim.x, 1e-4);
        fi = u32(t) % fc;
      }
      let f0 = sprite.frames[fi * 2u];
      let f1 = sprite.frames[fi * 2u + 1u];
      uv = vec2f(f0.x, f0.y) + uv.x * vec2f(f0.z, f0.w) + uv.y * vec2f(f1.x, f1.y);
    }

    if (mode == 0u) {
      // sprite：面向相机的 quad（roll = rotation.z）
      let rot = p.rotation.z;
      let cs = cos(rot);
      let sn = sin(rot);
      let rc = vec2f(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
      world = p.position.xy + rc * max(p.size, 0.0) * 0.5;
    } else {
      // spritetrail：沿速度拉伸（WE：像素长 = clamp(speed × length, 0, maxlength)），头锚定粒子
      let sp = length(p.velocity.xy);
      let L = clamp(sp * sprite.renderer.y, max(p.size, 1.0), max(sprite.renderer.z, max(p.size, 1.0)));
      let d = select(vec2f(1.0, 0.0), normalize(p.velocity.xy), sp > 1e-4);
      let n = vec2f(-d.y, d.x);
      let half = max(p.size, 1.0) * 0.5;
      // c.x∈[-1,1] → 段向 [-L/2, L/2]，整体后移 (L-size)/2 使头在粒子处
      world = p.position.xy + d * (c.x * L * 0.5 - (L * 0.5 - half)) + n * c.y * half;
    }
  }
  else if (mode == 2u) {
    // ---- ropetrail：条目 j 连接历史点 S(j) → S(j+1) ----
    let entry = renderIndices[ii];
    let slot = entry / TRAIL_STRIDE;
    let j = entry % TRAIL_STRIDE;
    let p = particles[slot];
    let segs = max(u32(sprite.renderer.w), 2u);
    let bin = u32(frame.time / max(sprite.renderer.z / f32(segs), 1e-3));
    let A = trailPoint(slot, bin, segs, j, p.position);
    let B = trailPoint(slot, bin, segs, j + 1u, p.position);
    let d = B - A;
    let len2 = length(d.xy);
    let dir = select(vec2f(1.0, 0.0), normalize(d.xy), len2 > 1e-4);
    let nrm = vec2f(-dir.y, dir.x);
    // 宽度与透明度沿尾部渐减
    let tf = 1.0 - f32(j) / f32(segs);
    let width = max(p.size, 1.0) * 0.5 * (0.35 + 0.65 * tf);
    world = A.xy + dir * (c.x * 0.5 + 0.5) * len2 + nrm * c.y * width;
    uv = vec2f(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5);
    color = vec4f(p.color, clamp(p.alpha * tf, 0.0, 1.0));
  }
  else {
    // ---- rope：排序后相邻两条目连段 ----
    let slotA = renderIndices[ii];
    let slotB = renderIndices[ii + 1u];
    let a = particles[slotA];
    let b = particles[slotB];
    let d = b.position - a.position;
    let len2 = length(d.xy);
    let dir = select(vec2f(1.0, 0.0), normalize(d.xy), len2 > 1e-4);
    let nrm = vec2f(-dir.y, dir.x);
    let width = max((a.size + b.size) * 0.25, 1.0);
    world = a.position.xy + dir * (c.x * 0.5 + 0.5) * len2 + nrm * c.y * width;
    uv = vec2f(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5);
    color = vec4f((a.color + b.color) * 0.5, clamp((a.alpha + b.alpha) * 0.5, 0.0, 1.0));
  }

  // 世界坐标（像素，原点在画布中心，+y 向上）→ NDC
  let ndc = vec2f(world.x / frame.resX * 2.0, world.y / frame.resY * 2.0);

  var o: VOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = uv;
  o.color = color;

  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, in.uv);
  return vec4f(in.color.rgb * t.rgb, in.color.a * t.a);
}
`
