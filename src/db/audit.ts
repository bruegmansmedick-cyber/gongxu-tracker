/**
 * 操作留痕（审计日志）。
 * 只追加、不修改、不删除；同步到云端 data/audit-YYYY-MM.json，合并时按 id 求并集，
 * 所以任何设备都无法用 App 抹掉历史。
 */
import { db, getKv } from '@/db/client'
import { uid } from '@/core/id'

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'import'
  | 'seed'
  | 'restore'
  | 'bulk-blocked'
  | 'bulk-approved'
  | 'health'

export type AuditEntity = 'record' | 'process' | 'wbs' | 'project' | 'operator' | 'system'

export interface AuditChange {
  field: string
  from: string
  to: string
}

export interface AuditEntry {
  id: string
  at: number
  deviceId: string
  operatorId: string
  operatorName: string
  action: AuditAction
  entity: AuditEntity
  entityId: string
  /** 记录所属日期（便于按天查） */
  date?: string
  /** 人话摘要 */
  summary: string
  changes?: AuditChange[]
  /** 同一次操作（如一次批量导入）的批次号 */
  batchId?: string
}

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  create: '新增',
  update: '修改',
  delete: '删除',
  import: '导入备份',
  seed: '补录历史',
  restore: '回滚',
  'bulk-blocked': '大批量改动被拦截',
  'bulk-approved': '大批量改动已确认',
  health: '数据异常'
}

/** 需要标红的动作 */
export const ALERT_ACTIONS: AuditAction[] = ['bulk-blocked', 'bulk-approved', 'health', 'restore', 'delete']

function brief(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  const text = String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

export function diffOf(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  fields: string[]
): AuditChange[] {
  const out: AuditChange[] = []
  fields.forEach((field) => {
    const a = before ? before[field] : undefined
    const b = after[field]
    if (String(a ?? '') !== String(b ?? '')) out.push({ field, from: brief(a), to: brief(b) })
  })
  return out
}

export interface LogAuditInput {
  action: AuditAction
  entity: AuditEntity
  entityId: string
  summary: string
  date?: string
  changes?: AuditChange[]
  batchId?: string
  /** 特殊情况（如系统导入）可指定操作人 */
  operatorName?: string
  operatorId?: string
  at?: number
}

/** 追加一条留痕。永远只写，不覆盖。 */
export async function logAudit(input: LogAuditInput): Promise<AuditEntry> {
  const [deviceId, operatorId, operatorName] = await Promise.all([
    getKv<string>('device.id', ''),
    getKv<string>('ui.currentOperatorId', ''),
    getKv<string>('ui.currentOperatorName', '')
  ])
  const entry: AuditEntry = {
    id: uid('aud-'),
    at: input.at ?? Date.now(),
    deviceId,
    operatorId: input.operatorId ?? operatorId,
    operatorName: input.operatorName ?? operatorName ?? '未署名',
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    date: input.date,
    summary: input.summary,
    changes: input.changes?.length ? input.changes : undefined,
    batchId: input.batchId
  }
  await db.audit.put(entry)
  return entry
}

export async function listAudit(opts: { limit?: number; alertsOnly?: boolean } = {}): Promise<AuditEntry[]> {
  const rows = await db.audit.toArray()
  const list = opts.alertsOnly ? rows.filter((r) => ALERT_ACTIONS.includes(r.action)) : rows
  return list.sort((a, b) => b.at - a.at).slice(0, opts.limit ?? 300)
}

export async function countAudit(): Promise<number> {
  return db.audit.count()
}

export interface AuditPayload {
  month: string
  updatedAt: number
  entries: AuditEntry[]
}

/** 用本地时区判断留痕属于哪个月 */
function monthOfTs(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function readAuditPayload(month: string): Promise<AuditPayload> {
  const rows = await db.audit.toArray()
  const entries = rows.filter((r) => monthOfTs(r.at) === month)
  return { month, updatedAt: Math.max(0, ...entries.map((e) => e.at)), entries }
}

export async function writeAuditPayload(payload: AuditPayload): Promise<void> {
  if (!payload.entries?.length) return
  await db.audit.bulkPut(payload.entries)
}

export function auditMonthsOf(entries: AuditEntry[]): string[] {
  return Array.from(new Set(entries.map((e) => monthOfTs(e.at)))).sort()
}
