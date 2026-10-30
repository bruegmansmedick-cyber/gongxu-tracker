/** 首页工序登记的多条未完成草稿；随 drafts.json 同步。 */
import type { Syncable } from '@/types'
import { uid } from '@/core/id'

/** v1 单草稿键；仅用于无损迁移到 v2 多草稿表 */
export const RECORD_DRAFT_KEY = 'ui.recordDraft'

export interface RecordDraftInput {
  projectId: string
  unitId: string
  divisionId: string
  itemId: string
  processId: string
  date: string
  startTime: string
  endTime: string
  startInput: string
  endInput: string
  quantity: string
  gapReason: string
  gapStartTime?: string
  gapEndTime?: string
  chainage?: string
  location: string
  note: string
}

export interface RecordDraft extends RecordDraftInput, Syncable {
  version: 2
  createdAt: number
  savedAt: number
}

export interface LegacyRecordDraft extends RecordDraftInput {
  version: 1
  savedAt: number
}

export function makeRecordDraft(
  input: RecordDraftInput,
  savedAt: number,
  opts: { id?: string; createdAt?: number } = {}
): RecordDraft {
  return {
    id: opts.id ?? uid('draft-'),
    version: 2,
    createdAt: opts.createdAt ?? savedAt,
    updatedAt: savedAt,
    savedAt,
    projectId: input.projectId,
    unitId: input.unitId,
    divisionId: input.divisionId,
    itemId: input.itemId,
    processId: input.processId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    startInput: input.startInput,
    endInput: input.endInput,
    quantity: input.quantity,
    gapReason: input.gapReason,
    gapStartTime: input.gapStartTime ?? '',
    gapEndTime: input.gapEndTime ?? '',
    chainage: input.chainage ?? '',
    location: input.location,
    note: input.note
  }
}

function sameStringFields(row: Record<string, unknown>): boolean {
  const stringFields = [
    'unitId',
    'divisionId',
    'itemId',
    'processId',
    'date',
    'startTime',
    'endTime',
    'startInput',
    'endInput',
    'quantity',
    'gapReason',
    'location',
    'note'
  ] as const
  const optionalStrings = ['gapStartTime', 'gapEndTime', 'chainage'] as const
  return (
    stringFields.every((key) => typeof row[key] === 'string') &&
    optionalStrings.every((key) => row[key] === undefined || typeof row[key] === 'string')
  )
}

/** IndexedDB / 云端里的值可能是旧版本或被手工改坏，恢复前先做最小类型校验。 */
export function isRecordDraft(value: unknown): value is RecordDraft {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    row.version === 2 &&
    typeof row.id === 'string' &&
    typeof row.projectId === 'string' &&
    typeof row.createdAt === 'number' &&
    typeof row.updatedAt === 'number' &&
    typeof row.savedAt === 'number' &&
    (row.deletedAt === undefined || typeof row.deletedAt === 'number') &&
    sameStringFields(row)
  )
}

export function isLegacyRecordDraft(value: unknown): value is LegacyRecordDraft {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    row.version === 1 &&
    typeof row.projectId === 'string' &&
    typeof row.savedAt === 'number' &&
    sameStringFields(row)
  )
}

function hash32(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** 旧键没有 id；用内容生成稳定 id，重复迁移或多设备迁移都不会生成两条。 */
export function legacyRecordDraftId(raw: LegacyRecordDraft): string {
  const parts = [
    raw.projectId,
    raw.unitId,
    raw.divisionId,
    raw.itemId,
    raw.processId,
    raw.date,
    raw.startTime,
    raw.endTime,
    raw.startInput,
    raw.endInput,
    raw.quantity,
    raw.gapReason,
    raw.gapStartTime ?? '',
    raw.gapEndTime ?? '',
    raw.chainage ?? '',
    raw.location,
    raw.note,
    String(raw.savedAt)
  ]
  return `draft-legacy-${hash32(parts.join('\u001f'))}`
}

export function migrateLegacyRecordDraft(raw: LegacyRecordDraft): RecordDraft {
  const id = legacyRecordDraftId(raw)
  const input: RecordDraftInput = {
    projectId: raw.projectId,
    unitId: raw.unitId,
    divisionId: raw.divisionId,
    itemId: raw.itemId,
    processId: raw.processId,
    date: raw.date,
    startTime: raw.startTime,
    endTime: raw.endTime,
    startInput: raw.startInput,
    endInput: raw.endInput,
    quantity: raw.quantity,
    gapReason: raw.gapReason,
    gapStartTime: raw.gapStartTime,
    gapEndTime: raw.gapEndTime,
    chainage: raw.chainage,
    location: raw.location,
    note: raw.note
  }
  return {
    ...makeRecordDraft(input, raw.savedAt, { id, createdAt: raw.savedAt }),
    version: 2
  }
}
