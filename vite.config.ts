import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    {
      // GitHub Pages 默认走 Jekyll，会忽略下划线开头的文件；空 .nojekyll 可关掉它
      name: 'emit-nojekyll',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' })
      }
    },
    Components({ resolvers: [VantResolver()], dts: 'src/components.d.ts' }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '工序用时记录与效率分析',
        short_name: '工序用时',
        description: '水利工程工序用时记录、衔接空隙与效率分析',
        lang: 'zh-CN',
        theme_color: '#1f6feb',
        background_color: '#f5f6f8',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './index.html',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        // 同步请求（GitHub API）绝不缓存，始终走网络
        runtimeCaching: []
      },
      devOptions: { enabled: false }
    })
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    target: 'es2019',
    chunkSizeWarningLimit: 1500
  }
})
