import Dexie, { type Table } from 'dexie'
import type {
  CatalogPayload,
  KvRow,
  Operator,
  Process,
  ProcessRecord,
  Project,
  RecordsPayload,
  WbsLevel,
  WbsNode
} from '@/types'
import { buildTimeFields } from '@/core/compute'
import { uid } from '@/core/id'
import { monthKey, todayStr } from '@/core/time'
import { BENCH_TEMPLATE, faceOfItem, refHoursOf } from '@/db/seed'
import { buildHistoryRecords, historyRecordIds } from '@/db/history'

class AppDB extends Dexie {
  projects!: Table<Project, string>
  wbs!: Table<WbsNode, string>
  processes!: Table<Process, string>
  records!: Table<ProcessRecord, string>
  operators!: Table<Operator, string>
  kv!: Table<KvRow, string>

  constructor() {
    super('gongxu-tracker')
    this.version(1).stores({
      projects: 'id, archived, updatedAt',
      wbs: 'id, projectId, parentId, [projectId+level], updatedAt',
      processes: 'id, projectId, itemId, [projectId+itemId], updatedAt',
      records: 'id, projectId, processId, date, [projectId+date], updatedAt',
      operators: 'id, updatedAt',
      kv: 'key'
    })
  }
}

export const db = new AppDB()

// ---------------------------------------------------------------- kv 工具

export async function getKv<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value })
}

export async function delKv(key: string): Promise<void> {
  await db.kv.delete(key)
}

/** 有待同步内容时置位，同步成功后清除 */
export async function markPending(): Promise<void> {
  await setKv('sync.pending', true)
}

export async function clearPending(): Promise<void> {
  await setKv('sync.pending', false)
}

export async function isPending(): Promise<boolean> {
  return getKv<boolean>('sync.pending', false)
}

/** 记录哪些月份的数据被改动过，同步时只需推送这些月份 */
export async function markDirtyMonth(month: string): Promise<void> {
  const list = await getKv<string[]>('sync.dirtyMonths', [])
  if (!list.includes(month)) {
    list.push(month)
    await setKv('sync.dirtyMonths', list)
  }
  await markPending()
}

export async function getDirtyMonths(): Promise<string[]> {
  return getKv<string[]>('sync.dirtyMonths', [])
}

export async function clearDirtyMonths(months?: string[]): Promise<void> {
  if (!months) {
    await setKv('sync.dirtyMonths', [])
    return
  }
  const list = await getKv<string[]>('sync.dirtyMonths', [])
  await setKv(
    'sync.dirtyMonths',
    list.filter((m) => !months.includes(m))
  )
}

// ------------------------------------------------------------- 项目 / 操作人

export async function listProjects(includeDeleted = false): Promise<Project[]> {
  const rows = await db.projects.toArray()
  return rows
    .filter((r) => includeDeleted || !r.deletedAt)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, 'zh'))
}

export async function saveProject(input: { id?: string; name: string; code?: string }): Promise<Project> {
  const now = Date.now()
  const existing = input.id ? await db.projects.get(input.id) : undefined
  const row: Project = existing
    ? { ...existing, name: input.name, code: input.code, updatedAt: now }
    : {
        id: input.id ?? uid('prj-'),
        name: input.name,
        code: input.code,
        archived: 0,
        createdAt: now,
        updatedAt: now
      }
  await db.projects.put(row)
  await markPending()
  return row
}

export async function setProjectArchived(id: string, archived: 0 | 1): Promise<void> {
  const row = await db.projects.get(id)
  if (!row) return
  await db.projects.put({ ...row, archived, updatedAt: Date.now() })
  await markPending()
}

/** 软删除项目及其全部结构、记录 */
export async function deleteProject(id: string): Promise<void> {
  const now = Date.now()
  const months = new Set<string>()
  await db.transaction('rw', db.projects, db.wbs, db.processes, db.records, async () => {
    const project = await db.projects.get(id)
    if (project) await db.projects.put({ ...project, deletedAt: now, updatedAt: now })
    for (const row of await db.wbs.where('projectId').equals(id).toArray()) {
      await db.wbs.put({ ...row, deletedAt: now, updatedAt: now })
    }
    for (const row of await db.processes.where('projectId').equals(id).toArray()) {
      await db.processes.put({ ...row, deletedAt: now, updatedAt: now })
    }
    for (const row of await db.records.where('projectId').equals(id).toArray()) {
      if (!row.deletedAt) months.add(monthKey(row.date))
      await db.records.put({ ...row, deletedAt: now, updatedAt: now })
    }
  })
  for (const m of months) await markDirtyMonth(m)
  await markPending()
}

export async function listOperators(): Promise<Operator[]> {
  const rows = await db.operators.toArray()
  return rows.filter((r) => !r.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export async function saveOperator(input: { id?: string; name: string; shift?: string }): Promise<Operator> {
  const now = Date.now()
  const existing = input.id ? await db.operators.get(input.id) : undefined
  const row: Operator = existing
    ? { ...existing, name: input.name, shift: input.shift ?? existing.shift, updatedAt: now }
    : { id: input.id ?? uid('op-'), name: input.name, shift: input.shift ?? '白班', updatedAt: now }
  await db.operators.put(row)
  await markPending()
  return row
}

export async function deleteOperator(id: string): Promise<void> {
  const row = await db.operators.get(id)
  if (!row) return
  await db.operators.put({ ...row, deletedAt: Date.now(), updatedAt: Date.now() })
  await markPending()
}

// ----------------------------------------------------------------- 工程结构

export async function listWbs(projectId: string): Promise<WbsNode[]> {
  const rows = await db.wbs.where('projectId').equals(projectId).toArray()
  return rows.filter((r) => !r.deletedAt).sort((a, b) => a.sort - b.sort)
}

export async function listProcesses(projectId: string): Promise<Process[]> {
  const rows = await db.processes.where('projectId').equals(projectId).toArray()
  return rows.filter((r) => !r.deletedAt).sort((a, b) => a.sort - b.sort)
}

export async function saveWbsNode(input: {
  id?: string
  projectId: string
  parentId: string | null
  level: WbsLevel
  name: string
  unit?: string
  designQty?: number
  note?: string
}): Promise<WbsNode> {
  const now = Date.now()
  const existing = input.id ? await db.wbs.get(input.id) : undefined
  let sort = existing?.sort ?? 0
  if (!existing) {
    const siblings = await db.wbs.where('projectId').equals(input.projectId).toArray()
    const same = siblings.filter((s) => s.parentId === input.parentId && !s.deletedAt)
    sort = same.length ? Math.max(...same.map((s) => s.sort)) + 1 : 1
  }
  const row: WbsNode = existing
    ? {
        ...existing,
        name: input.name,
        unit: input.unit,
        designQty: input.designQty,
        note: input.note ?? existing.note,
        updatedAt: now
      }
    : {
        id: input.id ?? uid('wbs-'),
        projectId: input.projectId,
        parentId: input.parentId,
        level: input.level,
        name: input.name,
        sort,
        unit: input.unit,
        designQty: input.designQty,
        note: input.note,
        updatedAt: now
      }
  await db.wbs.put(row)
  await markPending()
  return row
}

/** 软删除节点及其子节点、工序；withRecords=true 时一并删除其下记录 */
export async function deleteWbsNode(id: string, withRecords = true): Promise<void> {
  const now = Date.now()
  const months = new Set<string>()
  const node = await db.wbs.get(id)
  if (!node) return
  const all = await db.wbs.where('projectId').equals(node.projectId).toArray()
  const ids: string[] = []
  const walk = (nid: string) => {
    ids.push(nid)
    all.filter((n) => n.parentId === nid).forEach((n) => walk(n.id))
  }
  walk(id)
  await db.transaction('rw', db.wbs, db.processes, db.records, async () => {
    for (const nid of ids) {
      const n = await db.wbs.get(nid)
      if (n) await db.wbs.put({ ...n, deletedAt: now, updatedAt: now })
    }
    const procs = await db.processes.where('projectId').equals(node.projectId).toArray()
    const procIds = procs.filter((p) => ids.includes(p.itemId)).map((p) => p.id)
    for (const pid of procIds) {
      const p = await db.processes.get(pid)
      if (p) await db.processes.put({ ...p, deletedAt: now, updatedAt: now })
    }
    if (withRecords && procIds.length) {
      const recs = await db.records.where('projectId').equals(node.projectId).toArray()
      for (const r of recs) {
        if (procIds.includes(r.processId)) {
          if (!r.deletedAt) months.add(monthKey(r.date))
          await db.records.put({ ...r, deletedAt: now, updatedAt: now })
        }
      }
    }
  })
  for (const m of months) await markDirtyMonth(m)
  await markPending()
}

export async function saveProcess(input: {
  id?: string
  projectId: string
  itemId: string
  name: string
  unit?: string
  designQty?: number
  standardHours?: number
  refHours?: number
  refSamples?: number
  refMin?: number
  refMax?: number
  enabled?: 0 | 1
}): Promise<Process> {
  const now = Date.now()
  const existing = input.id ? await db.processes.get(input.id) : undefined
  let sort = existing?.sort ?? 0
  if (!existing) {
    const siblings = await db.processes.where('projectId').equals(input.projectId).toArray()
    const same = siblings.filter((s) => s.itemId === input.itemId && !s.deletedAt)
    sort = same.length ? Math.max(...same.map((s) => s.sort)) + 1 : 1
  }
  const row: Process = existing
    ? {
        ...existing,
        name: input.name,
        unit: input.unit,
        designQty: input.designQty,
        standardHours: input.standardHours,
        // 参考用时来自实测统计，未显式传入时保留原值（避免编辑标准用时把它清掉）
        refHours: input.refHours ?? existing.refHours,
        refSamples: input.refSamples ?? existing.refSamples,
        refMin: input.refMin ?? existing.refMin,
        refMax: input.refMax ?? existing.refMax,
        enabled: input.enabled ?? existing.enabled,
        updatedAt: now
      }
    : {
        id: input.id ?? uid('prc-'),
        projectId: input.projectId,
        itemId: input.itemId,
        name: input.name,
        sort,
        unit: input.unit,
        designQty: input.designQty,
        standardHours: input.standardHours,
        refHours: input.refHours,
        refSamples: input.refSamples,
        refMin: input.refMin,
        refMax: input.refMax,
        enabled: input.enabled ?? 1,
        updatedAt: now
      }
  await db.processes.put(row)
  await markPending()
  return row
}

export async function deleteProcess(id: string, withRecords = true): Promise<void> {
  const now = Date.now()
  const months = new Set<string>()
  const row = await db.processes.get(id)
  if (!row) return
  await db.transaction('rw', db.processes, db.records, async () => {
    await db.processes.put({ ...row, deletedAt: now, updatedAt: now })
    if (withRecords) {
      const recs = await db.records.where('projectId').equals(row.projectId).toArray()
      for (const r of recs) {
        if (r.processId === id && !r.deletedAt) {
          months.add(monthKey(r.date))
          await db.records.put({ ...r, deletedAt: now, updatedAt: now })
        }
      }
    }
  })
  for (const m of months) await markDirtyMonth(m)
  await markPending()
}

/**
 * 新建项目时套用本标段项目划分模板。
 * 节点与工序都带固定 id（由项目 id + 模板 key 推导），因此重复套用不会产生重复数据，
 * 也保证历史记录补录时能对应到同一批工序。
 */
export async function applyBenchTemplate(projectId: string): Promise<{ units: number; items: number; processes: number }> {
  let unitCount = 0
  let itemCount = 0
  let processCount = 0
  for (const unitTpl of BENCH_TEMPLATE) {
    const unitId = `wbs-${projectId}-${unitTpl.key}`
    await saveWbsNode({
      id: unitId,
      projectId,
      parentId: null,
      level: 1,
      name: unitTpl.name
    })
    unitCount += 1
    for (const divTpl of unitTpl.divisions) {
      const divId = `wbs-${projectId}-${divTpl.key}`
      await saveWbsNode({
        id: divId,
        projectId,
        parentId: unitId,
        level: 2,
        name: divTpl.name
      })
      for (const itemTpl of divTpl.items) {
        const itemId = `wbs-${projectId}-${itemTpl.key}`
        await saveWbsNode({
          id: itemId,
          projectId,
          parentId: divId,
          level: 3,
          name: itemTpl.name,
          note: itemTpl.note,
          unit: itemTpl.unit,
          designQty: itemTpl.designQty
        })
        itemCount += 1
        const face = faceOfItem(itemTpl.key)
        for (const procTpl of itemTpl.processes) {
          const ref = face ? refHoursOf(face, procTpl.key) : undefined
          await saveProcess({
            id: `prc-${projectId}-${itemTpl.key}--${procTpl.key}`,
            projectId,
            itemId,
            name: procTpl.name,
            unit: itemTpl.unit,
            standardHours: procTpl.standardHours,
            refHours: ref?.hours,
            refSamples: ref?.samples,
            refMin: ref?.min,
            refMax: ref?.max
          })
          processCount += 1
        }
      }
    }
  }
  return { units: unitCount, items: itemCount, processes: processCount }
}

/** 补录三份循环作业 Word 里的历史记录（幂等，可重复执行） */
export async function seedHistoryRecords(projectId: string): Promise<number> {
  const rows = buildHistoryRecords(projectId)
  if (!rows.length) return 0
  const months = new Set(rows.map((r) => monthKey(r.date)))
  await db.transaction('rw', db.records, async () => {
    await db.records.bulkPut(rows)
  })
  for (const m of months) await markDirtyMonth(m)
  await markPending()
  return rows.length
}

/** 撤销历史补录（软删除，不影响自己录入的数据） */
export async function clearHistoryRecords(projectId: string): Promise<number> {
  const ids = historyRecordIds(projectId)
  const now = Date.now()
  const months = new Set<string>()
  let removed = 0
  await db.transaction('rw', db.records, async () => {
    for (const id of ids) {
      const row = await db.records.get(id)
      if (row && !row.deletedAt) {
        months.add(monthKey(row.date))
        await db.records.put({ ...row, deletedAt: now, updatedAt: now })
        removed += 1
      }
    }
  })
  for (const m of months) await markDirtyMonth(m)
  await markPending()
  return removed
}

/** 当前项目已补录的历史记录条数 */
export async function countHistoryRecords(projectId: string): Promise<number> {
  const ids = historyRecordIds(projectId)
  let n = 0
  for (const id of ids) {
    const row = await db.records.get(id)
    if (row && !row.deletedAt) n += 1
  }
  return n
}

// --------------------------------------------------------------------- 记录

export async function listRecords(projectId: string): Promise<ProcessRecord[]> {
  const rows = await db.records.where('projectId').equals(projectId).toArray()
  return rows
    .filter((r) => !r.deletedAt)
    .map((r) => (r.startAt && r.endAt && Number.isFinite(r.hours) ? r : { ...r, ...buildTimeFields(r.date, r.startTime, r.endTime) }))
    .sort((a, b) => b.startAt - a.startAt)
}

export interface RecordInput {
  id?: string
  projectId: string
  processId: string
  date: string
  startTime: string
  endTime: string
  quantity?: number
  gapReason?: string
  location?: string
  note?: string
  operatorId: string
  operatorName: string
}

export async function saveRecord(input: RecordInput): Promise<ProcessRecord> {
  const now = Date.now()
  const existing = input.id ? await db.records.get(input.id) : undefined
  const times = buildTimeFields(input.date, input.startTime, input.endTime)
  const device = await getKv<string>('device.id', '')
  const row: ProcessRecord = {
    id: existing?.id ?? input.id ?? uid('rec-'),
    projectId: input.projectId,
    processId: input.processId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    ...times,
    quantity: input.quantity,
    gapReason: input.gapReason,
    location: input.location,
    note: input.note,
    operatorId: input.operatorId,
    operatorName: input.operatorName,
    deviceId: existing?.deviceId ?? device,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  await db.records.put(row)
  if (existing) {
    await markDirtyMonth(monthKey(existing.date))
    if (monthKey(existing.date) !== monthKey(row.date)) await markDirtyMonth(monthKey(row.date))
  } else {
    await markDirtyMonth(monthKey(row.date))
  }
  await markPending()
  return row
}

export async function deleteRecord(id: string): Promise<void> {
  const now = Date.now()
  const row = await db.records.get(id)
  if (!row) return
  await db.records.put({ ...row, deletedAt: now, updatedAt: now })
  await markDirtyMonth(monthKey(row.date))
  await markPending()
}

export async function getRecord(id: string): Promise<ProcessRecord | undefined> {
  return db.records.get(id)
}

/** 记录列表（用于导出、图表）：含跨项目 */
export async function allRecords(): Promise<ProcessRecord[]> {
  return db.records.toArray()
}

// ----------------------------------------------------------- 同步所需数据包

export async function readCatalogPayload(): Promise<CatalogPayload> {
  const [projects, wbs, processes, operators] = await Promise.all([
    db.projects.toArray(),
    db.wbs.toArray(),
    db.processes.toArray(),
    db.operators.toArray()
  ])
  return {
    updatedAt: Math.max(
      0,
      ...projects.map((r) => r.updatedAt),
      ...wbs.map((r) => r.updatedAt),
      ...processes.map((r) => r.updatedAt),
      ...operators.map((r) => r.updatedAt)
    ),
    projects,
    wbs,
    processes,
    operators
  }
}

export async function writeCatalogPayload(payload: CatalogPayload): Promise<void> {
  await db.transaction('rw', db.projects, db.wbs, db.processes, db.operators, async () => {
    if (payload.projects?.length) await db.projects.bulkPut(payload.projects)
    if (payload.wbs?.length) await db.wbs.bulkPut(payload.wbs)
    if (payload.processes?.length) await db.processes.bulkPut(payload.processes)
    if (payload.operators?.length) await db.operators.bulkPut(payload.operators)
  })
}

export async function readRecordsPayload(month: string): Promise<RecordsPayload> {
  const rows = await db.records.toArray()
  const list = rows.filter((r) => monthKey(r.date) === month)
  return {
    month,
    updatedAt: Math.max(0, ...list.map((r) => r.updatedAt)),
    records: list
  }
}

export async function writeRecordsPayload(payload: RecordsPayload): Promise<void> {
  if (!payload.records?.length) return
  await db.records.bulkPut(payload.records)
}

// ------------------------------------------------------------------ 备份

export interface BackupFile {
  meta: { schemaVersion: number; exportedAt: string; app: string }
  catalog: CatalogPayload
  records: ProcessRecord[]
  settings?: Record<string, unknown>
}

export async function exportBackup(): Promise<BackupFile> {
  const catalog = await readCatalogPayload()
  const records = await db.records.toArray()
  const syncSettings = {
    pat: await getKv<string>('sync.pat', ''),
    gistId: await getKv<string>('sync.gistId', '')
  }
  return {
    meta: { schemaVersion: 1, exportedAt: new Date().toISOString(), app: 'gongxu-tracker' },
    catalog,
    records,
    settings: syncSettings
  }
}

export async function importBackup(file: BackupFile, includeSettings = false): Promise<void> {
  const snapshot = await exportBackup()
  await setKv('backup.beforeImport', snapshot)
  await writeCatalogPayload(file.catalog)
  if (file.records?.length) await db.records.bulkPut(file.records)
  if (includeSettings && file.settings) {
    if (typeof file.settings.pat === 'string') await setKv('sync.pat', file.settings.pat)
    if (typeof file.settings.gistId === 'string') await setKv('sync.gistId', file.settings.gistId)
  }
  const months = new Set((file.records ?? []).map((r) => monthKey(r.date)))
  for (const m of months) await markDirtyMonth(m)
  await markPending()
}

export async function hasImportSnapshot(): Promise<boolean> {
  return (await getKv<BackupFile | null>('backup.beforeImport', null)) !== null
}

export async function restoreImportSnapshot(): Promise<boolean> {
  const snap = await getKv<BackupFile | null>('backup.beforeImport', null)
  if (!snap) return false
  await writeCatalogPayload(snap.catalog)
  if (snap.records?.length) await db.records.bulkPut(snap.records)
  await markPending()
  return true
}

export async function wipeLocalData(): Promise<void> {
  await db.transaction('rw', db.projects, db.wbs, db.processes, db.records, db.operators, async () => {
    await Promise.all([
      db.projects.clear(),
      db.wbs.clear(),
      db.processes.clear(),
      db.records.clear(),
      db.operators.clear()
    ])
  })
  await markPending()
}

/** 首次打开时初始化设备号与默认操作人 */
export async function ensureDeviceId(): Promise<string> {
  const existing = await getKv<string>('device.id', '')
  if (existing) return existing
  const id = uid('dev-')
  await setKv('device.id', id)
  return id
}

export function defaultRecordDate(): string {
  return todayStr()
}
