/**
 * 对 refs 中的真实 .tex 文件验证解析器（node 直接跑，无 DOM 依赖）。
 * 用法：node scripts/verify-tex.ts [文件...]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseTex } from '../packages/runtime/src/tex.ts'

const root = 'refs/MirageWallpaper/assets/materials'

function collect(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {

            // lut/ 是 3D 后期调色资产（体纹理，头部多 depth 字段、body 布局不同），
            // 不属于粒子贴图目标语料
            if (name !== 'lut') collect(p, out)
        }
        else if (name.endsWith('.tex')) out.push(p)
    }
}

const files = process.argv.slice(2)
const all: string[] = []
if (files.length) all.push(...files)
else collect(root, all)

let ok = 0
let failed = 0
let withFrames = 0
for (const f of all) {
    try {
        const tex = parseTex(readFileSync(f))
        const desc = [
            `${tex.width}x${tex.height}`,
            tex.container ? `container:${tex.container.mime}` : `${tex.rgba.length >> 2}px`,
            tex.isSprite ? `sprite:${tex.frames.length}帧` : '',
            tex.noInterpolation ? 'nearest' : '',
            tex.clampUVs ? 'clamp' : '',
        ].filter(Boolean).join(' ')
        if (tex.frames.length) {
            withFrames++
            const ft = tex.frames[0]!
            console.log(`✓ ${f.replace(`${root}/`, '')}  ${desc}  frame0: (${ft.x.toFixed(3)},${ft.y.toFixed(3)}) axis(${ft.xAxis.map(v => v.toFixed(3))}) t=${ft.frametime}s`)
        }
        else {
            console.log(`✓ ${f.replace(`${root}/`, '')}  ${desc}`)
        }
        ok++
    }
    catch(err) {
        console.log(`✗ ${f.replace(`${root}/`, '')}  ${(err as Error).message}`)
        failed++
    }
}
console.log(`\n${ok} 成功 / ${failed} 失败 / ${withFrames} 个 sprite 贴图（共 ${all.length}）`)
if (failed > 0) process.exit(1)
