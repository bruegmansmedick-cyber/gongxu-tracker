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
import { readAuditPayload, writeAuditPayload, type AuditPayload } from '@/db/audit'
import { listAudit, logAudit } from '@/db/audit'
import {
  MAX_FILE_BYTES,
  createGist,
  createGiteeRepo,
  createStore,
  listGiteeCommits,
  payloadSize,
  runDiagnostics,
  type CloudCommit,
  type ProbeResult,
  type SyncBackend,
  type SyncConfig
} from '@/sync/stores'

export type { ProbeResult, SyncBackend, SyncConfig }
export type { CloudCommit }
export { MAX_FILE_BYTES, runDiagnostics }

const MAX_ROUNDS = 2

export interface SyncResult {
  ok: boolean
  message: string
  pushedFiles: number
  pulledRecords: number
  lastSyncAt: number
  conflict?: boolean
  /** 本次改动过大，需要管理口令确认后才上传 */
  needsConfirm?: boolean
  bulk?: { changed: number; deleted: number }
}

/** 单次同步允许的改动上限：超过就要管理口令确认 */
export const BULK_CHANGE_LIMIT = 20
export const BULK_DELETE_LIMIT = 5
/** 首次补录历史数据 / 导入备份这类确认为正常的批量操作，放行一次 */
export const ALLOW_BULK_ONCE_KEY = 'sync.allowBulkOnce'
export const SECURITY_PIN_KEY = 'security.pin'
export const DEFAULT_SECURITY_PIN = '070010'

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

function auditMonthOfFile(name: string): string | null {
  const m = /^audit-(\d{4}-\d{2})\.json$/.exec(name)
  return m ? m[1] : null
}

async function localAuditMonths(): Promise<string[]> {
  const rows = await db.audit.toArray()
  const set = new Set<string>()
  rows.forEach((r) => {
    const d = new Date(r.at)
    set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  })
  return Array.from(set).sort()
}

async function localMonths(): Promise<string[]> {
  const rows = await db.records.toArray()
  return Array.from(new Set(rows.map((r) => monthKey(r.date)))).sort()
}

export async function syncNow(opts: { confirmBulk?: boolean } = {}): Promise<SyncResult> {
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
  const allowBulkOnce = await getKv<boolean>(ALLOW_BULK_ONCE_KEY, false)

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
      let changedRecords = 0
      let deletedRecords = 0
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
        if (needsPush) {
          const remoteById = new Map((remotePayload?.records ?? []).map((r) => [r.id, r]))
          merged.rows.forEach((row) => {
            const remote = remoteById.get(row.id)
            if (!remote) {
              if (!row.deletedAt) changedRecords += 1
              return
            }
            if (JSON.stringify(row) === JSON.stringify(remote)) return
            if (row.deletedAt && !remote.deletedAt) deletedRecords += 1
            else changedRecords += 1
          })
        }
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

      // 3) 操作留痕：只追加、按 id 求并集，任何设备都无法用 App 抹掉历史
      const auditMonths = Array.from(
        new Set([
          ...(await localAuditMonths()),
          ...Object.keys(remoteFiles)
            .map(auditMonthOfFile)
            .filter((m): m is string => !!m)
        ])
      ).sort()
      for (const month of auditMonths) {
        const remotePayload = parseJson<AuditPayload>(remoteFiles[`audit-${month}.json`])
        const localPayload = await readAuditPayload(month)
        const localIds = new Set(localPayload.entries.map((e) => e.id))
        const missing = (remotePayload?.entries ?? []).filter((e) => !localIds.has(e.id))
        if (missing.length) {
          await writeAuditPayload({ month, updatedAt: Date.now(), entries: missing })
        }
        const remoteIds = new Set((remotePayload?.entries ?? []).map((e) => e.id))
        const toPush = localPayload.entries.filter((e) => !remoteIds.has(e.id))
        if (toPush.length) {
          const merged = [...(remotePayload?.entries ?? []), ...toPush]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          const payload: AuditPayload = { month, updatedAt: Date.now(), entries: merged }
          const size = payloadSize(payload)
          if (size > MAX_FILE_BYTES) {
            throw new Error(`留痕文件 ${month} 已达 ${(size / 1024).toFixed(0)}KB，接近上限，请归档较早的留痕`)
          }
          filesToPush[`audit-${month}.json`] = JSON.stringify(payload)
        }
      }

      // 4) 推送
      const bulkLike = changedRecords + deletedRecords > BULK_CHANGE_LIMIT || deletedRecords > BULK_DELETE_LIMIT
      if (bulkLike && !opts.confirmBulk && !allowBulkOnce) {
        const summary = `本次同步包含 修改 ${changedRecords} 条、删除 ${deletedRecords} 条，已暂缓上传，等待管理口令确认`
        // 同一批改动每次自动同步都会再试一次，避免把告警页刷屏：10 分钟内同内容只记一条
        const recent = await listAudit({ limit: 10 })
        const lastBlocked = recent.find((a) => a.action === 'bulk-blocked')
        if (!lastBlocked || lastBlocked.summary !== summary || Date.now() - lastBlocked.at > 10 * 60 * 1000) {
          await logAudit({
            action: 'bulk-blocked',
            entity: 'system',
            entityId: 'sync',
            summary,
            changes: [
              { field: '修改', from: '—', to: String(changedRecords) },
              { field: '删除', from: '—', to: String(deletedRecords) }
            ]
          })
        }
        return {
          ok: false,
          message: `本次改动较大（修改 ${changedRecords} 条、删除 ${deletedRecords} 条），已暂缓上传。请输入管理口令确认后再同步。`,
          pushedFiles: 0,
          pulledRecords: Math.max(0, pulledRecords),
          lastSyncAt: 0,
          needsConfirm: true,
          bulk: { changed: changedRecords, deleted: deletedRecords }
        }
      }
      if (bulkLike && (opts.confirmBulk || allowBulkOnce)) {
        await logAudit({
          action: 'bulk-approved',
          entity: 'system',
          entityId: 'sync',
          summary: `${opts.confirmBulk ? '管理口令确认' : '首次补录/导入白名单'}后上传：修改 ${changedRecords} 条、删除 ${deletedRecords} 条`,
          changes: [
            { field: '修改', from: '—', to: String(changedRecords) },
            { field: '删除', from: '—', to: String(deletedRecords) }
          ]
        })
      }
      if (Object.keys(filesToPush).length) {
        await store.writeFiles(filesToPush)
        pushedFiles += Object.keys(filesToPush).length
        if (allowBulkOnce) await setKv(ALLOW_BULK_ONCE_KEY, false)
      }

      // 5) 回拉校验：确认推上去的内容没有被别的设备覆盖
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

/** 管理口令：默认 070010，存在本机（不参与同步），用于放行大批量改动 */
export async function checkSecurityPin(pin: string): Promise<boolean> {
  const saved = await getKv<string>(SECURITY_PIN_KEY, DEFAULT_SECURITY_PIN)
  return pin.trim() === saved
}

export async function saveSecurityPin(pin: string): Promise<void> {
  await setKv(SECURITY_PIN_KEY, pin.trim())
}

export async function currentSecurityPin(): Promise<string> {
  return getKv<string>(SECURITY_PIN_KEY, DEFAULT_SECURITY_PIN)
}

/** 允许一次大批量写入（导入、补录等），用于测试与人工放行 */
export async function allowBulkOnce(): Promise<void> {
  await setKv(ALLOW_BULK_ONCE_KEY, true)
}

/** 看云端数据文件的版本历史（只读，用于追溯；回滚由维护者在云端执行） */
export async function listDataCommits(limit = 20): Promise<CloudCommit[]> {
  const cfg = await getSyncConfig()
  if (cfg.backend !== 'gitee') throw new Error('版本历史目前只支持 Gitee 数据仓库')
  if (!cfg.giteeRepo || !cfg.giteeToken) throw new Error('尚未配置 Gitee 数据仓库')
  return listGiteeCommits(cfg.giteeToken.trim(), cfg.giteeRepo.trim(), cfg.giteeDir.trim() || 'data', limit)
}
