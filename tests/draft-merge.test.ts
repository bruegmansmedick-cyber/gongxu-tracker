import { describe, expect, it } from 'vitest'
import { mergeSyncable } from '@/sync/merge'
import { makeRecordDraft, type RecordDraftInput } from '@/core/recordDraft'

const input = (projectId = 'p1'): RecordDraftInput => ({
  projectId,
  unitId: 'u1',
  divisionId: 'd1',
  itemId: 'i1',
  processId: 'pr1',
  date: '2026-10-30',
  startTime: '22:00',
  endTime: '',
  startInput: '2200',
  endInput: '',
  quantity: '',
  gapReason: 'none',
  location: '',
  note: ''
})

describe('暂存云同步合并', () => {
  it('不同工作面草稿按独立 id 全部保留', () => {
    const a = makeRecordDraft(input('p1'), 100, { id: 'draft-a' })
    const b = makeRecordDraft({ ...input('p1'), processId: 'pr2' }, 101, { id: 'draft-b' })
    const merged = mergeSyncable([a], [b])
    expect(merged.rows.map((row) => row.id).sort()).toEqual(['draft-a', 'draft-b'])
  })

  it('同一草稿以更新时间较新的内容为准，删除墓碑不会被旧数据复活', () => {
    const local = makeRecordDraft({ ...input(), note: '本地新内容' }, 200, {
      id: 'draft-a',
      createdAt: 100
    })
    const remote = makeRecordDraft(input(), 100, { id: 'draft-a', createdAt: 100 })
    expect(mergeSyncable([local], [remote]).rows[0]?.note).toBe('本地新内容')

    const deleted = { ...local, deletedAt: 200, updatedAt: 200 }
    const older = { ...remote, updatedAt: 200 }
    expect(mergeSyncable([deleted], [older]).rows[0]?.deletedAt).toBe(200)
  })
})
