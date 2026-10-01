import type { HHMM, ISODate, Process, ProcessRecord, WbsNode } from '@/types'
import { GAP_REASONS, GAP_TOLERANCE_MINUTES } from '@/core/reasons'
import {
  addDays,
  addMonths,
  endOfMonth,
  hhmmToMinutes,
  listDates,
  monthKey,
  parseDate,
  startOfWeek
} from '@/core/time'

/**
 * 两条记录间隔超过该小时数就不再视为"衔接"。
 * 依据本标段三份循环作业实测：正常衔接中位 0.5~0.7h，6h 以内覆盖了等炸药(4.5h)、
 * 等喷浆料(4.3h)等真实等待，再长基本是夜班停工或跨循环，不应算作衔接问题。
 */
export const GAP_MAX_HOURS = 6

export interface TimeFields {
  startAt: number
  endAt: number
  hours: number
}

/** 由 日期 + 开工时刻 + 完工时刻 推出时间戳与净用时；完工不晚于开工则视为跨零点 */
export function buildTimeFields(date: ISODate, start: HHMM, end: HHMM): TimeFields {
  const base = parseDate(date).getTime()
  const sm = hhmmToMinutes(start)
  let em = hhmmToMinutes(end)
  if (em <= sm) em += 1440
  const startAt = base + sm * 60000
  const endAt = base + em * 60000
  return { startAt, endAt, hours: (endAt - startAt) / 3600000 }
}

export function isActive<T extends { deletedAt?: number }>(row: T): boolean {
  return !row.deletedAt
}

/** 每条记录参与效率计算时用的基准：标准用时优先，没填就用实测参考用时 */
export function baselineHoursOf(process?: Process): number | null {
  if (!process) return null
  if (process.standardHours && process.standardHours > 0) return process.standardHours
  if (process.refHours && process.refHours > 0) return process.refHours
  return null
}

/** 该工序用的是标准基准还是参考基准 */
export function baselineKindOf(process?: Process): 'standard' | 'reference' | null {
  if (!process) return null
  if (process.standardHours && process.standardHours > 0) return 'standard'
  if (process.refHours && process.refHours > 0) return 'reference'
  return null
}

export function activeRecords(records: ProcessRecord[]): ProcessRecord[] {
  return records.filter(isActive)
}

export function filterByRange(records: ProcessRecord[], from: ISODate, to: ISODate): ProcessRecord[] {
  return records.filter((r) => isActive(r) && r.date >= from && r.date <= to)
}

/** 兼容历史数据：缺少 startAt/endAt/hours 时按起止时刻补算 */
export function ensureTimes(r: ProcessRecord): ProcessRecord {
  if (r.startAt && r.endAt && Number.isFinite(r.hours)) return r
  const t = buildTimeFields(r.date, r.startTime, r.endTime)
  return { ...r, ...t }
}

export interface GapRow {
  recordId: string
  prevRecordId: string
  date: ISODate
  processId: string
  processName: string
  prevProcessName: string
  itemId: string
  location: string
  gapHours: number
  reason: string
}

export interface GapKey {
  itemId: string
  location: string
}

/** 衔接空隙的分组依据：分项工程（本标段里一个分项工程就是一个工作面） */
export function gapGroupKey(itemId: string): string {
  return itemId
}

/**
 * 衔接空隙：同一个分项工程（本标段里就是一个工作面）内按开工时间排序后，
 * 后一条开工时刻 − 前一条完工时刻；重叠记 0，超过 GAP_MAX_HOURS 视为停工不计入。
 * 部位 / 桩号只用于显示，不参与分组——同一桩号在不同循环重复出现时不会产生假空隙。
 */
export function computeGapRows(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  opts: { minGapMinutes?: number } = {}
): GapRow[] {
  const minGapHours = (opts.minGapMinutes ?? 0) / 60
  const groups = new Map<string, ProcessRecord[]>()
  activeRecords(records).forEach((r) => {
    const p = processById.get(r.processId)
    if (!p) return
    const key = gapGroupKey(p.itemId)
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  })

  const rows: GapRow[] = []
  groups.forEach((list) => {
    list.sort((a, b) => a.startAt - b.startAt)
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1]
      const cur = list[i]
      const raw = (cur.startAt - prev.endAt) / 3600000
      if (raw > GAP_MAX_HOURS) continue
      const gapHours = Math.max(0, raw)
      if (gapHours < minGapHours) continue
      const p = processById.get(cur.processId)
      const prevP = processById.get(prev.processId)
      rows.push({
        recordId: cur.id,
        prevRecordId: prev.id,
        date: cur.date,
        processId: cur.processId,
        processName: p?.name ?? '未知工序',
        prevProcessName: prevP?.name ?? '未知工序',
        itemId: p?.itemId ?? '',
        location: cur.location ?? '',
        gapHours,
        reason: cur.gapReason ?? ''
      })
    }
  })
  return rows
}

export interface PeriodStats {
  from: ISODate
  to: ISODate
  recordCount: number
  actualHours: number
  /** 只统计填了标准用时的记录 */
  standardHours: number
  standardCovered: number
  /** 参与效率计算的基准工时合计（标准优先，缺失时用参考用时） */
  baselineHours: number
  baselineCovered: number
  /** 基准来源：standard=全部用标准 / reference=全部用参考 / mixed=两者混合 / none=都没有 */
  baselineSource: 'standard' | 'reference' | 'mixed' | 'none'
  gapHours: number
  gapCount: number
  /** 总量口径：Σ标准 ÷ Σ实际 − 1 */
  totalEfficiency: number | null
  /** 工序平均口径：各工序 (标准 − 实际) ÷ 标准的算术平均 */
  avgDeviation: number | null
  quantity: number
  activeDays: number
}

export function computeStats(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  from: ISODate,
  to: ISODate
): PeriodStats {
  const rows = filterByRange(records, from, to)
  let actualHours = 0
  let standardHours = 0
  let standardCovered = 0
  let baselineHours = 0
  let baselineCovered = 0
  let referenceOnly = 0
  let quantity = 0
  const deviations: number[] = []
  const days = new Set<string>()

  rows.forEach((r) => {
    const hours = Number.isFinite(r.hours) ? r.hours : 0
    actualHours += hours
    quantity += Number(r.quantity) || 0
    days.add(r.date)
    const process = processById.get(r.processId)
    const std = process?.standardHours
    if (std && std > 0) {
      standardHours += std
      standardCovered += 1
    }
    const base = baselineHoursOf(process)
    if (base && base > 0) {
      baselineHours += base
      baselineCovered += 1
      deviations.push((base - hours) / base)
      if (!(std && std > 0)) referenceOnly += 1
    }
  })

  const gaps = computeGapRows(rows, processById)
  const gapHours = gaps.reduce((s, g) => s + g.gapHours, 0)

  const baselineSource: PeriodStats['baselineSource'] =
    baselineCovered === 0
      ? 'none'
      : referenceOnly === 0
        ? 'standard'
        : referenceOnly === baselineCovered
          ? 'reference'
          : 'mixed'

  return {
    from,
    to,
    recordCount: rows.length,
    actualHours,
    standardHours,
    standardCovered,
    baselineHours,
    baselineCovered,
    baselineSource,
    gapHours,
    gapCount: gaps.length,
    totalEfficiency: baselineHours > 0 && actualHours > 0 ? baselineHours / actualHours - 1 : null,
    avgDeviation: deviations.length
      ? deviations.reduce((s, v) => s + v, 0) / deviations.length
      : null,
    quantity,
    activeDays: days.size
  }
}

export interface ProcessAgg {
  processId: string
  processName: string
  itemId: string
  itemName: string
  unitName: string
  count: number
  actualHours: number
  standardHours: number | null
  standardTotal: number | null
  /** 实测参考用时（模板预置），标准用时未填时用于对比展示 */
  refHours: number | null
  refTotal: number | null
  /** 参与对比的基准（标准优先，缺失时用参考） */
  baselineHours: number | null
  baselineTotal: number | null
  baselineKind: 'standard' | 'reference' | null
  deviation: number | null
  quantity: number
  designQty: number | null
}

export function aggregateByProcess(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>
): ProcessAgg[] {
  const map = new Map<string, ProcessAgg>()
  activeRecords(records).forEach((r) => {
    const p = processById.get(r.processId)
    if (!p) return
    const item = wbsById.get(p.itemId)
    const div = item?.parentId ? wbsById.get(item.parentId) : undefined
    const unit = div?.parentId ? wbsById.get(div.parentId) : undefined
    const cur =
      map.get(p.id) ??
      ({
        processId: p.id,
        processName: p.name,
        itemId: p.itemId,
        itemName: item?.name ?? '未归类',
        unitName: unit?.name ?? '',
        count: 0,
        actualHours: 0,
        standardHours: p.standardHours ?? null,
        standardTotal: null,
        refHours: p.refHours ?? null,
        refTotal: null,
        baselineHours: baselineHoursOf(p),
        baselineTotal: null,
        baselineKind: baselineKindOf(p),
        deviation: null,
        quantity: 0,
        designQty: p.designQty ?? null
      } satisfies ProcessAgg)
    cur.count += 1
    cur.actualHours += Number.isFinite(r.hours) ? r.hours : 0
    cur.quantity += Number(r.quantity) || 0
    map.set(p.id, cur)
  })
  const out = Array.from(map.values())
  out.forEach((row) => {
    if (row.standardHours && row.standardHours > 0) {
      row.standardTotal = row.standardHours * row.count
    }
    if (row.refHours && row.refHours > 0) {
      row.refTotal = row.refHours * row.count
    }
    if (row.baselineHours && row.baselineHours > 0) {
      row.baselineTotal = row.baselineHours * row.count
      row.deviation = (row.baselineTotal - row.actualHours) / row.baselineTotal
    }
  })
  return out.sort((a, b) => b.actualHours - a.actualHours)
}

export interface ReasonAgg {
  key: string
  label: string
  color: string
  hours: number
  count: number
}

/** 间隙原因分布：只统计超过容忍值的衔接空隙 */
export function aggregateByReason(gaps: GapRow[], minGapMinutes = GAP_TOLERANCE_MINUTES): ReasonAgg[] {
  const minHours = minGapMinutes / 60
  const map = new Map<string, ReasonAgg>()
  gaps.forEach((g) => {
    if (g.gapHours < minHours) return
    const key = g.reason || 'unknown'
    const meta = GAP_REASONS.find((r) => r.key === key)
    const cur =
      map.get(key) ??
      ({ key, label: meta?.label ?? '未填写原因', color: meta?.color ?? '#9ca3af', hours: 0, count: 0 } satisfies ReasonAgg)
    cur.hours += g.gapHours
    cur.count += 1
    map.set(key, cur)
  })
  return Array.from(map.values()).sort((a, b) => b.hours - a.hours)
}

export interface GapAgg {
  recordId: string
  processName: string
  prevProcessName: string
  itemId: string
  date: ISODate
  gapHours: number
  reason: string
  location: string
}

export function topGaps(gaps: GapRow[], limit = 10): GapAgg[] {
  return gaps
    .filter((g) => g.gapHours >= GAP_TOLERANCE_MINUTES / 60)
    .sort((a, b) => b.gapHours - a.gapHours)
    .slice(0, limit)
    .map((g) => ({
      recordId: g.recordId,
      processName: g.processName,
      prevProcessName: g.prevProcessName,
      itemId: g.itemId,
      date: g.date,
      gapHours: g.gapHours,
      reason: g.reason,
      location: g.location
    }))
}

/** 每个日期的实际工时（日历热力图用） */
export function hoursByDate(records: ProcessRecord[]): Map<ISODate, number> {
  const map = new Map<ISODate, number>()
  activeRecords(records).forEach((r) => {
    map.set(r.date, (map.get(r.date) ?? 0) + (Number.isFinite(r.hours) ? r.hours : 0))
  })
  return map
}

export interface TrendPoint {
  key: string
  label: string
  from: ISODate
  to: ISODate
  actualHours: number
  standardHours: number
  totalEfficiency: number | null
  avgDeviation: number | null
  gapHours: number
}

export interface PeriodRange {
  from: ISODate
  to: ISODate
  key: string
  label: string
}

/** 周 / 月趋势：给出连续若干个周期的统计，用于周对比、月对比 */
export function buildTrend(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  periods: PeriodRange[]
): TrendPoint[] {
  return periods.map((p) => {
    const s = computeStats(records, processById, p.from, p.to)
    return {
      key: p.key,
      label: p.label,
      from: p.from,
      to: p.to,
      actualHours: s.actualHours,
      standardHours: s.standardHours,
      totalEfficiency: s.totalEfficiency,
      avgDeviation: s.avgDeviation,
      gapHours: s.gapHours
    }
  })
}

export interface ItemProgress {
  itemId: string
  itemName: string
  unitName: string
  designQty: number
  doneQty: number
  percent: number
  actualHours: number
}

/** 分项工程完成工程量与完成百分比 */
export function completionByItem(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>
): ItemProgress[] {
  const map = new Map<string, ItemProgress>()
  activeRecords(records).forEach((r) => {
    const p = processById.get(r.processId)
    if (!p) return
    const item = wbsById.get(p.itemId)
    const div = item?.parentId ? wbsById.get(item.parentId) : undefined
    const unit = div?.parentId ? wbsById.get(div.parentId) : undefined
    const cur =
      map.get(p.itemId) ??
      ({
        itemId: p.itemId,
        itemName: item?.name ?? '未归类',
        unitName: unit?.name ?? '',
        designQty: item?.designQty ?? 0,
        doneQty: 0,
        percent: 0,
        actualHours: 0
      } satisfies ItemProgress)
    cur.doneQty += Number(r.quantity) || 0
    cur.actualHours += Number.isFinite(r.hours) ? r.hours : 0
    map.set(p.itemId, cur)
  })
  const out = Array.from(map.values())
  out.forEach((row) => {
    row.percent = row.designQty > 0 ? row.doneQty / row.designQty : 0
  })
  return out.sort((a, b) => b.actualHours - a.actualHours)
}

/** 参考用时下限 / 上限（小时）：与本标段日志解析口径保持一致，异常值不参与统计 */
export const REF_MIN_HOURS = 0.08
export const REF_MAX_HOURS = 12

/** 标准用时建议值：该工序历史实际用时的平均值（剔除异常时长的记录与最长的 10%） */
export function suggestStandardHours(
  processId: string,
  records: ProcessRecord[]
): { value: number | null; sample: number; used: number } {
  const list = activeRecords(records)
    .filter(
      (r) =>
        r.processId === processId &&
        Number.isFinite(r.hours) &&
        r.hours >= REF_MIN_HOURS &&
        r.hours <= REF_MAX_HOURS
    )
    .map((r) => r.hours)
    .sort((a, b) => a - b)
  if (list.length === 0) return { value: null, sample: 0, used: 0 }
  const trimmed = list.length >= 5 ? list.slice(0, Math.max(1, Math.ceil(list.length * 0.9))) : list
  const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length
  return { value: Math.round(avg * 100) / 100, sample: list.length, used: trimmed.length }
}

/** 某天的工序记录（首页用） */
export function recordsOfDate(records: ProcessRecord[], date: ISODate): ProcessRecord[] {
  return activeRecords(records)
    .filter((r) => r.date === date)
    .sort((a, b) => a.startAt - b.startAt)
}

export function datesWithRecords(records: ProcessRecord[]): Set<ISODate> {
  return new Set(activeRecords(records).map((r) => r.date))
}

export function monthsWithRecords(records: ProcessRecord[]): string[] {
  return Array.from(new Set(activeRecords(records).map((r) => monthKey(r.date)))).sort()
}

/** 生成连续周期列表（周 / 月） */
export function weekPeriods(endDate: ISODate, count: number): PeriodRange[] {
  const out: PeriodRange[] = []
  const base = startOfWeek(endDate)
  for (let i = count - 1; i >= 0; i -= 1) {
    const from = addDays(base, -7 * i)
    const to = addDays(from, 6)
    out.push({ from, to, key: from, label: `${from.slice(5)}~${to.slice(5)}` })
  }
  return out
}

export function monthPeriods(endMonth: string, count: number): PeriodRange[] {
  const out: PeriodRange[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const m = addMonths(endMonth, -i)
    const from = `${m}-01`
    const to = endOfMonth(from)
    out.push({ from, to, key: m, label: m.slice(2) })
  }
  return out
}

/** 一段日期内的全部日期，供日历图使用 */
export function daysOfPeriod(from: ISODate, to: ISODate): ISODate[] {
  return listDates(from, to)
}
