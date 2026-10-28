/** 首页工序登记的未完成草稿；只存本机，不参与云同步。 */

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
  location: string
  note: string
}

export interface RecordDraft extends RecordDraftInput {
  version: 1
  savedAt: number
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
  return stringFields.every((key) => typeof row[key] === 'string')
}
