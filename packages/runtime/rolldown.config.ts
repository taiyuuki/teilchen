import { defineConfig } from 'rolldown'
import { dts } from 'rolldown-plugin-dts'

export default defineConfig({
    input:    'src/index.ts',
    external: ['@teilchen/core'],
    output:   {
        dir:       'dist',
        format:    'es',
        sourcemap: true,
    },
    plugins: [dts({ tsconfig: './tsconfig.json' })],
})
