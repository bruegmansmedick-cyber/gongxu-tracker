import { describe, expect, it } from 'vitest'
import { daySummaries } from '@/core/compute'
import type { ProcessRecord } from '@/types'

function rec(id: string, date: string, hours: number, deleted = false): ProcessRecord {
  return {
    id,
    projectId: 'p',
    processId: 'prc-1',
    date,
    startTime: '08:00',
    endTime: '12:00',
    startAt: 0,
    endAt: 0,
    hours,
    operatorId: 'op',
    operatorName: '白班',
    deviceId: 'dev',
    createdAt: 0,
    updatedAt: 0,
    ...(deleted ? { deletedAt: 1 } : {})
  }
}

describe('每天一行汇总（明细页月总览）', () => {
  it('只返回有记录的天，按日期倒序，并汇总条数与工时', () => {
    const rows = daySummaries(
      [rec('r1', '2026-09-20', 4), rec('r2', '2026-09-20', 2.5), rec('r3', '2026-09-18', 8)],
      new Map()
    )
    expect(rows.map((r) => r.date)).toEqual(['2026-09-20', '2026-09-18'])
    expect(rows[0]).toMatchObject({ count: 2, hours: 6.5, gapHours: 0 })
    expect(rows[1]).toMatchObject({ count: 1, hours: 8 })
  })

  it('空隙按记录 id 归到它自己那一天', () => {
    const rows = daySummaries(
      [rec('r1', '2026-09-20', 4), rec('r2', '2026-09-18', 8)],
      new Map([
        ['r1', 1.5],
        ['r2', 0.25]
      ])
    )
    expect(rows.find((r) => r.date === '2026-09-20')?.gapHours).toBe(1.5)
    expect(rows.find((r) => r.date === '2026-09-18')?.gapHours).toBe(0.25)
  })

  it('已删除的记录不算，异常工时按 0 计', () => {
    const rows = daySummaries(
      [rec('r1', '2026-09-20', 4), rec('r2', '2026-09-20', 4, true), rec('r3', '2026-09-19', Number.NaN)],
      new Map()
    )
    expect(rows.map((r) => r.date)).toEqual(['2026-09-20', '2026-09-19'])
    expect(rows[0].count).toBe(1)
    expect(rows[0].hours).toBe(4)
    expect(rows[1].hours).toBe(0)
  })
})
