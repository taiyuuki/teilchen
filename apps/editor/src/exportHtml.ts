/**
 * 独立 HTML 导出：把 player 浏览器包（@teilchen/runtime/dist/player.global.js）
 * + 场景文件（teilchen/scene v1）+ base64 资产表内嵌进一个零依赖 HTML，
 * 任何支持 WebGPU 的现代浏览器直接打开即播（文件协议亦可）。
 */
import playerBundle from '@teilchen/runtime/dist/player.global.js?raw'
import type { SceneFile } from '@teilchen/runtime'
import { editor, getTextureSource } from './store.ts'
import { t } from './i18n.ts'

function bytesToBase64(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes)
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < view.length; i += chunk) {
        bin += String.fromCharCode(...view.subarray(i, i + chunk))
    }

    return btoa(bin)
}

function stringToBase64(text: string): string {
    return bytesToBase64(new TextEncoder().encode(text).buffer as ArrayBuffer)
}

/** 内嵌进 <script> 的 JSON：转义 < 防止 </script> 提前闭合。 */
function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** IIFE 包体里的 </script> 序列同样要转义（字符串字面量内合法）。 */
function scriptSafe(code: string): string {
    return code.replace(/<\/script/gi, '<\\/script')
}

/** HTML 文本转义（<title> 等文本位）。 */
function htmlEscape(text: string): string {
    return text.replace(/[&<>]/g, ch => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;')
}

export function buildStandaloneHtml(): string {
    const def = JSON.parse(JSON.stringify(editor.def)) as typeof editor.def
    const src = getTextureSource()

    // 资产表：key = 贴图路径（player 的 bufferSource 按 key/basename 兜底查找）。
    // 上传图/.tex 的文件名与 def.material.textures[0] 无关 → 导出时把引用改写到嵌入路径。
    const assets: Record<string, { data: string }> = {}
    if (src) {
        assets[src.path] = { data: bytesToBase64(src.data) }
        if (src.alphaPriority === false) {
            assets[`${src.path}.json`] = { data: stringToBase64(JSON.stringify({ alphachannelpriority: false })) }
        }
        def.material.textures = [src.path, ...def.material.textures.slice(1)]
    }

    const scene: SceneFile = {
        format:  'teilchen/scene',
        version: 1,
        systems: [def],
    }

    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(def.name || 'teilchen scene')}</title>
<style>
  html, body { margin: 0; height: 100%; background: #04050a; overflow: hidden; }
  canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
  #unsupported {
    position: fixed; inset: 0; display: grid; place-items: center;
    color: #8b93a7; font: 14px/1.6 system-ui, sans-serif; text-align: center;
  }
  #unsupported[hidden] { display: none; }
</style>
</head>
<body>
<canvas id="scene"></canvas>
<div id="unsupported" hidden>
  此场景需要 WebGPU<br>请使用 Chrome 113+ / Edge 113+ / Safari 26+ 打开
</div>
<script>
window.__TEILCHEN_SCENE__ = ${scriptJson(scene)};
window.__TEILCHEN_ASSETS__ = ${scriptJson(assets)};
</script>
<script>${scriptSafe(playerBundle)}</script>
</body>
</html>
`
}

/** 导出独立 HTML 并触发下载。 */
export function exportStandaloneHtml(): void {
    const html = buildStandaloneHtml()
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${editor.def.name || 'scene'}.html`
    a.click()
    URL.revokeObjectURL(url)
    editor.warnings.push(t('warn.exportHtmlDone', { file: a.download }))
}
