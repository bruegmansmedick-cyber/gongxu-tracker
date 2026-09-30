import { createApp } from 'vue'
import 'vant/lib/index.css'
import '@/styles/global.css'
import App from '@/App.vue'
import router from '@/router'
import { initApp } from '@/store'

const app = createApp(App)
app.use(router)
app.mount('#app')

void initApp()
