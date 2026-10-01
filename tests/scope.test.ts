import { describe, expect, it } from 'vitest'
import { baselineHoursOf, buildTimeFields, computeStats } from '@/core/compute'
import {
  aggregateByItem,
  filterByScope,
  scopeLabel,
  shortItemLabel,
  stackedTrend
} from '@/core/scope'
import type { Process, ProcessRecord, WbsNode } from '@/types'

const wbs: WbsNode[] = [
  { id: 'u1', projectId: 'p', parentId: null, level: 1, name: '导流洞', sort: 1, updatedAt: 1 },
  { id: 'd1', projectId: 'p', parentId: 'u1', level: 2, name: '洞身段', sort: 1, updatedAt: 1 },
  { id: 'i1', projectId: 'p', parentId: 'd1', level: 3, name: '土石方洞挖（导流洞1#施工支洞）', sort: 1, updatedAt: 1 },
  { id: 'i2', projectId: 'p', parentId: 'd1', level: 3, name: '支护工程（导流洞1#施工支洞）', sort: 2, updatedAt: 1 },
  { id: 'u2', projectId: 'p', parentId: null, level: 1, name: '通风兼安全洞B段', sort: 2, updatedAt: 1 },
  { id: 'd2', projectId: 'p', parentId: 'u2', level: 2, name: '洞身段', sort: 1, updatedAt: 1 },
  { id: 'i3', projectId: 'p', parentId: 'd2', level: 3, name: '土石方洞挖（通风兼安全洞主洞）', sort: 1, updatedAt: 1 }
]

const processes: Process[] = [
  { id: 'pa', projectId: 'p', itemId: 'i1', name: '钻孔（爆破孔）', sort: 1, standardHours: 4, enabled: 1, updatedAt: 1 },
  { id: 'pb', projectId: 'p', itemId: 'i1', name: '出渣', sort: 2, refHours: 2.5, enabled: 1, updatedAt: 1 },
  { id: 'pc', projectId: 'p', itemId: 'i2', name: '喷护', sort: 1, refHours: 1.5, enabled: 1, updatedAt: 1 },
  { id: 'pd', projectId: 'p', itemId: 'i3', name: '钻孔（爆破孔）', sort: 1, standardHours: 3, enabled: 1, updatedAt: 1 }
]

const wbsById = new Map(wbs.map((w) => [w.id, w]))
const processById = new Map(processes.map((p) => [p.id, p]))

function rec(id: string, processId: string, date: string, hours: number): ProcessRecord {
  const end = 8 + Math.floor(hours)
  const t = buildTimeFields(date, '08:00', `${String(end).padStart(2, '0')}:00`)
  return {
    id,
    projectId: 'p',
    processId,
    date,
    startTime: '08:00',
    endTime: `${String(end).padStart(2, '0')}:00`,
    ...t,
    hours,
    operatorId: 'o',
    operatorName: '张三',
    deviceId: 'd',
    createdAt: 1,
    updatedAt: 1
  }
}

const records: ProcessRecord[] = [
  rec('r1', 'pa', '2026-09-20', 4),
  rec('r2', 'pb', '2026-09-20', 2),
  rec('r3', 'pc', '2026-09-21', 1),
  rec('r4', 'pd', '2026-09-21', 3),
  rec('r5', 'pa', '2026-09-22', 5)
]

describe('基准值：标准优先，缺失时用参考', () => {
  it('有标准用标准，没有标准但有参考用参考，都没有则为空', () => {
    expect(baselineHoursOf(processById.get('pa'))).toBe(4)
    expect(baselineHoursOf(processById.get('pb'))).toBe(2.5)
    expect(baselineHoursOf(undefined)).toBeNull()
  })

  it('效率在没有标准用时也能算出来（按参考口径）', () => {
    const only = records.filter((r) => r.processId === 'pb')
    const s = computeStats(only, processById, '2026-09-01', '2026-09-30')
    expect(s.standardHours).toBe(0)
    expect(s.baselineHours).toBe(2.5)
    expect(s.baselineSource).toBe('reference')
    expect(s.totalEfficiency).toBeCloseTo(2.5 / 2 - 1, 5)
  })

  it('标准与参考混用时标记为 mixed', () => {
    const s = computeStats(records, processById, '2026-09-01', '2026-09-30')
    expect(s.baselineSource).toBe('mixed')
    expect(s.baselineCovered).toBe(records.length)
  })
})

describe('按范围过滤', () => {
  it('整体返回全部', () => {
    expect(filterByScope(records, { level: 'all' }, processById, wbsById)).toHaveLength(5)
  })

  it('按单位工程过滤（导流洞 = u1）', () => {
    const rows = filterByScope(records, { level: 'unit', unitId: 'u1' }, processById, wbsById)
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r5'])
  })

  it('按分项工程过滤（1#支洞开挖 = i1）', () => {
    const rows = filterByScope(records, { level: 'item', itemId: 'i1' }, processById, wbsById)
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r5'])
  })

  it('按具体工序过滤（i1 的出渣 = pb）', () => {
    const rows = filterByScope(records, { level: 'item', itemId: 'i1', processId: 'pb' }, processById, wbsById)
    expect(rows.map((r) => r.id)).toEqual(['r2'])
  })

  it('范围名可读', () => {
    expect(scopeLabel({ level: 'all' }, wbsById)).toBe('全部工程')
    expect(scopeLabel({ level: 'unit', unitId: 'u1' }, wbsById)).toBe('导流洞')
    expect(scopeLabel({ level: 'item', itemId: 'i1' }, wbsById, processById)).toBe('土石方洞挖（导流洞1#施工支洞）')
    expect(scopeLabel({ level: 'item', itemId: 'i1', processId: 'pb' }, wbsById, processById)).toContain('出渣')
  })
})

describe('堆叠趋势', () => {
  const periods = [
    { from: '2026-09-01', to: '2026-09-20', label: '第一段' },
    { from: '2026-09-21', to: '2026-09-30', label: '第二段' }
  ]

  it('按分项工程分层，各层之和等于总数', () => {
    const t = stackedTrend(records, processById, wbsById, periods, 'item')
    expect(t.labels).toEqual(['第一段', '第二段'])
    t.totals.forEach((total, i) => {
      const sum = t.series.reduce((acc, s) => acc + s.data[i], 0)
      expect(sum).toBeCloseTo(total, 2)
    })
    expect(t.totals[0]).toBeCloseTo(6, 2) // r1 4h + r2 2h
    expect(t.totals[1]).toBeCloseTo(9, 2) // r3 1h + r4 3h + r5 5h
  })

  it('按工序分层时用工序名，且能合并为“其他”', () => {
    const t = stackedTrend(records, processById, wbsById, periods, 'process', 2)
    expect(t.series).toHaveLength(2)
    expect(t.series[1].name).toContain('其他')
  })
})

describe('按分项工程汇总与短名', () => {
  it('汇总各分项工程工时', () => {
    const rows = aggregateByItem(records, processById, wbsById)
    const i1 = rows.find((r) => r.itemId === 'i1')
    expect(i1?.actualHours).toBe(11)
    expect(i1?.count).toBe(3)
    expect(i1?.baselineHours).toBe(4 + 2.5 + 4)
  })

  it('分项工程名压成便于图例显示的短名', () => {
    expect(shortItemLabel('土石方洞挖（导流洞1#施工支洞）')).toBe('1#支洞开挖')
    expect(shortItemLabel('支护工程（导流洞1#施工支洞）')).toBe('1#支洞支护')
    expect(shortItemLabel('土石方洞挖（通风兼安全洞主洞）')).toBe('通风洞开挖')
  })
})
