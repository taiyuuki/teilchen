import { describe, expect, it } from 'vitest'
import {
    bufferSource,
    chainSource,
    fetchSource,
    looksLikeSceneFile,
    looksLikeWeParticleJson,
    parseSystemInput,
    pathCandidates,
} from '../src/player.ts'

describe('pathCandidates', () => {
    it('无扩展名贴图路径按序尝试扩展名变体，basename 兜底在最后', () => {
        expect(pathCandidates('particle/fire/fire1', ['.tex', '.png'])).toEqual([
            'particle/fire/fire1',
            'particle/fire/fire1.tex',
            'particle/fire/fire1.png',
            'fire1',
        ])
    })

    it('basename 兜底（WE 引用带目录、导出资产平铺）', () => {
        expect(pathCandidates('materials/plugin/spark.json')).toEqual([
            'materials/plugin/spark.json',
            'spark.json',
        ])
    })

    it('规范化反斜杠与首部斜杠', () => {
        expect(pathCandidates('\\a\\b.png')[0]).toBe('a/b.png')
        expect(pathCandidates('/a.png')[0]).toBe('a.png')
    })
})

describe('bufferSource', () => {
    const files = {
        'Particle/Fire/Fire1.tex': new Uint8Array([1, 2, 3]),
        'halo.png':                new Uint8Array([4]).buffer,
        'desc.json':               new TextEncoder().encode('{"a":1}'),
    }
    const src = bufferSource(files)

    it('精确命中', async() => {
        expect(new Uint8Array((await src.read('halo.png'))!)[0]).toBe(4)
    })

    it('大小写不敏感', async() => {
        expect(new Uint8Array((await src.read('particle/fire/fire1.tex'))!)[0]).toBe(1)
    })

    it('basename 兜底', async() => {
        expect(await src.read('any/dir/fire1.tex')).not.toBeNull()
        expect(await src.read('desc.json')).not.toBeNull()
    })

    it('Uint8Array 资产读取', async() => {
        expect(new Uint8Array((await src.read('x/other/desc.json'))!).length).toBeGreaterThan(0)
    })

    it('未命中返回 null', async() => {
        expect(await src.read('missing.png')).toBeNull()
    })
})

describe('chainSource', () => {
    it('先声明的源优先', async() => {
        const a = bufferSource({ 'x.png': new Uint8Array([1]) })
        const b = bufferSource({ 'y.png': new Uint8Array([2]) })
        const c = chainSource(a, b)
        expect(new Uint8Array((await c.read('x.png'))!)[0]).toBe(1)
        expect(new Uint8Array((await c.read('y.png'))!)[0]).toBe(2)
        expect(await c.read('z.png')).toBeNull()
    })
})

describe('格式识别', () => {
    it('WE particle JSON：material 路径字符串或单数模块表', () => {
        expect(looksLikeWeParticleJson({ material: 'materials/a.json' })).toBe(true)
        expect(looksLikeWeParticleJson({ emitter: { boxrandom: {} } })).toBe(true)
        expect(looksLikeWeParticleJson({ emitters: [], renderers: [{ name: 'sprite' }] })).toBe(false)
    })

    it('场景文件：format 标记或 systems 数组', () => {
        expect(looksLikeSceneFile({ format: 'teilchen/scene', version: 1, systems: [] })).toBe(true)
        expect(looksLikeSceneFile({ systems: [{}] })).toBe(true)
        expect(looksLikeSceneFile({ renderers: [] })).toBe(false)
    })
})

describe('parseSystemInput', () => {
    it('原生 def 直通并规范化', async() => {
        const { def, warnings } = await parseSystemInput({
            name:               'native',
            material:           { blending: 'additive', colorBlendMode: 0, textures: [], depthTest: false, depthWrite: false },
            maxCount:           100,
            startTime:          0,
            animationMode:      'sequence',
            sequenceMultiplier: 1,
            flags:              0,
            emitters:           [],
            initializers:       [],
            operators:          [],
            renderers:          [{ name: 'sprite' }],
            controlPoints:      [],
            children:           [],
            origin:             [0, 0, 0],
            scale:              [1, 1, 1],
            angles:             [0, 0, 0],
        }, bufferSource({}), 'native')
        expect(def.name).toBe('native')
        expect(def.controlPoints).toHaveLength(8)
        expect(warnings).toHaveLength(0)
    })

    it('WE JSON：material 引用未命中时告警并走默认材质', async() => {
        const { def, warnings } = await parseSystemInput({
            material: 'materials/missing.json',
            maxcount: '500',
        }, bufferSource({}), 'we')
        expect(warnings.some(w => w.includes('missing.json'))).toBe(true)
        expect(def.maxCount).toBe(500)
        expect(def.material.blending).toBe('additive')
    })

    it('WE JSON：material 引用从资产源补齐', async() => {
        const mat = { passes: [{ blending: 'translucent', textures: ['particle/halo'] }] }
        const { def } = await parseSystemInput(
            { material: 'materials/halo.json' },
            bufferSource({ 'materials/halo.json': JSON.stringify(mat) }),
            'we',
        )
        expect(def.material.blending).toBe('translucent')
        expect(def.material.textures[0]).toBe('particle/halo')
    })
})

describe('fetchSource', () => {
    it('相对路径 fetch（404 → null）', async() => {

        // vitest 环境无服务器：请求失败/404 都应返回 null 而非抛错
        const src = fetchSource('http://127.0.0.1:1/')
        await expect(src.read('x.tex')).resolves.toBeNull()
    })
})
