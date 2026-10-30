import { describe, expect, it } from 'vitest'
import {
  isLegacyRecordDraft,
  isRecordDraft,
  legacyRecordDraftId,
  makeRecordDraft,
  migrateLegacyRecordDraft,
  type LegacyRecordDraft,
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
  endTime: '',
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

describe('多条工序暂存', () => {
  it('完整保留尚未录入完工时刻的草稿', () => {
    const draft = makeRecordDraft(input, 123, { id: 'draft-a', createdAt: 100 })
    expect(draft).toMatchObject(input)
    expect(draft).toMatchObject({
      id: 'draft-a',
      version: 2,
      createdAt: 100,
      savedAt: 123,
      updatedAt: 123
    })
    expect(draft.endInput).toBe('')
    expect(draft.chainage).toBe('545-548')
    expect(draft.gapStartTime).toBe('07:20')
  })

  it('能校验 v2 恢复值并拒绝损坏对象', () => {
    const draft = makeRecordDraft(input, 123, { id: 'draft-a' })
    expect(isRecordDraft(draft)).toBe(true)
    expect(isRecordDraft({ ...draft, version: 1 })).toBe(false)
    expect(isRecordDraft({ ...draft, note: undefined })).toBe(false)
    expect(isRecordDraft(null)).toBe(false)
  })

  it('旧版单草稿迁移为稳定 id，重复迁移结果一致', () => {
    const legacy: LegacyRecordDraft = {
      version: 1,
      ...input,
      endTime: '12:00',
      endInput: '1200',
      savedAt: 456
    }
    expect(isLegacyRecordDraft(legacy)).toBe(true)
    const first = migrateLegacyRecordDraft(legacy)
    const second = migrateLegacyRecordDraft(legacy)
    expect(first.id).toBe(legacyRecordDraftId(legacy))
    expect(second.id).toBe(first.id)
    expect(first.version).toBe(2)
    expect(isRecordDraft(first)).toBe(true)
  })
})
