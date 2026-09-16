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
  blend: vec4f,                     // x: colorBlendMode（0 无 / 1-31 WE 编号）
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

// group 1：帧背景快照（colorBlendMode 合成用；无混合时绑 1×1 白）
@group(1) @binding(0) var bgTex: texture_2d<f32>;

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


// ---------- Photoshop 式混合（移植自 WE common_blending.h，A=背景 B=前景） ----------
fn rgbToHsl(c: vec3f) -> vec3f {
  let fmin = min(min(c.r, c.g), c.b);
  let fmax = max(max(c.r, c.g), c.b);
  let delta = fmax - fmin;
  var hsl = vec3f(0.0, 0.0, (fmax + fmin) * 0.5);
  if (delta > 0.0) {
    hsl.y = select(delta / (2.0 - fmax - fmin), delta / (fmax + fmin), hsl.z < 0.5);
    let deltaR = (((fmax - c.r) / 6.0) + (delta * 0.5)) / delta;
    let deltaG = (((fmax - c.g) / 6.0) + (delta * 0.5)) / delta;
    let deltaB = (((fmax - c.b) / 6.0) + (delta * 0.5)) / delta;
    if (c.r == fmax) { hsl.x = deltaB - deltaG; }
    else if (c.g == fmax) { hsl.x = (1.0 / 3.0) + deltaR - deltaB; }
    else { hsl.x = (2.0 / 3.0) + deltaG - deltaR; }
    if (hsl.x < 0.0) { hsl.x += 1.0; } else if (hsl.x > 1.0) { hsl.x -= 1.0; }
  }

  return hsl;
}
fn hueToRGB(f1: f32, f2: f32, hue_: f32) -> f32 {
  var hue = hue_;
  if (hue < 0.0) { hue += 1.0; } else if (hue > 1.0) { hue -= 1.0; }
  if ((6.0 * hue) < 1.0) { return f1 + (f2 - f1) * 6.0 * hue; }
  if ((2.0 * hue) < 1.0) { return f2; }
  if ((3.0 * hue) < 2.0) { return f1 + (f2 - f1) * ((2.0 / 3.0) - hue) * 6.0; }

  return f1;
}
fn hslToRGB(hsl: vec3f) -> vec3f {
  if (hsl.y == 0.0) { return vec3f(hsl.z); }
  let f2 = select((hsl.z + hsl.y) - (hsl.y * hsl.z), hsl.z * (1.0 + hsl.y), hsl.z < 0.5);
  let f1 = 2.0 * hsl.z - f2;

  return vec3f(hueToRGB(f1, f2, hsl.x + (1.0 / 3.0)), hueToRGB(f1, f2, hsl.x), hueToRGB(f1, f2, hsl.x - (1.0 / 3.0)));
}
fn blendOverlayf(base: f32, blend: f32) -> f32 {
  return select(1.0 - 2.0 * (1.0 - base) * (1.0 - blend), 2.0 * base * blend, base < 0.5);
}
fn blendSoftLightf(base: f32, blend: f32) -> f32 {
  return select(sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend),
                2.0 * base * blend + base * base * (1.0 - 2.0 * blend), blend < 0.5);
}
fn blendColorDodgef(base: f32, blend: f32) -> f32 {
  return select(min(base / max(1.0 - blend, 1e-4), 1.0), blend, blend == 1.0);
}
fn blendColorBurnf(base: f32, blend: f32) -> f32 {
  return select(max(1.0 - ((1.0 - base) / max(blend, 1e-4)), 0.0), blend, blend == 0.0);
}
fn blendReflectf(base: f32, blend: f32) -> f32 {
  return select(min(base * base / max(1.0 - blend, 1e-4), 1.0), blend, blend == 1.0);
}
// WGSL 无函数指针：每通道混合展开为 vec3 版本
fn vOverlay(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(blendOverlayf(a.r, b.r), blendOverlayf(a.g, b.g), blendOverlayf(a.b, b.b));
}
fn vSoftLight(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(blendSoftLightf(a.r, b.r), blendSoftLightf(a.g, b.g), blendSoftLightf(a.b, b.b));
}
fn vColorDodge(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(blendColorDodgef(a.r, b.r), blendColorDodgef(a.g, b.g), blendColorDodgef(a.b, b.b));
}
fn vColorBurn(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(blendColorBurnf(a.r, b.r), blendColorBurnf(a.g, b.g), blendColorBurnf(a.b, b.b));
}
fn vReflect(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(blendReflectf(a.r, b.r), blendReflectf(a.g, b.g), blendReflectf(a.b, b.b));
}

/** WE ApplyBlending 的运行时分发（mode: 1-31，A=背景 B=前景，opacity 混合权重）。 */
fn applyBlend(mode: u32, A: vec3f, B: vec3f, opacity: f32) -> vec3f {
  var F = B;
  switch mode {
    case 1u { F = min(A, B); }
    case 2u { F = A * B; }
    case 3u { F = vColorBurn(A, B); }
    case 4u, 20u { F = max(A + B - vec3f(1.0), vec3f(0.0)); }
    case 5u { return min(A, B); }
    case 6u { F = max(A, B); }
    case 7u { F = vec3f(1.0) - (vec3f(1.0) - A) * (vec3f(1.0) - B); }
    case 8u { F = vColorDodge(A, B); }
    case 9u { F = min(A + B, vec3f(1.0)); }
    case 10u { return max(A, B); }
    case 11u { F = vOverlay(A, B); }
    case 12u { F = vSoftLight(A, B); }
    case 13u { F = vOverlay(B, A); }
    case 14u { F = select(vColorDodge(A, 2.0 * (B - vec3f(0.5))), vColorBurn(A, B * 2.0), B < vec3f(0.5)); }
    case 15u { F = select(min(A + 2.0 * (B - vec3f(0.5)), vec3f(1.0)), max(A + 2.0 * B - vec3f(1.0), vec3f(0.0)), B < vec3f(0.5)); }
    case 16u { F = select(max(A, 2.0 * (B - vec3f(0.5))), min(A, 2.0 * B), B < vec3f(0.5)); }
    case 17u { F = select(vec3f(1.0), vec3f(0.0), vColorBurn(A, B) + vColorDodge(A, B) < vec3f(0.5)); }
    case 18u { F = abs(A - B); }
    case 19u { F = A + B - 2.0 * A * B; }
    case 21u { F = vReflect(A, B); }
    case 22u { F = vReflect(B, A); }
    case 23u { F = min(A, B) - max(A, B) + vec3f(1.0); }
    case 24u { F = (A + B) * 0.5; }
    case 25u { F = vec3f(1.0) - abs(vec3f(1.0) - A - B); }
    case 26u { F = hslToRGB(vec3f(rgbToHsl(B).r, rgbToHsl(A).g, rgbToHsl(A).b)); }
    case 27u { F = hslToRGB(vec3f(rgbToHsl(A).r, rgbToHsl(B).g, rgbToHsl(A).b)); }
    case 28u { let bh = rgbToHsl(B); F = hslToRGB(vec3f(bh.r, bh.g, rgbToHsl(A).b)); }
    case 29u { F = hslToRGB(vec3f(rgbToHsl(A).r, rgbToHsl(A).g, rgbToHsl(B).b)); }
    case 30u { F = vec3f(max(A.r, max(A.g, A.b))) * B; }
    case 31u { return A + B * opacity; }
    default { return B; }
  }

  return mix(A, F, opacity);
}
\n@vertex
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
  var rgb = in.color.rgb * t.rgb;
  let a = in.color.a * t.a;
  let mode = u32(sprite.blend.x);
  if (mode > 0u) {
    // colorBlendMode：采样当前帧背景做 Photoshop 式合成（WE _rt_FullFrameBuffer 语义）
    let bg = textureSample(bgTex, samp, in.pos.xy / vec2f(frame.resX, frame.resY)).rgb;
    rgb = applyBlend(mode, bg, rgb, 1.0);
  }

  return vec4f(rgb, a);
}
`

/** 全屏 blit（离屏场景 → 画布）。 */
// prettier-ignore
export const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let c = corners[vi];
  var o: VOut;
  o.pos = vec4f(c, 0.0, 1.0);
  o.uv = vec2f((c.x + 1.0) * 0.5, 1.0 - (c.y + 1.0) * 0.5);
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, in.uv);
}
`
