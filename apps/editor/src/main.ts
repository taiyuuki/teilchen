import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

if (navigator.gpu) {
    createApp(App).mount('#app')
}
else {
    document.getElementById('unsupported')!.style.display = 'grid'
}
