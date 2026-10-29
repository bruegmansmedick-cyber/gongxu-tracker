import { describe, expect, it } from 'vitest'
import { baselineHoursOf, buildTimeFields, computeStats } from '@/core/compute'
import {
  aggregateByItem,
  aggregateByWorkface,
  chainageOptionsOf,
  filterByScope,
  normalizeScope,
  scopeLabel,
  shortItemLabel,
  stackedTrend,
  workfaceIdOfItem
} from '@/core/scope'
import { buildItemWorkfaceMap } from '@/core/workface'
import type { Process, ProcessRecord, WbsNode, Workface } from '@/types'

const wbs: WbsNode[] = [
  { id: 'u1', projectId: 'p', parentId: null, level: 1, name: '导流洞', sort: 1, updatedAt: 1 },
  { id: 'd1', projectId: 'p', parentId: 'u1', level: 2, name: '洞身段', sort: 1, updatedAt: 1 },
  {
    id: 'i1',
    projectId: 'p',
    parentId: 'd1',
    level: 3,
    name: '土石方洞挖（导流洞1#施工支洞）',
    sort: 1,
    workfaceId: 'wf1',
    updatedAt: 1
  },
  {
    id: 'i2',
    projectId: 'p',
    parentId: 'd1',
    level: 3,
    name: '支护工程（导流洞1#施工支洞）',
    sort: 2,
    workfaceId: 'wf1',
    updatedAt: 1
  },
  {
    id: 'i3',
    projectId: 'p',
    parentId: 'd1',
    level: 3,
    name: '土石方洞挖（导流洞2#施工支洞）',
    sort: 3,
    workfaceId: 'wf2',
    updatedAt: 1
  },
  { id: 'u2', projectId: 'p', parentId: null, level: 1, name: '通风兼安全洞B段', sort: 2, updatedAt: 1 },
  { id: 'd2', projectId: 'p', parentId: 'u2', level: 2, name: '洞身段', sort: 1, updatedAt: 1 },
  {
    id: 'i4',
    projectId: 'p',
    parentId: 'd2',
    level: 3,
    name: '土石方洞挖（通风兼安全洞主洞）',
    sort: 1,
    workfaceId: 'wf3',
    updatedAt: 1
  }
]

const workfaces: Workface[] = [
  { id: 'wf1', projectId: 'p', unitId: 'u1', name: '1#支洞', sort: 1, updatedAt: 1 },
  { id: 'wf2', projectId: 'p', unitId: 'u1', name: '2#支洞', sort: 2, updatedAt: 1 },
  { id: 'wf3', projectId: 'p', unitId: 'u2', name: '通风洞', sort: 1, updatedAt: 1 }
]

const processes: Process[] = [
  { id: 'pa', projectId: 'p', itemId: 'i1', name: '钻孔（爆破孔）', sort: 1, standardHours: 4, enabled: 1, updatedAt: 1 },
  { id: 'pb', projectId: 'p', itemId: 'i1', name: '出渣', sort: 2, refHours: 2.5, enabled: 1, updatedAt: 1 },
  { id: 'pc', projectId: 'p', itemId: 'i2', name: '喷护', sort: 1, refHours: 1.5, enabled: 1, updatedAt: 1 },
  { id: 'pd', projectId: 'p', itemId: 'i4', name: '钻孔（爆破孔）', sort: 1, standardHours: 3, enabled: 1, updatedAt: 1 }
]

const wbsById = new Map(wbs.map((w) => [w.id, w]))
const processById = new Map(processes.map((p) => [p.id, p]))
const workfaceById = new Map(workfaces.map((w) => [w.id, w]))
const itemWorkface = buildItemWorkfaceMap(wbs, workfaces)

function rec(id: string, processId: string, date: string, hours: number, chainage?: string): ProcessRecord {
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
    chainage,
    operatorId: 'o',
    operatorName: '张三',
    deviceId: 'd',
    createdAt: 1,
    updatedAt: 1
  }
}

const records: ProcessRecord[] = [
  rec('r1', 'pa', '2026-09-20', 4, '545-548'),
  rec('r2', 'pb', '2026-09-20', 2, '548-551'),
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

describe('按范围过滤（单位工程 → 工作面 → 桩号）', () => {
  it('整体返回全部', () => {
    expect(filterByScope(records, { level: 'all' }, processById, wbsById, itemWorkface)).toHaveLength(5)
  })

  it('按单位工程过滤（导流洞 = u1）', () => {
    const rows = filterByScope(records, { level: 'unit', unitId: 'u1' }, processById, wbsById, itemWorkface)
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r5'])
  })

  it('按工作面过滤（1#支洞 = wf1，含开挖与支护两个分项）', () => {
    const rows = filterByScope(records, { level: 'workface', workfaceId: 'wf1' }, processById, wbsById, itemWorkface)
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r5'])
  })

  it('按桩号交集过滤，同时保留工作面条件', () => {
    expect(
      filterByScope(
        records,
        { level: 'workface', workfaceId: 'wf1', chainage: '547-550' },
        processById,
        wbsById,
        itemWorkface
      ).map((r) => r.id)
    ).toEqual(['r1', 'r2'])
  })

  it('没有绑定表时退回节点上的 workfaceId', () => {
    expect(workfaceIdOfItem('i1', wbsById)).toBe('wf1')
    expect(workfaceIdOfItem('i4', wbsById)).toBe('wf3')
    expect(workfaceIdOfItem('nope', wbsById)).toBe('')
  })

  it('范围名可读', () => {
    expect(scopeLabel({ level: 'all' }, wbsById, workfaceById)).toBe('全部工程')
    expect(scopeLabel({ level: 'unit', unitId: 'u1' }, wbsById, workfaceById)).toBe('导流洞')
    expect(scopeLabel({ level: 'workface', workfaceId: 'wf1' }, wbsById, workfaceById)).toBe('1#支洞')
    expect(
      scopeLabel({ level: 'workface', workfaceId: 'wf1', chainage: '545-548' }, wbsById, workfaceById)
    ).toBe('1#支洞 · 桩号 545-548')
  })
})

describe('旧版本本机范围兼容', () => {
  it('旧的 level=item / process 范围退回到全部工程', () => {
    expect(normalizeScope({ level: 'item', itemId: 'i1', processId: 'pa' })).toEqual({ level: 'all' })
  })

  it('工作面与桩号原样保留，脏数据退回全部', () => {
    expect(normalizeScope({ level: 'workface', workfaceId: 'wf1', chainage: '0+545~0+548' })).toEqual({
      level: 'workface',
      workfaceId: 'wf1',
      chainage: '0+545~0+548'
    })
    expect(normalizeScope(null)).toEqual({ level: 'all' })
    expect(normalizeScope({ level: 'workface' })).toEqual({ level: 'all' })
  })
})

describe('桩号身份 = 工作面 + 规范化桩号', () => {
  const rows: ProcessRecord[] = [
    rec('c1', 'pa', '2026-09-20', 4, '545-548'),
    rec('c2', 'pd', '2026-09-20', 4, '545-548'),
    rec('c3', 'pa', '2026-09-21', 4, 'K0+545～0+548')
  ]

  it('同一短桩号在不同工作面分开列出，不被去重合并', () => {
    const options = chainageOptionsOf({
      records: rows,
      processById,
      wbsById,
      itemWorkface,
      workfaceById
    })
    const labels = options.map((o) => o.label)
    expect(labels).toContain('1#支洞 · 545-548')
    expect(labels).toContain('通风洞 · 545-548')
    expect(options).toHaveLength(2)
    expect(new Set(options.map((o) => o.key)).size).toBe(2)
  })

  it('同一工作面里不同写法的同一桩号合并成一项', () => {
    const options = chainageOptionsOf({
      records: rows,
      processById,
      wbsById,
      itemWorkface,
      workfaceById
    })
    const face1 = options.find((o) => o.workfaceId === 'wf1')
    expect(face1?.count).toBe(2)
    expect(face1?.text).toBe('0+545~0+548')
  })
})

describe('堆叠趋势', () => {
  const periods = [
    { from: '2026-09-01', to: '2026-09-20', label: '第一段' },
    { from: '2026-09-21', to: '2026-09-30', label: '第二段' }
  ]

  it('按工作面分层，各层之和等于总数', () => {
    const t = stackedTrend(records, processById, wbsById, periods, 'workface', 6, { itemWorkface, workfaceById })
    expect(t.labels).toEqual(['第一段', '第二段'])
    t.totals.forEach((total, i) => {
      const sum = t.series.reduce((acc, s) => acc + s.data[i], 0)
      expect(sum).toBeCloseTo(total, 2)
    })
    expect(t.series.map((s) => s.name).sort()).toEqual(['1#支洞', '通风洞'])
    expect(t.totals[0]).toBeCloseTo(6, 2) // r1 4h + r2 2h
    expect(t.totals[1]).toBeCloseTo(9, 2) // r3 1h + r4 3h + r5 5h
  })

  it('按工序分层时用工序名，且能合并为“其他”', () => {
    const t = stackedTrend(records, processById, wbsById, periods, 'process', 2)
    expect(t.series).toHaveLength(2)
    expect(t.series[1].name).toContain('其他')
  })
})

describe('按分项工程 / 工作面汇总与短名', () => {
  it('汇总各分项工程工时，并带上工作面名', () => {
    const rows = aggregateByItem(records, processById, wbsById, itemWorkface, workfaceById)
    const i1 = rows.find((r) => r.itemId === 'i1')
    expect(i1?.actualHours).toBe(11)
    expect(i1?.count).toBe(3)
    expect(i1?.baselineHours).toBe(4 + 2.5 + 4)
    expect(i1?.workfaceName).toBe('1#支洞')
  })

  it('按工作面汇总把开挖与支护并到一起', () => {
    const rows = aggregateByWorkface(records, processById, wbsById, itemWorkface, workfaceById)
    const wf1 = rows.find((r) => r.workfaceId === 'wf1')
    expect(wf1?.workfaceName).toBe('1#支洞')
    expect(wf1?.actualHours).toBe(12)
    expect(wf1?.chainages.sort()).toEqual(['545-551'])
  })

  it('分项工程名压成便于图例显示的短名', () => {
    expect(shortItemLabel('土石方洞挖（导流洞1#施工支洞）')).toBe('1#支洞开挖')
    expect(shortItemLabel('支护工程（导流洞1#施工支洞）')).toBe('1#支洞支护')
    expect(shortItemLabel('土石方洞挖（通风兼安全洞主洞）')).toBe('通风洞开挖')
  })
})
