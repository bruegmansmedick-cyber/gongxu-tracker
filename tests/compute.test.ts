import { describe, expect, it } from 'vitest'
import {
  aggregateByProcess,
  buildTimeFields,
  computeGapRows,
  computeStats,
  completionByItem,
  suggestStandardHours
} from '@/core/compute'
import type { Process, ProcessRecord, WbsNode } from '@/types'

function rec(partial: Partial<ProcessRecord> & { id: string; processId: string; date: string }): ProcessRecord {
  const t = buildTimeFields(partial.date, partial.startTime ?? '08:00', partial.endTime ?? '12:00')
  return {
    projectId: 'p1',
    startTime: '08:00',
    endTime: '12:00',
    quantity: undefined,
    operatorId: 'o1',
    operatorName: '张三',
    deviceId: 'd1',
    createdAt: 0,
    updatedAt: 1,
    ...t,
    ...partial
  } as ProcessRecord
}

function proc(id: string, itemId: string, name: string, standardHours?: number): Process {
  return { id, projectId: 'p1', itemId, name, sort: 1, enabled: 1, standardHours, updatedAt: 1 }
}

describe('buildTimeFields', () => {
  it('普通时段按小时计算', () => {
    const t = buildTimeFields('2026-09-30', '08:00', '12:00')
    expect(t.hours).toBe(4)
  })

  it('完工早于开工视为跨零点并加一天', () => {
    const t = buildTimeFields('2026-09-30', '20:00', '04:00')
    expect(t.hours).toBe(8)
    expect(t.endAt - t.startAt).toBe(8 * 3600000)
  })

  it('起止相同按 24 小时处理（避免出现 0 分钟记录）', () => {
    expect(buildTimeFields('2026-09-30', '08:00', '08:00').hours).toBe(24)
  })
})

describe('computeGapRows', () => {
  const processes = new Map<string, Process>([
    ['a', proc('a', 'item1', '钻孔')],
    ['b', proc('b', 'item1', '注浆')],
    ['c', proc('c', 'item2', '浇筑')]
  ])

  it('同一分项内按开工时间排序，后一条开工减前一条完工', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30', startTime: '08:00', endTime: '12:00' }),
      rec({ id: 'r2', processId: 'b', date: '2026-09-30', startTime: '13:30', endTime: '16:00' })
    ]
    const gaps = computeGapRows(rows, processes)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].gapHours).toBeCloseTo(1.5, 5)
    expect(gaps[0].prevProcessName).toBe('钻孔')
    expect(gaps[0].processName).toBe('注浆')
  })

  it('时间重叠记 0，不产生负空隙', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30', startTime: '08:00', endTime: '13:00' }),
      rec({ id: 'r2', processId: 'b', date: '2026-09-30', startTime: '11:00', endTime: '16:00' })
    ]
    const gaps = computeGapRows(rows, processes)
    expect(gaps[0].gapHours).toBe(0)
  })

  it('同一分项工程内不同桩号仍按时间衔接（部位只用于显示）', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30', location: 'K0+100' }),
      rec({ id: 'r2', processId: 'b', date: '2026-09-30', location: 'K0+500', startTime: '18:00', endTime: '20:00' })
    ]
    const gaps = computeGapRows(rows, processes)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].gapHours).toBeCloseTo(6, 5)
  })

  it('超过 6 小时的间隔视为停工（夜班 / 跨循环），不计入衔接空隙', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30' }), // 08:00-12:00
      rec({ id: 'r2', processId: 'b', date: '2026-09-30', startTime: '20:00', endTime: '22:00' }) // 间隔 8h
    ]
    expect(computeGapRows(rows, processes)).toHaveLength(0)
  })

  it('不同分项工程之间不算衔接', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30' }),
      rec({ id: 'r2', processId: 'c', date: '2026-09-30', startTime: '18:00', endTime: '20:00' })
    ]
    expect(computeGapRows(rows, processes)).toHaveLength(0)
  })
})

describe('computeStats 双口径效率', () => {
  const processes = new Map<string, Process>([
    ['a', proc('a', 'item1', '钻孔', 4)],
    ['b', proc('b', 'item1', '注浆', 8)]
  ])

  it('总量口径 = Σ标准/Σ实际-1，工序平均口径 = 平均偏差率', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30', startTime: '08:00', endTime: '10:00' }), // 实际 2h / 标准 4h
      rec({ id: 'r2', processId: 'b', date: '2026-09-30', startTime: '10:00', endTime: '18:00' }) // 实际 8h / 标准 8h
    ]
    const stats = computeStats(rows, processes, '2026-09-01', '2026-09-30')
    expect(stats.actualHours).toBe(10)
    expect(stats.standardHours).toBe(12)
    expect(stats.totalEfficiency).toBeCloseTo(0.2, 5)
    // (4-2)/4 = 0.5 ; (8-8)/8 = 0 -> 平均 0.25
    expect(stats.avgDeviation).toBeCloseTo(0.25, 5)
  })

  it('没有标准用时的记录不参与效率计算，但仍计入实际工时', () => {
    const localProcesses = new Map<string, Process>([['c', proc('c', 'item1', '浇筑')]])
    const rows = [rec({ id: 'r9', processId: 'c', date: '2026-09-30', quantity: 120 })]
    const stats = computeStats(rows, localProcesses, '2026-09-01', '2026-09-30')
    expect(stats.actualHours).toBe(4)
    expect(stats.standardHours).toBe(0)
    expect(stats.totalEfficiency).toBeNull()
    expect(stats.avgDeviation).toBeNull()
    expect(stats.quantity).toBe(120)
  })
})

describe('aggregateByProcess / completionByItem', () => {
  const wbs: WbsNode[] = [
    { id: 'unit', projectId: 'p1', parentId: null, level: 1, name: '主体工程', sort: 1, updatedAt: 1 },
    { id: 'div', projectId: 'p1', parentId: 'unit', level: 2, name: '混凝土工程', sort: 1, updatedAt: 1 },
    { id: 'item1', projectId: 'p1', parentId: 'div', level: 3, name: '混凝土浇筑', sort: 1, unit: 'm³', designQty: 1000, updatedAt: 1 }
  ]
  const wbsById = new Map(wbs.map((w) => [w.id, w]))
  const processes = new Map<string, Process>([['a', { ...proc('a', 'item1', '浇筑', 4), unit: 'm³', designQty: 1000 }]])

  it('按工序汇总并与标准对比', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30', quantity: 100 }),
      rec({ id: 'r2', processId: 'a', date: '2026-09-30', startTime: '13:00', endTime: '19:00', quantity: 200 })
    ]
    const agg = aggregateByProcess(rows, processes, wbsById)
    expect(agg).toHaveLength(1)
    expect(agg[0].count).toBe(2)
    expect(agg[0].actualHours).toBe(10)
    expect(agg[0].standardTotal).toBe(8)
    expect(agg[0].deviation).toBeCloseTo(-0.25, 5)
    expect(agg[0].itemName).toBe('混凝土浇筑')
    expect(agg[0].unitName).toBe('主体工程')
  })

  it('计算分项完成百分比', () => {
    const rows = [
      rec({ id: 'r1', processId: 'a', date: '2026-09-30', quantity: 250 }),
      rec({ id: 'r2', processId: 'a', date: '2026-09-30', quantity: 250 })
    ]
    const items = completionByItem(rows, processes, wbsById)
    expect(items[0].doneQty).toBe(500)
    expect(items[0].percent).toBeCloseTo(0.5, 5)
  })
})

describe('suggestStandardHours', () => {
  it('给出历史平均并剔除最长的 10%', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      rec({
        id: `r${i}`,
        processId: 'a',
        date: '2026-09-30',
        startTime: '08:00',
        endTime: `${String(8 + i + 1).padStart(2, '0')}:00`
      })
    )
    const s = suggestStandardHours('a', rows)
    expect(s.sample).toBe(10)
    expect(s.used).toBe(9)
    expect(s.value).toBeGreaterThan(0)
    expect(s.value!).toBeLessThan(10)
  })

  it('没有记录时返回 null', () => {
    expect(suggestStandardHours('a', []).value).toBeNull()
  })
})
