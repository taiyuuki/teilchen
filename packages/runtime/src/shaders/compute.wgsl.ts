/**
 * 计算着色器：模拟主循环 + 子粒子系统（children）。
 * 布局必须与 layout.ts / compile.ts 严格一致。
 *
 * 父系统帧序：
 *   prepare → spawn(rate 发射) → simulate(含 children 簿记：新生/跟随/死亡事件) → finalize
 * 子系统帧序（在父之后 dispatch）：
 *   prepare → childInstanceMain(实例老化/爆发配额) → childEventMain(处理父事件分配爆发实例)
 *   → childSpawnMain(每实例发射) → simulate(cp 替换为实例位置) → finalize
 *
 * 实例布局：父持有合并实例缓冲，各子区域拼接（follow 区域与父粒子槽 1:1，burst 区域走自由列表）。
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
  frame: u32, _p0: u32, _p1: u32, _p2: u32,  // 64
  eventCount: atomic<u32>, // 80（父：本帧 spawn/death 事件数）
  instFreeCount: atomic<u32>, // 84（子：爆发实例空闲数）
  _pe0: u32, _pe1: u32,    // 88 → 总 96B
};
struct Particle {
  position: vec3f, lifetime: f32,
  simPos: vec3f, initLifetime: f32,
  velocity: vec3f, random: f32,
  rotation: vec3f, size: f32,
  angularVelocity: vec3f, initSize: f32,
  color: vec3f, alpha: f32,
  initColor: vec3f, initAlpha: f32,
  age: f32, spawnSequence: u32, state: u32, instanceId: u32,  // state: 0 死 / 1 活 / 2 新生
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
  children: array<vec4u, 8>,  // 父侧每 child 2 项：[2i]=(type,cpStart,active,prob) [2i+1]=(regionBase,regionCap,0,0)
  childMetaA: vec4u,    // 父=(0,count,0,0)；子=(1, myType, cpStart, instanceBase)
  childMetaB: vec4f,    // 子=(lifetime, instanceCap, probability, 0)；父未用
  renderer0: vec4u,     // (mode, segments, 0, 0)  mode: 0 sprite/1 spritetrail/2 ropetrail/3 rope
  renderer1: vec4f,     // (length, maxlength, interval, 0)
};

// 子实例：posAge.w = age；info = (state 0死/1活/2新生, burstRem, 0, 0)；emitted = 各 emitter 累计
struct ChildInstance {
  posAge: vec4f,
  info: vec4u,
  emitted: vec4u,
  _pad: vec4u,
};
// 父粒子事件：pos.w = age；info = (kind 1=death 2=spawn, parentSlot, 0, 0)
struct ChildEvent {
  pos: vec4f,
  info: vec4u,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> sysUniform: SysUniform;
@group(0) @binding(2) var<storage, read_write> sys: Counters;
@group(0) @binding(3) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(4) var<storage, read> program: Program;
@group(0) @binding(5) var<storage, read_write> freeList: array<u32>;
@group(0) @binding(6) var<storage, read_write> renderIndices: array<u32>;
// 父：children 合并实例缓冲；子：同一缓冲（读自己的区域）
@group(0) @binding(8) var<storage, read_write> instances: array<ChildInstance>;
// 父：自己的事件缓冲（写）；子：父的事件缓冲（读）。头部为原子计数
struct EventBuffer {
  count: atomic<u32>,
  _p0: u32, _p1: u32, _p2: u32,
  data: array<ChildEvent>,
};
@group(0) @binding(9) var<storage, read_write> events: EventBuffer;
// 子：爆发实例自由列表（CAS 弹出）
@group(0) @binding(10) var<storage, read_write> instanceFree: array<u32>;
// ropetrail 历史环形缓冲（每粒子 64 槽 vec4：xyz + 时间桶号）
@group(0) @binding(12) var<storage, read_write> trailHistory: array<vec4f>;
// rope bitonic 排序参数（k, j, n；每 pass 由 CPU 写入）
struct SortParams { k: u32, j: u32, n: u32, _pad: u32 };
@group(0) @binding(13) var<uniform> sortParams: SortParams;

const INVALID: u32 = 4294967295u;
const TAU: f32 = 6.28318530718;
const MAX_EVENTS: u32 = 4096u;
const TRAIL_STRIDE: u32 = 64u; // 历史槽 stride（= MAX_TRAIL_SEGMENTS）

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

/** WE ApplySign 的单分量版：0 保留原值（默认），±1 强制该分量符号。 */
fn applySign1(c: f32, s: f32) -> f32 {
  if (s == 0.0) { return c; }
  return abs(c) * s;
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
  // 事件计数只在父侧清零（子系统绑定的是父的事件缓冲，不能重复清）
  if (program.childMetaA.x != 1u) { atomicStore(&events.count, 0u); }
  let isChild = program.childMetaA.x == 1u;
  if (!isChild) {
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
  }
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

fn hsv2rgb(c: vec3f) -> vec3f {
  // 标准 HSV→RGB（iq 公式）：通道偏移 (0, 2/3, 1/3) 对应 (R, G, B)
  let p3 = abs(fract(vec3f(c.x) + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - vec3f(1.0);
  return c.z * mix(vec3f(1.0), clamp(p3, vec3f(0.0), vec3f(1.0)), c.y);
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
    case 7u {                                                                 // turbulentvelocityrandom（近似 WE）
      let sp = mixExp(ini.a.y, ini.a.z, 1.0, r) + ini.b.y;
      let dir = curlNoise((*p).position * ini.a.x, ini.b.x + r * 6.28);
      (*p).velocity += dir * sp;
    }
    case 8u {                                                                 // hsvcolorrandom（hue/sat/val 各自随机）
      let h = mixExp(ini.a.x, ini.a.y, 1.0, r);
      let s = mixExp(ini.a.z, ini.b.x, 1.0, rnd(seq, 2000u + k));
      let v = mixExp(ini.b.y, ini.b.z, 1.0, rnd(seq, 3000u + k));
      (*p).color = hsv2rgb(vec3f(h, s, v));
    }
    case 9u {                                                                 // mapsequencebetweencontrolpoints
      let cs = clamp(i32(ini.a.x), 0, 7);
      let ce = clamp(i32(ini.a.y), 0, 7);
      let t = fract(f32(seq) / max(ini.a.z, 0.0001));
      let a3 = sysUniform.controlPoints[u32(cs)].xyz;
      let b3 = sysUniform.controlPoints[u32(ce)].xyz;
      (*p).position += (b3 - a3) * t;
    }
    case 10u {                                                                // mapsequencearoundcontrolpoint（axis 主分量）
      let cp0 = sysUniform.controlPoints[u32(clamp(i32(ini.a.x), 0, 7))].xyz;
      var rel = (*p).position - cp0;
      let ang = f32(seq) / max(ini.a.y, 0.0001) * TAU;
      if (ini.a.z < 0.5) {
        let r = length(rel.yz);
        rel = vec3f(rel.x, cos(ang) * r, sin(ang) * r);        // 绕 x
      } else if (ini.a.z < 1.5) {
        let r = length(rel.xz);
        rel = vec3f(cos(ang) * r, rel.y, sin(ang) * r);        // 绕 y
      } else {
        let r = length(rel.xy);
        rel = vec3f(cos(ang) * r, sin(ang) * r, rel.z);        // 绕 z
      }
      (*p).position = cp0 + rel;
    }
    default {}
  }
}

/** 发射一个粒子：emitter 几何 + initializer 管线（父/子 spawn 共用）。originBase 为实例/控制点偏移后的原点。 */
fn emitOne(slot: u32, em: EmitterGpu, originBase: vec3f, instanceId: u32) {
  atomicAdd(&sys.alive, 1u);
  let seq = atomicAdd(&sys.spawnSeq, 1u);

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
  p.state = 2u; // 新生：首帧 simulate 处理 children 簿记后转 1
  p.random = rnd(seq, 0u);
  p.spawnSequence = seq;
  p.instanceId = instanceId;

  var origin = em.origin.xyz + originBase;
  if (instanceId == INVALID) {
    // 父系统：发射器可挂 controlpoint
    let cp = i32(em.origin.w);
    if (cp >= 0 && cp < 8) { origin += sysUniform.controlPoints[u32(cp)].xyz; }
  }

  var pos = origin;
  var vel = vec3f(0.0);
  let speed = mix(em.rateDur.z, em.rateDur.w, rnd(seq, 13u));
  var off = vec3f(0.0);
  if (em.kindActive.x == 0u) {
    // boxrandom：盒内均匀取点 × directions 掩码
    let r = vec3f(rnd(seq, 10u), rnd(seq, 11u), rnd(seq, 12u));
    off = mix(em.distMin.rgb, em.distMax.rgb, r) * em.dirSign.rgb;
  } else {
    // sphererandom：随机方向 + 维度幂采样半径（2D 面积均匀 / 3D 体积均匀，对齐 WE）
    var dims = 0.0;
    if (abs(em.dirSign.x) > 1e-6) { dims += 1.0; }
    if (abs(em.dirSign.y) > 1e-6) { dims += 1.0; }
    if (abs(em.dirSign.z) > 1e-6) { dims += 1.0; }
    let mn = max(em.distMin.x, 0.0);
    let mx = max(mn, em.distMax.x);
    let rr = rnd(seq, 21u);
    var radius = mix(mn, mx, rr);
    if (dims > 1.0) {
      radius = pow(mix(pow(mn, dims), pow(mx, dims), rr), 1.0 / dims);
    }
    let dir = normalize(gauss3(seq, 20u) * em.dirSign.rgb + vec3f(1e-6));
    off = dir * radius * abs(em.dirSign.rgb);
    // WE ApplySign：sign 强制位置分量符号（0 分量清零；box 不应用）
    off = vec3f(applySign1(off.x, em.sign.x), applySign1(off.y, em.sign.y), applySign1(off.z, em.sign.z));
  }
  pos = origin + off;
  // WE 语义：初速沿径向（位置归一化）；位置≈0 时无初速
  if (speed != 0.0 && dot(off, off) > 1e-12) {
    vel = normalize(off) * speed;
  }
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

  // ropetrail：历史环预填出生点（尾长从 0 平滑长出）
  if (program.renderer0.x == 2u) {
    let segs = max(program.renderer0.y, 2u);
    let bin = u32(frame.time / max(program.renderer1.z, 1e-3));
    for (var q = 0u; q < TRAIL_STRIDE; q++) {
      if (q >= segs) { break; }
      trailHistory[slot * TRAIL_STRIDE + q] = vec4f(p.position, f32(bin));
    }
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
  emitOne(slot, program.emitters[u32(e)], vec3f(0.0), INVALID);
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
    case 2u {  // alphafade：首尾淡入淡出（fadeintime/fadeouttime = 寿命归一化进度）
      let prog = clamp(age / max((*p).initLifetime, 1e-5), 0.0, 1.0);
      var f = 1.0;
      if (op.a.x > 0.0 && prog <= op.a.x) {
        f = prog / op.a.x;
      } else if (op.a.y < 1.0 && prog > op.a.y) {
        f = 1.0 - (prog - op.a.y) / max(1.0 - op.a.y, 1e-5);
      }
      (*p).alpha *= clamp(f, 0.0, 1.0);
    }
    case 3u {  // alphachange：×[sv→ev]，插值自变量为寿命进度（WE ValueChange）
      let prog = clamp(age / max((*p).initLifetime, 1e-5), 0.0, 1.0);
      let t = clamp((prog - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
      (*p).alpha *= mix(op.a.z, op.a.w, t);
    }
    case 4u {  // sizechange：×[sv→ev]，插值自变量为寿命进度
      let prog = clamp(age / max((*p).initLifetime, 1e-5), 0.0, 1.0);
      let t = clamp((prog - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
      (*p).size = max(0.0, (*p).size * mix(op.a.z, op.a.w, t));
    }
    case 5u {  // colorchange：×逐通道 [sv→ev]，插值自变量为寿命进度
      let prog = clamp(age / max((*p).initLifetime, 1e-5), 0.0, 1.0);
      let t = clamp((prog - op.a.x) / max(op.a.y - op.a.x, 1e-5), 0.0, 1.0);
      (*p).color *= mix(op.b.rgb, op.c.rgb, vec3f(t));
    }
    case 6u {  // oscillatealpha：alpha × mix(smin, smax, (cos(w·age+φ)+1)/2)，freq/φ per-particle
      let r = hashOp(seq, k);
      let freq = mix(op.a.x, op.a.y, r.x);
      let phase = mix(op.b.x, op.b.y + TAU, r.z);
      let osc = (cos(freq * age + phase) + 1.0) * 0.5;
      (*p).alpha *= mix(op.a.z, op.a.w, osc);
    }
    case 7u {  // oscillatesize：size × mix(smin, smax, (cos(w·age+φ)+1)/2)
      let r = hashOp(seq, k);
      let freq = mix(op.a.x, op.a.y, r.x);
      let phase = mix(op.b.x, op.b.y + TAU, r.z);
      let osc = (cos(freq * age + phase) + 1.0) * 0.5;
      (*p).size = max(0.0, (*p).size * mix(op.a.z, op.a.w, osc));
    }
    case 9u {  // turbulence：curl noise 流场
      let r = hashOp(seq, k);
      let phase = mix(op.a.x, op.a.y, r.x);
      let speed = mix(op.a.z, op.a.w, r.y);
      let sp = (*p).simPos * op.b.y + vec3f((frame.time * op.b.x + phase) * 0.5);
      let curl = curlNoise(sp, phase);
      (*p).velocity += curl * op.c.rgb * speed * frame.dt;
    }
    case 10u {  // vortex：切向速度场（把切向分量拉向目标速度，避免加速度语义的持续累积甩散）
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
        let vT = dot((*p).velocity, tangent);
        (*p).velocity += tangent * (speed - vT) * min(frame.dt * 2.0, 1.0);
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
    case 12u {  // maintaindistancetocontrolpoint：径向弹簧把粒子约束在目标距离环上
      let cpi = i32(op.b.w);
      var center = vec3f(0.0);
      if (cpi >= 0 && cpi < 8) { center += cp[u32(cpi)].xyz; }
      let dir = (*p).simPos - center;
      let d = length(dir);
      if (d > 0.001) {
        (*p).velocity += (dir / d) * (d - op.a.x) * op.a.y * frame.dt;
      }
    }
    case 13u {  // boids：对齐/聚合/分离（小容量 O(N²)；容量护栏在 compile 侧）
      var ali = vec3f(0.0);
      var coh = vec3f(0.0);
      var sep = vec3f(0.0);
      var cnt = 0u;
      let myPos = (*p).simPos;
      let mySeq = (*p).spawnSequence;
      for (var j = 0u; j < program.counts.w; j++) {
        let q = particles[j];
        if (q.state == 0u || q.spawnSequence == mySeq) { continue; }
        let dq = q.simPos - myPos;
        let d = length(dq);
        if (d > 0.001 && d < op.a.x) {
          ali += q.velocity;
          coh += dq;
          if (d < op.a.x * 0.5) { sep -= dq / d; }
          cnt++;
        }
      }
      if (cnt > 0u) {
        let inv = 1.0 / f32(cnt);
        (*p).velocity += (ali * inv * op.b.x + coh * inv * op.b.y + sep * op.b.z) * frame.dt;
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
  // WE 参考实现：w = frequency（弧度/秒），与 alpha/size 振荡一致
  (*p).position += scale * cos(freq * (*p).age + phase);
}

// ---------- 父侧 children 簿记（父 simulate 内调用） ----------
fn parentOnEvent(kind: u32, slot: u32, pos: vec3f, age: f32) {
  let n = atomicAdd(&events.count, 1u);
  if (n < MAX_EVENTS) {
    events.data[n].pos = vec4f(pos, age);
    events.data[n].info = vec4u(kind, slot, 0u, 0u);
  }
}

/** 新生粒子：follow 子系统初始化 1:1 实例；eventspawn 子系统发事件。 */
fn parentChildOnFresh(i: u32, p: ptr<function, Particle>) {
  let metaA = program.childMetaA;
  let count = metaA.y;
  for (var ci = 0u; ci < 4u; ci++) {
    if (ci >= count) { break; }
    let d0 = program.children[ci * 2u];
    if (d0.z != 1u) { continue; }
    let d1 = program.children[ci * 2u + 1u];
    if (d0.x == 3u) {
      // eventfollow：实例槽位 = 父粒子槽位（1:1 直映）
      var inst: ChildInstance;
      inst.posAge = vec4f((*p).position, 0.0);
      inst.info = vec4u(2u, 0u, 0u, 0u);
      instances[d1.x + i] = inst;
    } else if (d0.x == 2u) {
      if (rnd((*p).spawnSequence, 700u + ci) * 1000.0 < f32(d0.w)) {
        parentOnEvent(2u, i, (*p).position, 0.0);
      }
    }
  }
}

/** 每帧：follow 子系统实例跟随父粒子位置。 */
fn parentChildOnFrame(i: u32, p: ptr<function, Particle>) {
  let metaA = program.childMetaA;
  let count = metaA.y;
  for (var ci = 0u; ci < 4u; ci++) {
    if (ci >= count) { break; }
    let d0 = program.children[ci * 2u];
    if (d0.x != 3u || d0.z != 1u) { continue; }
    let d1 = program.children[ci * 2u + 1u];
    var inst = instances[d1.x + i];
    if (inst.info.x != 0u) {
      inst.posAge = vec4f((*p).position, inst.posAge.w);
      instances[d1.x + i] = inst;
    }
  }
}

/** 粒子死亡：follow 实例终止；eventdeath 子系统发事件。 */
fn parentChildOnDeath(i: u32, p: ptr<function, Particle>) {
  let metaA = program.childMetaA;
  let count = metaA.y;
  for (var ci = 0u; ci < 4u; ci++) {
    if (ci >= count) { break; }
    let d0 = program.children[ci * 2u];
    if (d0.z != 1u) { continue; }
    let d1 = program.children[ci * 2u + 1u];
    if (d0.x == 3u) {
      instances[d1.x + i].info = vec4u(0u, 0u, 0u, 0u);
    } else if (d0.x == 1u) {
      if (rnd((*p).spawnSequence, 900u + ci) * 1000.0 < f32(d0.w)) {
        parentOnEvent(1u, i, (*p).position, (*p).age);
      }
    }
  }
}

// ---------- 子实例 pass ----------
fn popInstance() -> u32 {
  loop {
    let c = atomicLoad(&sys.instFreeCount);
    if (c == 0u) { return INVALID; }
    let r = atomicCompareExchangeWeak(&sys.instFreeCount, c, c - 1u);
    if (r.exchanged) {
      return instanceFree[c - 1u];
    }
  }
}

/** 实例老化：follow 寿命由父粒子管理；death/spawn 按寿命过期并归还自由槽。新生转活跃并计算瞬时爆发配额。 */
@compute @workgroup_size(64)
fn childInstanceMain(@builtin(global_invocation_id) g: vec3u) {
  let metaA = program.childMetaA;
  if (metaA.x != 1u) { return; }
  let s = g.x;
  if (s >= u32(program.childMetaB.y)) { return; }
  let base = metaA.w;
  var inst = instances[base + s];
  if (inst.info.x == 0u) { return; }
  inst.posAge.w += frame.dt;

  if (inst.info.x == 2u) {
    // 新生 → 活跃；按各 emitter 的 instantaneous 总量设爆发余额
    var burstTotal = 0u;
    for (var e = 0u; e < 4u; e++) {
      if (e >= program.counts.x) { break; }
      burstTotal += program.emitters[e].kindActive.w;
    }
    inst.info.y = min(burstTotal, 1024u);
    inst.info.x = 1u;
  } else if (metaA.y != 3u && inst.posAge.w > program.childMetaB.x) {
    // 爆发实例过期（follow 由父粒子死亡终止）
    inst.info = vec4u(0u, 0u, 0u, 0u);
    instances[base + s] = inst;
    let c = atomicAdd(&sys.instFreeCount, 1u);
    instanceFree[c] = s;
    return;
  }
  instances[base + s] = inst;
}

/** 处理父事件：death/spawn 子系统按事件分配爆发实例。 */
@compute @workgroup_size(64)
fn childEventMain(@builtin(global_invocation_id) g: vec3u) {
  let metaA = program.childMetaA;
  if (metaA.x != 1u) { return; }
  let myType = metaA.y;
  if (myType == 0u || myType == 3u) { return; } // static 独立运行 / follow 由父直写
  let t = g.x;
  let n = atomicLoad(&events.count);
  if (t >= n || t >= MAX_EVENTS) { return; }
  let ev = events.data[t];
  if (ev.info.x != myType) { return; }
  // 概率门控（事件无独立 seq：父槽位 × 帧号哈希）
  if (rnd((ev.info.y * 2654435761u) ^ sys.frame, 55u) >= program.childMetaB.z) { return; }

  let slot = popInstance();
  if (slot == INVALID) { return; }
  var inst: ChildInstance;
  inst.posAge = vec4f(ev.pos.xyz, 0.0);
  inst.info = vec4u(2u, 0u, 0u, 0u);
  instances[metaA.w + slot] = inst;
}

/** 子粒子发射：每实例 64 线程。瞬时余额优先（instantiate），否则 rate 按实例 age 结转（每帧每实例 ≤64）。 */
@compute @workgroup_size(64)
fn childSpawnMain(@builtin(global_invocation_id) g: vec3u) {
  let metaA = program.childMetaA;
  if (metaA.x != 1u) { return; }
  let cap = u32(program.childMetaB.y);
  let t = g.x;
  let s = t / 64u;
  let k = t % 64u;
  if (s >= cap) { return; }
  var inst = instances[metaA.w + s];
  if (inst.info.x == 0u) { return; }

  // 各 emitter 本帧发射数（全线程一致计算）
  var counts = array<u32, 4>(0u, 0u, 0u, 0u);
  var isBurst = inst.info.y > 0u;
  if (isBurst) {
    var rem = inst.info.y;
    for (var e = 0u; e < 4u; e++) {
      if (e >= program.counts.x) { break; }
      let take = min(program.emitters[e].kindActive.w, rem);
      counts[e] = take;
      rem -= take;
    }
  } else {
    for (var e = 0u; e < 4u; e++) {
      if (e >= program.counts.x) { break; }
      let em = program.emitters[e];
      if (em.rateDur.x > 0.0) {
        let n2 = u32(floor(em.rateDur.x * inst.posAge.w)) - inst.emitted[e];
        counts[e] = min(n2, 64u);
      }
    }
  }
  let total = counts[0] + counts[1] + counts[2] + counts[3];

  if (k == 0u) {
    // 簿记（仅线程 0 写）
    var emitted = inst.emitted;
    for (var e = 0u; e < 4u; e++) { emitted[e] += counts[e]; }
    inst.emitted = emitted;
    if (isBurst) { inst.info.y = inst.info.y - total; }
    instances[metaA.w + s] = inst;
  }

  if (k >= total) { return; }
  // 展平序号 → (emitter, 框内序号)
  var flat = k;
  var e = 0u;
  for (var q = 0u; q < 4u; q++) {
    if (flat < counts[q]) { e = q; break; }
    flat -= counts[q];
    e = q + 1u;
  }
  if (e >= program.counts.x) { return; }

  let slot = popFree();
  if (slot == INVALID) { return; }
  emitOne(slot, program.emitters[e], inst.posAge.xyz, s);
}

// ---------- simulate ----------
@compute @workgroup_size(64)
fn simulateMain(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= program.counts.w) { return; }
  var p = particles[i];
  if (p.state == 0u) { return; }
  let isChild = program.childMetaA.x == 1u;
  let fresh = p.state == 2u;

  // 生命周期
  p.age += frame.dt;
  p.lifetime -= frame.dt;
  if (p.lifetime <= 0.0) {
    p.state = 0u;
    if (!isChild) { parentChildOnDeath(i, &p); }
    let c = atomicAdd(&sys.freeCount, 1u);
    freeList[c] = i;
    atomicSub(&sys.alive, 1u);
    particles[i] = p;
    return;
  }

  if (fresh) {
    p.state = 1u;
    if (!isChild) { parentChildOnFresh(i, &p); }
  } else if (!isChild) {
    parentChildOnFrame(i, &p);
  }

  // WE 算子语义：每帧先恢复初始值，算子算绝对量
  p.color = p.initColor;
  p.alpha = p.initAlpha;
  p.size = p.initSize;

  var cp = sysUniform.controlPoints;
  // 子系统：controlpoint[cpStart] = 所属实例位置（发射原点）
  if (isChild && program.childMetaA.z < 8u && p.instanceId != INVALID) {
    let inst = instances[program.childMetaA.w + p.instanceId];
    cp[program.childMetaA.z] = vec4f(inst.posAge.xyz, 1.0);
  }
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

  // ropetrail：当前时间桶写最新位置（w 存桶号，读取端按桶号校验）
  if (program.renderer0.x == 2u) {
    let segs = max(program.renderer0.y, 2u);
    let bin = u32(frame.time / max(program.renderer1.z, 1e-3));
    trailHistory[i * TRAIL_STRIDE + (bin % segs)] = vec4f(p.position, f32(bin));
  }

  particles[i] = p;
  if (program.renderer0.x == 2u) {
    // ropetrail 压缩：每相邻历史点对展开一个段实例（entry = slot*64 + j）
    let segs = max(program.renderer0.y, 2u);
    let interval = max(program.renderer1.z, 1e-3);
    let v = min(segs, u32(p.age / interval) + 1u); // 有效采样点数
    for (var j = 0u; j < TRAIL_STRIDE; j++) {
      if (j + 1u >= v) { break; }
      let idx = atomicAdd(&sys.renderCount, 1u);
      renderIndices[idx] = i * TRAIL_STRIDE + j;
    }
  }
  else {
    let idx = atomicAdd(&sys.renderCount, 1u);
    renderIndices[idx] = i;
  }
}

// ---------- rope 排序（bitonic，按 spawnSequence 升序） ----------
/** 条目 → spawnSequence（ropetrail 条目是 slot*64+j 打包；rope/sprite 是裸槽位）。 */
fn seqOf(entry: u32) -> u32 {
  let slot = select(entry, entry / TRAIL_STRIDE, program.renderer0.x == 2u);
  if (slot >= program.counts.w) { return INVALID; }
  return particles[slot].spawnSequence;
}

/** 排序前置：count 之后的槽位置 INVALID（沉底）。 */
@compute @workgroup_size(64)
fn ropeSortInitMain(@builtin(global_invocation_id) g: vec3u) {
  let i = atomicLoad(&sys.renderCount) + g.x;
  if (i < program.counts.w) {
    renderIndices[i] = INVALID;
  }
}

@compute @workgroup_size(64)
fn ropeSortMain(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let n = sortParams.n;
  if (i >= n) { return; }
  let j = sortParams.j;
  let partner = i ^ j;
  if (partner <= i || partner >= n) { return; }
  let ascending = (i & sortParams.k) == 0u;
  let a = renderIndices[i];
  let b = renderIndices[partner];
  let sa = seqOf(a);
  let sb = seqOf(b);
  if (ascending == (sa > sb)) {
    renderIndices[i] = b;
    renderIndices[partner] = a;
  }
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
  let count = atomicLoad(&sys.renderCount);
  atomicStore(&drawArgs.vertexCount, 6u);
  // rope：排序后相邻两条目连一段 → 段数 = count - 1
  atomicStore(&drawArgs.instanceCount, select(count, count - 1u, program.renderer0.x == 3u && count > 0u));
  drawArgs.firstVertex = 0u;
  drawArgs.firstInstance = 0u;
}
`
