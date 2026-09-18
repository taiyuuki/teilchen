<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Vec3 } from '@teilchen/core'
import { attachRuntime, editor, getRuntime } from '../store.ts'

const gpuCanvas = ref<HTMLCanvasElement | null>(null)
const overlay = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLDivElement | null>(null)

let raf = 0

onMounted(() => {
    void attachRuntime(gpuCanvas.value!)
    raf = requestAnimationFrame(drawGizmos)
})

onBeforeUnmount(() => cancelAnimationFrame(raf))

// ---------------------------------------------------------------- 几何（绘制与拾取共用）

interface GizmoCircle {

    /** ring/threshold 挂在 operator；sphere 挂在 emitter。 */
    kind:          'ring' | 'sphere-max' | 'sphere-min' | 'threshold';
    cpIndex?:      number;
    opIndex?:      number;
    emitterIndex?: number;

    /** 圆心与半径，世界（设备像素）。 */
    cx: number;
    cy: number;
    r:  number;

    /** ring 专属：随控制点角度旋转后的涡旋轴（画轴向线用）。 */
    axis?: Vec3;
}

type DragTarget = { kind: 'cp', cpIndex: number }
    | { kind: 'ring' | 'threshold', opIndex: number, center: [number, number] }
    | { kind: 'sphere', emitterIndex: number, which: 'max' | 'min', center: [number, number] }

let drag: DragTarget | null = null

function view(): { w: number, h: number, dpr: number } {
    const c = overlay.value!

    return {
        w:   Math.max(1, Math.round(c.clientWidth)),
        h:   Math.max(1, Math.round(c.clientHeight)),
        dpr: gpuCanvas.value ? gpuCanvas.value.width / Math.max(1, gpuCanvas.value.clientWidth) : 1,
    }
}

/** 收集 gizmo 几何：控制点位置（含 lock 跟随/自转进动）与可拖拽圆（vortex 环/attract 阈值/球发射半径）。 */
function gizmoGeometry() {
    const def = editor.def
    const origin = def.origin
    const rt = getRuntime()
    const simT = rt?.time ?? 0
    const cps = def.controlPoints.map((cp, i) => {
        const ang: Vec3 = [
            cp.angles[0] + cp.spin[0] * simT,
            cp.angles[1] + cp.spin[1] * simT,
            cp.angles[2] + cp.spin[2] * simT,
        ]

        return {
            i,
            ang,
            locked: cp.lockToPointer,
            x:      origin[0] + cp.offset[0] + (cp.lockToPointer ? editor.pointer[0] : 0),
            y:      origin[1] + cp.offset[1] + (cp.lockToPointer ? editor.pointer[1] : 0),
        }
    })
    const circles: GizmoCircle[] = []
    def.operators.forEach((op, opIndex) => {
        const g = cps[Number(op.controlpoint) || 0]
        if (!g) return
        const rot = cpRotMat(g.ang)
        if (op.name === 'vortex' || op.name === 'vortex_v2') {
            const off = mulMatVec(rot, asVec3(op.offset))
            const ring = Number(op.ringradius) || 0
            if (ring > 0) {
                circles.push({
                    kind:    'ring',
                    cpIndex: g.i,
                    opIndex,
                    cx:      g.x + off[0],
                    cy:      g.y + off[1],
                    r:       ring,
                    axis:    mulMatVec(rot, asVec3(op.axis ?? [0, 0, 1])),
                })
            }
        }
        else if (op.name === 'controlpointattract') {
            const off = mulMatVec(rot, asVec3(op.origin))
            const th = Number(op.threshold) || 0
            if (th > 0) circles.push({ kind: 'threshold', cpIndex: g.i, opIndex, cx: g.x + off[0], cy: g.y + off[1], r: th })
        }
    })
    def.emitters.forEach((em, emitterIndex) => {
        if (em.name !== 'sphererandom') return
        const o = asVec3(em.origin)
        const mn = scalarOf(em.distancemin)
        const mx = scalarOf(em.distancemax)
        if (mn > 0) circles.push({ kind: 'sphere-min', emitterIndex, cx: origin[0] + o[0], cy: origin[1] + o[1], r: mn })
        if (mx > 0) circles.push({ kind: 'sphere-max', emitterIndex, cx: origin[0] + o[0], cy: origin[1] + o[1], r: mx })
    })

    return { origin, cps, circles }
}

// ---------------------------------------------------------------- 指针与拖拽

function onPointerMove(e: PointerEvent): void {
    const rt = getRuntime()
    const rect = gpuCanvas.value!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    rt?.setPointer(x, y)

    // runtime 世界坐标 = 设备像素（canvas 背板 = CSS × DPR），overlay 绘制用同一坐标系
    const dpr = gpuCanvas.value!.width / Math.max(1, gpuCanvas.value!.clientWidth)
    editor.pointer = [(x - rect.width / 2) * dpr, (rect.height / 2 - y) * dpr]

    if (drag) applyDrag(e)
    if (wrap.value) wrap.value.style.cursor = drag ? 'grabbing' : hitGizmo(e) ? 'grab' : ''
}

function eventWorld(e: PointerEvent): [number, number] {
    const rect = gpuCanvas.value!.getBoundingClientRect()
    const dpr = gpuCanvas.value!.width / Math.max(1, gpuCanvas.value!.clientWidth)

    return [(e.clientX - rect.left - rect.width / 2) * dpr, (rect.height / 2 - (e.clientY - rect.top)) * dpr]
}

/** 命中测试：控制点十字（12px）优先于圆环（圆周 10px）；锁定点跟随指针、不可拖。 */
function hitGizmo(e: PointerEvent): DragTarget | null {
    if (!editor.gizmos || !editor.runtimeReady || !overlay.value || !gpuCanvas.value) return null
    const { w, h, dpr } = view()
    const rect = overlay.value.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const toScreen = (x: number, y: number): [number, number] => [w / 2 + x / dpr, h / 2 - y / dpr]
    const geo = gizmoGeometry()

    let best: DragTarget | null = null
    let bestDist = 12
    for (const g of geo.cps) {
        if (g.locked) continue
        const [px, py] = toScreen(g.x, g.y)
        const d = Math.hypot(px - sx, py - sy)
        if (d < bestDist) {
            bestDist = d
            best = { kind: 'cp', cpIndex: g.i }
        }
    }
    if (best) return best

    bestDist = 10
    for (const c of geo.circles) {
        const [px, py] = toScreen(c.cx, c.cy)
        const d = Math.abs(Math.hypot(px - sx, py - sy) - c.r / dpr)
        if (d >= bestDist) continue
        bestDist = d
        if (c.kind === 'ring') best = { kind: 'ring', opIndex: c.opIndex!, center: [c.cx, c.cy] }
        else if (c.kind === 'threshold') best = { kind: 'threshold', opIndex: c.opIndex!, center: [c.cx, c.cy] }
        else best = { kind: 'sphere', emitterIndex: c.emitterIndex!, which: c.kind === 'sphere-min' ? 'min' : 'max', center: [c.cx, c.cy] }
    }

    return best
}

function onPointerDown(e: PointerEvent): void {
    drag = hitGizmo(e)
    if (!drag) return
    wrap.value?.setPointerCapture(e.pointerId)
    applyDrag(e)
}

/** 拖拽即改 def：cp 改 offset XY；环/阈值/球半径取到各自圆心的屏幕距离。 */
function applyDrag(e: PointerEvent): void {
    const d = drag
    if (!d) return
    const [wx, wy] = eventWorld(e)
    const def = editor.def
    if (d.kind === 'cp') {
        const cp = def.controlPoints[d.cpIndex]
        cp.offset = [wx - def.origin[0], wy - def.origin[1], cp.offset[2]]
    }
    else if (d.kind === 'sphere') {
        const em = def.emitters[d.emitterIndex]
        const o = asVec3(em.origin)
        const r = Math.hypot(wx - def.origin[0] - o[0], wy - def.origin[1] - o[1])
        em[d.which === 'min' ? 'distancemin' : 'distancemax'] = Math.round(r * 10) / 10
    }
    else {
        const r = Math.hypot(wx - d.center[0], wy - d.center[1])
        const op = def.operators[d.opIndex]
        if (d.kind === 'ring') op.ringradius = Math.round(r * 10) / 10
        else op.threshold = Math.round(r * 10) / 10
    }
}

function onPointerUp(e: PointerEvent): void {
    if (!drag) return
    drag = null
    if (wrap.value?.hasPointerCapture(e.pointerId)) wrap.value.releasePointerCapture(e.pointerId)
}

// ---------------------------------------------------------------- 绘制

/** 2D overlay：emitter 范围线框 + 算子辅助圈/轴向 + 控制点十字 + 指针（世界系与 runtime 一致）。 */
function drawGizmos(): void {
    const c = overlay.value
    if (c) {
        const { w, h, dpr } = view()
        if (c.width !== w || c.height !== h) {
            c.width = w
            c.height = h
        }
        const ctx = c.getContext('2d')!
        ctx.clearRect(0, 0, w, h)
        if (editor.gizmos && editor.runtimeReady) {
            const geo = gizmoGeometry()
            const toScreen = (x: number, y: number): [number, number] => [w / 2 + x / dpr, h / 2 - y / dpr]

            // boxrandom 盒范围（sphererandom 圆圈在 circles 里）
            ctx.lineWidth = 1
            ctx.strokeStyle = 'rgba(120, 200, 255, 0.55)'
            ctx.setLineDash([4, 3])
            for (const em of editor.def.emitters) {
                if (em.name !== 'boxrandom') continue
                const o = asVec3(em.origin)
                const mn = asVec3(em.distancemin)
                const mx = asVec3(em.distancemax)
                const cx = geo.origin[0] + o[0]
                const cy = geo.origin[1] + o[1]
                const [sx1, sy1] = toScreen(cx + mn[0], cy + mx[1])
                const [sx2, sy2] = toScreen(cx + mx[0], cy + mn[1])
                ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1)
            }

            // 圆类 gizmo：球发射半径（蓝）/ vortex 环（绿，附轴向）/ attract 阈值（橙）
            for (const g of geo.circles) {
                const [sx, sy] = toScreen(g.cx, g.cy)
                const active = drag?.kind === 'sphere' && drag.emitterIndex === g.emitterIndex
                    || drag?.kind === 'ring' && drag.opIndex === g.opIndex
                    || drag?.kind === 'threshold' && drag.opIndex === g.opIndex
                ctx.setLineDash(g.kind === 'threshold' ? [3, 4] : [6, 4])
                ctx.strokeStyle = g.kind === 'ring'
                    ? active ? 'rgba(150, 255, 200, 0.95)' : 'rgba(120, 255, 180, 0.55)'
                    : g.kind === 'threshold'
                        ? active ? 'rgba(255, 190, 140, 0.9)' : 'rgba(255, 170, 120, 0.5)'
                        : active ? 'rgba(150, 215, 255, 0.95)' : 'rgba(120, 200, 255, 0.55)'
                ctx.beginPath()
                ctx.arc(sx, sy, g.r / dpr, 0, Math.PI * 2)
                ctx.stroke()
                if (g.kind === 'ring' && g.axis) {
                    const norm = Math.hypot(g.axis[0], g.axis[1])
                    if (norm > 1e-4) {
                        ctx.setLineDash([])
                        ctx.strokeStyle = 'rgba(120, 255, 180, 0.85)'
                        ctx.beginPath()
                        ctx.moveTo(sx, sy)
                        ctx.lineTo(sx + g.axis[0] / norm * 56, sy - g.axis[1] / norm * 56)
                        ctx.stroke()
                    }
                }
            }
            ctx.setLineDash([])

            // 无 vortex 的控制点：角度非零时标出旋转后的 Z 轴
            for (const g of geo.cps) {
                if (geo.circles.some(x => x.kind === 'ring' && x.cpIndex === g.i)) continue
                if (!g.ang.some(a => a !== 0)) continue
                const z = mulMatVec(cpRotMat(g.ang), [0, 0, 1])
                const norm = Math.hypot(z[0], z[1])
                if (norm <= 1e-4) continue
                const [sx, sy] = toScreen(g.x, g.y)
                ctx.strokeStyle = 'rgba(160, 170, 255, 0.6)'
                ctx.beginPath()
                ctx.moveTo(sx, sy)
                ctx.lineTo(sx + z[0] / norm * 40, sy - z[1] / norm * 40)
                ctx.stroke()
            }

            // control points
            ctx.font = '10px ui-monospace, monospace'
            for (const g of geo.cps) {
                const used = [editor.def.emitters, editor.def.operators].some(list =>
                    list.some(m => Number(m.controlpoint) === g.i || Number(m.controlpointstart) === g.i))
                const active = drag?.kind === 'cp' && drag.cpIndex === g.i
                const [sx, sy] = toScreen(g.x, g.y)
                ctx.strokeStyle = g.locked
                    ? 'rgba(255, 210, 120, 0.95)'
                    : active ? 'rgba(255, 160, 160, 1)' : used ? 'rgba(255, 130, 130, 0.9)' : 'rgba(255, 130, 130, 0.35)'
                const arm = active ? 9 : 7
                ctx.beginPath()
                ctx.moveTo(sx - arm, sy)
                ctx.lineTo(sx + arm, sy)
                ctx.moveTo(sx, sy - arm)
                ctx.lineTo(sx, sy + arm)
                ctx.stroke()
                ctx.fillStyle = ctx.strokeStyle as string
                ctx.fillText(`cp${g.i}${g.locked ? ' ⌨' : ''}`, sx + 9, sy - 6)
            }

            // 指针
            const [px, py] = toScreen(editor.pointer[0], editor.pointer[1])
            ctx.strokeStyle = 'rgba(255, 210, 120, 0.35)'
            ctx.beginPath()
            ctx.arc(px, py, 12, 0, Math.PI * 2)
            ctx.stroke()
        }
    }
    raf = requestAnimationFrame(drawGizmos)
}

function asVec3(v: unknown): Vec3 {
    if (Array.isArray(v)) return v as Vec3
    const n = Number(v) || 0

    return [n, n, n]
}

function scalarOf(v: unknown): number {
    return Array.isArray(v) ? Number(v[0]) || 0 : Number(v) || 0
}

/** ZYX 欧拉角旋转矩阵（列向量），与 compute.wgsl 的 cpRot 一致。 */
function cpRotMat(a: Vec3): [Vec3, Vec3, Vec3] {
    const cx = Math.cos(a[0]); const sx = Math.sin(a[0])
    const cy = Math.cos(a[1]); const sy = Math.sin(a[1])
    const cz = Math.cos(a[2]); const sz = Math.sin(a[2])

    return [
        [cz * cy, sz * cy, -sy],
        [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx],
        [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx],
    ]
}

/** 矩阵（列存储）× 向量。 */
function mulMatVec(m: [Vec3, Vec3, Vec3], v: Vec3): Vec3 {
    return [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}
</script>

<template>
  <div
    ref="wrap"
    class="preview"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <canvas
      ref="gpuCanvas"
      class="gpu"
    />
    <canvas
      ref="overlay"
      class="overlay"
    />
    <div
      v-if="editor.warnings.length"
      class="warns"
    >
      <div
        v-for="(w, i) in editor.warnings.slice(-4)"
        :key="i"
      >
        {{ w }}
      </div>
    </div>
  </div>
</template>
