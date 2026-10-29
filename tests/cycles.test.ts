import { describe, expect, it } from 'vitest'
import {
  buildCombinedCycles,
  buildCycles,
  cycleChainageText,
  cycleLabel,
  cyclesInPeriod,
  filterCyclesByChainage,
  summarizeCycles,
  COMBINE_WINDOW_HOURS
} from '@/core/cycles'
import type { Process, ProcessRecord } from '@/types'

const T = (s: string) => new Date(`${s}+08:00`).getTime()
const ITEM = 'wbs-p-i1'

function rec(
  id: string,
  key: string,
  start: string,
  end: string,
  note = '',
  item = ITEM,
  location = ''
): ProcessRecord {
  const pid = `prc-${item}--${key}`
  return {
    id,
    projectId: 'p',
    processId: pid,
    date: start.slice(0, 10),
    startTime: start.slice(11, 16),
    endTime: end.slice(11, 16),
    startAt: T(start),
    endAt: T(end),
    hours: (T(end) - T(start)) / 3600000,
    note,
    location: location || undefined,
    operatorId: 'op',
    operatorName: '白班',
    deviceId: 'dev',
    createdAt: 0,
    updatedAt: 0
  }
}

function run(records: ProcessRecord[], faces: Record<string, string> = {}) {
  const map = new Map<string, Process>()
  records.forEach((r) => {
    const item = r.processId.split('--')[0].replace('prc-', '')
    map.set(r.processId, {
      id: r.processId,
      projectId: 'p',
      itemId: item,
      name: r.processId.split('--').pop() ?? '',
      sort: 1,
      enabled: 1,
      updatedAt: 0
    })
  })
  return buildCycles(records, { processById: map, itemWorkface: new Map(Object.entries(faces)) })
}

describe('循环识别', () => {
  it('开挖：测量放样到下一轮测量放样，用时为首道开工到末道完工', () => {
    const rows = [
      rec('a1', 'm-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
      rec('a2', 'm-drill', '2026-10-10T09:00', '2026-10-10T12:00'),
      rec('a3', 'm-blast', '2026-10-10T12:30', '2026-10-10T13:30'),
      rec('a4', 'm-muck', '2026-10-10T14:00', '2026-10-10T18:00'),
      rec('b1', 'm-survey', '2026-10-11T08:00', '2026-10-11T09:00'),
      rec('b2', 'm-drill', '2026-10-11T09:00', '2026-10-11T12:00'),
      rec('b3', 'm-blast', '2026-10-11T12:30', '2026-10-11T13:30'),
      rec('b4', 'm-muck', '2026-10-11T14:00', '2026-10-11T18:00')
    ]
    const cycles = run(rows)
    expect(cycles).toHaveLength(2)
    const first = cycles[0]
    expect(first.family).toBe('exc')
    expect(first.startAt).toBe(T('2026-10-10T08:00'))
    expect(first.endAt).toBe(T('2026-10-10T18:00'))
    expect(first.hours).toBeCloseTo(10, 5)
    expect(first.steps).toBe(4)
    expect(first.startDate).toBe('2026-10-10')
    expect(first.endDate).toBe('2026-10-10')
    expect(first.spansDays).toBe(false)
    expect(first.incomplete).toBe(false)
  })

  it('同一轮里多条测量放样不会切出假循环（取离爆破最近的一条）', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T07:40', '2026-10-10T08:30'),
      rec('a2', 'm-survey', '2026-10-10T08:10', '2026-10-10T10:10'),
      rec('a3', 'm-drill', '2026-10-10T10:10', '2026-10-10T12:57'),
      rec('a4', 'm-blast', '2026-10-10T13:50', '2026-10-10T15:31'),
      rec('a5', 'm-muck', '2026-10-10T16:00', '2026-10-10T19:00')
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].startAt).toBe(T('2026-10-10T08:10'))
  })

  it('补炮 / 处理欠挖不单独开一轮', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
      rec('a2', 'm-blast', '2026-10-10T10:00', '2026-10-10T11:00'),
      rec('a3', 'm-muck', '2026-10-10T12:00', '2026-10-10T14:00'),
      rec('a4', 'm-blast', '2026-10-10T15:00', '2026-10-10T16:00', '补炮处理欠挖'),
      rec('a5', 'm-muck', '2026-10-10T17:00', '2026-10-10T18:00')
    ])
    expect(cycles).toHaveLength(1)
  })

  it('首道工序到末道工序之间的停工全部计入（不再剔除 6h 以上间隔）', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T09:00', '2026-10-10T10:00'),
      rec('a2', 'm-drill', '2026-10-10T10:00', '2026-10-10T11:00'),
      rec('a3', 'm-blast', '2026-10-11T09:00', '2026-10-11T10:00'),
      rec('a4', 'm-survey', '2026-10-11T12:00', '2026-10-11T13:00'),
      rec('a5', 'm-blast', '2026-10-11T14:00', '2026-10-11T15:00')
    ])
    expect(cycles).toHaveLength(2)
    const first = cycles[0]
    // 10-10 09:00 → 10-11 10:00 共 25h，中间 22h 停工计入
    expect(first.hours).toBeCloseTo(25, 5)
    expect(first.endAt).toBe(T('2026-10-11T10:00'))
    expect(first.spansDays).toBe(true)
    expect(first.endDate).toBe('2026-10-11')
  })

  it('跨零点作业标记为跨天，并按结束日归属', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T22:00', '2026-10-10T23:00'),
      rec('a2', 'm-drill', '2026-10-10T23:00', '2026-10-11T02:00'),
      rec('a3', 'm-blast', '2026-10-11T02:30', '2026-10-11T03:30'),
      rec('a4', 'm-muck', '2026-10-11T04:00', '2026-10-11T06:00')
    ])
    expect(cycles[0].spansDays).toBe(true)
    expect(cycles[0].startDate).toBe('2026-10-10')
    expect(cycles[0].endDate).toBe('2026-10-11')
    expect(cycles[0].hours).toBeCloseTo(8, 5)
    expect(cycles[0].incomplete).toBe(true)
  })

  it('没有测量放样时从窗口内最早一条同族记录起算', () => {
    const cycles = run([
      rec('a1', 'm-drill', '2026-10-10T09:00', '2026-10-10T12:00'),
      rec('a2', 'm-blast', '2026-10-10T13:00', '2026-10-10T14:00'),
      rec('a3', 'm-muck', '2026-10-10T15:00', '2026-10-10T18:00')
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].startAt).toBe(T('2026-10-10T09:00'))
  })

  it('上一轮的测量放样不会被下一轮借用', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T20:00', '2026-10-10T21:00'),
      rec('a2', 'm-blast', '2026-10-10T22:00', '2026-10-10T23:00'),
      rec('a3', 'm-muck', '2026-10-10T23:30', '2026-10-11T00:30'),
      rec('b1', 'm-drill', '2026-10-11T17:00', '2026-10-11T17:50'),
      rec('b2', 'm-blast', '2026-10-11T18:00', '2026-10-11T19:00')
    ])
    expect(cycles).toHaveLength(2)
    expect(cycles[1].startAt).toBe(T('2026-10-11T17:00'))
  })

  it('同一工作面的两个分项算一轮，不按分项拆开', () => {
    const cycles = run(
      [
        rec('a1', 'm-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', 'wbs-p-i1'),
        rec('a2', 'm-blast', '2026-10-10T10:00', '2026-10-10T11:00', '', 'wbs-p-i2'),
        rec('a3', 'm-muck', '2026-10-10T12:00', '2026-10-10T14:00', '', 'wbs-p-i2')
      ],
      { 'wbs-p-i1': 'wf-1', 'wbs-p-i2': 'wf-1' }
    )
    expect(cycles).toHaveLength(1)
    expect(cycles[0].workfaceId).toBe('wf-1')
    expect(cycles[0].itemIds.sort()).toEqual(['wbs-p-i1', 'wbs-p-i2'])
  })

  it('支护轮带上桩号、合并长度与每米用时', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+459~0+462'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, 'K0+460~0+464')
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].family).toBe('sup')
    expect(cycles[0].chainages).toEqual(['0+459~0+464'])
    expect(cycles[0].chainageLengthM).toBeCloseTo(5, 3)
    // 08:00 → 12:00 共 4h，5m → 0.8h/m
    expect(cycles[0].hoursPerMeter).toBeCloseTo(0.8, 3)
    expect(cycleChainageText(cycles[0])).toBe('桩号 459-464（5.0m）· 0.80h/m')
  })

  it('新 chainage 字段优先于旧 location', () => {
    const cycles = run([
      { ...rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+100~0+103'), chainage: '545-548' },
      { ...rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, '0+100~0+103'), chainage: '545-548' }
    ])
    expect(cycles[0].chainages).toEqual(['0+545~0+548'])
  })

  it('没有桩号时长度和每米用时为空', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00')
    ])
    expect(cycles[0].chainages).toEqual([])
    expect(cycles[0].chainageLengthM).toBeNull()
    expect(cycles[0].hoursPerMeter).toBeNull()
    expect(cycleChainageText(cycles[0])).toBe('桩号未填（可到明细补填）')
  })
})

describe('循环归属与筛选', () => {
  const rows = [
    rec('a1', 'm-survey', '2026-10-10T22:00', '2026-10-10T23:00'),
    rec('a2', 'm-blast', '2026-10-11T00:00', '2026-10-11T01:00'),
    rec('a3', 'm-muck', '2026-10-11T02:00', '2026-10-11T04:00'),
    rec('b1', 'm-survey', '2026-10-12T08:00', '2026-10-12T09:00'),
    rec('b2', 'm-blast', '2026-10-12T10:00', '2026-10-12T11:00')
  ]

  it('跨天轮在结束日可见，开始日看不到', () => {
    const cycles = run(rows)
    expect(cyclesInPeriod(cycles, '2026-10-10', '2026-10-10')).toHaveLength(0)
    expect(cyclesInPeriod(cycles, '2026-10-11', '2026-10-11')).toHaveLength(1)
    expect(cyclesInPeriod(cycles, '2026-10-11', '2026-10-11')[0].startDate).toBe('2026-10-10')
  })

  it('日期范围覆盖两天时也只出现一次', () => {
    const cycles = run(rows)
    const hit = cyclesInPeriod(cycles, '2026-10-10', '2026-10-11')
    expect(hit).toHaveLength(1)
    expect(hit[0].endDate).toBe('2026-10-11')
  })

  it('按桩号筛选，无桩号的轮不会误命中', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+459~0+462'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, '0+459~0+462'),
      rec('t1', 's-survey', '2026-10-11T08:00', '2026-10-11T09:00'),
      rec('t2', 's-shot', '2026-10-11T10:00', '2026-10-11T12:00')
    ])
    expect(filterCyclesByChainage(cycles, '459-462')).toHaveLength(1)
    expect(filterCyclesByChainage(cycles, '')).toHaveLength(2)
  })

  it('汇总只统计结束日范围内的轮次', () => {
    const cycles = run(rows)
    const inRange = cyclesInPeriod(cycles, '2026-10-11', '2026-10-12')
    const exc = summarizeCycles(inRange, 'exc')
    expect(exc.count).toBe(2)
  })
})

describe('循环标签', () => {
  it('有工作面有桩号：工作面 · 桩号 · 类型', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+459~0+464'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, '0+459~0+464')
    ])
    expect(cycleLabel(cycles[0], { workfaceName: '1#支洞' })).toBe('1#支洞 · 459-464 · 支护')
  })

  it('没有桩号时回退到原有的分项短名标签', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00')
    ])
    expect(
      cycleLabel(cycles[0], { workfaceName: '1#支洞', itemName: '支护工程（导流洞1#施工支洞）', index: 2 })
    ).toBe('10-10 1#支洞支护#2')
  })

  it('有桩号但没有工作面时只给桩号与类型', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+459~0+464'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, '0+459~0+464')
    ])
    expect(cycleLabel(cycles[0], {})).toBe('459-464 · 支护')
  })
})

describe('综合视图（开挖 + 支护）', () => {
  const excRows = [
    rec('e1', 'm-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+459~0+464'),
    rec('e2', 'm-blast', '2026-10-10T16:00', '2026-10-10T18:00', '', ITEM, '0+459~0+464')
  ]
  const supRows = [
    rec('s1', 's-survey', '2026-10-10T20:00', '2026-10-10T21:00', '', ITEM, '0+459~0+464'),
    rec('s2', 's-shot', '2026-10-11T01:00', '2026-10-11T02:00', '', ITEM, '0+459~0+464')
  ]

  it('完整轮：开挖首道开工 → 支护末道完工', () => {
    const all = run([...excRows, ...supRows])
    const exc = all.filter((c) => c.family === 'exc')
    const sup = all.filter((c) => c.family === 'sup')
    const res = buildCombinedCycles(exc, sup)
    expect(res.rounds).toHaveLength(1)
    const round = res.rounds[0]
    expect(round.missing).toEqual([])
    expect(round.excHours).toBeCloseTo(10, 5)
    expect(round.supHours).toBeCloseTo(6, 5)
    expect(round.gapHours).toBeCloseTo(2, 5)
    // 10-10 08:00 → 10-11 02:00 = 18h
    expect(round.hours).toBeCloseTo(18, 5)
    expect(round.spansDays).toBe(true)
    expect(res.complete).toBe(1)
    expect(res.totalHours).toBeCloseTo(18, 5)
  })

  it('缺支护：不生成综合用时', () => {
    const all = run(excRows)
    const res = buildCombinedCycles(
      all.filter((c) => c.family === 'exc'),
      []
    )
    expect(res.rounds).toHaveLength(1)
    expect(res.rounds[0].missing).toEqual(['sup'])
    expect(res.rounds[0].hours).toBeNull()
    expect(res.missingSup).toBe(1)
    expect(res.totalHours).toBe(0)
    expect(res.avgHours).toBeNull()
  })

  it('缺开挖：孤立支护轮照实列出', () => {
    const all = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00')
    ])
    const res = buildCombinedCycles(
      [],
      all.filter((c) => c.family === 'sup')
    )
    expect(res.rounds).toHaveLength(1)
    expect(res.rounds[0].missing).toEqual(['exc'])
    expect(res.rounds[0].hours).toBeNull()
    expect(res.missingExc).toBe(1)
  })

  it('支护超出配对窗口时按缺开挖处理，不硬配', () => {
    const exc = run(excRows).filter((c) => c.family === 'exc')
    const late = run([
      rec('s9', 's-survey', '2026-10-20T08:00', '2026-10-20T09:00'),
      rec('s10', 's-shot', '2026-10-20T10:00', '2026-10-20T12:00')
    ]).filter((c) => c.family === 'sup')
    expect(COMBINE_WINDOW_HOURS).toBe(72)
    const res = buildCombinedCycles(exc, late)
    expect(res.rounds).toHaveLength(2)
    expect(res.missingSup).toBe(1)
    expect(res.missingExc).toBe(1)
  })

  it('按桩号筛整轮：支护没填桩号也不会被误判缺支护', () => {
    const all = run([
      ...excRows,
      // 支护轮故意不填桩号
      rec('s1', 's-survey', '2026-10-10T20:00', '2026-10-10T21:00'),
      rec('s2', 's-shot', '2026-10-11T01:00', '2026-10-11T02:00')
    ])
    const res = buildCombinedCycles(
      all.filter((c) => c.family === 'exc'),
      all.filter((c) => c.family === 'sup'),
      '459-464'
    )
    expect(res.rounds).toHaveLength(1)
    expect(res.rounds[0].missing).toEqual([])
    expect(res.rounds[0].hours).toBeCloseTo(18, 5)
  })

  it('桩号不命中的整轮被筛掉', () => {
    const all = run([...excRows, ...supRows])
    const res = buildCombinedCycles(
      all.filter((c) => c.family === 'exc'),
      all.filter((c) => c.family === 'sup'),
      '600-610'
    )
    expect(res.rounds).toHaveLength(0)
    expect(res.complete).toBe(0)
    expect(res.totalHours).toBe(0)
  })
})
