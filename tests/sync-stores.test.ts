import { describe, expect, it } from 'vitest'
import {
  GistStore,
  GiteeStore,
  createStore,
  errorTextOf,
  fromBase64,
  payloadSize,
  toBase64
} from '@/sync/stores'
import type { SyncConfig } from '@/sync/stores'

const base: SyncConfig = {
  backend: 'gitee',
  githubToken: '',
  gistId: '',
  giteeToken: '',
  giteeRepo: '',
  giteeDir: 'data'
}

describe('base64 编解码（Gitee 接口用）', () => {
  it('中文与 emoji 往返一致', () => {
    const text = '测量放样（爆破孔） 0.67h · 中文测试 🚀'
    expect(fromBase64(toBase64(text))).toBe(text)
  })

  it('较长内容不会因分段编码出错', () => {
    const text = '导流洞1#施工支洞,0+020.5~0+025.7,锚杆注浆,4.00h\n'.repeat(2000)
    expect(fromBase64(toBase64(text))).toBe(text)
  })
})

describe('文件体积估算', () => {
  it('按 UTF-8 字节计算，用于 1MB 上限判断', () => {
    expect(payloadSize({ a: '中文' })).toBe(Buffer.byteLength(JSON.stringify({ a: '中文' }), 'utf8'))
  })
})

describe('后端选择', () => {
  it('Gitee 配置不全时报错', () => {
    expect(() => createStore({ ...base })).toThrow(/Gitee/)
    expect(() => createStore({ ...base, giteeToken: 't' })).toThrow(/仓库/)
  })

  it('GitHub 配置不全时报错', () => {
    expect(() => createStore({ ...base, backend: 'gist' })).toThrow(/GitHub/)
    expect(() => createStore({ ...base, backend: 'gist', githubToken: 't' })).toThrow(/Gist/)
  })

  it('配置完整时返回对应适配器', () => {
    const gitee = createStore({ ...base, giteeToken: 'tok', giteeRepo: 'wsq/gongxu-data' })
    expect(gitee).toBeInstanceOf(GiteeStore)
    expect(gitee.label).toContain('Gitee')

    const gist = createStore({ ...base, backend: 'gist', githubToken: 'tok', gistId: 'abc' })
    expect(gist).toBeInstanceOf(GistStore)
    expect(gist.label).toContain('GitHub')
  })
})

describe('接口错误信息渲染', () => {
  it('Gitee 的嵌套 error 对象不会被渲染成 [object Object]', () => {
    expect(errorTextOf({ error: { base: ['已存在同地址仓库（忽略大小写）'] } })).toBe(
      '已存在同地址仓库（忽略大小写）'
    )
  })

  it('多层嵌套会按顺序拼接', () => {
    expect(errorTextOf({ error: { a: ['x', 'y'], b: 'z' } })).toBe('x；y；z')
  })

  it('GitHub 风格的单层 message 与空值都能处理', () => {
    expect(errorTextOf({ message: 'Not Found Project' })).toBe('Not Found Project')
    expect(errorTextOf(null)).toBe('')
    expect(errorTextOf(undefined)).toBe('')
  })
})
