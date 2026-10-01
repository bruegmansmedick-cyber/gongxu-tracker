/**
 * 同步引擎：拉取云端 → 与本地按 id + updatedAt 逐条合并 → 只推变化的部分 → 回拉校验。
 * 存储后端可切换（Gitee 私有仓库 / GitHub Gist），合并逻辑与数据格式完全一致。
 */
import type { CatalogPayload, MetaPayload, RecordsPayload } from '@/types'
import {
  clearDirtyMonths,
  clearPending,
  db,
  getDirtyMonths,
  getKv,
  isPending,
  readCatalogPayload,
  readRecordsPayload,
  setKv,
  writeCatalogPayload,
  writeRecordsPayload
} from '@/db'
import { monthKey } from '@/core/time'
import { mergeSyncable, normalizeForCompare } from '@/sync/merge'
import {
  MAX_FILE_BYTES,
  createGist,
  createGiteeRepo,
  createStore,
  payloadSize,
  runDiagnostics,
  type ProbeResult,
  type SyncBackend,
  type SyncConfig
} from '@/sync/stores'

export type { ProbeResult, SyncBackend, SyncConfig }
export { MAX_FILE_BYTES, runDiagnostics }

const MAX_ROUNDS = 2

export interface SyncResult {
  ok: boolean
  message: string
  pushedFiles: number
  pulledRecords: number
  lastSyncAt: number
  conflict?: boolean
}

// ------------------------------------------------------------------ 配置

export async function getSyncConfig(): Promise<SyncConfig> {
  return {
    backend: await getKv<SyncBackend>('sync.backend', 'gitee'),
    githubToken: await getKv<string>('sync.github.token', ''),
    gistId: await getKv<string>('sync.github.gistId', ''),
    giteeToken: await getKv<string>('sync.gitee.token', ''),
    giteeRepo: await getKv<string>('sync.gitee.repo', ''),
    giteeDir: await getKv<string>('sync.gitee.dir', 'data')
  }
}

export async function saveSyncConfig(cfg: SyncConfig): Promise<void> {
  await setKv('sync.backend', cfg.backend)
  await setKv('sync.github.token', (cfg.githubToken ?? '').trim())
  await setKv('sync.github.gistId', (cfg.gistId ?? '').trim())
  await setKv('sync.gitee.token', (cfg.giteeToken ?? '').trim())
  await setKv('sync.gitee.repo', (cfg.giteeRepo ?? '').trim())
  await setKv('sync.gitee.dir', (cfg.giteeDir ?? 'data').trim() || 'data')
}

export async function clearSyncConfig(): Promise<void> {
  await saveSyncConfig({
    backend: 'gitee',
    githubToken: '',
    gistId: '',
    giteeToken: '',
    giteeRepo: '',
    giteeDir: 'data'
  })
  await setKv('sync.lastSyncAt', 0)
}

export function isConfigured(cfg: SyncConfig): boolean {
  if (cfg.backend === 'gitee') return Boolean(cfg.giteeToken && cfg.giteeRepo)
  return Boolean(cfg.githubToken && cfg.gistId)
}

/** 创建数据空间：Gitee 建私有仓库，GitHub 建私密 Gist */
export async function createDataSpace(
  cfg: SyncConfig,
  deviceId: string
): Promise<{ gistId?: string; repo?: string; reused?: boolean }> {
  const meta: MetaPayload = { schemaVersion: 1, updatedAt: Date.now(), deviceId }
  const catalog = await readCatalogPayload()
  const files = {
    'meta.json': JSON.stringify(meta, null, 2),
    'catalog.json': JSON.stringify(catalog, null, 2)
  }
  if (cfg.backend === 'gitee') {
    const repo = await createGiteeRepo(
      cfg.giteeToken.trim(),
      'gongxu-data',
      '工序用时记录与效率分析（私有数据仓库，勿公开）'
    )
    const store = createStore({ ...cfg, giteeRepo: repo })
    // 云端已经有数据时绝不能覆盖（第二台手机走同样流程时必然命中这种情况）
    const existing = await store.readAll().catch(() => ({}) as Record<string, string>)
    const hasData = Object.keys(existing).some((n) => n === 'catalog.json' || n.startsWith('records-'))
    if (!hasData) await store.writeFiles(files)
    return { repo, reused: hasData }
  }
  const gistId = await createGist(cfg.githubToken.trim(), files)
  return { gistId }
}

// ------------------------------------------------------------------ 同步

function parseJson<T>(content: string | undefined): T | null {
  if (!content) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function monthOfFile(name: string): string | null {
  const m = /^records-(\d{4}-\d{2})\.json$/.exec(name)
  return m ? m[1] : null
}

async function localMonths(): Promise<string[]> {
  const rows = await db.records.toArray()
  return Array.from(new Set(rows.map((r) => monthKey(r.date)))).sort()
}

export async function syncNow(): Promise<SyncResult> {
  const cfg = await getSyncConfig()
  if (!isConfigured(cfg)) {
    return {
      ok: false,
      message: '尚未配置同步（缺少令牌或数据空间）',
      pushedFiles: 0,
      pulledRecords: 0,
      lastSyncAt: 0
    }
  }

  let store
  try {
    store = createStore(cfg)
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : '同步配置不完整',
      pushedFiles: 0,
      pulledRecords: 0,
      lastSyncAt: 0
    }
  }

  let pushedFiles = 0
  let pulledRecords = 0
  let conflict = false

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const remoteFiles = await store.readAll()
      const remoteCatalog = parseJson<CatalogPayload>(remoteFiles['catalog.json'])
      const remoteMonths = Object.keys(remoteFiles)
        .map(monthOfFile)
        .filter((m): m is string => !!m)

      const filesToPush: Record<string, string> = {}

      // 1) 目录数据：项目 / 工程结构 / 工序 / 操作人
      const localCatalog = await readCatalogPayload()
      const pMerge = mergeSyncable(localCatalog.projects ?? [], remoteCatalog?.projects ?? [])
      const wMerge = mergeSyncable(localCatalog.wbs ?? [], remoteCatalog?.wbs ?? [])
      const cMerge = mergeSyncable(localCatalog.processes ?? [], remoteCatalog?.processes ?? [])
      const oMerge = mergeSyncable(localCatalog.operators ?? [], remoteCatalog?.operators ?? [])
      const mergedCatalog: CatalogPayload = {
        updatedAt: Math.max(localCatalog.updatedAt, remoteCatalog?.updatedAt ?? 0, Date.now()),
        projects: normalizeForCompare(pMerge.rows),
        wbs: normalizeForCompare(wMerge.rows),
        processes: normalizeForCompare(cMerge.rows),
        operators: normalizeForCompare(oMerge.rows)
      }
      const catalogRemoteDiffers =
        !remoteCatalog || pMerge.remoteDiffers || wMerge.remoteDiffers || cMerge.remoteDiffers || oMerge.remoteDiffers
      const catalogLocalDiffers =
        pMerge.localDiffers || wMerge.localDiffers || cMerge.localDiffers || oMerge.localDiffers
      if (catalogLocalDiffers) await writeCatalogPayload(mergedCatalog)
      if (catalogRemoteDiffers) {
        if (payloadSize(mergedCatalog) > MAX_FILE_BYTES) {
          throw new Error('工程结构数据过大（超过 900KB），请联系维护者拆分项目')
        }
        filesToPush['catalog.json'] = JSON.stringify(mergedCatalog)
      }

      // 2) 按月分片的记录
      const dirty = await getDirtyMonths()
      const months = Array.from(new Set([...(await localMonths()), ...remoteMonths, ...dirty])).sort()
      for (const month of months) {
        const remotePayload = parseJson<RecordsPayload>(remoteFiles[`records-${month}.json`])
        const localPayload = await readRecordsPayload(month)
        const merged = mergeSyncable(localPayload.records, remotePayload?.records ?? [])
        const localIds = new Set(localPayload.records.map((r) => r.id))
        pulledRecords += (remotePayload?.records ?? []).filter((r) => !localIds.has(r.id) && !r.deletedAt).length
        if (merged.localDiffers) {
          await writeRecordsPayload({ month, updatedAt: Date.now(), records: merged.rows })
        }
        const needsPush = merged.remoteDiffers || dirty.includes(month)
        const payload: RecordsPayload = {
          month,
          updatedAt: Math.max(Date.now(), remotePayload?.updatedAt ?? 0),
          records: normalizeForCompare(merged.rows.filter((r) => monthKey(r.date) === month))
        }
        if (needsPush && payload.records.length) {
          const size = payloadSize(payload)
          if (size > MAX_FILE_BYTES) {
            throw new Error(
              `月份 ${month} 数据已达 ${(size / 1024).toFixed(0)}KB，接近单文件 1MB 上限，请归档该月数据`
            )
          }
          filesToPush[`records-${month}.json`] = JSON.stringify(payload)
        }
      }

      // 3) 推送
      if (Object.keys(filesToPush).length) {
        await store.writeFiles(filesToPush)
        pushedFiles += Object.keys(filesToPush).length
      }

      // 4) 回拉校验：确认推上去的内容没有被别的设备覆盖
      const verify = await store.readAll()
      const overwritten = Object.entries(filesToPush).some(([name, content]) => verify[name] !== content)
      if (!overwritten) {
        await clearDirtyMonths(months)
        await clearPending()
        await setKv('sync.lastSyncAt', Date.now())
        return {
          ok: true,
          message: pushedFiles ? `同步完成（${store.label}），已上传 ${pushedFiles} 个数据文件` : '同步完成，已是最新数据',
          pushedFiles,
          pulledRecords: Math.max(0, pulledRecords),
          lastSyncAt: Date.now()
        }
      }
      conflict = true
      pushedFiles = 0
    }

    await setKv('sync.lastSyncAt', Date.now())
    return {
      ok: true,
      message: '同步完成（检测到另一台设备同时在写入，已自动再合并一次）',
      pushedFiles,
      pulledRecords: Math.max(0, pulledRecords),
      lastSyncAt: Date.now(),
      conflict
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '同步失败，请检查网络'
    return { ok: false, message, pushedFiles, pulledRecords: Math.max(0, pulledRecords), lastSyncAt: 0, conflict }
  }
}

export async function syncState(): Promise<{
  configured: boolean
  backend: SyncBackend
  lastSyncAt: number
  pending: boolean
}> {
  const cfg = await getSyncConfig()
  return {
    configured: isConfigured(cfg),
    backend: cfg.backend,
    lastSyncAt: await getKv<number>('sync.lastSyncAt', 0),
    pending: await isPending()
  }
}
