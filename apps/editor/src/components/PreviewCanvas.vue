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

function onPointerMove(e: PointerEvent): void {
    const rt = getRuntime()
    const rect = gpuCanvas.value!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    rt?.setPointer(x, y)

    // runtime 世界坐标 = 设备像素（canvas 背板 = CSS × DPR），overlay 绘制用同一坐标系
    const dpr = gpuCanvas.value!.width / Math.max(1, gpuCanvas.value!.clientWidth)
    editor.pointer = [(x - rect.width / 2) * dpr, (rect.height / 2 - y) * dpr]
}

/** 2D overlay：emitter 范围线框 + controlpoint 十字 + 指针（世界系与 runtime 一致）。 */
function drawGizmos(): void {
    const c = overlay.value
    if (c) {
        const w = Math.max(1, Math.round(c.clientWidth))
        const h = Math.max(1, Math.round(c.clientHeight))
        if (c.width !== w || c.height !== h) {
            c.width = w
            c.height = h
        }
        const ctx = c.getContext('2d')!
        ctx.clearRect(0, 0, w, h)
        if (editor.gizmos && editor.runtimeReady) {
            const def = editor.def
            const origin = def.origin

            // 世界（设备像素）→ overlay（CSS 像素）：除以 DPR，与 runtime 渲染一致
            const dpr = gpuCanvas.value ? gpuCanvas.value.width / Math.max(1, gpuCanvas.value.clientWidth) : 1
            const toScreen = (x: number, y: number): [number, number] => [w / 2 + x / dpr, h / 2 - y / dpr]

            // emitter 范围
            ctx.lineWidth = 1
            ctx.strokeStyle = 'rgba(120, 200, 255, 0.55)'
            ctx.setLineDash([4, 3])
            for (const em of def.emitters) {
                const o = em.origin as Vec3 | number | undefined
                const eo: Vec3 = Array.isArray(o) ? o : [0, 0, 0]
                const cx = origin[0] + eo[0]
                const cy = origin[1] + eo[1]
                if (em.name === 'boxrandom') {
                    const mn = asVec3(em.distancemin)
                    const mx = asVec3(em.distancemax)
                    const [sx1, sy1] = toScreen(cx + mn[0], cy + mx[1])
                    const [sx2, sy2] = toScreen(cx + mx[0], cy + mn[1])
                    ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1)
                }
                else if (em.name === 'sphererandom') {
                    const mn = scalarOf(em.distancemin)
                    const mx = scalarOf(em.distancemax)
                    const [sx, sy] = toScreen(cx, cy)
                    if (mx > 0) {
                        ctx.beginPath()
                        ctx.arc(sx, sy, mx / dpr, 0, Math.PI * 2)
                        ctx.stroke()
                    }
                    if (mn > 0) {
                        ctx.beginPath()
                        ctx.arc(sx, sy, mn / dpr, 0, Math.PI * 2)
                        ctx.stroke()
                    }
                }
            }
            ctx.setLineDash([])

            // 算子辅助圈：vortex 环/轴向、attract 阈值圈、控制点角度轴向
            // （角度含 spin 进动，与 GPU 侧 angles + spin·t 同步）
            const rt = getRuntime()
            const simT = rt?.time ?? 0
            def.controlPoints.forEach((cp, i) => {
                const ang: Vec3 = [
                    cp.angles[0] + cp.spin[0] * simT,
                    cp.angles[1] + cp.spin[1] * simT,
                    cp.angles[2] + cp.spin[2] * simT,
                ]
                const rot = cpRotMat(ang)
                const bx = origin[0] + cp.offset[0] + (cp.lockToPointer ? editor.pointer[0] : 0)
                const by = origin[1] + cp.offset[1] + (cp.lockToPointer ? editor.pointer[1] : 0)
                let hasVortex = false
                for (const op of def.operators) {
                    if ((Number(op.controlpoint) || 0) !== i) continue
                    if (op.name === 'vortex' || op.name === 'vortex_v2') {
                        hasVortex = true
                        const off = mulMatVec(rot, asVec3(op.offset))
                        const axis = mulMatVec(rot, asVec3(op.axis ?? [0, 0, 1]))
                        const cx = bx + off[0]
                        const cy = by + off[1]
                        const ring = Number(op.ringradius) || 0
                        ctx.strokeStyle = 'rgba(120, 255, 180, 0.55)'
                        ctx.setLineDash([6, 4])
                        if (ring > 0) {
                            const [sx, sy] = toScreen(cx, cy)
                            ctx.beginPath()
                            ctx.arc(sx, sy, ring / dpr, 0, Math.PI * 2)
                            ctx.stroke()
                        }
                        const norm = Math.hypot(axis[0], axis[1])
                        if (norm > 1e-4) {
                            const [sx, sy] = toScreen(cx, cy)
                            ctx.strokeStyle = 'rgba(120, 255, 180, 0.85)'
                            ctx.beginPath()
                            ctx.moveTo(sx, sy)
                            ctx.lineTo(sx + axis[0] / norm * 56, sy - axis[1] / norm * 56)
                            ctx.stroke()
                        }
                        ctx.setLineDash([])
                    }
                    else if (op.name === 'controlpointattract') {
                        const off = mulMatVec(rot, asVec3(op.origin))
                        const th = Number(op.threshold) || 0
                        if (th > 0) {
                            const [sx, sy] = toScreen(bx + off[0], by + off[1])
                            ctx.strokeStyle = 'rgba(255, 170, 120, 0.5)'
                            ctx.setLineDash([3, 4])
                            ctx.beginPath()
                            ctx.arc(sx, sy, th / dpr, 0, Math.PI * 2)
                            ctx.stroke()
                            ctx.setLineDash([])
                        }
                    }
                }

                // 无 vortex 时，角度非零的控制点也标出旋转后的 Z 轴
                if (!hasVortex && ang.some(a => a !== 0)) {
                    const z = mulMatVec(rot, [0, 0, 1])
                    const norm = Math.hypot(z[0], z[1])
                    if (norm > 1e-4) {
                        const [sx, sy] = toScreen(bx, by)
                        ctx.strokeStyle = 'rgba(160, 170, 255, 0.6)'
                        ctx.beginPath()
                        ctx.moveTo(sx, sy)
                        ctx.lineTo(sx + z[0] / norm * 40, sy - z[1] / norm * 40)
                        ctx.stroke()
                    }
                }
            })

            // control points
            ctx.font = '10px ui-monospace, monospace'
            def.controlPoints.forEach((cp, i) => {
                const used = [def.emitters, def.operators].some(list =>
                    list.some(m => Number(m.controlpoint) === i || Number(m.controlpointstart) === i))
                const px = origin[0] + cp.offset[0] + (cp.lockToPointer ? editor.pointer[0] : 0)
                const py = origin[1] + cp.offset[1] + (cp.lockToPointer ? editor.pointer[1] : 0)
                const [sx, sy] = toScreen(px, py)
                ctx.strokeStyle = cp.lockToPointer ? 'rgba(255, 210, 120, 0.95)' : used ? 'rgba(255, 130, 130, 0.9)' : 'rgba(255, 130, 130, 0.35)'
                ctx.beginPath()
                ctx.moveTo(sx - 7, sy)
                ctx.lineTo(sx + 7, sy)
                ctx.moveTo(sx, sy - 7)
                ctx.lineTo(sx, sy + 7)
                ctx.stroke()
                ctx.fillStyle = ctx.strokeStyle as string
                ctx.fillText(`cp${i}${cp.lockToPointer ? ' ⌨' : ''}`, sx + 9, sy - 6)
            })

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
    @pointermove="onPointerMove"
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
