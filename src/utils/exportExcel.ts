import type { Process, ProcessRecord, WbsNode } from '@/types'
import {
  aggregateByProcess,
  buildTrend,
  computeGapRows,
  computeStats,
  completionByItem,
  monthPeriods,
  weekPeriods
} from '@/core/compute'
import { reasonLabel } from '@/core/reasons'
import { fmtHoursShort, monthKey, parseDate } from '@/core/time'
import { buildXlsx, type CellValue } from '@/utils/xlsx'
import { downloadBlob, stamp } from '@/utils/download'

export interface ExportOptions {
  projectName: string
  from: string
  to: string
  records: ProcessRecord[]
  processes: Process[]
  wbs: WbsNode[]
}

function dmy(s: string): string {
  return s
}

export function exportProjectExcel(opts: ExportOptions): void {
  const processById = new Map(opts.processes.map((p) => [p.id, p]))
  const wbsById = new Map(opts.wbs.map((w) => [w.id, w]))
  const inRange = opts.records.filter((r) => r.date >= opts.from && r.date <= opts.to)

  const gapRows = computeGapRows(inRange, processById)
  const gapByRecord = new Map(gapRows.map((g) => [g.recordId, g]))

  const nodePath = (itemId: string): { unit: string; division: string; item: string } => {
    const item = wbsById.get(itemId)
    const div = item?.parentId ? wbsById.get(item.parentId) : undefined
    const unit = div?.parentId ? wbsById.get(div.parentId) : undefined
    return { unit: unit?.name ?? '', division: div?.name ?? '', item: item?.name ?? '' }
  }

  // 1) 记录明细
  const detailHeader: CellValue[] = [
    '日期',
    '单位工程',
    '分部工程',
    '分项工程',
    '工序',
    '开工时刻',
    '完工时刻',
    '净用时(h)',
    '工程量',
    '单位',
    '部位/桩号',
    '衔接空隙(h)',
    '前道工序',
    '间隙原因',
    '备注',
    '录入人'
  ]
  const detailRows = [...inRange]
    .sort((a, b) => a.startAt - b.startAt)
    .map((r) => {
      const p = processById.get(r.processId)
      const path = nodePath(p?.itemId ?? '')
      const gap = gapByRecord.get(r.id)
      return [
        dmy(r.date),
        path.unit,
        path.division,
        path.item,
        p?.name ?? '',
        r.startTime,
        r.endTime,
        Number(r.hours.toFixed(2)),
        r.quantity ?? null,
        p?.unit ?? '',
        r.location ?? '',
        gap ? Number(gap.gapHours.toFixed(2)) : 0,
        gap?.prevProcessName ?? '',
        reasonLabel(r.gapReason),
        r.note ?? '',
        r.operatorName
      ] as CellValue[]
    })

  // 2) 工序汇总
  const procAgg = aggregateByProcess(inRange, processById, wbsById)
  const procHeader: CellValue[] = [
    '工序',
    '分项工程',
    '记录次数',
    '实际总用时(h)',
    '标准用时(h/次)',
    '参考用时(h/次)',
    '标准合计(h)',
    '偏差率',
    '完成工程量',
    '单位',
    '设计总量',
    '完成率'
  ]
  const procRows = procAgg.map((a) => [
    a.processName,
    a.itemName,
    a.count,
    Number(a.actualHours.toFixed(2)),
    a.standardHours ?? null,
    a.refHours ?? null,
    a.standardTotal === null ? null : Number(a.standardTotal.toFixed(2)),
    a.deviation === null ? null : Number((a.deviation * 100).toFixed(1)) / 100,
    Number(a.quantity.toFixed(2)),
    processById.get(a.processId)?.unit ?? '',
    a.designQty ?? null,
    a.designQty && a.designQty > 0 ? Number((a.quantity / a.designQty).toFixed(4)) : null
  ] as CellValue[])

  // 3) 周对比 / 月对比
  const weeks = weekPeriods(opts.to, 12)
  const weekTrend = buildTrend(opts.records, processById, weeks)
  const months = monthPeriods(monthKey(opts.to), 12)
  const monthTrend = buildTrend(opts.records, processById, months)
  const trendHeader: CellValue[] = [
    '周期',
    '起止',
    '实际工时(h)',
    '标准工时(h)',
    '总量口径效率',
    '工序平均偏差',
    '衔接空隙(h)'
  ]
  const trendRows = (list: typeof weekTrend): CellValue[][] =>
    list.map((t) => [
      t.label,
      `${t.from} ~ ${t.to}`,
      Number(t.actualHours.toFixed(2)),
      Number(t.standardHours.toFixed(2)),
      t.totalEfficiency === null ? null : Number(t.totalEfficiency.toFixed(4)),
      t.avgDeviation === null ? null : Number(t.avgDeviation.toFixed(4)),
      Number(t.gapHours.toFixed(2))
    ])

  // 4) 衔接空隙明细
  const gapHeader: CellValue[] = ['日期', '前道工序', '本工序', '空隙(h)', '间隙原因', '部位/桩号']
  const gapDetailRows = gapRows
    .filter((g) => g.gapHours > 0)
    .sort((a, b) => b.gapHours - a.gapHours)
    .map(
      (g) =>
        [
          g.date,
          g.prevProcessName,
          g.processName,
          Number(g.gapHours.toFixed(2)),
          reasonLabel(g.reason),
          g.location
        ] as CellValue[]
    )

  // 5) 分项完成情况
  const items = completionByItem(inRange, processById, wbsById)
  const itemHeader: CellValue[] = ['单位工程', '分项工程', '设计总量', '已完成', '完成率', '实际工时(h)']
  const itemRows = items.map((i) => [
    i.unitName,
    i.itemName,
    i.designQty || null,
    Number(i.doneQty.toFixed(2)),
    i.percent ? Number(i.percent.toFixed(4)) : null,
    Number(i.actualHours.toFixed(2))
  ] as CellValue[])

  const summary = computeStats(opts.records, processById, opts.from, opts.to)
  const overviewHeader: CellValue[] = ['项目', '统计区间', '记录条数', '实际工时(h)', '标准工时(h)', '总量口径效率', '工序平均偏差', '衔接空隙(h)']
  const overviewRows: CellValue[][] = [
    [
      opts.projectName,
      `${opts.from} ~ ${opts.to}`,
      summary.recordCount,
      Number(summary.actualHours.toFixed(2)),
      Number(summary.standardHours.toFixed(2)),
      summary.totalEfficiency === null ? null : Number(summary.totalEfficiency.toFixed(4)),
      summary.avgDeviation === null ? null : Number(summary.avgDeviation.toFixed(4)),
      Number(summary.gapHours.toFixed(2))
    ]
  ]

  const blob = buildXlsx([
    { name: '统计概览', rows: [overviewHeader, ...overviewRows], freezeHeader: true },
    { name: '记录明细', rows: [detailHeader, ...detailRows], freezeHeader: true },
    { name: '工序汇总', rows: [procHeader, ...procRows], freezeHeader: true },
    { name: '周对比', rows: [trendHeader, ...trendRows(weekTrend)], freezeHeader: true },
    { name: '月对比', rows: [trendHeader, ...trendRows(monthTrend)], freezeHeader: true },
    { name: '衔接空隙明细', rows: [gapHeader, ...gapDetailRows], freezeHeader: true },
    { name: '分项完成情况', rows: [itemHeader, ...itemRows], freezeHeader: true }
  ])

  const safeName = opts.projectName.replace(/[\\/:*?"<>|]/g, '_')
  downloadBlob(blob, `${safeName}-工序用时-${opts.from}_${opts.to}-${stamp()}.xlsx`)
}

export function describeEfficiency(v: number | null): string {
  if (v === null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

export function hoursText(h: number): string {
  return fmtHoursShort(h)
}

export function dateText(s: string): string {
  const d = parseDate(s)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
