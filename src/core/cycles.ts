/**
 * 循环用时：一圈开挖 / 支护干了多久。
 *
 * 口径（2026-10-29 用户确认，替代原「剔除 >6h 停工」口径）：
 *   - 识别单位：工作面（同一洞室下的开挖 / 支护分项归到一起），没有工作面时退回分项工程；
 *   - 边界：本轮首道工序开工 → 下一轮首道工序开工；下一轮不存在时截至本轮末道工序完工；
 *   - 用时：**首道工序开工至末道工序完工**，跨天与中间停工间隔全部计入，不再剔除；
 *   - 归属：按**结束日**，跨天轮在结束日可见，日期范围内只出现一次；
 *   - 起点：以爆破（开挖）/ 喷护（支护）为锚点向前回溯，开挖 24h、支护 48h 内最近的测量放样；
 *           找不到就用窗口内最早一条同族记录。
 *
 * 纯函数，不读写数据库。
 */
import { isActive } from '@/core/compute'
import { chainageOverlaps, mergeChainages, recordChainage, shortChainageText } from '@/core/chainage'
import { shortItemLabel } from '@/core/scope'
import { addDays } from '@/core/time'
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

/** 补炮 / 处理欠挖不单独开一轮 */
const REWORK_PATTERN = /补炮|处理欠挖|欠挖/
/** 每族的收尾工序：上一轮真正结束的位置，避免把上一轮的出渣算到下一轮起点 */
const TERMINAL_KEYS: Record<CycleFamily, string[]> = {
  exc: ['m-muck', 'm-scale'],
  sup: ['s-clean']
}

const HOUR = 3600000

/** 循环识别上下文：分项 → 工作面 */
export interface CycleContext {
  processById: Map<string, Process>
  /** 分项工程 id → 工作面 id；缺省时按分项工程分组 */
  itemWorkface?: Map<string, string>
}

export interface Cycle {
  /** 稳定 key：family + 分组 + 起点时间戳 */
  id: string
  family: CycleFamily
  /** 工作面 id；没有工作面时为空串（分组退回分项工程） */
  workfaceId: string
  /** 主分项（锚点所在分项），用于回退标签 */
  itemId: string
  /** 本轮涉及的全部分项 */
  itemIds: string[]
  startAt: number
  /** 末道工序完工时间 */
  endAt: number
  startDate: ISODate
  /** 结束日：循环按这一天归属 */
  endDate: ISODate
  /** 首道工序开工 → 末道工序完工（含跨天与全部停工间隔） */
  hours: number
  steps: number
  /** 本轮作业是否跨自然日 */
  spansDays: boolean
  /** 最后一轮（还没有下一轮起点） */
  incomplete: boolean
  /** 本轮记录里出现的桩号（合并后的区间） */
  chainages: string[]
  /** 桩号区间总长度（米）；没有有效区间时为 null */
  chainageLengthM: number | null
  /** 每米用时（小时/米）；没有有效长度时为 null */
  hoursPerMeter: number | null
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

/** 记录的完工日：跨零点（endTime ≤ startTime）归到次日 */
function endDateOfRecord(record: ProcessRecord): ISODate {
  return record.endTime <= record.startTime ? addDays(record.date, 1) : record.date
}

/** 分组键：优先工作面，没有工作面时退回分项工程 */
function groupKeyOf(itemId: string, context: CycleContext): string {
  const wfId = context.itemWorkface?.get(itemId) ?? ''
  return wfId ? `wf:${wfId}` : `item:${itemId}`
}

/**
 * 从记录中识别循环。
 * records 应当已经按「单位工程 / 工作面」过滤，但**不要**先按桩号或日期过滤，
 * 否则桩号缺失会把一轮拆成两轮、日期边界会截断跨天循环。
 */
export function buildCycles(records: ProcessRecord[], context: CycleContext): Cycle[] {
  const groups = new Map<string, ProcessRecord[]>()
  records.filter(isActive).forEach((r) => {
    const p = context.processById.get(r.processId)
    if (!p) return
    const key = groupKeyOf(p.itemId, context)
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  })

  const cycles: Cycle[] = []
  groups.forEach((rows, groupKey) => {
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
        const lastRecord = block.reduce((a, b) => (b.endAt > a.endAt ? b : a))
        const startRecord = block.reduce((a, b) => (b.startAt < a.startAt ? b : a))
        const startAt = startRecord.startAt
        const endAt = lastRecord.endAt
        const hours = Math.max(0, (endAt - startAt) / HOUR)
        const startDate = startRecord.date
        const endDate = endDateOfRecord(lastRecord)
        const chain = mergeChainages(block.map(recordChainage))
        const chainageLengthM = chain.lengthM > 0 ? chain.lengthM : null
        const workfaceId = groupKey.startsWith('wf:') ? groupKey.slice(3) : ''
        const itemIds = Array.from(new Set(block.map((r) => context.processById.get(r.processId)?.itemId ?? '')))
          .filter(Boolean)
        cycles.push({
          id: `${family}-${groupKey}-${startAt}`,
          family,
          workfaceId,
          itemId: context.processById.get(cur.anchor.processId)?.itemId ?? itemIds[0] ?? '',
          itemIds,
          startAt,
          endAt,
          startDate,
          endDate,
          hours: Math.round(hours * 1000) / 1000,
          steps: block.length,
          spansDays: startDate !== endDate,
          incomplete: !next,
          chainages: chain.ranges,
          chainageLengthM,
          hoursPerMeter:
            chainageLengthM && chainageLengthM > 0 ? Math.round((hours / chainageLengthM) * 1000) / 1000 : null
        })
      })
    })
  })
  return cycles.sort((a, b) => a.startAt - b.startAt)
}

/** 取结束日落在 [from, to] 内的循环：跨天轮在结束日出现，且只出现一次 */
export function cyclesInPeriod(cycles: Cycle[], from: ISODate, to: ISODate): Cycle[] {
  return cycles.filter((c) => c.endDate >= from && c.endDate <= to)
}

/** 按桩号筛选循环：用整轮合并后的桩号判断交集 */
export function filterCyclesByChainage(cycles: Cycle[], chainage: string | null | undefined): Cycle[] {
  const target = String(chainage ?? '').trim()
  if (!target) return cycles
  return cycles.filter((c) => c.chainages.some((value) => chainageOverlaps(value, target)))
}

export function summarizeCycles(cycles: Cycle[], family?: CycleFamily): CycleSummary {
  const rows = family ? cycles.filter((c) => c.family === family) : cycles
  const totalHours = rows.reduce((s, c) => s + c.hours, 0)
  return {
    count: rows.length,
    totalHours,
    avgHours: rows.length ? totalHours / rows.length : 0,
    spanning: rows.filter((c) => c.spansDays).length,
    incomplete: rows.filter((c) => c.incomplete).length
  }
}

/** 图例里的短桩号：多段时只留第一段并标出段数，避免手机图表标签过长 */
export function cycleChainageLabel(c: Cycle): string {
  const rows = c.chainages.map(shortChainageText)
  if (!rows.length) return ''
  return rows.length === 1 ? rows[0] : `${rows[0]} 等${rows.length}段`
}

/** tooltip 里的桩号/工作量一行：无桩号时保持原有提示 */
export function cycleChainageText(c: Cycle): string {
  if (!c.chainages.length) return c.family === 'sup' ? '桩号未填（可到明细补填）' : ''
  const more = c.chainages.length > 3 ? ` 等 ${c.chainages.length} 段` : ''
  const len = c.chainageLengthM ? `（${c.chainageLengthM.toFixed(1)}m）` : ''
  const hpm = c.hoursPerMeter ? `· ${c.hoursPerMeter.toFixed(2)}h/m` : ''
  return `桩号 ${c.chainages.slice(0, 3).map(shortChainageText).join(' / ')}${more}${len}${hpm}`
}

/**
 * 循环标签：工作面 · 桩号 · 开挖/支护。
 * 历史数据缺桩号或缺工作面时，回退到原来的「日期 + 分项短名 #序号」。
 */
export function cycleLabel(
  c: Cycle,
  opts: { workfaceName?: string; itemName?: string; index?: number } = {}
): string {
  const family = CYCLE_FAMILIES[c.family].label
  const workface = String(opts.workfaceName ?? '').trim()
  const chain = cycleChainageLabel(c)
  if (workface && chain) return `${workface} · ${chain} · ${family}`
  if (chain) return `${chain} · ${family}`
  const item = String(opts.itemName ?? '').trim()
  const head = item ? shortItemLabel(item) : family
  return `${c.startDate.slice(5)} ${head}#${opts.index ?? 1}`
}

// --------------------------------------------------------------- 综合（开挖 + 支护）

/** 支护轮与开挖轮的配对窗口：超出这个跨度就不硬配 */
export const COMBINE_WINDOW_HOURS = 72

export interface CombinedCycle {
  id: string
  startAt: number
  /** 支护末道工序完工；缺支护时为开挖末道工序完工 */
  endAt: number
  startDate: ISODate
  endDate: ISODate
  /** 开挖段用时（开挖首道 → 开挖末道） */
  excHours: number | null
  /** 支护段用时（支护首道 → 支护末道） */
  supHours: number | null
  /** 开挖完工 → 支护开工的间隔 */
  gapHours: number | null
  /** 综合跨度：开挖首道开工 → 支护末道完工；缺任一环节时为 null（不造假数据） */
  hours: number | null
  /** 缺失的环节 */
  missing: CycleFamily[]
  spansDays: boolean
  exc: Cycle | null
  sup: Cycle | null
}

export interface CombinedResult {
  rounds: CombinedCycle[]
  complete: number
  missingExc: number
  missingSup: number
  /** 只累加完整轮，避免把缺环节的轮算成虚高总用时 */
  totalHours: number
  avgHours: number | null
}

/**
 * 综合视图：把同一工作面、同一桩号范围内的开挖轮与随后的支护轮配成一轮。
 * 只在选定单一工作面 + 桩号时使用；缺环节的轮照实列出，但不产生综合用时。
 *
 * 注意：配对必须在**未按桩号裁剪**的两族循环上做，否则支护轮没有桩号时会被误判成"缺支护"；
 *        桩号只用来筛掉整轮（开挖或支护任一段命中即可）。
 */
export function buildCombinedCycles(
  excCycles: Cycle[],
  supCycles: Cycle[],
  chainage?: string | null
): CombinedResult {
  const exc = [...excCycles].sort((a, b) => a.startAt - b.startAt)
  const sup = [...supCycles].sort((a, b) => a.startAt - b.startAt)
  const usedSup = new Set<string>()
  const rounds: CombinedCycle[] = []

  exc.forEach((round, i) => {
    const next = exc[i + 1]
    const windowEnd = Math.min(next ? next.startAt : Number.POSITIVE_INFINITY, round.startAt + COMBINE_WINDOW_HOURS * HOUR)
    const matched = sup.filter(
      (s) => !usedSup.has(s.id) && s.startAt >= round.startAt && s.startAt < windowEnd
    )
    matched.forEach((s) => usedSup.add(s.id))
    const firstSup = matched[0]
    const lastSup = matched[matched.length - 1]
    const supHours = matched.length ? matched.reduce((sum, s) => sum + s.hours, 0) : null
    const endAt = lastSup ? lastSup.endAt : round.endAt
    const endDate = lastSup ? lastSup.endDate : round.endDate
    rounds.push({
      id: `comb-${round.startAt}`,
      startAt: round.startAt,
      endAt,
      startDate: round.startDate,
      endDate,
      excHours: round.hours,
      supHours,
      gapHours: firstSup ? Math.max(0, Math.round(((firstSup.startAt - round.endAt) / HOUR) * 1000) / 1000) : null,
      hours: matched.length ? Math.round(((endAt - round.startAt) / HOUR) * 1000) / 1000 : null,
      missing: matched.length ? [] : ['sup'],
      spansDays: round.startDate !== endDate,
      exc: round,
      sup: lastSup ?? null
    })
  })

  // 没配上开挖的支护轮：照实列出「缺开挖」，不猜归属
  sup
    .filter((s) => !usedSup.has(s.id))
    .forEach((s) => {
      rounds.push({
        id: `comb-orphan-${s.startAt}`,
        startAt: s.startAt,
        endAt: s.endAt,
        startDate: s.startDate,
        endDate: s.endDate,
        excHours: null,
        supHours: s.hours,
        gapHours: null,
        hours: null,
        missing: ['exc'],
        spansDays: s.spansDays,
        exc: null,
        sup: s
      })
    })

  rounds.sort((a, b) => a.startAt - b.startAt)
  const target = String(chainage ?? '').trim()
  const visible = target
    ? rounds.filter((r) =>
        [r.exc, r.sup].some((c) => c && c.chainages.some((value) => chainageOverlaps(value, target)))
      )
    : rounds
  const complete = visible.filter((r) => r.hours !== null)
  const totalHours = complete.reduce((s, r) => s + (r.hours ?? 0), 0)
  return {
    rounds: visible,
    complete: complete.length,
    missingExc: visible.filter((r) => r.missing.includes('exc')).length,
    missingSup: visible.filter((r) => r.missing.includes('sup')).length,
    totalHours,
    avgHours: complete.length ? totalHours / complete.length : null
  }
}
