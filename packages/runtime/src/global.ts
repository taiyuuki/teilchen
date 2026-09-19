/**
 * 浏览器直引入口 —— 构建为 dist/player.global.js（IIFE，无外部依赖）。
 *
 * 用法一（库）：任何页面引入本文件后，window.Teilchen 上可用
 * VFXPlayer / fetchSource / bufferSource / chainSource / SceneFile 工具。
 *
 * 用法二（独立 HTML 导出产物）：页面预置
 *   window.__TEILCHEN_SCENE__  = 场景文件（SceneFile）
 *   window.__TEILCHEN_ASSETS__ = { 路径: { data: base64 } }
 * 时自动引导：创建播放器 → 载入场景 → 指针跟随 → 播放。
 */
import { VFXPlayer, bufferSource } from './player.ts'
import type { SceneFile } from './player.ts'

export { VFXPlayer, bufferSource, chainSource, fetchSource } from './player.ts'
export type { AssetSource, SceneFile } from './player.ts'

interface EmbeddedAsset {

    /** base64 编码的文件字节。 */
    data: string
}

interface EmbeddedGlobals {
    __TEILCHEN_SCENE__?:  SceneFile
    __TEILCHEN_ASSETS__?: Record<string, EmbeddedAsset>
}

/** 独立 HTML 自动引导：场景脚本先于本包执行，因此执行到此处时数据已在 window 上。 */
async function bootEmbedded(): Promise<void> {
    const w = window as unknown as EmbeddedGlobals
    const scene = w.__TEILCHEN_SCENE__
    if (!scene) return
    const canvas = document.querySelector('canvas')
    if (!canvas) {
        console.error('[teilchen] 未找到 <canvas>')

        return
    }
    if (!navigator.gpu) {
        document.getElementById('unsupported')?.removeAttribute('hidden')
        console.error('[teilchen] 此浏览器不支持 WebGPU')

        return
    }

    try {
        const files: Record<string, ArrayBuffer> = {}
        for (const [path, a] of Object.entries(w.__TEILCHEN_ASSETS__ ?? {})) {
            files[path] = base64ToBytes(a.data)
        }
        const player = await VFXPlayer.create({ canvas })
        await player.load(scene, { assets: bufferSource(files) })
        canvas.addEventListener('pointermove', e => {
            const rect = canvas.getBoundingClientRect()
            player.setPointer(e.clientX - rect.left, e.clientY - rect.top)
        })
        if (scene.autostart !== false) player.start();
        (window as unknown as Record<string, unknown>).__teilchenPlayer = player
    }
    catch(err) {
        console.error('[teilchen] 场景加载失败:', err)
        document.getElementById('unsupported')?.removeAttribute('hidden')
    }
}

function base64ToBytes(b64: string): ArrayBuffer {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)

    return out.buffer as ArrayBuffer
}

if (typeof window !== 'undefined' && (window as unknown as EmbeddedGlobals).__TEILCHEN_SCENE__) {
    if (document.readyState === 'loading') {
        void document.addEventListener('DOMContentLoaded', () => void bootEmbedded())
    }
    else {
        void bootEmbedded()
    }
}
