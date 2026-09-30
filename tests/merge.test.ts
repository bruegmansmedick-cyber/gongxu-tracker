import { describe, expect, it } from 'vitest'
import { mergeSyncable, pickWinner } from '@/sync/merge'
import type { ProcessRecord } from '@/types'

function row(id: string, updatedAt: number, extra: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id,
    projectId: 'p1',
    processId: 'a',
    date: '2026-09-30',
    startTime: '08:00',
    endTime: '12:00',
    startAt: 1,
    endAt: 2,
    hours: 4,
    operatorId: 'o1',
    operatorName: '张三',
    deviceId: 'd1',
    createdAt: 0,
    updatedAt,
    ...extra
  }
}

describe('pickWinner', () => {
  it('取 updatedAt 较新的一条', () => {
    const a = row('x', 100, { hours: 4 })
    const b = row('x', 200, { hours: 6 })
    expect(pickWinner(a, b).hours).toBe(6)
    expect(pickWinner(b, a).hours).toBe(6)
  })

  it('时间戳相同时删除优先，避免记录被复活', () => {
    const a = row('x', 100, { deletedAt: 150 })
    const b = row('x', 100)
    expect(pickWinner(a, b).deletedAt).toBe(150)
    expect(pickWinner(b, a).deletedAt).toBe(150)
  })
})

describe('mergeSyncable', () => {
  it('两台设备各自新增的记录会合并到一起', () => {
    const local = [row('a', 1), row('b', 2)]
    const remote = [row('c', 3)]
    const r = mergeSyncable(local, remote)
    expect(r.rows.map((x) => x.id).sort()).toEqual(['a', 'b', 'c'])
    expect(r.remoteDiffers).toBe(true)
    expect(r.localDiffers).toBe(true)
  })

  it('同一条记录两边都改过时以时间新的为准，且不影响其他记录', () => {
    const local = [row('a', 10, { hours: 5 }), row('b', 20)]
    const remote = [row('a', 30, { hours: 7 }), row('c', 5)]
    const r = mergeSyncable(local, remote)
    const a = r.rows.find((x) => x.id === 'a')
    expect(a?.hours).toBe(7)
    expect(r.rows.map((x) => x.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('本地删除的记录在合并后不会复活', () => {
    const local = [row('a', 100, { deletedAt: 100 })]
    const remote = [row('a', 90)]
    const r = mergeSyncable(local, remote)
    expect(r.rows[0].deletedAt).toBe(100)
  })

  it('两边完全一致时不标记差异，避免反复上传', () => {
    const local = [row('a', 1), row('b', 2)]
    const remote = [row('b', 2), row('a', 1)]
    const r = mergeSyncable(local, remote)
    expect(r.remoteDiffers).toBe(false)
    expect(r.localDiffers).toBe(false)
  })
})
