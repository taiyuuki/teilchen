import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
    plugins: [vue()],

    // dev 时借用 playground 的 WE 资产（/we/presets、/we/tex），导入 children/material/贴图用；
    // build 不打包（publicDir 关闭，产物保持干净）
    publicDir: command === 'serve' ? '../playground/public' : false,
}))
