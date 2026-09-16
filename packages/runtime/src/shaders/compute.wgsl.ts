/**
 * 计算着色器：模拟主循环（prepare → spawn → simulate → finalize）。
 * 布局必须与 layout.ts / compile.ts 严格一致。
 *
 * 帧序（对齐 WE 的 CPU 执行顺序）：
 *   prepare(1 线程)   —— 结转发射计时器、算出各 emitter 本帧发射数
 *   spawn(64×16)      —— 每线程发射 1 个粒子：CAS 弹出空闲槽、跑 initializer 管线
 *   simulate(64×N)    —— 生命周期 → 恢复初始值 → operator 链 → 积分 → 追加渲染实例
 *   finalize(1 线程)  —— 把存活数写进 indirect draw 参数
 */

// prettier-ignore
export const COMPUTE_WGSL = /* wgsl */ `
// ---------- 绑定 ----------
struct Frame {
  time: f32,
  dt: f32,
  resX: f32,
  resY: f32,
};
struct SysUniform {
  origin: vec4f,                       // xyz: 层 origin
  pointer: vec4f,                      // xy: 鼠标世界坐标
  controlPoints: array<vec4f, 8>,      // xyz: 世界坐标, w: angle
};
struct Counters {
  alive: atomic<u32>,
  renderCount: atomic<u32>,
  spawnSeq: atomic<u32>,
  freeCount: atomic<u32>,
  emitCounts: vec4u,       // 16
  emitOffsets: vec4u,      // 32
  timers: vec4f,           // 48
  frame: u32, _p0: u32, _p1: u32, _p2: u32,  // 64 → 总 80B
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
struct EmitterGpu {
  kindActive: vec4u,   // x: kind(0 box/1 sphere) y: active z: onePerFrame w: instantaneous
  rateDur: vec4f,      // x: rate y: duration z: speedMin w: speedMax
  origin: vec4f,       // xyz: origin  w: controlpoint 索引（-1 无）
  distMin: vec4f,      // box: xyz min；sphere: x = 半径 min
  distMax: vec4f,      // box: xyz max；sphere: x = 半径 max
  dirSign: vec4f,      // xyz: directions 掩码
  sign: vec4f,         // xyz: 符号强制  w: maxtoemitperperiod
};
struct IniGpu {
  kind: u32, _p0: u32, _p1: u32, _p2: u32,
  a: vec4f, b: vec4f,
};
struct OpGpu {
  kind: u32, _p0: u32, _p1: u32, _p2: u32,
  a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f, f: vec4f,
};
struct Program {
  emitters: array<EmitterGpu, 4>,
  initializers: array<IniGpu, 16>,
  operators: array<OpGpu, 16>,
  counts: vec4u,        // x: emitter 数 y: initializer 数 z: operator 数 w: capacity
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> sysUniform: SysUniform;
@group(0) @binding(2) var<storage, read_write> sys: Counters;
@group(0) @binding(3) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(4) var<storage, read> program: Program;
@group(0) @binding(5) var<storage, read_write> freeList: array<u32>;
@group(0) @binding(6) var<storage, read_write> renderIndices: array<u32>;

const INVALID: u32 = 4294967295u;
const TAU: f32 = 6.28318530718;

// ---------- 随机数（pcg hash，以 spawnSequence 为种子保证每粒子稳定） ----------
fn pcg1d(v_: u32) -> u32 {
  var x = v_;
  x = x * 747796405u + 2891336453u;
  let w = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(seq: u32, i: u32) -> f32 {
  return f32(pcg1d((seq * 668265263u) ^ (i * 374761393u + 668265263u))) / 4294967296.0;
}
fn rnd2(seq: u32, i: u32) -> vec2f {
  return vec2f(rnd(seq, i), rnd(seq, i + 1013904223u));
}
fn gauss3(seq: u32, i: u32) -> vec3f {
  // 球面均匀采样（x/y 必须用同一个方位角 phi）
  let r = vec3f(rnd(seq, i), rnd(seq, i + 1u), rnd(seq, i + 2u));
  let phi = r.x * TAU;
  let cosT = r.z * 2.0 - 1.0;
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  return vec3f(sinT * cos(phi), sinT * sin(phi), cosT);
}

// ---------- 3D value noise + curl（turbulence 用） ----------
fn hash13(p: vec3f) -> f32 {
  var q = fract(p * 0.3183099 + vec3f(0.1, 0.2, 0.3));
  q *= 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3f(0, 0, 0)), hash13(i + vec3f(1, 0, 0)), u.x),
        mix(hash13(i + vec3f(0, 1, 0)), hash13(i + vec3f(1, 1, 0)), u.x), u.y),
    mix(mix(hash13(i + vec3f(0, 0, 1)), hash13(i + vec3f(1, 0, 1)), u.x),
        mix(hash13(i + vec3f(0, 1, 1)), hash13(i + vec3f(1, 1, 1)), u.x), u.y),
    u.z);
}
fn potential(p: vec3f, seed: f32) -> f32 {
  return vnoise(p + vec3f(seed * 37.0, seed * 61.0, seed * 89.0));
}
fn curlNoise(p: vec3f, seed: f32) -> vec3f {
  let e = 0.1;
  let dx = vec3f(e, 0.0, 0.0);
  let dy = vec3f(0.0, e, 0.0);
  let dz = vec3f(0.0, 0.0, e);
  // 向量场 F = (F1,F2,F3)（三个错位 value noise），取旋度
  let dF3dy = (potential(p + dy, seed + 13.0) - potential(p - dy, seed + 13.0));
  let dF2dz = (potential(p + dz, seed + 7.0) - potential(p - dz, seed + 7.0));
  let dF1dz = (potential(p + dz, seed) - potential(p - dz, seed));
  let dF3dx = (potential(p + dx, seed + 13.0) - potential(p - dx, seed + 13.0));
  let dF2dx = (potential(p + dx, seed + 7.0) - potential(p - dx, seed + 7.0));
  let dF1dy = (potential(p + dy, seed) - potential(p - dy, seed));
  let c = vec3f(dF3dy - dF2dz, dF1dz - dF3dx, dF2dx - dF1dy) / (2.0 * e);
  return normalize(c + vec3f(1e-6));
}

// ---------- prepare ----------
@compute @workgroup_size(1)
fn prepareMain() {
  atomicStore(&sys.renderCount, 0u);
  var timers = sys.timers;
  var counts = vec4u(0u);
  var offs = vec4u(0u);
  var total = 0u;
  let eCount = program.counts.x;
  let alive = atomicLoad(&sys.alive);
  for (var e = 0u; e < 4u; e++) {
    if (e >= eCount) { break; }
    let em = program.emitters[e];
    var n = 0u;
    let withinDuration = em.rateDur.y <= 0.0 || frame.time <= em.rateDur.y;
    if (em.kindActive.y == 1u && withinDuration) {
      if (em.kindActive.w > 0u && alive == 0u) {
        // instantaneous：粒子集为空时一次性全发
        n = em.kindActive.w;
      } else if (em.rateDur.x > 0.0) {
        timers[e] += frame.dt;
        var c = u32(floor(timers[e] * em.rateDur.x));
        if (em.kindActive.z == 1u && c > 1u) { c = 1u; }
        let mp = u32(em.sign.w);
        if (mp > 0u && c > mp) { c = mp; }
        timers[e] -= f32(c) / em.rateDur.x;
        n = c;
      }
    }
    counts[e] = n;
    offs[e] = total;
    total += n;
  }
  sys.timers = timers;
  sys.emitCounts = counts;
  sys.emitOffsets = offs;
  sys.frame = sys.frame + 1u;
}

// ---------- spawn ----------
fn popFree() -> u32 {
  loop {
    let c = atomicLoad(&sys.freeCount);
    if (c == 0u) { return INVALID; }
    let r = atomicCompareExchangeWeak(&sys.freeCount, c, c - 1u);
    if (r.exchanged) {
      return freeList[c - 1u];
    }
  }
}

fn mixExp(lo: f32, hi: f32, exp: f32, r: f32) -> f32 {
  return mix(lo, hi, pow(clamp(r, 0.0, 1.0), exp));
}

fn applyInitializer(p: ptr<function, Particle>, ini: IniGpu, seq: u32, k: u32) {
  let r = rnd(seq, 1000u + k);
  switch ini.kind {
    case 0u { (*p).lifetime = mixExp(ini.a.x, ini.a.y, ini.a.z, r); }        // lifetimerandom
    case 1u { (*p).size = mixExp(ini.a.x, ini.a.y, ini.a.z, r); }            // sizerandom
    case 2u { (*p).alpha = mixExp(ini.a.x, ini.a.y, ini.a.z, r); }           // alpharandom
    case 3u {                                                                 // colorrandom（0-255 归一化）
      let t = pow(clamp(r, 0.0, 1.0), ini.a.w);
      (*p).color = mix(ini.a.rgb, ini.b.rgb, vec3f(t));
    }
    case 4u { (*p).velocity = mix(ini.a.rgb, ini.b.rgb, vec3f(pow(clamp(r, 0.0, 1.0), ini.a.w))); }
    case 5u { (*p).rotation = mix(ini.a.rgb, ini.b.rgb, vec3f(pow(clamp(r, 0.0, 1.0), ini.a.w))); }
    case 6u { (*p).angularVelocity = mix(ini.a.rgb, ini.b.rgb, vec3f(pow(clamp(r, 0.0, 1.0), ini.a.w))); }
    default {}
  }
}

@compute @workgroup_size(64)
fn spawnMain(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x;
  // 找到本线程归属的 emitter（前缀偏移区间）
  var e = -1;
  for (var k = 0u; k < 4u; k++) {
    if (t >= sys.emitOffsets[k] && t < sys.emitOffsets[k] + sys.emitCounts[k]) { e = i32(k); break; }
  }
  if (e < 0) { return; }

  let slot = popFree();
  if (slot == INVALID) { return; }
  atomicAdd(&sys.alive, 1u);
  let seq = atomicAdd(&sys.spawnSeq, 1u);
  let em = program.emitters[u32(e)];

  var p: Particle;
  p.color = vec3f(1.0);
  p.alpha = 1.0;
  p.size = 20.0;
  p.initColor = vec3f(1.0);
  p.initAlpha = 1.0;
  p.initSize = 20.0;
  p.lifetime = 1.0;
  p.initLifetime = 1.0;
  p.age = 0.0;
  p.rotation = vec3f(0.0);
  p.angularVelocity = vec3f(0.0);
  p.velocity = vec3f(0.0);
  p.state = 1u;
  p.random = rnd(seq, 0u);
  p.spawnSequence = seq;

  // 发射原点（可挂 controlpoint）
  var origin = em.origin.xyz;
  let cp = i32(em.origin.w);
  if (cp >= 0 && cp < 8) { origin += sysUniform.controlPoints[u32(cp)].xyz; }

  var pos = origin;
  var vel = vec3f(0.0);
  let speed = mix(em.rateDur.z, em.rateDur.w, rnd(seq, 13u));
  if (em.kindActive.x == 0u) {
    // boxrandom：盒内均匀取点，初速沿径向
    let r = vec3f(rnd(seq, 10u), rnd(seq, 11u), rnd(seq, 12u));
    let off = mix(em.distMin.rgb, em.distMax.rgb, r);
    pos = origin + off;
    let dir = normalize(off * em.dirSign.rgb + vec3f(1e-6));
    vel = dir * speed;
  } else {
    // sphererandom：随机方向 + 半径
    let d1 = normalize(gauss3(seq, 20u) * em.dirSign.rgb + vec3f(1e-6));
    let radius = mix(em.distMin.x, em.distMax.x, rnd(seq, 21u));
    pos = origin + d1 * radius;
    let d2 = normalize(gauss3(seq, 22u) * em.dirSign.rgb + vec3f(1e-6));
    vel = d2 * speed;
  }
  vel *= em.sign.rgb;
  p.position = pos;
  p.velocity = vel;

  let iniCount = program.counts.y;
  for (var k = 0u; k < 16u; k++) {
    if (k >= iniCount) { break; }
    applyInitializer(&p, program.initializers[k], seq, k);
  }
  p.initLifetime = p.lifetime;
  p.initSize = p.size;
  p.initColor = p.color;
  p.initAlpha = p.alpha;
  p.simPos = p.position;
  p.age = 0.0;
  particles[slot] = p;
}

// ---------- simulate ----------
fn hashOp(seq: u32, k: u32) -> vec3f {
  return vec3f(rnd(seq, 2000u + k), rnd(seq, 3000u + k), rnd(seq, 4000u + k));
}

fn applyOperator(p: ptr<function, Particle>, op: OpGpu, k: u32, cp: array<vec4f, 8>) {
  let age = (*p).age;
  let seq = (*p).spawnSequence;
  switch op.kind {
    case 0u {  // movement：v += (gravity - drag·v)·dt（半隐式欧拉）
      (*p).velocity += (op.a.rgb - op.a.w * (*p).velocity) * frame.dt;
    }
    case 1u {  // angularmovement
      (*p).angularVelocity += (op.a.rgb - op.a.w * (*p).angularVelocity) * frame.dt;
    }
    case 2u {  // alphafade：首尾淡入淡出
      var f = 1.0;
      if (op.a.x > 0.0) { f = min(f, age / op.a.x); }
      if (op.a.y > 0.0) { f = min(f, (*p).lifetime / op.a.y); }
      (*p).alpha *= clamp(f, 0.0, 1.0);
    }
    case 3u {  // alphachange
      let t = clamp((age - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
      (*p).alpha = mix(op.a.z, op.a.w, t);
    }
    case 4u {  // sizechange
      let t = clamp((age - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
      (*p).size = max(0.0, mix(op.a.z, op.a.w, t));
    }
    case 5u {  // colorchange
      let t = clamp((age - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
      (*p).color = mix(op.b.rgb, op.c.rgb, vec3f(t));
    }
    case 6u {  // oscillatealpha：per-particle 随机 freq/scale/phase（hash spawnSequence）
      let r = hashOp(seq, k);
      let freq = mix(op.a.x, op.a.y, r.x);
      let scale = mix(op.a.z, op.a.w, r.y);
      let phase = mix(op.b.x, op.b.y, r.z);
      (*p).alpha = clamp((*p).alpha + (*p).initAlpha * scale * cos(TAU * freq * age + phase), 0.0, 1.0);
    }
    case 7u {  // oscillatesize
      let r = hashOp(seq, k);
      let freq = mix(op.a.x, op.a.y, r.x);
      let scale = mix(op.a.z, op.a.w, r.y);
      let phase = mix(op.b.x, op.b.y, r.z);
      (*p).size = max(0.0, (*p).size + (*p).initSize * scale * cos(TAU * freq * age + phase));
    }
    case 9u {  // turbulence：curl noise 流场
      let r = hashOp(seq, k);
      let phase = mix(op.a.x, op.a.y, r.x);
      let speed = mix(op.a.z, op.a.w, r.y);
      let sp = (*p).simPos * op.b.y + vec3f((frame.time * op.b.x + phase) * 0.5);
      let curl = curlNoise(sp, phase);
      (*p).velocity += curl * op.c.rgb * speed * frame.dt;
    }
    case 10u {  // vortex：绕控制点轴的切向速度
      let cpi = i32(op.b.w);
      var center = sysUniform.origin.xyz;
      if (cpi >= 0 && cpi < 8) { center = cp[u32(cpi)].xyz; }
      let axial = normalize(op.b.rgb + vec3f(1e-6));
      let rel = (*p).simPos - center;
      let radial = rel - axial * dot(rel, axial);
      let d = length(radial);
      if (d > 0.001) {
        let tt = clamp((d - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
        let speed = mix(op.a.z, op.a.w, tt);
        let tangent = normalize(cross(axial, radial));
        (*p).velocity += tangent * speed * frame.dt;
      }
    }
    case 11u {  // controlpointattract：scale<0 远离控制点（cursor avoid），>0 吸引
      let cpi = i32(op.b.w);
      var center = op.b.rgb;
      if (cpi >= 0 && cpi < 8) { center += cp[u32(cpi)].xyz; }
      let dir = center - (*p).simPos;
      let d = length(dir);
      let th = op.a.y;
      if (d > 0.001 && (th <= 0.0 || d < th)) {
        (*p).velocity += (dir / d) * op.a.x * frame.dt;
      }
    }
    default {}
  }
}

// oscillateposition 在主循环之外处理（需要 simPos 与最终 position 分离）
fn applyPositionOscillator(p: ptr<function, Particle>, op: OpGpu, k: u32) {
  let r = hashOp(p.spawnSequence, k);
  let freq = mix(op.a.rgb, op.b.rgb, vec3f(r.x));
  let scale = mix(op.c.rgb, op.d.rgb, vec3f(r.y));
  let phase = mix(op.e.rgb, op.f.rgb, vec3f(r.z));
  (*p).position += scale * cos(TAU * freq * (*p).age + phase);
}

@compute @workgroup_size(64)
fn simulateMain(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= program.counts.w) { return; }
  var p = particles[i];
  if (p.state != 1u) { return; }

  // 生命周期
  p.age += frame.dt;
  p.lifetime -= frame.dt;
  if (p.lifetime <= 0.0) {
    p.state = 0u;
    let c = atomicAdd(&sys.freeCount, 1u);
    freeList[c] = i;
    atomicSub(&sys.alive, 1u);
    particles[i] = p;
    return;
  }

  // WE 算子语义：每帧先恢复初始值，算子算绝对量
  p.color = p.initColor;
  p.alpha = p.initAlpha;
  p.size = p.initSize;

  let cp = sysUniform.controlPoints;
  let opCount = program.counts.z;
  for (var k = 0u; k < 16u; k++) {
    if (k >= opCount) { break; }
    applyOperator(&p, program.operators[k], k, cp);
  }

  // 统一积分（力已在算子内并入速度）
  p.simPos += p.velocity * frame.dt;
  p.rotation += p.angularVelocity * frame.dt;

  // 位置振荡叠加在积分位置之上
  p.position = p.simPos;
  for (var k = 0u; k < 16u; k++) {
    if (k >= opCount) { break; }
    if (program.operators[k].kind == 8u) {
      applyPositionOscillator(&p, program.operators[k], k);
    }
  }

  particles[i] = p;
  let idx = atomicAdd(&sys.renderCount, 1u);
  renderIndices[idx] = i;
}

// ---------- finalize：写 indirect draw 参数 ----------
struct DrawIndirect {
  vertexCount: atomic<u32>,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance: u32,
};
@group(0) @binding(7) var<storage, read_write> drawArgs: DrawIndirect;

@compute @workgroup_size(1)
fn finalizeMain() {
  atomicStore(&drawArgs.vertexCount, 6u);
  atomicStore(&drawArgs.instanceCount, atomicLoad(&sys.renderCount));
  drawArgs.firstVertex = 0u;
  drawArgs.firstInstance = 0u;
}
`
