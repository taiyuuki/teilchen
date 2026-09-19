import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

if (navigator.gpu) {
    createApp(App).mount('#app')
}
else {
    const zh = navigator.language.toLowerCase().startsWith('zh')
    document.getElementById('unsupported')!.textContent = zh
        ? '当前浏览器不支持 WebGPU（需要 Chrome 113+ / Edge 113+ / Safari 26+）'
        : 'This browser does not support WebGPU (requires Chrome 113+ / Edge 113+ / Safari 26+)'
    document.getElementById('unsupported')!.style.display = 'grid'
}
