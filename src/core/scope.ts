/**
 * 分析范围：决定看板 / 明细页"在看哪一块工程"。
 * 全部 → 单位工程 → 分项工程（可再筛工序）。
 * 所有图表都先用它把记录过滤一遍，避免把并行施工的工作面混在一起算。
 */
import type { Process, ProcessRecord, WbsNode } from '@/types'
import { baselineHoursOf, isActive } from '@/core/compute'

export type ScopeLevel = 'all' | 'unit' | 'item'

export interface AnalysisScope {
  level: ScopeLevel
  /** level = 'unit' 时的单位工程 id */
  unitId?: string
  /** level = 'item' 时的分项工程 id */
  itemId?: string
  /** 选定分项工程后可再筛具体工序，留空表示全部工序 */
  processId?: string
}

export const ALL_SCOPE: AnalysisScope = { level: 'all' }

/** 某个分项工程属于哪个单位工程（分项 → 分部 → 单位） */
export function unitIdOfItem(itemId: string, wbsById: Map<string, WbsNode>): string {
  const item = wbsById.get(itemId)
  const div = item?.parentId ? wbsById.get(item.parentId) : undefined
  return div?.parentId ?? ''
}

export function filterByScope(
  records: ProcessRecord[],
  scope: AnalysisScope,
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>
): ProcessRecord[] {
  const rows = records.filter(isActive)
  if (scope.level === 'all') return rows
  if (scope.level === 'unit') {
    if (!scope.unitId) return rows
    return rows.filter((r) => {
      const p = processById.get(r.processId)
      if (!p) return false
      return unitIdOfItem(p.itemId, wbsById) === scope.unitId
    })
  }
  if (!scope.itemId) return rows
  return rows.filter((r) => {
    const p = processById.get(r.processId)
    if (!p) return false
    if (p.itemId !== scope.itemId) return false
    if (scope.processId && p.id !== scope.processId) return false
    return true
  })
}

/** 范围内的工序 id 集合；null 表示不限制 */
export function scopedProcessIds(
  scope: AnalysisScope,
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>
): Set<string> | null {
  if (scope.level === 'all') return null
  const out = new Set<string>()
  processById.forEach((p) => {
    if (scope.level === 'unit') {
      if (scope.unitId && unitIdOfItem(p.itemId, wbsById) === scope.unitId) out.add(p.id)
    } else if (scope.itemId && p.itemId === scope.itemId) {
      if (!scope.processId || p.id === scope.processId) out.add(p.id)
    }
  })
  return out
}

export function scopeLabel(
  scope: AnalysisScope,
  wbsById: Map<string, WbsNode>,
  processById?: Map<string, Process>
): string {
  if (scope.level === 'all') return '全部工程'
  if (scope.level === 'unit') return wbsById.get(scope.unitId ?? '')?.name ?? '未知单位工程'
  const item = wbsById.get(scope.itemId ?? '')?.name ?? '未知分项工程'
  if (scope.processId) {
    const proc = processById?.get(scope.processId)
    return proc ? `${item} · ${proc.name}` : item
  }
  return item
}

/** 把"土石方洞挖（导流洞1#施工支洞）"压成"1#支洞开挖"，用于图例 / 饼图 */
export function shortSpot(itemName: string): string {
  const m = /（(.+?)）/.exec(itemName)
  const spot = m ? m[1] : itemName
  return spot
    .replace('通风兼安全洞主洞', '通风洞')
    .replace('主变通风兼安全洞', '主变通风洞')
    .replace('尾闸通风兼安全洞', '尾闸通风洞')
    .replace('导流洞1#施工支洞', '1#支洞')
    .replace('导流洞2#施工支洞', '2#支洞')
    .replace('导流洞闸室交通洞', '闸室交通洞')
    .replace('导流洞主洞', '导流洞洞身')
    .replace('进厂交通洞主洞', '进厂交通洞')
    .replace('临时生态放水洞', '放水洞')
}

export function shortKind(itemName: string): string {
  const base = itemName.replace(/（.*?）/, '')
  if (base.includes('洞挖') || base.includes('土石方开挖')) return '开挖'
  if (base.includes('支护')) return '支护'
  if (base.includes('衬砌')) return '衬砌'
  if (base.includes('灌浆')) return '灌浆'
  if (base.includes('路面') || base.includes('垫层')) return '路面'
  if (base.includes('开挖')) return '开挖'
  return base.slice(0, 4)
}

export function shortItemLabel(itemName: string): string {
  const spot = shortSpot(itemName)
  const kind = shortKind(itemName)
  if (!spot || spot === itemName) return itemName.slice(0, 8)
  return `${spot}${kind}`
}

export interface ItemAgg {
  itemId: string
  itemName: string
  shortName: string
  unitName: string
  count: number
  actualHours: number
  baselineHours: number
}

/** 按分项工程汇总工时（整体视图的堆叠柱与饼图用） */
export function aggregateByItem(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>
): ItemAgg[] {
  const map = new Map<string, ItemAgg>()
  records.filter(isActive).forEach((r) => {
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
        shortName: shortItemLabel(item?.name ?? '未归类'),
        unitName: unit?.name ?? '',
        count: 0,
        actualHours: 0,
        baselineHours: 0
      } satisfies ItemAgg)
    cur.count += 1
    cur.actualHours += Number.isFinite(r.hours) ? r.hours : 0
    cur.baselineHours += baselineHoursOf(p) ?? 0
    map.set(p.itemId, cur)
  })
  return Array.from(map.values()).sort((a, b) => b.actualHours - a.actualHours)
}

export interface StackedSeries {
  name: string
  data: number[]
}

export interface StackedTrend {
  labels: string[]
  series: StackedSeries[]
  totals: number[]
}

/**
 * 把若干周期的工时按"分项工程"或"工序"拆成堆叠序列（最多 maxGroups 个，其余并入"其他"）。
 */
export function stackedTrend(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>,
  periods: Array<{ from: string; to: string; label: string }>,
  groupBy: 'item' | 'process',
  maxGroups = 6
): StackedTrend {
  const labels = periods.map((p) => p.label)
  const groupNames = new Map<string, string>()
  const perPeriod = periods.map((period) => {
    const cell = new Map<string, number>()
    records
      .filter((r) => isActive(r) && r.date >= period.from && r.date <= period.to)
      .forEach((r) => {
        const p = processById.get(r.processId)
        if (!p) return
        const key = groupBy === 'item' ? p.itemId : p.id
        if (!groupNames.has(key)) {
          const item = wbsById.get(p.itemId)
          groupNames.set(key, groupBy === 'item' ? shortItemLabel(item?.name ?? '未归类') : p.name)
        }
        cell.set(key, (cell.get(key) ?? 0) + (Number.isFinite(r.hours) ? r.hours : 0))
      })
    return cell
  })

  const totals = new Map<string, number>()
  perPeriod.forEach((cell) => {
    cell.forEach((hours, key) => totals.set(key, (totals.get(key) ?? 0) + hours))
  })
  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(([key]) => key)
  const keep = ranked.slice(0, Math.max(1, maxGroups - (ranked.length > maxGroups ? 1 : 0)))
  const rest = ranked.slice(keep.length)

  const series: StackedSeries[] = keep.map((key) => ({
    name: groupNames.get(key) ?? key,
    data: perPeriod.map((cell) => Number((cell.get(key) ?? 0).toFixed(2)))
  }))
  if (rest.length) {
    series.push({
      name: `其他 ${rest.length} 项`,
      data: perPeriod.map((cell) => Number(rest.reduce((s, key) => s + (cell.get(key) ?? 0), 0).toFixed(2)))
    })
  }
  return {
    labels,
    series,
    totals: perPeriod.map((cell) => Number(Array.from(cell.values()).reduce((s, v) => s + v, 0).toFixed(2)))
  }
}
