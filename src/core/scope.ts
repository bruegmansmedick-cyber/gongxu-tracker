/**
 * 分析范围：决定看板 / 明细页"在看哪一块工程"。
 * 全部 → 单位工程 → 工作面（+ 可选桩号）。
 *
 * 为什么不再按分项 / 工序筛：一个洞室里开挖、支护是同一个工作面的两道循环，
 * 分项工程只是项目划分的记账口径；看板上按工作面看才不会被拆成两半。
 * 工序级明细仍可在明细页搜索。
 *
 * 记录 → 工序 → 分项工程 → 工作面：记录不直接挂工作面，因此历史数据不需要改写。
 */
import type { Process, ProcessRecord, WbsNode, Workface } from '@/types'
import { baselineHoursOf, isActive } from '@/core/compute'
import { chainageOverlaps, mergeChainages, parseChainageRange, recordChainage, shortChainageText } from '@/core/chainage'
import { chainageKey, chainageOptionLabel, workfaceLabel } from '@/core/workface'

export type ScopeLevel = 'all' | 'unit' | 'workface'

export interface AnalysisScope {
  level: ScopeLevel
  /** level = 'unit' 时的单位工程 id */
  unitId?: string
  /** level = 'workface' 时的工作面 id */
  workfaceId?: string
  /** 按桩号区间筛选；留空表示全部桩号 */
  chainage?: string
}

export const ALL_SCOPE: AnalysisScope = { level: 'all' }

/**
 * 归一化本机保存的范围。旧版本可能存着 level='item' + itemId/processId，
 * 这两个入口已经取消，直接退回"全部工程"，避免打开看板时是一块空数据。
 */
export function normalizeScope(raw: unknown): AnalysisScope {
  if (!raw || typeof raw !== 'object') return { ...ALL_SCOPE }
  const obj = raw as Record<string, unknown>
  const chainage = typeof obj.chainage === 'string' && obj.chainage.trim() ? obj.chainage.trim() : undefined
  if (obj.level === 'unit' && typeof obj.unitId === 'string' && obj.unitId) {
    return { level: 'unit', unitId: obj.unitId, chainage }
  }
  if (obj.level === 'workface' && typeof obj.workfaceId === 'string' && obj.workfaceId) {
    return { level: 'workface', workfaceId: obj.workfaceId, chainage }
  }
  return { ...ALL_SCOPE }
}

/** 某个分项工程属于哪个单位工程（分项 → 分部 → 单位） */
export function unitIdOfItem(itemId: string, wbsById: Map<string, WbsNode>): string {
  const item = wbsById.get(itemId)
  const div = item?.parentId ? wbsById.get(item.parentId) : undefined
  return div?.parentId ?? ''
}

/** 某个分项工程属于哪个工作面：优先用绑定表，其次看节点上的 workfaceId */
export function workfaceIdOfItem(
  itemId: string,
  wbsById: Map<string, WbsNode>,
  itemWorkface?: Map<string, string>
): string {
  const fromMap = itemWorkface?.get(itemId)
  if (fromMap) return fromMap
  return wbsById.get(itemId)?.workfaceId ?? ''
}

export function filterByScope(
  records: ProcessRecord[],
  scope: AnalysisScope,
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>,
  itemWorkface?: Map<string, string>
): ProcessRecord[] {
  const rows = records.filter(isActive)
  let scoped = rows
  if (scope.level === 'unit' && scope.unitId) {
    scoped = rows.filter((r) => {
      const p = processById.get(r.processId)
      if (!p) return false
      return unitIdOfItem(p.itemId, wbsById) === scope.unitId
    })
  } else if (scope.level === 'workface' && scope.workfaceId) {
    scoped = rows.filter((r) => {
      const p = processById.get(r.processId)
      if (!p) return false
      return workfaceIdOfItem(p.itemId, wbsById, itemWorkface) === scope.workfaceId
    })
  }
  if (!scope.chainage) return scoped
  return scoped.filter((r) => chainageOverlaps(recordChainage(r), scope.chainage))
}

/** 范围内的分项工程 id 集合；null 表示不限制 */
export function scopedItemIds(
  scope: AnalysisScope,
  wbsById: Map<string, WbsNode>,
  itemWorkface?: Map<string, string>
): Set<string> | null {
  if (scope.level === 'all') return null
  const out = new Set<string>()
  wbsById.forEach((node) => {
    if (node.level !== 3 || node.deletedAt) return
    if (scope.level === 'unit') {
      if (scope.unitId && unitIdOfItem(node.id, wbsById) === scope.unitId) out.add(node.id)
    } else if (scope.workfaceId && workfaceIdOfItem(node.id, wbsById, itemWorkface) === scope.workfaceId) {
      out.add(node.id)
    }
  })
  return out
}

export function scopeLabel(
  scope: AnalysisScope,
  wbsById: Map<string, WbsNode>,
  workfaceById?: Map<string, Workface>
): string {
  let label = '全部工程'
  if (scope.level === 'unit') label = wbsById.get(scope.unitId ?? '')?.name ?? '未知单位工程'
  if (scope.level === 'workface') {
    label = workfaceById
      ? workfaceLabel(scope.workfaceId ?? '', workfaceById)
      : wbsById.get(scope.workfaceId ?? '')?.name ?? '未知工作面'
  }
  if (scope.chainage) label += ` · 桩号 ${shortChainageText(scope.chainage)}`
  return label
}

/** 把"土石方洞挖（导流洞1#施工支洞）"压成"1#支洞"，用于图例 / 饼图 */
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
  workfaceId: string
  workfaceName: string
  count: number
  actualHours: number
  baselineHours: number
  chainages: string[]
}

/** 按分项工程汇总工时 */
export function aggregateByItem(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>,
  itemWorkface?: Map<string, string>,
  workfaceById?: Map<string, Workface>
): ItemAgg[] {
  const map = new Map<string, ItemAgg>()
  const chainageValues = new Map<string, string[]>()
  records.filter(isActive).forEach((r) => {
    const p = processById.get(r.processId)
    if (!p) return
    const item = wbsById.get(p.itemId)
    const div = item?.parentId ? wbsById.get(item.parentId) : undefined
    const unit = div?.parentId ? wbsById.get(div.parentId) : undefined
    const wfId = workfaceIdOfItem(p.itemId, wbsById, itemWorkface)
    const cur =
      map.get(p.itemId) ??
      ({
        itemId: p.itemId,
        itemName: item?.name ?? '未归类',
        shortName: shortItemLabel(item?.name ?? '未归类'),
        unitName: unit?.name ?? '',
        workfaceId: wfId,
        workfaceName: workfaceById ? workfaceLabel(wfId, workfaceById) : '',
        count: 0,
        actualHours: 0,
        baselineHours: 0,
        chainages: []
      } satisfies ItemAgg)
    cur.count += 1
    cur.actualHours += Number.isFinite(r.hours) ? r.hours : 0
    cur.baselineHours += baselineHoursOf(p) ?? 0
    const chain = recordChainage(r)
    if (chain) {
      const values = chainageValues.get(p.itemId) ?? []
      values.push(chain)
      chainageValues.set(p.itemId, values)
    }
    map.set(p.itemId, cur)
  })
  const out = Array.from(map.values())
  out.forEach((row) => {
    row.chainages = mergeChainages(chainageValues.get(row.itemId) ?? []).ranges.map(shortChainageText)
  })
  return out.sort((a, b) => b.actualHours - a.actualHours)
}

export interface WorkfaceAgg {
  workfaceId: string
  workfaceName: string
  unitName: string
  count: number
  actualHours: number
  chainages: string[]
}

/** 按工作面汇总工时（看板主图 / 图例用） */
export function aggregateByWorkface(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>,
  itemWorkface: Map<string, string>,
  workfaceById: Map<string, Workface>
): WorkfaceAgg[] {
  const map = new Map<string, WorkfaceAgg>()
  const chainageValues = new Map<string, string[]>()
  records.filter(isActive).forEach((r) => {
    const p = processById.get(r.processId)
    if (!p) return
    const wfId = workfaceIdOfItem(p.itemId, wbsById, itemWorkface)
    const wf = workfaceById.get(wfId)
    const unit = wbsById.get(wf?.unitId ?? '')
    const cur =
      map.get(wfId) ??
      ({
        workfaceId: wfId,
        workfaceName: workfaceLabel(wfId, workfaceById),
        unitName: unit?.name ?? '',
        count: 0,
        actualHours: 0,
        chainages: []
      } satisfies WorkfaceAgg)
    cur.count += 1
    cur.actualHours += Number.isFinite(r.hours) ? r.hours : 0
    const chain = recordChainage(r)
    if (chain) {
      const values = chainageValues.get(wfId) ?? []
      values.push(chain)
      chainageValues.set(wfId, values)
    }
    map.set(wfId, cur)
  })
  const out = Array.from(map.values())
  out.forEach((row) => {
    row.chainages = mergeChainages(chainageValues.get(row.workfaceId) ?? []).ranges.map(shortChainageText)
  })
  return out.sort((a, b) => b.actualHours - a.actualHours)
}

export interface ChainageOption {
  /** workfaceId|规范化桩号 —— 桩号身份，不能只用短桩号去重 */
  key: string
  workfaceId: string
  workfaceName: string
  /** 规范化后的完整桩号，如 0+545~0+548 */
  text: string
  /** 手机端短桩号，如 545-548 */
  shortText: string
  /** 按钮文案，如「1#支洞 · 545-548」 */
  label: string
  startM: number
  count: number
}

/** 当前范围里出现过的桩号，按工作面 + 规范化桩号去重，按里程排序 */
export function chainageOptionsOf(input: {
  records: ProcessRecord[]
  processById: Map<string, Process>
  wbsById: Map<string, WbsNode>
  itemWorkface: Map<string, string>
  workfaceById: Map<string, Workface>
}): ChainageOption[] {
  const map = new Map<string, ChainageOption>()
  input.records.filter(isActive).forEach((r) => {
    const parsed = parseChainageRange(recordChainage(r))
    if (!parsed) return
    const p = input.processById.get(r.processId)
    if (!p) return
    const wfId = workfaceIdOfItem(p.itemId, input.wbsById, input.itemWorkface)
    const key = chainageKey(wfId, parsed.text)
    const cur = map.get(key)
    if (cur) {
      cur.count += 1
      return
    }
    const name = workfaceLabel(wfId, input.workfaceById)
    map.set(key, {
      key,
      workfaceId: wfId,
      workfaceName: name,
      text: parsed.text,
      shortText: parsed.shortText,
      label: chainageOptionLabel(name, parsed.shortText),
      startM: parsed.startM,
      count: 1
    })
  })
  return Array.from(map.values()).sort((a, b) => a.startM - b.startM || a.label.localeCompare(b.label, 'zh'))
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
 * 把若干周期的工时按"工作面 / 分项工程 / 工序"拆成堆叠序列
 * （最多 maxGroups 个，其余并入"其他"）。
 */
export function stackedTrend(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>,
  periods: Array<{ from: string; to: string; label: string }>,
  groupBy: 'workface' | 'item' | 'process',
  maxGroups = 6,
  lookups?: { itemWorkface: Map<string, string>; workfaceById: Map<string, Workface> }
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
        let key = p.id
        if (groupBy === 'item') key = p.itemId
        else if (groupBy === 'workface') key = workfaceIdOfItem(p.itemId, wbsById, lookups?.itemWorkface) || 'unknown'
        if (!groupNames.has(key)) {
          const item = wbsById.get(p.itemId)
          if (groupBy === 'item') groupNames.set(key, shortItemLabel(item?.name ?? '未归类'))
          else if (groupBy === 'workface') {
            groupNames.set(
              key,
              lookups?.workfaceById ? workfaceLabel(key, lookups.workfaceById) : shortItemLabel(item?.name ?? '未归类')
            )
          } else groupNames.set(key, p.name)
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
