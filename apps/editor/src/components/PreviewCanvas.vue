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
    editor.pointer = [x - rect.width / 2, rect.height / 2 - y]
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
            const toScreen = (x: number, y: number): [number, number] => [w / 2 + x, h / 2 - y]

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
                        ctx.arc(sx, sy, mx, 0, Math.PI * 2)
                        ctx.stroke()
                    }
                    if (mn > 0) {
                        ctx.beginPath()
                        ctx.arc(sx, sy, mn, 0, Math.PI * 2)
                        ctx.stroke()
                    }
                }
            }
            ctx.setLineDash([])

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
