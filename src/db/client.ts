/** Dexie 实例与最基础的键值读写（独立成模块，避免各表模块之间循环引用） */
import Dexie, { type Table } from 'dexie'
import type { AuditEntry } from '@/db/audit'
import type { RecordDraft } from '@/core/recordDraft'
import type { KvRow, Operator, Process, ProcessRecord, Project, WbsNode, Workface } from '@/types'

export class AppDB extends Dexie {
  projects!: Table<Project, string>
  wbs!: Table<WbsNode, string>
  processes!: Table<Process, string>
  records!: Table<ProcessRecord, string>
  operators!: Table<Operator, string>
  audit!: Table<AuditEntry, string>
  kv!: Table<KvRow, string>
  workfaces!: Table<Workface, string>
  recordDrafts!: Table<RecordDraft, string>

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
    // v2：新增操作留痕表（只追加）
    this.version(2).stores({
      audit: 'id, at, action, entity, entityId, date'
    })
    // v3：新增工作面表；wbs 增加可选 workfaceId（无需改索引，旧数据原样保留）
    this.version(3).stores({
      workfaces: 'id, projectId, unitId, [projectId+unitId], updatedAt'
    })
    // v4：多条可同步草稿；旧 ui.recordDraft 在启动时无损迁移
    this.version(4).stores({
      recordDrafts: 'id, projectId, updatedAt, deletedAt'
    })
  }
}

export const db = new AppDB()

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
