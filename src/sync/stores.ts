/**
 * 同步后端适配器：
 *   gitee   —— Gitee 私有仓库（国内直连，推荐）
 *   gist    —— GitHub Gist（国外，国内可能连不上）
 * 两者都实现同一套 readAll / writeFiles，上层的"拉取→合并→推送→回拉校验"逻辑完全共用。
 */

export type SyncBackend = 'gitee' | 'gist'

export const MAX_FILE_BYTES = 900 * 1024
export const REQUEST_TIMEOUT_MS = 15000

const GITHUB_API = 'https://api.github.com'
const GITEE_API = 'https://gitee.com/api/v5'

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('连接超时：网络受限或需要代理。可稍后重试，或用导出/导入备份人工合并')
    }
    const detail = err instanceof Error && err.message ? `（${err.message}）` : ''
    throw new Error(`网络不可用${detail}：请检查手机网络后重试`)
  } finally {
    clearTimeout(timer)
  }
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export function payloadSize(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length
}

export interface RemoteStore {
  readonly kind: SyncBackend
  readonly label: string
  /** 读取全部数据文件：文件名 → 文本内容 */
  readAll(): Promise<Record<string, string>>
  /** 写入（新增或覆盖）若干数据文件 */
  writeFiles(files: Record<string, string>): Promise<void>
  /** 连通性自检，返回可读描述 */
  test(): Promise<string>
}

// ------------------------------------------------------------------ GitHub

function ghHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

/** 把接口返回的错误体压成一句人话（Gitee 的 error 可能是嵌套对象，直接 String() 会变成 [object Object]） */
export function errorTextOf(body: unknown): string {
  const pick = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return v.map(pick).filter(Boolean).join('；')
    if (typeof v === 'object') {
      return Object.values(v as Record<string, unknown>)
        .map(pick)
        .filter(Boolean)
        .join('；')
    }
    return ''
  }
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body : ''
  const obj = body as Record<string, unknown>
  return [pick(obj.message), pick(obj.error)].filter(Boolean).join('；')
}

export async function readError(res: Response, what: string): Promise<string> {
  let detail = ''
  try {
    detail = errorTextOf(await res.json())
  } catch {
    detail = ''
  }
  if (res.status === 401) return `${what}：凭据无效或权限不足（401${detail ? '：' + detail : ''}）`
  if (res.status === 403) return `${what}：访问被拒绝或已超限（403${detail ? '：' + detail : ''}）`
  if (res.status === 404) return `${what}：数据空间不存在或无权访问（404${detail ? '：' + detail : ''}）`
  if (res.status === 422) return `${what}：数据格式被拒绝（422${detail ? '：' + detail : ''}）`
  return `${what}：请求失败 HTTP ${res.status}${detail ? '：' + detail : ''}`
}

interface GistFile {
  filename: string
  content?: string
  truncated?: boolean
  size?: number
}

interface GistPayload {
  id: string
  description?: string
  files: Record<string, GistFile>
}

export class GistStore implements RemoteStore {
  readonly kind = 'gist' as const
  readonly label = 'GitHub Gist'

  constructor(
    private readonly pat: string,
    private readonly gistId: string
  ) {}

  private async fetchGist(): Promise<GistPayload> {
    const res = await fetchWithTimeout(`${GITHUB_API}/gists/${encodeURIComponent(this.gistId)}`, {
      headers: ghHeaders(this.pat)
    })
    if (!res.ok) throw new Error(await readError(res, 'GitHub 同步'))
    return (await res.json()) as GistPayload
  }

  async readAll(): Promise<Record<string, string>> {
    const gist = await this.fetchGist()
    const out: Record<string, string> = {}
    Object.values(gist.files ?? {}).forEach((file) => {
      if (file.truncated) {
        throw new Error(`云端文件 ${file.filename} 超过 1MB 已被截断，请先归档较早的数据再同步`)
      }
      if (typeof file.content === 'string') out[file.filename] = file.content
    })
    return out
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    const names = Object.keys(files)
    for (let i = 0; i < names.length; i += 5) {
      const chunk: Record<string, { content: string }> = {}
      names.slice(i, i + 5).forEach((n) => {
        chunk[n] = { content: files[n] }
      })
      const res = await fetchWithTimeout(`${GITHUB_API}/gists/${encodeURIComponent(this.gistId)}`, {
        method: 'PATCH',
        headers: ghHeaders(this.pat),
        body: JSON.stringify({ files: chunk })
      })
      if (!res.ok) throw new Error(await readError(res, 'GitHub 同步'))
      await res.json()
    }
  }

  async test(): Promise<string> {
    const gist = await this.fetchGist()
    const files = Object.keys(gist.files ?? {}).length
    return `GitHub Gist 连接正常：${gist.description || '（无描述）'}，文件 ${files} 个`
  }
}

// ------------------------------------------------------------------- Gitee

interface GiteeEntry {
  name: string
  path: string
  sha: string
  type: 'file' | 'dir'
  size: number
  content?: string
  encoding?: string
}

export class GiteeStore implements RemoteStore {
  readonly kind = 'gitee' as const
  readonly label = 'Gitee 私有仓库'
  private shas: Record<string, string> = {}

  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly dir: string
  ) {}

  private url(path: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ access_token: this.token, ...extra })
    return `${GITEE_API}/repos/${this.repo}/contents/${path}?${params.toString()}`
  }

  private dirPath(): string {
    return this.dir.replace(/^\/+|\/+$/g, '')
  }

  /** 404 时把"当前填的仓库名"回显出来，方便核对是不是打错字 */
  private async fail(res: Response, what: string): Promise<Error> {
    if (res.status === 404) {
      return new Error(
        `${what}：数据空间不存在或无权访问（404）——当前“数据仓库”填的是「${this.repo}」，请核对是否与 Gitee 上的地址完全一致（注意连字符，例如 youzero/gongxu-data）`
      )
    }
    return new Error(await readError(res, what))
  }

  private filePath(name: string): string {
    const dir = this.dirPath()
    return dir ? `${dir}/${name}` : name
  }

  private async listDir(): Promise<GiteeEntry[]> {
    const dir = this.dirPath()
    const res = await fetchWithTimeout(this.url(dir ? encodeURI(dir) : ''), {
      headers: { Accept: 'application/json' }
    })
    if (res.status === 404) return []
    if (!res.ok) throw await this.fail(res, 'Gitee 同步')
    const body = (await res.json()) as GiteeEntry[] | GiteeEntry
    return Array.isArray(body) ? body : [body]
  }

  private async readFile(path: string): Promise<string> {
    const res = await fetchWithTimeout(this.url(path.split('/').map(encodeURIComponent).join('/')), {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) throw await this.fail(res, 'Gitee 同步')
    const entry = (await res.json()) as GiteeEntry
    this.shas[entry.name] = entry.sha
    if (!entry.content) {
      throw new Error(`云端文件 ${entry.name} 超过 1MB 无法直接读取，请先归档较早的数据再同步`)
    }
    return fromBase64(entry.content)
  }

  async readAll(): Promise<Record<string, string>> {
    this.shas = {}
    const entries = await this.listDir()
    const out: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue
      out[entry.name] = await this.readFile(this.filePath(entry.name))
    }
    return out
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(files)) {
      const path = this.filePath(name)
      const body: Record<string, string> = {
        access_token: this.token,
        content: toBase64(content),
        message: `sync ${name} ${new Date().toISOString()}`
      }
      const sha = this.shas[name]
      const res = await fetchWithTimeout(this.url(encodeURI(path)), {
        method: sha ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(sha ? { ...body, sha } : body)
      })
      if (!res.ok) throw await this.fail(res, 'Gitee 同步')
      const saved = (await res.json()) as { content?: { sha?: string } }
      if (saved.content?.sha) this.shas[name] = saved.content.sha
    }
  }

  async test(): Promise<string> {
    const entries = await this.listDir()
    const json = entries.filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    return `Gitee 连接正常：仓库 ${this.repo}，目录 ${this.dirPath() || '根目录'} 下数据文件 ${json.length} 个`
  }
}

// -------------------------------------------------------------- 工厂与诊断

export interface SyncConfig {
  backend: SyncBackend
  /** GitHub 细粒度令牌 */
  githubToken: string
  gistId: string
  /** Gitee 私人令牌 */
  giteeToken: string
  /** Gitee 仓库，格式 owner/repo */
  giteeRepo: string
  /** 数据目录，默认 data */
  giteeDir: string
}

export function createStore(cfg: SyncConfig): RemoteStore {
  if (cfg.backend === 'gitee') {
    if (!cfg.giteeToken || !cfg.giteeRepo) throw new Error('尚未配置 Gitee 令牌或仓库')
    return new GiteeStore(cfg.giteeToken.trim(), cfg.giteeRepo.trim(), cfg.giteeDir.trim() || 'data')
  }
  if (!cfg.githubToken || !cfg.gistId) throw new Error('尚未配置 GitHub 令牌或 Gist ID')
  return new GistStore(cfg.githubToken.trim(), cfg.gistId.trim())
}

export interface ProbeResult {
  name: string
  ok: boolean
  ms: number
  detail: string
}

/** 网络诊断：分别测两个同步接口在当前网络下的连通性与耗时 */
export async function runDiagnostics(): Promise<ProbeResult[]> {
  const targets: Array<{ name: string; url: string }> = [
    { name: 'Gitee（国内，推荐）', url: `${GITEE_API}/repos/oschina/git-osc` },
    { name: 'GitHub API（国外）', url: `${GITHUB_API}/` }
  ]
  const out: ProbeResult[] = []
  for (const target of targets) {
    const started = Date.now()
    try {
      const res = await fetchWithTimeout(target.url, { headers: { Accept: 'application/json' } }, 10000)
      out.push({
        name: target.name,
        ok: res.ok,
        ms: Date.now() - started,
        detail: res.ok ? `连通，耗时 ${Date.now() - started} ms` : `返回 HTTP ${res.status}`
      })
    } catch (err) {
      out.push({
        name: target.name,
        ok: false,
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : '不可达'
      })
    }
  }
  return out
}

/** 在账号下按名字找仓库（用于"仓库已存在"时复用） */
async function findGiteeRepo(token: string, name: string): Promise<string | null> {
  const res = await fetchWithTimeout(
    `${GITEE_API}/user/repos?access_token=${encodeURIComponent(token)}&per_page=100&sort=updated`,
    { headers: { Accept: 'application/json' } }
  )
  if (!res.ok) return null
  const list = (await res.json()) as Array<{ full_name?: string; name?: string }>
  const hit = list.find((r) => (r.name ?? '').toLowerCase() === name.toLowerCase())
  return hit?.full_name ?? null
}

/**
 * 创建 Gitee 私有数据仓库。
 * 如果同名仓库已经存在（第二台手机走同样的流程时必然如此），直接复用而不是报错。
 */
export async function createGiteeRepo(token: string, name: string, description: string): Promise<string> {
  const body = new URLSearchParams({
    access_token: token,
    name,
    description,
    private: 'true',
    auto_init: 'true',
    has_issues: 'false',
    has_wiki: 'false'
  })
  const res = await fetchWithTimeout(`${GITEE_API}/user/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString()
  })
  if (res.ok) {
    const repo = (await res.json()) as { full_name?: string }
    if (repo.full_name) return repo.full_name
    throw new Error('创建 Gitee 仓库成功但未返回仓库名')
  }

  const raw = await res.text().catch(() => '')
  if (/已存在|already exists|already been taken/i.test(raw) || res.status === 422) {
    const existing = await findGiteeRepo(token, name)
    if (existing) return existing
  }
  let detail = ''
  try {
    detail = errorTextOf(JSON.parse(raw))
  } catch {
    detail = raw.slice(0, 120)
  }
  throw new Error(
    `创建 Gitee 仓库：请求被拒绝（${res.status}${detail ? '：' + detail : ''}）。` +
      '若仓库已存在可忽略本步，直接填“数据仓库”后点“测试连接”“立即同步”；' +
      '若提示权限不足，请确认私人令牌勾选了 projects 权限且账号已完成实名认证'
  )
}

/** 创建新的私密 Gist（保留 GitHub 方案时使用） */
export async function createGist(pat: string, initialFiles: Record<string, string>): Promise<string> {
  const files: Record<string, { content: string }> = {}
  Object.entries(initialFiles).forEach(([name, content]) => {
    files[name] = { content }
  })
  const res = await fetchWithTimeout(`${GITHUB_API}/gists`, {
    method: 'POST',
    headers: ghHeaders(pat),
    body: JSON.stringify({
      description: '工序用时记录与效率分析（私密数据，勿删）',
      public: false,
      files
    })
  })
  if (!res.ok) throw new Error(await readError(res, '创建 Gist'))
  const json = (await res.json()) as { id: string }
  return json.id
}
