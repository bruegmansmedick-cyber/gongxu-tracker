import { describe, expect, it } from 'vitest'
import { buildDayRing, coveredMinutes, ringArcPath, RING_MAX_LANES } from '@/core/dayRing'
import type { Process, ProcessRecord, WbsNode } from '@/types'

const DATE = '2026-09-20'
const NEXT = '2026-09-21'

function wbs(id: string, parentId: string | null, level: 1 | 2 | 3, name: string, sort: number): WbsNode {
  return { id, projectId: 'p', parentId, level, name, sort, updatedAt: 0 }
}

function proc(id: string, itemId: string, name: string, sort: number): Process {
  return { id, projectId: 'p', itemId, name, sort, enabled: 1, updatedAt: 0 }
}

function rec(id: string, processId: string, startTime: string, endTime: string, hours: number, date = DATE): ProcessRecord {
  return {
    id,
    projectId: 'p',
    processId,
    date,
    startTime,
    endTime,
    startAt: 0,
    endAt: 0,
    hours,
    operatorId: 'op',
    operatorName: '白班',
    deviceId: 'dev',
    createdAt: 0,
    updatedAt: 0
  }
}

const WBS: WbsNode[] = [
  wbs('u1', null, 1, '导流洞', 1),
  wbs('d1', 'u1', 2, '洞身段', 1),
  wbs('i-1zd', 'd1', 3, '土石方洞挖（导流洞1#施工支洞）', 1),
  wbs('i-2zd', 'd1', 3, '土石方洞挖（导流洞2#施工支洞）', 2)
]

const PROC: Process[] = [
  proc('p-blast', 'i-1zd', '装药爆破', 1),
  proc('p-muck', 'i-1zd', '出渣', 2),
  proc('p-drill', 'i-2zd', '钻孔（爆破孔）', 1)
]

const WBS_MAP = new Map(WBS.map((w) => [w.id, w]))
const PROC_MAP = new Map(PROC.map((p) => [p.id, p]))

function ring(records: ProcessRecord[], byProcess = false) {
  return buildDayRing({ date: DATE, records, processById: PROC_MAP, wbsById: WBS_MAP, byProcess })
}

describe('24 小时圆盘分段', () => {
  it('一条记录：起止分钟、时长与时间标签', () => {
    const data = ring([rec('r1', 'p-blast', '08:00', '12:00', 4)])
    expect(data.segments).toHaveLength(1)
    const seg = data.segments[0]
    expect(seg.startMin).toBe(480)
    expect(seg.endMin).toBe(720)
    expect(seg.hours).toBe(4)
    expect(seg.lane).toBe(0)
    expect(seg.timeLabel).toBe('08:00–12:00')
    expect(data.stats).toMatchObject({ count: 1, hours: 4, coveredHours: 4, lanes: 1, overflow: 0 })
  })

  it('前一条结束正好接上时复用同一层；重叠才另起一层', () => {
    const chained = ring([
      rec('r1', 'p-blast', '08:00', '12:00', 4),
      rec('r2', 'p-muck', '12:00', '14:00', 2)
    ])
    expect(chained.segments.map((s) => s.lane)).toEqual([0, 0])
    expect(chained.stats.lanes).toBe(1)

    const parallel = ring([
      rec('r1', 'p-blast', '08:00', '12:00', 4),
      rec('r2', 'p-drill', '09:00', '11:00', 2),
      rec('r3', 'p-muck', '10:00', '13:00', 3)
    ])
    expect(parallel.segments.map((s) => s.lane)).toEqual([0, 1, 2])
    expect(parallel.stats.lanes).toBe(3)
  })

  it('跨零点记录：越过 0 点继续画，标签带"次日"，只算这一天的覆盖', () => {
    const data = ring([rec('r1', 'p-blast', '22:00', '02:00', 4)])
    const seg = data.segments[0]
    expect(seg.crossMidnight).toBe(true)
    expect(seg.startMin).toBe(1320)
    expect(seg.endMin).toBe(1560)
    expect(seg.timeLabel).toBe('22:00–次日 02:00')
    // 覆盖只算当天被占的 22:00~24:00 两小时
    expect(data.stats.coveredHours).toBeCloseTo(2, 5)
    // 时长合计仍是完整 4 小时（并行/跨日各算各的）
    expect(data.stats.hours).toBe(4)
  })

  it('覆盖时长做区间去重，不是简单相加', () => {
    const data = ring([
      rec('r1', 'p-blast', '08:00', '12:00', 4),
      rec('r2', 'p-muck', '11:00', '13:00', 2)
    ])
    expect(data.stats.hours).toBe(6)
    expect(data.stats.coveredHours).toBeCloseTo(5, 5)
  })

  it('并行层数超过上限时并到最外层并统计条数', () => {
    const records = Array.from({ length: RING_MAX_LANES + 3 }, (_, i) =>
      rec(`r${i}`, 'p-blast', '08:00', '12:00', 4)
    )
    const data = ring(records)
    expect(data.stats.lanes).toBe(RING_MAX_LANES)
    expect(data.stats.overflow).toBe(3)
    expect(data.segments.filter((s) => s.overflow)).toHaveLength(3)
    expect(Math.max(...data.segments.map((s) => s.lane))).toBe(RING_MAX_LANES - 1)
  })

  it('忽略别的日期和已删除的记录', () => {
    const data = ring([
      rec('r1', 'p-blast', '08:00', '12:00', 4),
      rec('r2', 'p-blast', '08:00', '12:00', 4, NEXT),
      { ...rec('r3', 'p-blast', '08:00', '12:00', 4), deletedAt: 1 }
    ])
    expect(data.segments.map((s) => s.recordId)).toEqual(['r1'])
  })

  it('找不到工序的记录直接跳过，不会画半个扇弧', () => {
    const data = ring([rec('r1', 'p-missing', '08:00', '12:00', 4)])
    expect(data.segments).toHaveLength(0)
    expect(data.stats.count).toBe(0)
  })
})

describe('24 小时圆盘配色与图例', () => {
  it('按工作面着色：同一分项同色，不同分项不同色', () => {
    const data = ring([
      rec('r1', 'p-blast', '08:00', '10:00', 2),
      rec('r2', 'p-muck', '10:00', '12:00', 2),
      rec('r3', 'p-drill', '08:00', '09:00', 1)
    ])
    // 按开工时间排序，同一时刻先看结束更早的
    expect(data.segments.map((s) => s.recordId)).toEqual(['r3', 'r1', 'r2'])
    const byId = new Map(data.segments.map((s) => [s.recordId, s]))
    expect(byId.get('r1')?.colorKey).toBe('1#支洞开挖')
    expect(byId.get('r2')?.colorKey).toBe('1#支洞开挖')
    expect(byId.get('r3')?.colorKey).toBe('2#支洞开挖')
    expect(byId.get('r1')?.color).toBe(byId.get('r2')?.color)
    expect(byId.get('r1')?.color).not.toBe(byId.get('r3')?.color)
    // 图例按第一次出现的顺序，工时按同名累加
    expect(data.legend.map((l) => l.label)).toEqual(['2#支洞开挖', '1#支洞开挖'])
    const first = data.legend.find((l) => l.label === '1#支洞开挖')!
    expect(first.count).toBe(2)
    expect(first.hours).toBe(4)
  })

  it('按工序着色：同一工序名同色；清单里带着工作面短名', () => {
    const data = ring(
      [rec('r1', 'p-blast', '08:00', '10:00', 2), rec('r2', 'p-muck', '10:00', '12:00', 2)],
      true
    )
    expect(data.segments.map((s) => s.colorKey)).toEqual(['装药爆破', '出渣'])
    expect(data.segments.map((s) => s.itemShort)).toEqual(['1#支洞', '1#支洞'])
  })
})

describe('扇弧路径', () => {
  it('正常跨度生成环形扇区路径，零跨度返回空', () => {
    const path = ringArcPath({ size: 200, rInner: 44, rOuter: 80, startMin: 480, endMin: 720 })
    expect(path.startsWith('M ')).toBe(true)
    expect(path).toContain(' A 80 80 ')
    expect(path.endsWith('Z')).toBe(true)
    expect(ringArcPath({ size: 200, rInner: 44, rOuter: 80, startMin: 480, endMin: 480 })).toBe('')
  })

  it('超过半圈用大弧标记，满圈也不会画出破图', () => {
    const long = ringArcPath({ size: 200, rInner: 44, rOuter: 80, startMin: 0, endMin: 1080 })
    expect(long).toContain(' 1 1 ')
    const full = ringArcPath({ size: 200, rInner: 44, rOuter: 80, startMin: 0, endMin: 1440 })
    expect(full).not.toBe('')
    expect(full.split('A')).toHaveLength(3)
  })
})

describe('区间合并', () => {
  it('相邻区间合并、重叠区间去重、超界截断', () => {
    expect(coveredMinutes([[0, 60], [60, 120]])).toBe(120)
    expect(coveredMinutes([[0, 60], [30, 90]])).toBe(90)
    expect(coveredMinutes([[-60, 60], [1400, 1500]])).toBe(60 + 40)
    expect(coveredMinutes([])).toBe(0)
  })
})
