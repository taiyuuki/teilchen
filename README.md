# teilchen

基于 **WebGPU** 的 GPU VFX Runtime 与编辑器。`@teilchen/core` + `@teilchen/runtime` 作为独立库可嵌入任意场景；同时兼容 Wallpaper Engine 的 json 文件（导入能力之一）。

```
packages/
  core/      数据模型 + 模块参数注册表 + WE JSON 导入/导出（与图形 API 无关）
  runtime/   WebGPU 运行时：GPU 模拟 + indirect billboard 渲染 + VFXPlayer 高层入口
apps/
  playground/  浏览器预览台（pnpm dev）
  editor/      Vue 3 可视化编辑器（pnpm dev:editor）
```

## 运行

```bash
pnpm install
pnpm dev            # playground  http://localhost:5180（需要 WebGPU：Chrome 113+ / Safari 26+）
pnpm dev:editor     # editor      http://localhost:5181
pnpm build          # 构建两个包（含 player.global.js 浏览器直引包）
pnpm lint
pnpm typecheck
pnpm test
```

## 作为库使用

高层入口是 `VFXPlayer`（`@teilchen/runtime`）

```bash
npm i @teilchen/core @teilchen/runtime
```

```ts
import { VFXPlayer, fetchSource } from '@teilchen/runtime'

const player = await VFXPlayer.create({
    canvas,
    onWarning: console.warn,
    onStats:   s => console.log(s.fps, s.systems),   // 约 500ms 一次；也可 player.setStatsListener(fn)
})
await player.load(scene, { assets: fetchSource('/assets') })  // 场景文件 / 原生 def / WE JSON
player.start()
```

- `load` 接受三种输入（对象或 JSON 字符串）：**场景文件**（`{ format: 'teilchen/scene', version: 1, systems: [...] }`，可多系统、带 clearColor）、**原生 ParticleSystemDef**、**WE particle JSON**（自动识别，材质/子定义/贴图按路径从资产源拉取）。
- 资产源 `AssetSource` 是可插拔的：`fetchSource(baseUrl)`（HTTP 目录）、`bufferSource(files)`（内嵌字节/base64，带 basename 兜底）、`chainSource(...)`（多源串联）。贴图支持 WE `.tex`（按 TEXV 魔数嗅探，含 `.tex.json` 通道语义描述）与常规图片。
- 播放控制：`start/stop/setPaused/step/reset/setPointer/setSpeed/setCamera/setClearColor`，`stats`/`time`/`systems` 只读；宿主回调 `onStats`（统计）与 `onWarning`（告警）。
- 浏览器直引：`@teilchen/runtime/player`（`dist/player.global.js`，IIFE 单文件）。页面预置 `window.__TEILCHEN_SCENE__` + `window.__TEILCHEN_ASSETS__`（路径 → base64）时自动引导播放。

## Editor

`apps/editor`（Vue 3）：改参数 → 防抖 120ms → `handle.update()` 重编译 GPU program 表热生效（不 reset，粒子状态保留；maxCount 变化自动重建缓冲）。

- 左栏场景列表（多系统：新建/复制/删除/选中切换）+ 模块树（emitter/initializer/operator/renderer 增删，未实现模块带标记）
- 右栏属性面板由 core 注册表自动生成（float/int/bool/vec3/color255/enum）
- 系统面板：maxCount / startTime / blending / origin / 8 个 controlpoint（lock = 跟随鼠标）
- 中央预览 + 2D gizmo overlay（emitter 范围线框、controlpoint 十字、指针圈）
- 时间轴：播放/暂停/单步/重置、fps/alive/drawn/时间
- 预设（与 playground 共享 `core/presets.ts`）、WE JSON 导入/导出、贴图切换（halo/white/上传图片）
- **导出独立 HTML**：单文件内嵌 player IIFE 包 + 场景 JSON（全部系统）+ base64 贴图，任何支持 WebGPU 的浏览器直接打开即播（文件协议亦可）

## GPU 模拟架构

每个粒子系统的全部状态都在 storage buffer 里，CPU 侧零回读、零每帧顶点上传：

| Pass | 线程规模 | 职责 |
|---|---|---|
| `prepare` | 1 | 结转各 emitter 的发射计时器（rate/duration/instantaneous/one-per-frame），写本帧各 emitter 发射数与前缀偏移 |
| `spawn` | 64×16 | 每线程发射 1 粒：`atomicCompareExchangeWeak` CAS 弹出 free-list 槽位 → boxrandom/sphererandom 几何 → initializer 管线（颜色/寿命/尺寸/速度/旋转…） |
| `simulate` | 64×ceil(N/64) | 生命周期扣减 → 死粒子 CAS 压回 free-list → 恢复初始值（WE 算子语义）→ operator 链（switch 分发）→ 统一半隐式欧拉积分 → oscillateposition 叠加 → 原子追加进渲染实例表 |
| `finalize` | 1 | 把存活数写进 `drawIndirect` 参数 |

渲染：vertex shader 直读粒子 storage buffer，6 顶点展开 billboard（旋转 roll、尺寸、颜色、sprite 采样），`drawIndirect` 实例数完全由 GPU 决定。混合管线：translucent / additive / normal。

- 粒子结构 128B/粒（position/simPos 分离支持位置振荡），容量上限 500k。
- 随机数全部以 `spawnSequence` 为种子做 pcg hash —— 每粒子稳定、无状态；oscillate 的 per-particle frequency/scale/phase 同样用 hash 派生，不需要额外列。
- `warmup`：`starttime > 0` 时 GPU 侧以 1/60s 空转预模拟（单 submit 批量 dispatch）。
- stats：计数器每 500ms 异步回读一次（mapAsync），HUD 显示 fps / alive / drawn。

## WE 兼容性（v1 已支持）

- **emitter**：`boxrandom`、`sphererandom`（含 rate/duration/instantaneous/one-per-frame/maxtoemitperperiod/controlpoint/audio 字段解析，audio 调制暂未实现）
- **initializer**：`colorrandom` `lifetimerandom` `sizerandom` `alpharandom` `velocityrandom` `rotationrandom` `angularvelocityrandom`
- **operator**：`movement` `angularmovement` `alphafade` `alphachange` `sizechange` `colorchange` `oscillatealpha` `oscillatesize` `oscillateposition` `turbulence`（curl noise）`vortex` `controlpointattract`（scale<0 = 远离控制点，已用官方 cursor avoid 样例验证）
- **controlpoint**：8 槽、`locktopointer` 鼠标跟随
- **material**：blending（translucent/additive/normal）+ 贴图路径；31 种 Photoshop colorBlendMode → 后续版本
- **renderer**：sprite / spritetrail / ropetrail / rope 全支持（length/maxlength/segments）
- vec3 字段的 `"x y z"` 字符串 / 数组 / 标量三种写法均已兼容

## Todo

- [ ] 音频响应（FFT → uniform）
- [ ] Editor：模块拖拽排序、撤销/重做、参数曲线
