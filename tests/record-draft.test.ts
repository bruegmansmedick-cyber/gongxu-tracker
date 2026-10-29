import { describe, expect, it } from 'vitest'
import {
  isRecordDraft,
  makeRecordDraft,
  shouldRestoreRecordDraft,
  type RecordDraftInput
} from '@/core/recordDraft'

const input: RecordDraftInput = {
  projectId: 'p1',
  unitId: 'u1',
  divisionId: 'd1',
  itemId: 'i1',
  processId: 'pr1',
  date: '2026-10-28',
  startTime: '08:00',
  endTime: '12:00',
  startInput: '0800',
  endInput: '',
  quantity: '2.5',
  gapReason: '等监理旁站',
  gapStartTime: '07:20',
  gapEndTime: '07:55',
  chainage: '545-548',
  location: '0+413~0+438',
  note: '完工后再补'
}

describe('工序记录暂存', () => {
  it('完整保留尚未录入完工时刻的草稿', () => {
    const draft = makeRecordDraft(input, 123)
    expect(draft).toMatchObject(input)
    expect(draft.version).toBe(1)
    expect(draft.savedAt).toBe(123)
    expect(draft.endInput).toBe('')
    expect(draft.chainage).toBe('545-548')
    expect(draft.gapStartTime).toBe('07:20')
  })

  it('能校验本机恢复值', () => {
    expect(isRecordDraft(makeRecordDraft(input, 123))).toBe(true)
    expect(isRecordDraft({ ...makeRecordDraft(input, 123), version: 2 })).toBe(false)
    expect(isRecordDraft({ ...makeRecordDraft(input, 123), note: undefined })).toBe(false)
    expect(isRecordDraft(null)).toBe(false)
  })

  it('首页加号恢复草稿，指定日期或工序入口不覆盖本次选择', () => {
    expect(shouldRestoreRecordDraft({ resumeDraft: true })).toBe(true)
    expect(shouldRestoreRecordDraft({})).toBe(true)
    expect(shouldRestoreRecordDraft({ date: '2026-10-28', resumeDraft: true })).toBe(true)
    expect(shouldRestoreRecordDraft({ date: '2026-10-28' })).toBe(false)
    expect(shouldRestoreRecordDraft({ processId: 'pr1', resumeDraft: true })).toBe(false)
    expect(shouldRestoreRecordDraft({ itemId: 'i1', resumeDraft: true })).toBe(false)
    expect(shouldRestoreRecordDraft({ id: 'r1', resumeDraft: true })).toBe(false)
  })
})
