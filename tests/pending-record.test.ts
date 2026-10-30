import { describe, expect, it } from 'vitest'
import {
  buildStartAt,
  computeGapRows,
  computeStats,
  ensureTimes,
  isCompleteRecord
} from '@/core/compute'
import { buildCycles } from '@/core/cycles'
import { buildDayRing } from '@/core/dayRing'
import { scanHealth } from '@/core/health'
import type { Process, ProcessRecord, WbsNode } from '@/types'

const projectId = 'p1'
const itemId = 'item-1'

const processRow: Process = {
  id: 'p--m-drill',
  projectId,
  itemId,
  name: '钻孔',
  sort: 1,
  standardHours: 4,
  enabled: 1,
  updatedAt: 1
}

const wbsRow: WbsNode = {
  id: itemId,
  projectId,
  parentId: null,
  level: 3,
  name: '洞挖（1#支洞）',
  sort: 1,
  updatedAt: 1
}

function pending(): ProcessRecord {
  return {
    id: 'rec-pending',
    projectId,
    processId: processRow.id,
    date: '2026-10-30',
    startTime: '22:00',
    startAt: buildStartAt('2026-10-30', '22:00'),
    endPending: 1,
    chainage: '0-5',
    operatorId: 'op1',
    operatorName: '白班',
    deviceId: 'd1',
    createdAt: 1,
    updatedAt: 1
  }
}

function complete(id: string, start: string, end: string): ProcessRecord {
  const startAt = buildStartAt('2026-10-30', start)
  const endAt = buildStartAt('2026-10-30', end)
  return {
    id,
    projectId,
    processId: processRow.id,
    date: '2026-10-30',
    startTime: start,
    endTime: end,
    startAt,
    endAt,
    hours: (endAt - startAt) / 3600000,
    chainage: '0-5',
    operatorId: 'op1',
    operatorName: '白班',
    deviceId: 'd1',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('待补完工记录', () => {
  it('保持待补状态，不伪造默认完工时间', () => {
    const row = ensureTimes(pending())
    expect(isCompleteRecord(row)).toBe(false)
    expect(row.endPending).toBe(1)
    expect(row.endAt).toBeUndefined()
    expect(row.hours).toBeUndefined()
  })

  it('不进入工时、空隙、循环和圆盘统计，但进入健康提醒', () => {
    const rows = [pending(), complete('rec-ok', '08:00', '12:00')]
    const processById = new Map([[processRow.id, processRow]])
    const wbsById = new Map([[wbsRow.id, wbsRow]])

    const stats = computeStats(rows, processById, '2026-10-30', '2026-10-30')
    expect(stats.recordCount).toBe(1)
    expect(stats.pendingCount).toBe(1)
    expect(stats.actualHours).toBe(4)

    expect(computeGapRows(rows, processById)).toEqual([])
    expect(buildCycles(rows, { processById })).toEqual([])
    expect(
      buildDayRing({
        date: '2026-10-30',
        records: rows,
        processById,
        wbsById,
        byProcess: false
      }).segments.map((row) => row.recordId)
    ).toEqual(['rec-ok'])

    const pendingIssue = scanHealth(rows, processById, wbsById).find((row) => row.rule === 'pending-end')
    expect(pendingIssue?.recordId).toBe('rec-pending')
  })
})
