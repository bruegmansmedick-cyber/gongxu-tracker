/**
 * 数据体检：把明显不合常理的记录挑出来，供人核对。
 * 纯函数，便于单测；不修改任何数据。
 */
import type { Process, ProcessRecord, WbsNode } from '@/types'
import { activeRecords, baselineHoursOf } from '@/core/compute'

export type HealthLevel = 'high' | 'mid' | 'low'

export type HealthRule =
  | 'too-long'
  | 'too-short'
  | 'day-over-24'
  | 'overlap'
  | 'big-gap'
  | 'qty-without-time'
  | 'duplicate'

export interface HealthIssue {
  /** 稳定 id：同一条问题重复扫描不会变，便于"已核实"标记 */
  id: string
  rule: HealthRule
  level: HealthLevel
  recordId?: string
  processName: string
  itemName: string
  date?: string
  title: string
  detail: string
}

export const HEALTH_RULE_LABEL: Record<HealthRule, string> = {
  'too-long': '单条用时过长',
  'too-short': '单条用时过短',
  'day-over-24': '同一天同一工作面超过 24 小时',
  overlap: '与上一条工序时间重叠',
  'big-gap': '与上一条工序间隔过长',
  'qty-without-time': '有工程量但用时不足 5 分钟',
  duplicate: '同一工序重复录入'
}

export const MAX_SINGLE_HOURS = 12
export const MIN_SINGLE_HOURS = 0.08 // 5 分钟
export const MAX_DAY_HOURS = 24
/** 与应用里的衔接口径一致：超过 6 小时不算衔接 */
export const BIG_GAP_HOURS = 6

function itemNameOf(process: Process | undefined, wbsById: Map<string, WbsNode>): string {
  if (!process) return ''
  return wbsById.get(process.itemId)?.name ?? ''
}

export function scanHealth(
  records: ProcessRecord[],
  processById: Map<string, Process>,
  wbsById: Map<string, WbsNode>
): HealthIssue[] {
  const rows = activeRecords(records)
  const issues: HealthIssue[] = []
  const nameOf = (r: ProcessRecord) => processById.get(r.processId)?.name ?? '未知工序'
  const itemOf = (r: ProcessRecord) => itemNameOf(processById.get(r.processId), wbsById)

  // 1) 单条时长异常
  rows.forEach((r) => {
    if (r.hours > MAX_SINGLE_HOURS) {
      issues.push({
        id: `too-long-${r.id}`,
        rule: 'too-long',
        level: 'high',
        recordId: r.id,
        processName: nameOf(r),
        itemName: itemOf(r),
        date: r.date,
        title: `${nameOf(r)} 单条用时 ${r.hours.toFixed(1)} 小时`,
        detail: `${r.date} ${r.startTime}-${r.endTime}，超过 ${MAX_SINGLE_HOURS} 小时，常见原因是跨零点写法或笔误`
      })
    } else if (r.hours < MIN_SINGLE_HOURS) {
      issues.push({
        id: `too-short-${r.id}`,
        rule: 'too-short',
        level: 'mid',
        recordId: r.id,
        processName: nameOf(r),
        itemName: itemOf(r),
        date: r.date,
        title: `${nameOf(r)} 单条用时不足 5 分钟`,
        detail: `${r.date} ${r.startTime}-${r.endTime}`
      })
    }
    if ((r.quantity ?? 0) > 0 && r.hours < MIN_SINGLE_HOURS) {
      issues.push({
        id: `qty-${r.id}`,
        rule: 'qty-without-time',
        level: 'mid',
        recordId: r.id,
        processName: nameOf(r),
        itemName: itemOf(r),
        date: r.date,
        title: `填了工程量但用时不足 5 分钟`,
        detail: `${r.date} ${nameOf(r)}：工程量 ${r.quantity}`
      })
    }
  })

  // 2) 同一天同一工作面合计超 24 小时
  const dayMap = new Map<string, { hours: number; itemName: string; date: string; records: string[] }>()
  rows.forEach((r) => {
    const itemId = processById.get(r.processId)?.itemId ?? ''
    const key = `${itemId}|${r.date}`
    const cur = dayMap.get(key) ?? { hours: 0, itemName: itemOf(r), date: r.date, records: [] }
    cur.hours += r.hours
    cur.records.push(r.id)
    dayMap.set(key, cur)
  })
  dayMap.forEach((v, key) => {
    if (v.hours > MAX_DAY_HOURS) {
      issues.push({
        id: `day24-${key}`,
        rule: 'day-over-24',
        level: 'high',
        processName: '',
        itemName: v.itemName,
        date: v.date,
        title: `${v.itemName} ${v.date} 合计 ${v.hours.toFixed(1)} 小时`,
        detail: '同一天同一工作面超过 24 小时，通常是重复录入或时间填错'
      })
    }
  })

  // 3) 相邻工序重叠 / 间隔过长 / 重复录入
  const groups = new Map<string, ProcessRecord[]>()
  rows.forEach((r) => {
    const itemId = processById.get(r.processId)?.itemId
    if (!itemId) return
    const list = groups.get(itemId) ?? []
    list.push(r)
    groups.set(itemId, list)
  })
  groups.forEach((list, itemId) => {
    list.sort((a, b) => a.startAt - b.startAt)
    const seen = new Map<string, ProcessRecord>()
    list.forEach((r) => {
      const dupKey = `${r.processId}|${r.date}|${r.startTime}|${r.endTime}`
      const prevSame = seen.get(dupKey)
      if (prevSame) {
        issues.push({
          id: `dup-${r.id}`,
          rule: 'duplicate',
          level: 'high',
          recordId: r.id,
          processName: nameOf(r),
          itemName: wbsById.get(itemId)?.name ?? '',
          date: r.date,
          title: `${nameOf(r)} 重复录入`,
          detail: `${r.date} ${r.startTime}-${r.endTime} 与另一条完全相同`
        })
      } else {
        seen.set(dupKey, r)
      }
    })
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1]
      const cur = list[i]
      const gap = (cur.startAt - prev.endAt) / 3600000
      if (gap < 0) {
        issues.push({
          id: `overlap-${cur.id}`,
          rule: 'overlap',
          level: 'mid',
          recordId: cur.id,
          processName: nameOf(cur),
          itemName: wbsById.get(itemId)?.name ?? '',
          date: cur.date,
          title: `${nameOf(cur)} 与上一道工序时间重叠`,
          detail: `上一条「${nameOf(prev)}」到 ${prev.endTime}，本条从 ${cur.startTime} 开始，重叠 ${Math.abs(gap).toFixed(1)} 小时`
        })
      } else if (gap > BIG_GAP_HOURS) {
        issues.push({
          id: `gap-${cur.id}`,
          rule: 'big-gap',
          level: 'low',
          recordId: cur.id,
          processName: nameOf(cur),
          itemName: wbsById.get(itemId)?.name ?? '',
          date: cur.date,
          title: `${nameOf(prev)} → ${nameOf(cur)} 间隔 ${gap.toFixed(1)} 小时`,
          detail: `超过 ${BIG_GAP_HOURS} 小时不计入衔接空隙，可能是漏填了中间工序`
        })
      }
    }
  })

  const order: Record<HealthLevel, number> = { high: 0, mid: 1, low: 2 }
  return issues.sort((a, b) => order[a.level] - order[b.level] || (a.date ?? '').localeCompare(b.date ?? ''))
}

/** 保存前的即时提醒：只针对"本条的衔接"检查 */
export function checkBeforeSave(
  draft: { id?: string; processId: string; date: string; startAt: number; endAt: number },
  records: ProcessRecord[],
  processById: Map<string, Process>
): string[] {
  const warnings: string[] = []
  const itemId = processById.get(draft.processId)?.itemId
  if (!itemId) return warnings
  const hours = (draft.endAt - draft.startAt) / 3600000
  if (hours > MAX_SINGLE_HOURS) {
    warnings.push(`本条用时 ${hours.toFixed(1)} 小时，超过 ${MAX_SINGLE_HOURS} 小时，请确认时间是否填错`)
  }
  const siblings = activeRecords(records)
    .filter((r) => r.id !== draft.id && processById.get(r.processId)?.itemId === itemId)
    .sort((a, b) => a.startAt - b.startAt)
  const before = [...siblings].reverse().find((r) => r.startAt <= draft.startAt)
  const after = siblings.find((r) => r.startAt > draft.startAt)
  if (before) {
    const gap = (draft.startAt - before.endAt) / 3600000
    if (gap < 0) {
      warnings.push(`与上一条「${processById.get(before.processId)?.name ?? ''}」重叠 ${Math.abs(gap).toFixed(1)} 小时`)
    } else if (gap > BIG_GAP_HOURS && before.date === draft.date) {
      // 只对"同一天内"的长间隔提醒；跨天补录是正常操作，不打扰
      warnings.push(
        `距上一条「${processById.get(before.processId)?.name ?? ''}」完工已 ${gap.toFixed(1)} 小时，超过 ${BIG_GAP_HOURS} 小时不计入衔接，确认是否漏填中间工序`
      )
    }
  }
  if (after) {
    const gap = (after.startAt - draft.endAt) / 3600000
    if (gap < 0) {
      warnings.push(`与下一条「${processById.get(after.processId)?.name ?? ''}」重叠 ${Math.abs(gap).toFixed(1)} 小时`)
    } else if (gap > BIG_GAP_HOURS && after.date === draft.date) {
      warnings.push(
        `距下一条「${processById.get(after.processId)?.name ?? ''}」开工还有 ${gap.toFixed(1)} 小时，确认是否漏填中间工序`
      )
    }
  }
  const dup = siblings.find(
    (r) => r.processId === draft.processId && r.date === draft.date && r.startAt === draft.startAt && r.endAt === draft.endAt
  )
  if (dup) warnings.push('同一工序同一天已有完全相同起止时刻的记录，请确认是否重复录入')
  const std = baselineHoursOf(processById.get(draft.processId))
  if (std && hours > std * 3) {
    warnings.push(`本条用时是基准用时的 ${(hours / std).toFixed(1)} 倍（基准 ${std} 小时），请确认`)
  }
  return warnings
}
