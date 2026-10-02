import { describe, expect, it } from 'vitest'
import {
  buildUsageIndex,
  predictNode,
  predictSelection,
  rankByUsage,
  topProcesses,
  usageScore,
  type UsageIndex
} from '@/core/predict'
import { BENCH_TEMPLATE } from '@/db/seed'
import { HISTORY_ROWS, buildHistoryRecords } from '@/db/history'
import type { Process, ProcessRecord, WbsNode } from '@/types'

const PID = 'prj-test'
const NOW = Date.parse('2026-10-01T12:00:00+08:00')

// ---------------------------------------------------------------- 合成小工程

function wbs(id: string, parentId: string | null, level: 1 | 2 | 3, name: string, sort: number): WbsNode {
  return { id, projectId: PID, parentId, level, name, sort, updatedAt: 0 }
}

function proc(id: string, itemId: string, name: string, sort: number): Process {
  return { id, projectId: PID, itemId, name, sort, enabled: 1, updatedAt: 0 }
}

function rec(id: string, processId: string, startAt: number, deleted = false): ProcessRecord {
  return {
    id,
    projectId: PID,
    processId,
    date: '2026-09-30',
    startTime: '08:00',
    endTime: '09:00',
    startAt,
    endAt: startAt + 3600000,
    hours: 1,
    operatorId: 'op-1',
    operatorName: '白班',
    deviceId: 'dev-1',
    createdAt: startAt,
    updatedAt: startAt,
    ...(deleted ? { deletedAt: startAt } : {})
  }
}

const SMALL_WBS: WbsNode[] = [
  wbs('u1', null, 1, '一号单位工程', 1),
  wbs('u2', null, 1, '二号单位工程', 2),
  wbs('d1', 'u1', 2, '洞身段', 1),
  wbs('d2', 'u1', 2, '洞口段', 2),
  wbs('i1', 'd1', 3, '土石方洞挖', 1),
  wbs('i2', 'd2', 3, '明渠底板混凝土', 1)
]

const SMALL_PROC: Process[] = [
  proc('p1', 'i1', '装药爆破', 1),
  proc('p2', 'i1', '出渣', 2),
  proc('p3', 'i2', '混凝土浇筑', 1)
]

const SMALL_PROC_MAP = new Map(SMALL_PROC.map((p) => [p.id, p]))
const SMALL_WBS_MAP = new Map(SMALL_WBS.map((w) => [w.id, w]))

const DAY = 86400000

function smallIndex(): UsageIndex {
  return buildUsageIndex(
    [
      rec('r1', 'p1', NOW - 1 * DAY), // 最近：一号洞身开挖
      rec('r2', 'p1', NOW - 1 * DAY),
      rec('r3', 'p3', NOW - 20 * DAY), // 较早：明渠混凝土
      rec('r4', 'p2', NOW - 40 * DAY), // 超出 30 天窗口，忽略
      rec('r5', 'p1', NOW, true) // 已删除，忽略
    ],
    SMALL_PROC_MAP,
    SMALL_WBS_MAP,
    NOW
  )
}

describe('使用习惯统计', () => {
  it('越近的权重越高；超出 30 天和已删除的记录都不算', () => {
    const index = smallIndex()
    // 只剩 r1/r2/r3 三条
    expect(index.sample).toBe(3)
    const recent = usageScore(index, 'i1') // r1 + r2
    const old = usageScore(index, 'i2') // r3
    expect(recent).toBeGreaterThan(old)
    expect(usageScore(index, 'u2')).toBe(0)
    expect(usageScore(index, 'p2')).toBe(0)
  })

  it('统计会累加到单位 / 分部 / 分项 / 工序四级', () => {
    const index = smallIndex()
    expect(usageScore(index, 'u1')).toBeCloseTo(usageScore(index, 'd1') + usageScore(index, 'd2'), 6)
    expect(usageScore(index, 'd1')).toBeCloseTo(usageScore(index, 'i1'), 6)
    expect(usageScore(index, 'i1')).toBeCloseTo(usageScore(index, 'p1'), 6)
  })

  it('没有任何记录时统计为空，不会瞎猜', () => {
    const empty = buildUsageIndex([], SMALL_PROC_MAP, SMALL_WBS_MAP, NOW)
    expect(empty.sample).toBe(0)
    expect(predictNode('u1', 2, SMALL_WBS, empty)).toBeUndefined()
    expect(predictSelection({ unitId: 'u1', wbs: SMALL_WBS, index: empty })).toEqual({})
  })
})

describe('按使用习惯排序', () => {
  it('常记的排前面，没有记录的保持工程结构顺序', () => {
    const index = smallIndex()
    expect(rankByUsage(SMALL_WBS.filter((n) => n.level === 1), index).map((n) => n.id)).toEqual(['u1', 'u2'])
    expect(rankByUsage(SMALL_WBS.filter((n) => n.level === 2), index).map((n) => n.id)).toEqual(['d1', 'd2'])
    const flat: UsageIndex = { score: new Map([['b', 1]]), lastAt: new Map(), sample: 1 }
    expect(rankByUsage([{ id: 'a', sort: 1 }, { id: 'b', sort: 2 }], flat).map((n) => n.id)).toEqual(['b', 'a'])
  })
})

describe('预判下一步选什么', () => {
  it('选了单位工程就能预判分部与分项', () => {
    const index = smallIndex()
    expect(predictNode('u1', 2, SMALL_WBS, index)).toBe('d1')
    expect(predictSelection({ unitId: 'u1', wbs: SMALL_WBS, index })).toEqual({ divisionId: 'd1', itemId: 'i1' })
  })

  it('已经选了分部时，只在那个分部里预判分项', () => {
    const index = smallIndex()
    expect(predictSelection({ unitId: 'u1', divisionId: 'd2', wbs: SMALL_WBS, index })).toEqual({ itemId: 'i2' })
  })

  it('单位工程下没有分部记录时，直接跨分部找最常用的分项', () => {
    const index = buildUsageIndex([rec('r1', 'p3', NOW - 1 * DAY)], SMALL_PROC_MAP, SMALL_WBS_MAP, NOW)
    expect(predictSelection({ unitId: 'u1', wbs: SMALL_WBS, index })).toEqual({ divisionId: 'd2', itemId: 'i2' })
  })

  it('分项下只有一道工序时顺手选中；有多道工序不猜，留给现场选', () => {
    const index = smallIndex()
    const single = predictSelection({ unitId: 'u1', divisionId: 'd2', wbs: SMALL_WBS, index, processes: SMALL_PROC })
    expect(single).toEqual({ itemId: 'i2', processId: 'p3' })
    const multi = predictSelection({ unitId: 'u1', wbs: SMALL_WBS, index, processes: SMALL_PROC })
    expect(multi).toEqual({ divisionId: 'd1', itemId: 'i1' })
  })

  it('常用工序只收有使用记录的，并按用量排序', () => {
    const index = smallIndex()
    expect(topProcesses(SMALL_PROC, index, 5).map((p) => p.id)).toEqual(['p1', 'p3'])
    expect(topProcesses(SMALL_PROC, index, 1).map((p) => p.id)).toEqual(['p1'])
  })
})

// ------------------------------------------------- 真实模板 + 三份历史记录

function benchWbs(): WbsNode[] {
  const out: WbsNode[] = []
  let sort = 0
  BENCH_TEMPLATE.forEach((unitTpl) => {
    const unitId = `wbs-${PID}-${unitTpl.key}`
    out.push(wbs(unitId, null, 1, unitTpl.name, (sort += 1)))
    unitTpl.divisions.forEach((divTpl) => {
      const divId = `wbs-${PID}-${divTpl.key}`
      out.push(wbs(divId, unitId, 2, divTpl.name, (sort += 1)))
      divTpl.items.forEach((itemTpl) => {
        out.push(wbs(`wbs-${PID}-${itemTpl.key}`, divId, 3, itemTpl.name, (sort += 1)))
      })
    })
  })
  return out
}

function benchProcesses(): Process[] {
  const out: Process[] = []
  let sort = 0
  BENCH_TEMPLATE.forEach((unitTpl) =>
    unitTpl.divisions.forEach((divTpl) =>
      divTpl.items.forEach((itemTpl) => {
        itemTpl.processes.forEach((p) => {
          out.push(proc(`prc-${PID}-${itemTpl.key}--${p.key}`, `wbs-${PID}-${itemTpl.key}`, p.name, (sort += 1)))
        })
      })
    )
  )
  return out
}

describe('用真实模板与 209 条历史记录验证', () => {
  const wbs = benchWbs()
  const processes = benchProcesses()
  const processById = new Map(processes.map((p) => [p.id, p]))
  const wbsById = new Map(wbs.map((n) => [n.id, n]))
  const records = buildHistoryRecords(PID)
  const index = buildUsageIndex(records, processById, wbsById, NOW)

  it('历史记录都参与统计（工序 id 能对上）', () => {
    expect(index.sample).toBeGreaterThan(200)
    expect(index.sample).toBeLessThanOrEqual(HISTORY_ROWS.length)
  })

  it('最常用的单位工程是导流洞或通风兼安全洞B段（历史只有这三个工作面）', () => {
    const top = predictNode(null, 1, wbs, index)
    const name = wbsById.get(top ?? '')?.name
    expect(['导流洞', '通风兼安全洞B段']).toContain(name)
  })

  it('选了导流洞，预判到的是 1#施工支洞所在的分部与分项', () => {
    const dldId = wbs.find((n) => n.level === 1 && n.name === '导流洞')!.id
    const predicted = predictSelection({ unitId: dldId, wbs, index, processes })
    const itemKey = wbsById.get(predicted.itemId ?? '')?.id
    expect([`wbs-${PID}-dld-1zd-exc`, `wbs-${PID}-dld-1zd-sup`]).toContain(itemKey)
    const division = wbsById.get(predicted.divisionId ?? '')
    expect(division?.level).toBe(2)
    expect(division?.id).toBe(wbsById.get(predicted.itemId!)?.parentId)
    // 预判到的分项确实在预判到的分部下面
    expect(wbsById.get(predicted.itemId!)?.parentId).toBe(predicted.divisionId)
    // 1#支洞开挖有多道工序，所以不会顺手选中工序
    expect(predicted.processId).toBeUndefined()
  })
})
