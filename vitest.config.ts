import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Windows 上多个测试文件并行时，vitest 会把同一个模块缓存写到同一临时路径，
    // 偶发 EPERM（系统或安全软件占用）；串行只慢 1 秒左右，但退出码稳定。
    fileParallelism: false
  }
})
