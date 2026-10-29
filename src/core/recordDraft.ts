/** 首页工序登记的未完成草稿；只存本机，不参与云同步。 */

export const RECORD_DRAFT_KEY = 'ui.recordDraft'

export interface RecordDraftRestoreContext {
  id?: string
  processId?: string
  itemId?: string
  date?: string
  resumeDraft?: boolean
}

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

export interface RecordDraft extends RecordDraftInput {
  version: 1
  savedAt: number
}

/**
 * 编辑旧记录、从工序快捷入口新建、或指定日期补填时，以地址参数为准。
 * 首页加号会显式请求恢复草稿；普通无参数入口也恢复，兼容旧链接。
 */
export function shouldRestoreRecordDraft(context: RecordDraftRestoreContext): boolean {
  if (context.id || context.processId || context.itemId) return false
  return Boolean(context.resumeDraft) || !context.date
}

export function makeRecordDraft(input: RecordDraftInput, savedAt: number): RecordDraft {
  return {
    version: 1,
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

/** IndexedDB 里的值可能是旧版本或被手工改坏，恢复前先做最小类型校验。 */
export function isRecordDraft(value: unknown): value is RecordDraft {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.projectId !== 'string' || typeof row.savedAt !== 'number') return false
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
