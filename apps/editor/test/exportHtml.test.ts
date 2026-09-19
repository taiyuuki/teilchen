import { describe, expect, it } from 'vitest'
import { editor } from '../src/store.ts'
import { buildStandaloneHtml } from '../src/exportHtml.ts'

describe('buildStandaloneHtml（独立 HTML 导出模板）', () => {
    it('包含场景文件、资产表与 player 包体，且危险序列被转义', () => {

        // 名字注入 </script>：内嵌 JSON 必须转义 <，否则脚本提前闭合
        editor.def.name = 'a</script>b'
        const html = buildStandaloneHtml()
        editor.def.name = 'untitled'

        expect(html).toContain('window.__TEILCHEN_SCENE__')
        expect(html).toContain('window.__TEILCHEN_ASSETS__')
        expect(html).toContain('"format":"teilchen/scene"')

        // 场景 JSON 内 < 已转义为 \u003c（不会提前闭合脚本）；title 走 HTML 实体
        expect(html).toContain('a\\u003c/script>b')
        expect(html).toContain('<title>a&lt;/script&gt;b</title>')

        // 全文只允许模板自身的 3 个 <script>/</script> 标签对
        const opens = html.match(/<script>/g)?.length ?? 0
        const closes = html.match(/<\/script>/g)?.length ?? 0
        expect(opens).toBe(2)
        expect(closes).toBe(2)

        // player 浏览器包以原文内嵌（IIFE）
        expect(html.length).toBeGreaterThan(100_000)
        expect(html).toContain('<canvas')
        expect(html).toContain('id="unsupported"')
    })
})
