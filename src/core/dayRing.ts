/**
 * 24 小时圆盘：把"这一天每个时间段在干什么"摊在一个整圈上（整圈 24h、半圈 12h）。
 *
 * - 一条记录 = 圆环上的一段扇弧；跨零点（22:00→次日 02:00）顺时针越过 0 点继续画。
 * - 同时施工的记录用**同心环带分层**（贪心分层），超过上限就并到最外层并给出提示数。
 * - 只按"开工日"归属：次日不会再画一遍。
 *
 * 纯函数，不碰 DOM：几何与配色都在这里算，组件只负责画。
 */
import { isActive } from '@/core/compute'
import { shortItemLabel, shortSpot } from '@/core/scope'
import { recordChainage, shortChainageText } from '@/core/chainage'
import { hhmmToMinutes } from '@/core/time'
import type { ISODate, Process, ProcessRecord, WbsNode } from '@/types'

/** 一天的总分钟数：整圈 */
export const DAY_MINUTES = 1440
/** 最多画几层环带，多出来的并行记录并到最外层 */
export const RING_MAX_LANES = 8
/** 环带配色（按出现顺序分配，超出后循环使用） */
export const RING_PALETTE = [
  '#2b7fff',
  '#f59e0b',
  '#12805c',
  '#8b5cf6',
  '#0ea5e9',
  '#ef4444',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
  '#ec4899',
  '#64748b'
]

export interface RingSegment {
  recordId: string
  processId: string
  itemId: string
  /** 工序名 */
  name: string
  /** 分项工程全名 */
  itemName: string
  /** 工作面短名，如 "1#支洞" */
  itemShort: string
  /** 简洁桩号，如 "545-548"；历史无桩号时为空 */
  chainage: string
  /** 着色维度对应的名字（按工作面着色=分项短名，按工序着色=工序名） */
  colorKey: string
  color: string
  /** 起点分钟 0~1439 */
  startMin: number
  /** 终点分钟，跨零点会 > 1440 */
  endMin: number
  hours: number
  lane: number
  /** 因层数超限被并进最外层 */
  overflow: boolean
  crossMidnight: boolean
  /** 如 "22:00–次日 02:00" */
  timeLabel: string
}

export interface RingLegendRow {
  label: string
  color: string
  hours: number
  count: number
}

export interface DayRingStats {
  count: number
  /** 记录工时合计（并行、跨零点各算各的） */
  hours: number
  /** 当天被覆盖的实际时间跨度（去重，最多 24h） */
  coveredHours: number
  lanes: number
  /** 被并到最外层的记录条数 */
  overflow: number
}

export interface DayRingData {
  date: ISODate
  segments: RingSegment[]
  legend: RingLegendRow[]
  stats: DayRingStats
}

export interface DayRingInput {
  date: ISODate
  /** 当前分析范围内该天的记录 */
  records: ProcessRecord[]
  processById: Map<string, Process>
  wbsById: Map<string, WbsNode>
  /** true = 按工序着色（选定分项工程时）；false = 按分项工程/工作面着色 */
  byProcess: boolean
}

function endMinuteOf(startMin: number, endTime: string): number {
  const end = hhmmToMinutes(endTime)
  return end <= startMin ? end + DAY_MINUTES : end
}

/** 当天被记录覆盖的总时长（区间合并去重，按 0~1440 截断） */
export function coveredMinutes(spans: Array<[number, number]>): number {
  const list = spans
    .map(([a, b]) => [Math.max(0, a), Math.min(DAY_MINUTES, b)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let total = 0
  let start = -1
  let end = -1
  list.forEach(([a, b]) => {
    if (start < 0) {
      start = a
      end = b
      return
    }
    if (a <= end) {
      end = Math.max(end, b)
      return
    }
    total += end - start
    start = a
    end = b
  })
  if (start >= 0) total += end - start
  return total
}

export function buildDayRing(input: DayRingInput): DayRingData {
  const rows = input.records.filter((r) => isActive(r) && r.date === input.date)

  const segments: RingSegment[] = []
  rows.forEach((r) => {
    const p = input.processById.get(r.processId)
    if (!p) return
    const item = input.wbsById.get(p.itemId)
    const itemName = item?.name ?? '未归类'
    const startMin = hhmmToMinutes(r.startTime)
    const endMin = endMinuteOf(startMin, r.endTime)
    const crossMidnight = endMin > DAY_MINUTES
    segments.push({
      recordId: r.id,
      processId: p.id,
      itemId: p.itemId,
      name: p.name,
      itemName,
      itemShort: shortSpot(itemName),
      chainage: shortChainageText(recordChainage(r)),
      colorKey: input.byProcess ? p.name : shortItemLabel(itemName),
      color: RING_PALETTE[0],
      startMin,
      endMin,
      hours: Number.isFinite(r.hours) ? r.hours : 0,
      lane: 0,
      overflow: false,
      crossMidnight,
      timeLabel: crossMidnight ? `${r.startTime}–次日 ${r.endTime}` : `${r.startTime}–${r.endTime}`
    })
  })
  segments.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

  // 贪心分层：每层记录该层最后一条的结束分钟，能接上就复用同一层
  const laneEnds: number[] = []
  segments.forEach((seg) => {
    const reusable = laneEnds.findIndex((end) => end <= seg.startMin)
    if (reusable < 0) {
      laneEnds.push(seg.endMin)
      seg.lane = laneEnds.length - 1
    } else {
      laneEnds[reusable] = seg.endMin
      seg.lane = reusable
    }
  })

  let overflow = 0
  if (laneEnds.length > RING_MAX_LANES) {
    segments.forEach((seg) => {
      if (seg.lane >= RING_MAX_LANES) {
        seg.lane = RING_MAX_LANES - 1
        seg.overflow = true
        overflow += 1
      }
    })
  }

  // 配色：同一个名字用同一种颜色，按第一次出现分配
  const colorOf = new Map<string, string>()
  segments.forEach((seg) => {
    if (!colorOf.has(seg.colorKey)) colorOf.set(seg.colorKey, RING_PALETTE[colorOf.size % RING_PALETTE.length])
    seg.color = colorOf.get(seg.colorKey)!
  })

  const legendMap = new Map<string, RingLegendRow>()
  segments.forEach((seg) => {
    const row = legendMap.get(seg.colorKey) ?? { label: seg.colorKey, color: seg.color, hours: 0, count: 0 }
    row.hours += seg.hours
    row.count += 1
    legendMap.set(seg.colorKey, row)
  })

  const hours = segments.reduce((s, seg) => s + seg.hours, 0)
  return {
    date: input.date,
    segments,
    legend: Array.from(legendMap.values()),
    stats: {
      count: segments.length,
      hours,
      coveredHours: coveredMinutes(segments.map((s) => [s.startMin, s.endMin])) / 60,
      lanes: Math.max(1, Math.min(laneEnds.length, RING_MAX_LANES)),
      overflow
    }
  }
}

/** 扇弧路径（环形扇区）；sweep 为分钟跨度 */
export function ringArcPath(input: {
  size: number
  rInner: number
  rOuter: number
  startMin: number
  endMin: number
}): string {
  const c = input.size / 2
  const sweepDeg = Math.min(((input.endMin - input.startMin) / DAY_MINUTES) * 360, 359.9)
  if (sweepDeg <= 0.05) return ''
  const from = (input.startMin / DAY_MINUTES) * 360
  const to = from + sweepDeg
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180
  const pt = (r: number, deg: number) => `${(c + r * Math.cos(rad(deg))).toFixed(2)} ${(c + r * Math.sin(rad(deg))).toFixed(2)}`
  const large = sweepDeg > 180 ? 1 : 0
  return [
    `M ${pt(input.rOuter, from)}`,
    `A ${input.rOuter} ${input.rOuter} 0 ${large} 1 ${pt(input.rOuter, to)}`,
    `L ${pt(input.rInner, to)}`,
    `A ${input.rInner} ${input.rInner} 0 ${large} 0 ${pt(input.rInner, from)}`,
    'Z'
  ].join(' ')
}
