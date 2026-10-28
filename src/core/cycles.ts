/**
 * 循环用时：一圈开挖 / 支护干了多久。
 *
 * 口径（2026-10-28 用户确认）：
 *   - 边界：本轮起点 → 下一轮起点（下一轮测量放样）；
 *   - 起点：以爆破（开挖）/ 喷护（支护）为锚点向前回溯，开挖 24h、支护 48h 内最近的测量放样；
 *           找不到就用窗口内最早一条同族记录；
 *   - 用时：轮内按时间合并同族记录，间隔 ≤6h 的算衔接、>6h 的视为轮次停工剔除；
 *   - 归属：按开始日期；跨天循环不在结束日重复统计。
 *
 * 纯函数，不读写数据库。
 */
import { isActive } from '@/core/compute'
import { fmtDate } from '@/core/time'
import type { ISODate, Process, ProcessRecord } from '@/types'

export type CycleFamily = 'exc' | 'sup'

export interface CycleFamilyConfig {
  label: string
  anchorKey: string
  startKey: string
  lookbackHours: number
  color: string
}

export const CYCLE_FAMILIES: Record<CycleFamily, CycleFamilyConfig> = {
  exc: { label: '开挖', anchorKey: 'm-blast', startKey: 'm-survey', lookbackHours: 24, color: '#2b7fff' },
  sup: { label: '支护', anchorKey: 's-shot', startKey: 's-survey', lookbackHours: 48, color: '#f59e0b' }
}

/** 轮内超过这个间隔视为停工，不计入循环用时（与衔接空隙的上限一致） */
export const CYCLE_IDLE_GAP_HOURS = 6
/** 补炮 / 处理欠挖不单独开一轮 */
const REWORK_PATTERN = /补炮|处理欠挖|欠挖/
/** 每族的收尾工序：上一轮真正结束的位置，避免把上一轮的出渣算到下一轮起点 */
const TERMINAL_KEYS: Record<CycleFamily, string[]> = {
  exc: ['m-muck', 'm-scale'],
  sup: ['s-clean']
}

const HOUR = 3600000

export interface Cycle {
  /** 稳定 key：family + item + 起点时间戳 */
  id: string
  family: CycleFamily
  itemId: string
  startAt: number
  /** 下一轮起点（最后一轮为数据末） */
  boundaryEndAt: number
  /** 本轮最后一条有效记录的完工时间 */
  lastActiveEndAt: number
  /** 剔除 >6h 停工后的有效用时 */
  activeHours: number
  /** 轮内停工合计（边界跨度 - 有效用时） */
  idleHours: number
  /** 本轮的记录条数 */
  steps: number
  startDate: ISODate
  /** 本轮有效作业是否跨自然日 */
  spansDays: boolean
  /** 最后一轮（还没有下一轮起点） */
  incomplete: boolean
}

export interface CycleSummary {
  count: number
  totalHours: number
  avgHours: number
  /** 跨自然日的轮数 */
  spanning: number
  /** 截至数据末、尚未闭合的轮数 */
  incomplete: number
}

export function processKeyOf(processId: string): string {
  return processId.split('--').pop() ?? ''
}

export function familyOfKey(key: string): CycleFamily | null {
  if (key.startsWith('m-')) return 'exc'
  if (key.startsWith('s-')) return 'sup'
  return null
}

/** 合并区间，间隔 ≤ maxGapMs 的连成一段 */
function mergedHours(spans: Array<[number, number]>, maxGapMs: number): number {
  if (!spans.length) return 0
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let curStart = sorted[0][0]
  let curEnd = sorted[0][1]
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i]
    if (s - curEnd <= maxGapMs) {
      curEnd = Math.max(curEnd, e)
    } else {
      total += curEnd - curStart
      curStart = s
      curEnd = e
    }
  }
  return (total + (curEnd - curStart)) / HOUR
}

/**
 * 从记录中识别循环。
 * records 应已按分析范围过滤；processById 用来取工序所属分项。
 */
export function buildCycles(records: ProcessRecord[], processById: Map<string, Process>): Cycle[] {
  const groups = new Map<string, ProcessRecord[]>()
  records.filter(isActive).forEach((r) => {
    const p = processById.get(r.processId)
    if (!p) return
    const list = groups.get(p.itemId) ?? []
    list.push(r)
    groups.set(p.itemId, list)
  })

  const cycles: Cycle[] = []
  groups.forEach((rows, itemId) => {
    const sorted = [...rows].sort((a, b) => a.startAt - b.startAt)
    ;(Object.keys(CYCLE_FAMILIES) as CycleFamily[]).forEach((family) => {
      const cfg = CYCLE_FAMILIES[family]
      const familyRows = sorted.filter((r) => familyOfKey(processKeyOf(r.processId)) === family)
      if (!familyRows.length) return
      const anchors = familyRows.filter(
        (r) => processKeyOf(r.processId) === cfg.anchorKey && !REWORK_PATTERN.test(r.note ?? '')
      )
      if (!anchors.length) return

      const starts: Array<{ startAt: number; anchor: ProcessRecord }> = []
      const anchorsSorted = [...anchors].sort((a, b) => a.startAt - b.startAt)
      anchorsSorted.forEach((anchor, ai) => {
        const prevAnchor = ai > 0 ? anchorsSorted[ai - 1] : undefined
        let lowerBound = prevAnchor ? prevAnchor.endAt : Number.NEGATIVE_INFINITY
        if (prevAnchor) {
          const terminal = familyRows.find(
            (r) => r.startAt >= prevAnchor.endAt && TERMINAL_KEYS[family].includes(processKeyOf(r.processId))
          )
          if (terminal) lowerBound = Math.max(lowerBound, terminal.endAt)
        }
        const window = familyRows.filter(
          (r) =>
            r.startAt > lowerBound &&
            r.startAt < anchor.startAt &&
            anchor.startAt - r.startAt <= cfg.lookbackHours * HOUR
        )
        const survey = [...window].reverse().find((r) => processKeyOf(r.processId) === cfg.startKey)
        const startAt = survey?.startAt ?? window[0]?.startAt ?? anchor.startAt
        starts.push({ startAt, anchor })
      })
      starts.sort((a, b) => a.startAt - b.startAt)
      const unique = starts.filter((s, i) => i === 0 || s.startAt > starts[i - 1].startAt)

      unique.forEach((cur, i) => {
        const next = unique[i + 1]
        const block = familyRows.filter(
          (r) => r.startAt >= cur.startAt && (next ? r.startAt < next.startAt : true)
        )
        if (!block.length) return
        const lastActiveEndAt = Math.max(...block.map((r) => r.endAt))
        const boundaryEndAt = next ? next.startAt : Math.max(lastActiveEndAt, cur.anchor.endAt)
        const activeHours = mergedHours(
          block.map((r) => [r.startAt, r.endAt] as [number, number]),
          CYCLE_IDLE_GAP_HOURS * HOUR
        )
        const spanHours = Math.max(0, (boundaryEndAt - cur.startAt) / HOUR)
        cycles.push({
          id: `${family}-${itemId}-${cur.startAt}`,
          family,
          itemId,
          startAt: cur.startAt,
          boundaryEndAt,
          lastActiveEndAt,
          activeHours: Math.round(activeHours * 1000) / 1000,
          idleHours: Math.max(0, Math.round((spanHours - activeHours) * 1000) / 1000),
          steps: block.length,
          startDate: fmtDate(new Date(cur.startAt)),
          spansDays: fmtDate(new Date(cur.startAt)) !== fmtDate(new Date(lastActiveEndAt)),
          incomplete: !next
        })
      })
    })
  })
  return cycles.sort((a, b) => a.startAt - b.startAt)
}

/** 只取开始日期在 [from, to] 内的循环 */
export function cyclesInPeriod(cycles: Cycle[], from: ISODate, to: ISODate): Cycle[] {
  return cycles.filter((c) => c.startDate >= from && c.startDate <= to)
}

export function summarizeCycles(cycles: Cycle[], family?: CycleFamily): CycleSummary {
  const rows = family ? cycles.filter((c) => c.family === family) : cycles
  const totalHours = rows.reduce((s, c) => s + c.activeHours, 0)
  return {
    count: rows.length,
    totalHours,
    avgHours: rows.length ? totalHours / rows.length : 0,
    spanning: rows.filter((c) => c.spansDays).length,
    incomplete: rows.filter((c) => c.incomplete).length
  }
}
