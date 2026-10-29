import { describe, expect, it } from 'vitest'
import {
  buildCycles,
  cycleChainageLabel,
  cycleChainageText,
  cyclesInPeriod,
  summarizeCycles,
  CYCLE_IDLE_GAP_HOURS
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
  const pid = `prc-p-${item}--${key}`
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

function run(records: ProcessRecord[]) {
  const map = new Map<string, Process>()
  records.forEach((r) => {
    const item = r.processId.split('--')[0].replace('prc-p-', 'wbs-p-')
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
  return buildCycles(records, map)
}

describe('循环识别', () => {
  it('开挖：测量放样到下一轮测量放样，轮内短衔接合并', () => {
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
    expect(first.boundaryEndAt).toBe(T('2026-10-11T08:00'))
    expect(first.activeHours).toBeCloseTo(10, 5)
    expect(first.steps).toBe(4)
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

  it('轮内超过 6 小时的停工不计入用时，但边界仍到下一轮起点', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T09:00', '2026-10-10T10:00'),
      rec('a2', 'm-drill', '2026-10-10T10:00', '2026-10-10T11:00'),
      rec('a3', 'm-blast', '2026-10-11T09:00', '2026-10-11T10:00'),
      rec('a4', 'm-survey', '2026-10-11T12:00', '2026-10-11T13:00'),
      rec('a5', 'm-blast', '2026-10-11T14:00', '2026-10-11T15:00')
    ])
    expect(cycles).toHaveLength(2)
    const first = cycles[0]
    // 09-10 + 10-11 + 次日 09-10 三段，中间 22h 停工剔除
    expect(first.activeHours).toBeCloseTo(3, 5)
    expect(first.idleHours).toBeGreaterThan(20)
    expect(first.boundaryEndAt).toBe(T('2026-10-11T12:00'))
    expect(CYCLE_IDLE_GAP_HOURS).toBe(6)
  })

  it('跨零点作业标记为跨天', () => {
    const cycles = run([
      rec('a1', 'm-survey', '2026-10-10T22:00', '2026-10-10T23:00'),
      rec('a2', 'm-drill', '2026-10-10T23:00', '2026-10-11T02:00'),
      rec('a3', 'm-blast', '2026-10-11T02:30', '2026-10-11T03:30'),
      rec('a4', 'm-muck', '2026-10-11T04:00', '2026-10-11T06:00')
    ])
    expect(cycles[0].spansDays).toBe(true)
    expect(cycles[0].startDate).toBe('2026-10-10')
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

  it('支护轮带上桩号、合并长度与每米用时', () => {
    const cycles = run([
      rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+459~0+462'),
      rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, 'K0+460~0+464')
    ])
    expect(cycles).toHaveLength(1)
    expect(cycles[0].family).toBe('sup')
    expect(cycles[0].chainages).toEqual(['0+459~0+464'])
    expect(cycles[0].chainageLengthM).toBeCloseTo(5, 3)
    // 08-09 + 10-12 之间 1h 属短衔接，合并成 08-12 共 4h，5m → 0.8h/m
    expect(cycles[0].hoursPerMeter).toBeCloseTo(0.8, 3)
    expect(cycles[0].chainages).toEqual(['0+459~0+464'])
    expect(cycleChainageLabel(cycles[0])).toBe('459-464')
    expect(cycleChainageText(cycles[0])).toBe('桩号 459-464（5.0m）· 0.80h/m')
  })

  it('新 chainage 字段优先于旧 location', () => {
    const cycles = run([
      { ...rec('s1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00', '', ITEM, '0+100~0+103'), chainage: '545-548' },
      { ...rec('s2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00', '', ITEM, '0+100~0+103'), chainage: '545-548' }
    ])
    expect(cycles[0].chainages).toEqual(['0+545~0+548'])
    expect(cycleChainageLabel(cycles[0])).toBe('545-548')
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

describe('循环汇总', () => {
  const rows = [
    rec('a1', 'm-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
    rec('a2', 'm-blast', '2026-10-10T10:00', '2026-10-10T11:00'),
    rec('b1', 'm-survey', '2026-10-11T08:00', '2026-10-11T09:00'),
    rec('b2', 'm-blast', '2026-10-11T10:00', '2026-10-11T11:00'),
    rec('c1', 's-survey', '2026-10-10T08:00', '2026-10-10T09:00'),
    rec('c2', 's-shot', '2026-10-10T10:00', '2026-10-10T12:00')
  ]

  it('按开始日期筛选并分族汇总', () => {
    const cycles = run(rows)
    expect(cyclesInPeriod(cycles, '2026-10-10', '2026-10-10')).toHaveLength(2)
    const exc = summarizeCycles(cycles, 'exc')
    const sup = summarizeCycles(cycles, 'sup')
    expect(exc.count).toBe(2)
    expect(exc.totalHours).toBeCloseTo(6, 5)
    expect(exc.avgHours).toBeCloseTo(3, 5)
    expect(sup.count).toBe(1)
    expect(sup.totalHours).toBeCloseTo(4, 5)
  })
})
