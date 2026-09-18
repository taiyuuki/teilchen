/**
 * WE particle JSON 导入/导出 round-trip 用例。
 * 锁住本文件承载的关键语义：控制点 angles/spin/flags 位、模块参数的宽松类型收敛
 * （float 不截断）、默认值填充与未知字段告警。
 */
import { describe, expect, it } from 'vitest'

// 从包入口导入：builtins 的模块注册副作用随加载生效（we.ts 自身不注册模块）
import { normalizeDef, parseWeParticleJson, serializeWeParticleJson } from '../src/index.ts'

describe('parseWeParticleJson：控制点', () => {

    it('angles/spin 解析并完整导出（round-trip 不丢失）', () => {
        const { def } = parseWeParticleJson({
            controlpoint: [
                { id: 1, flags: 16, angles: '1.5 0.5 0.1', spin: '0 -2.1142338 0' },
            ],
        })
        expect(def.controlPoints[1].angles).toEqual([1.5, 0.5, 0.1])
        expect(def.controlPoints[1].spin).toEqual([0, -2.1142338, 0])
        expect(def.controlPoints[1].lockToPointer).toBe(false)

        const out = serializeWeParticleJson(def).controlpoint as Record<string, unknown>[]
        expect(out[1].flags).toBe(16)
        expect(out[1].angles).toBe('1.5 0.5 0.1')

        // spin 经 vec3 格式化（6 位小数）后语义不变：回读比对
        const rt = parseWeParticleJson(serializeWeParticleJson(def))
        expect(rt.def.controlPoints[1].spin).toEqual([0, expect.closeTo(-2.1142338, 5), 0])

        // 缺省控制点：零值 angles/spin 不写出（贴近 WE 导出观感）
        expect(out[0]).not.toHaveProperty('angles')
        expect(out[0]).not.toHaveProperty('spin')
    })

    it('lockToPointer 与 flags 其他位互不破坏', () => {
        const { def } = parseWeParticleJson({
            controlpoint: [
                { id: 0, flags: 17 }, // worldspace + link_mouse
                { id: 1, flags: 16, locktopointer: true }, // 显式覆盖默认
                { id: 2, flags: 1, locktopointer: false }, // 显式解除
            ],
        })
        expect(def.controlPoints[0].lockToPointer).toBe(true)
        expect(def.controlPoints[1].lockToPointer).toBe(true)
        expect(def.controlPoints[2].lockToPointer).toBe(false)

        const out = serializeWeParticleJson(def).controlpoint as Record<string, unknown>[]
        expect(out[0].flags).toBe(17) // 锁定不清除其他位
        expect(out[1].flags).toBe(17) // 16|1
        expect(out[2].flags).toBe(0) // 解锁清除 bit1
    })
})

describe('normalizeModule：类型收敛与默认值', () => {

    it('mapsequence count 保持小数（dna 双螺旋的扭转相位）', () => {
        const { def } = parseWeParticleJson({
            initializer: [
                { name: 'mapsequencearoundcontrolpoint', count: 2.2 },
                { name: 'mapsequencebetweencontrolpoints', count: 63.5 },
            ],
        })
        expect(def.initializers[0].count).toBe(2.2)
        expect(def.initializers[1].count).toBe(63.5)

        // 手工 def / 预设走 normalizeDef 同样不截断
        expect(normalizeDef(def).initializers[0].count).toBe(2.2)
    })

    it('bounds 缺省填 WE 默认角度范围 [0,1]', () => {
        const { def } = parseWeParticleJson({ initializer: [{ name: 'mapsequencearoundcontrolpoint' }] })
        expect(def.initializers[0].bounds).toEqual([0, 1, 0])
    })

    it('宽松类型：字符串数值/vec3/数组形态统一', () => {
        const { def } = parseWeParticleJson({
            maxcount:    '500',
            starttime:   '1.5',
            flags:       '1',
            emitter:     [{ name: 'sphererandom', rate: '32', directions: '1 0 1' }],
            initializer: [{ name: 'colorrandom', min: '204 0 255', max: [124, 64, 255] }],
        })
        expect(def.maxCount).toBe(500)
        expect(def.startTime).toBe(1.5)
        expect(def.flags).toBe(1)
        expect(def.emitters[0].rate).toBe(32)
        expect(def.emitters[0].directions).toEqual([1, 0, 1])
        expect(def.initializers[0].min).toEqual([204, 0, 255])
        expect(def.initializers[0].max).toEqual([124, 64, 255])
    })
})

describe('结构与告警', () => {

    it('material 引用未提供内容时告警并回退默认', () => {
        const { def, warnings } = parseWeParticleJson({ material: 'materials/x.json' })
        expect(warnings.some(w => w.includes('material'))).toBe(true)
        expect(def.material.blending).toBe('additive')
    })

    it('children：type 缺省为 static，未知 type 忽略并告警', () => {
        const { def, warnings } = parseWeParticleJson({
            emitter:  [{ name: 'sphererandom' }],
            children: [
                { name: 'a.json' },
                { name: 'b.json', type: 'bogus' },
            ],
        })
        expect(def.children).toHaveLength(1)
        expect(def.children[0].type).toBe('static')
        expect(warnings.some(w => w.includes('bogus'))).toBe(true)
    })

    it('没有可用 emitter 时告警', () => {
        const { warnings } = parseWeParticleJson({})
        expect(warnings.some(w => w.includes('emitter'))).toBe(true)
    })
})
