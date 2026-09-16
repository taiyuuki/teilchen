/**
 * 对 WE 官方示例/preset JSON 验证导入器（node 直接跑，无 DOM 依赖）。
 * 用法：node --experimental-strip-types scripts/verify-we-samples.ts [目录]
 * 目录里同时放 particle json 和其引用的 material json（按 basename 配对）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseWeParticleJson } from '../packages/core/src/index.ts'

const dir = process.argv[2] ?? 'apps/playground/public/we'
const files = readdirSync(dir).filter(n => n.endsWith('.json'))

// 材料 json 在 materials/ 子目录，按 basename 索引（particle 里引用形如 "materials/presets/foo.json"）
const materialByName: Record<string, unknown> = {}
for (const f of readdirSync(join(dir, 'materials')).filter(n => n.endsWith('.json'))) {
    try {
        const j = JSON.parse(readFileSync(join(dir, 'materials', f), 'utf8')) as Record<string, unknown>
        if (j && typeof j === 'object' && 'passes' in j) materialByName[f] = j
    }
    catch { /* 非 JSON 或语法错误，忽略 */ }
}

let failed = 0
for (const f of files) {
    let json: unknown
    try {
        json = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    }
    catch(err) {
        failed++
        console.log(`✘ ${f}: JSON 语法错误 ${(err as Error).message}`)
        continue
    }
    const matRef = String((json as Record<string, unknown>)?.material ?? '')
    const matFile = matRef.split('/').pop() ?? ''
    try {
        const { def, warnings } = parseWeParticleJson(json, materialByName[matFile], f)
        console.log(`✔ ${f}  max=${def.maxCount} emitters=[${def.emitters.map(e => e.name)}] `
            + `init=${def.initializers.length} ops=[${def.operators.map(o => o.name)}] `
            + `rnd=[${def.renderers.map(r => r.name)}] blend=${def.material.blending}`
            + `${def.children.length ? ` children=${def.children.length}` : ''}`)
        for (const w of warnings) console.log(`   ⚠ ${w}`)
    }
    catch(err) {
        failed++
        console.log(`✘ ${f}: ${(err as Error).message}`)
    }
}
process.exit(failed ? 1 : 0)
