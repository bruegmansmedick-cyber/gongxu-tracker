/**
 * 预判：按"最近实际记过的"来排序和预填，而不是按工程结构顺序。
 *
 * 依据是最近的记录，越近权重越高（半衰期 7 天，只看最近 30 天），于是：
 *   - 主推进的工作面会浮到列表前面，已完工 / 还没开始的自然沉到后面；
 *   - 选了单位工程之后，可以按习惯预判分部工程 / 分项工程并自动填上（可随时改）。
 *
 * 纯函数：不读写数据库、不参与云同步。
 */
import { isActive } from '@/core/compute'
import type { Process, ProcessRecord, WbsLevel, WbsNode } from '@/types'

/** 只看最近这些天的记录 */
export const USAGE_WINDOW_DAYS = 30
/** 权重半衰期：7 天前的记录影响力减半 */
export const USAGE_HALF_LIFE_DAYS = 7

const DAY_MS = 86400000

export interface UsageIndex {
  /** 节点 id（单位 / 分部 / 分项 / 工序）→ 加权使用次数 */
  score: Map<string, number>
  /** 节点 id → 最近一次记录时间戳 */
  lastAt: Map<string, number>
  /** 参与统计的记录条数 */
  sample: number
}

export function buildUsageIndex(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>,
  now = Date.now()
): UsageIndex {
  const score = new Map<string, number>()
  const lastAt = new Map<string, number>()
  let sample = 0

  const bump = (id: string, weight: number, at: number) => {
    score.set(id, (score.get(id) ?? 0) + weight)
    lastAt.set(id, Math.max(lastAt.get(id) ?? 0, at))
  }

  records.forEach((r) => {
    if (!isActive(r)) return
    const at = Number(r.startAt)
    if (!Number.isFinite(at) || at <= 0) return
    const ageDays = Math.max(0, (now - at) / DAY_MS)
    if (ageDays > USAGE_WINDOW_DAYS) return
    const p = processById.get(r.processId)
    if (!p) return
    const item = wbsById.get(p.itemId)
    const division = item?.parentId ? wbsById.get(item.parentId) : undefined
    const unit = division?.parentId ? wbsById.get(division.parentId) : undefined
    const weight = Math.pow(0.5, ageDays / USAGE_HALF_LIFE_DAYS)
    sample += 1
    if (unit) bump(unit.id, weight, at)
    if (division) bump(division.id, weight, at)
    if (item) bump(item.id, weight, at)
    bump(p.id, weight, at)
  })

  return { score, lastAt, sample }
}

export function usageScore(index: UsageIndex, id: string): number {
  return index.score.get(id) ?? 0
}

/**
 * 按使用习惯排序：常记的在前，其次保持工程结构里的原有顺序（sort 小的在前）。
 * 没有使用记录时结果与结构顺序完全一致。
 */
export function rankByUsage<T extends { id: string; sort?: number }>(nodes: T[], index: UsageIndex): T[] {
  return [...nodes].sort((a, b) => {
    const diff = usageScore(index, b.id) - usageScore(index, a.id)
    if (Math.abs(diff) > 1e-9) return diff
    return (a.sort ?? 0) - (b.sort ?? 0)
  })
}

/** 在某个父节点下的指定层级里，挑最近记得最多的那个（没有使用记录就返回 undefined） */
export function predictNode(
  parentId: string | null,
  level: WbsLevel,
  wbs: WbsNode[],
  index: UsageIndex
): string | undefined {
  let bestId: string | undefined
  let bestScore = 0
  wbs.forEach((n) => {
    if (n.level !== level || n.parentId !== parentId) return
    const s = usageScore(index, n.id)
    if (s > bestScore) {
      bestScore = s
      bestId = n.id
    }
  })
  return bestId
}

export interface PredictInput {
  unitId?: string
  divisionId?: string
  wbs: WbsNode[]
  index: UsageIndex
  /** 传入后：分项下只有一道工序时会顺手选中它（多道工序不猜，免得记错） */
  processes?: Process[]
}

export interface PredictResult {
  divisionId?: string
  itemId?: string
  processId?: string
}

/**
 * 按使用习惯预判"下一步该选什么"。
 * 只在有真实使用记录时才给结果；给不出就返回空对象，页面照常让人手选。
 */
export function predictSelection(input: PredictInput): PredictResult {
  const { unitId, wbs, index } = input
  const out: PredictResult = {}
  const byId = new Map(wbs.map((n) => [n.id, n]))

  let divisionId = input.divisionId
  if (!divisionId && unitId) {
    divisionId = predictNode(unitId, 2, wbs, index)
    if (divisionId) out.divisionId = divisionId
  }

  let itemId: string | undefined
  if (divisionId) {
    itemId = predictNode(divisionId, 3, wbs, index)
  } else if (unitId) {
    // 这道单位工程可能压根没有分部层级（或分部没有记录）：直接在该单位工程下找最常用的分项
    let best: string | undefined
    let bestScore = 0
    wbs.forEach((n) => {
      if (n.level !== 3) return
      const div = n.parentId ? byId.get(n.parentId) : undefined
      if (div?.parentId !== unitId) return
      const s = usageScore(index, n.id)
      if (s > bestScore) {
        bestScore = s
        best = n.id
      }
    })
    itemId = best
    if (itemId) {
      const item = byId.get(itemId)
      if (item?.parentId) out.divisionId = item.parentId
    }
  }
  if (itemId) out.itemId = itemId

  if (itemId && input.processes) {
    const list = input.processes.filter((p) => p.itemId === itemId && p.enabled)
    if (list.length === 1) out.processId = list[0].id
  }
  return out
}

/** 某个分项工程下最常用的几道工序（用于首页常用工序分组；没有使用记录就按结构顺序） */
export function topProcesses(
  processes: Process[],
  index: UsageIndex,
  limit = 4
): Process[] {
  const used = processes.filter((p) => usageScore(index, p.id) > 0)
  const ranked = rankByUsage(used.length ? used : processes, index)
  return ranked.slice(0, limit)
}
