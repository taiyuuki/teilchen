import { describe, expect, it } from 'vitest'
import {
    addSystemToScene,
    editor,
    registerTextureAsset,
    removeSystem,
    setRootTexturePath,
} from '../src/store.ts'
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

        // 全文只允许模板自身的 2 个 <script>/</script> 标签对
        const opens = html.match(/<script>/g)?.length ?? 0
        const closes = html.match(/<\/script>/g)?.length ?? 0
        expect(opens).toBe(2)
        expect(closes).toBe(2)

        // player 浏览器包以原文内嵌（IIFE）
        expect(html.length).toBeGreaterThan(100_000)
        expect(html).toContain('<canvas')
        expect(html).toContain('id="unsupported"')
    })

    it('全量嵌入贴图登记表（根 + children）并改写根引用', () => {
        editor.def.name = 'tex-demo'
        const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
        registerTextureAsset({ path: 'particle/fire/fire1', data: bytes('TEXV-root') })
        registerTextureAsset({ path: 'particle/child/spark', data: bytes('TEXV-child'), alphaPriority: false })
        setRootTexturePath('particle/fire/fire1')
        try {
            const html = buildStandaloneHtml()
            expect(html).toContain('"particle/fire/fire1"')
            expect(html).toContain('"particle/child/spark"')

            // alphaPriority=false 的资产附带 .json 通道语义描述（base64 内嵌）
            const descMatch = html.match(/"particle\/child\/spark\.json":{"data":"([^"]+)"}/)
            expect(descMatch).not.toBeNull()
            expect(atob(descMatch![1])).toBe('{"alphachannelpriority":false}')

            // 根材质引用改写到登记键
            expect(html).toContain('"textures":["particle/fire/fire1"')
        }
        finally {
            setRootTexturePath(null)
        }
    })

    it('多系统场景：全部系统进场景文件', () => {
        editor.def.name = 'multi-a'
        addSystemToScene()
        editor.def.name = 'multi-b'
        const html = buildStandaloneHtml()
        removeSystem(editor.activeId)
        editor.def.name = 'untitled'

        expect(html).toContain('"name":"multi-a"')
        expect(html).toContain('"name":"multi-b"')
    })
})
