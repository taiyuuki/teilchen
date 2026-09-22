import { describe, expect, it } from 'vitest'
import { defaultSystem } from '@teilchen/core'
import { compileProgram } from '../src/compile.ts'
import { OPERATORS_OFFSET, OperatorKind } from '../src/layout.ts'

const OP_U32 = OPERATORS_OFFSET / 4
const OP_F32 = OPERATORS_OFFSET / 4

/** f32 槽位逐元素近似比较。 */
function expectSlot(f32: Float32Array, base: number, expected: number[]): void {
    for (let i = 0; i < expected.length; i++) expect(f32[base + i]).toBeCloseTo(expected[i], 5)
}

describe('compileProgram：audioreact', () => {
    it('kind 编码 + 参数写入 a/b 槽位（band/sizemin/sizemax + alphamin/alphamax）', () => {
        const def = defaultSystem('t')
        def.operators = [{ name: 'audioreact', band: 0.4, sizemin: 0.5, sizemax: 2, alphamin: 0.2, alphamax: 1.5 }]
        const { data, warnings } = compileProgram(def)
        expect(warnings).toEqual([])

        const u32 = new Uint32Array(data.buffer)
        const f32 = new Float32Array(data.buffer)
        expect(u32[OP_U32]).toBe(OperatorKind.AudioReact)
        expectSlot(f32, OP_F32 + 4, [0.4, 0.5, 2, 0])
        expectSlot(f32, OP_F32 + 8, [0.2, 1.5, 0, 0])
    })

    it('缺省值：band 0.1、size 1→1.6、alpha 1→1（不调制）', () => {
        const def = defaultSystem('t')
        def.operators = [{ name: 'audioreact' }]
        const { data } = compileProgram(def)

        const f32 = new Float32Array(data.buffer)
        expectSlot(f32, OP_F32 + 4, [0.1, 1, 1.6, 0])
        expectSlot(f32, OP_F32 + 8, [1, 1, 0, 0])
    })

    it('band 越界钳制到 [0,1]', () => {
        const def = defaultSystem('t')
        def.operators = [{ name: 'audioreact', band: 7 }]
        const { data } = compileProgram(def)

        const f32 = new Float32Array(data.buffer)
        expect(f32[OP_F32 + 4]).toBe(1)
    })
})
