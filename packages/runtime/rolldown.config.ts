import {  type RolldownOptions, defineConfig } from 'rolldown'
import { dts } from 'rolldown-plugin-dts'

// 库入口：ESM + d.ts，@teilchen/core 保持外部依赖
const lib = {
    input:    'src/index.ts',
    external: ['@teilchen/core'],
    output:   {
        dir:       'dist',
        format:    'es',
        sourcemap: true,
    },
    plugins: [dts({ tsconfig: './tsconfig.json' })],
}

// 浏览器直引入口：IIFE 单文件（core 打进包里），供独立 HTML 内嵌 / CDN 引用
const global = {
    input:  'src/global.ts',
    output: {
        file:      'dist/player.global.js',
        format:    'iife',
        name:      'Teilchen',
        exports:   'named',
        sourcemap: true,
    },
}

export default defineConfig([lib, global] as RolldownOptions)
