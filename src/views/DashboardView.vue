<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'
import ChartBox from '@/components/ChartBox.vue'
import DayRing from '@/components/DayRing.vue'
import StatCard from '@/components/StatCard.vue'
import ScopePicker from '@/components/ScopePicker.vue'
import { getKv, setKv } from '@/db'
import { state } from '@/store'
import {
  aggregateByProcess,
  aggregateByReason,
  buildTrend,
  computeGapRows,
  computeStats,
  completionByItem,
  monthPeriods,
  monthsWithRecords,
  topGaps,
  weekPeriods,
  type PeriodRange
} from '@/core/compute'
import { buildDayRing } from '@/core/dayRing'
import { CYCLE_FAMILIES, buildCycles, cycleChainageText, cyclesInPeriod, summarizeCycles } from '@/core/cycles'
import { aggregateByItem, filterByScope, shortItemLabel, stackedTrend } from '@/core/scope'
import { GAP_TOLERANCE_MINUTES } from '@/core/reasons'
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  fmtDate,
  fmtHoursShort,
  fmtPercent,
  monthKey,
  parseDate,
  startOfMonth,
  startOfWeek,
  todayStr
} from '@/core/time'

type PeriodType = 'day' | 'week' | 'month'

const route = useRoute()
const router = useRouter()
const DASHBOARD_KV = 'ui.dashboard'

const periodType = ref<PeriodType>('day')
const anchor = ref(todayStr())
const showPeriodPicker = ref(false)
const showPeriodCalendar = ref(false)
const calendarValue = ref(parseDate(todayStr()))
/** 用户主动选过日期后，就不再自动把锚点挪到"最近有记录的一天" */
let anchorTouched = false

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

/** 当前分析范围内的全部记录（范围由页首选择器决定） */
const scopeRecords = computed(() => filterByScope(state.records, state.scope, processById.value, wbsById.value))

function rangeOf(type: PeriodType, day: string): { from: string; to: string } {
  if (type === 'day') return { from: day, to: day }
  if (type === 'week') return { from: startOfWeek(day), to: endOfWeek(day) }
  return { from: startOfMonth(day), to: endOfMonth(day) }
}

const range = computed(() => rangeOf(periodType.value, anchor.value))

const prevRange = computed(() => {
  if (periodType.value === 'day') {
    const d = addDays(anchor.value, -1)
    return { from: d, to: d }
  }
  if (periodType.value === 'week') {
    const d = addDays(startOfWeek(anchor.value), -7)
    return { from: d, to: addDays(d, 6) }
  }
  const m = addMonths(monthKey(anchor.value), -1)
  return { from: `${m}-01`, to: endOfMonth(`${m}-01`) }
})

const periodLabel = computed(() =>
  periodType.value === 'day' ? anchor.value : `${range.value.from} ~ ${range.value.to}`
)

const stats = computed(() => computeStats(scopeRecords.value, processById.value, range.value.from, range.value.to))
const prevStats = computed(() =>
  computeStats(scopeRecords.value, processById.value, prevRange.value.from, prevRange.value.to)
)

const hoursDelta = computed(() => {
  if (!prevStats.value.actualHours) return null
  return stats.value.actualHours / prevStats.value.actualHours - 1
})
const efficiencyDelta = computed(() => {
  if (stats.value.totalEfficiency === null || prevStats.value.totalEfficiency === null) return null
  return stats.value.totalEfficiency - prevStats.value.totalEfficiency
})

const gapRatio = computed(() => {
  const total = stats.value.actualHours + stats.value.gapHours
  return total > 0 ? stats.value.gapHours / total : 0
})

/** 效率基准口径说明 */
const caliberText = computed(() => {
  const s = stats.value
  if (s.baselineSource === 'none') return '暂无基准（标准用时与参考用时都为空）'
  if (s.baselineSource === 'standard') return `标准口径 · ${s.baselineCovered} 条记录`
  const label = s.baselineSource === 'mixed' ? '参考口径（标准 + 参考）' : '参考口径'
  return `${label} · ${s.baselineCovered}/${s.recordCount} 条有基准`
})

const scopeName = computed(() => {
  const s = state.scope
  if (s.level === 'all') return '全部工程'
  if (s.level === 'unit') return wbsById.value.get(s.unitId ?? '')?.name ?? ''
  const item = wbsById.value.get(s.itemId ?? '')?.name ?? ''
  const proc = s.processId ? processById.value.get(s.processId) : undefined
  return proc ? `${item} · ${proc.name}` : item
})

// ---------------------------------------------------------------- 周期趋势
const trendPeriods = computed<PeriodRange[]>(() => {
  if (periodType.value === 'day') {
    const out: PeriodRange[] = []
    for (let i = 13; i >= 0; i -= 1) {
      const d = addDays(anchor.value, -i)
      out.push({ from: d, to: d, key: d, label: d.slice(5) })
    }
    return out
  }
  if (periodType.value === 'week') return weekPeriods(anchor.value, 12)
  return monthPeriods(monthKey(anchor.value), 12)
})

const trend = computed(() => buildTrend(scopeRecords.value, processById.value, trendPeriods.value))

const trendGroupBy = computed<'item' | 'process'>(() => (state.scope.level === 'item' ? 'process' : 'item'))

const trendStack = computed(() =>
  stackedTrend(
    scopeRecords.value,
    processById.value,
    wbsById.value,
    trendPeriods.value.map((p) => ({ from: p.from, to: p.to, label: p.label })),
    trendGroupBy.value
  )
)

const trendTitle = computed(() => {
  const base = periodType.value === 'day' ? '近 14 天' : periodType.value === 'week' ? '近 12 周' : '近 12 月'
  return `${base}工时构成（${trendGroupBy.value === 'item' ? '按工作面' : '按工序'}）`
})

/** 单工作面时画 24 小时参考线，并标出超 24h 的日期 */
const showDayLimit = computed(() => state.scope.level === 'item' && periodType.value === 'day')
/** 只有单工作面（分项工程）时，"一天超过 24h"才是异常；全部/单位工程是多条洞并行，合计超 24h 正常 */
const exceedPeriods = computed(() =>
  showDayLimit.value
    ? trendStack.value.totals.map((t, i) => (t > 24.01 ? i : -1)).filter((i) => i >= 0)
    : []
)

const trendOption = computed<EChartsOption>(() => {
  const stack = trendStack.value
  const eff = trend.value
  const series: Array<Record<string, unknown>> = stack.series.map((s, idx) => ({
    name: s.name,
    type: 'bar',
    stack: 'hours',
    data: s.data,
    barMaxWidth: 18,
    emphasis: { focus: 'series' },
    ...(idx === 0 && showDayLimit.value
      ? {
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#f59e0b', type: 'dashed', width: 1 },
            label: { formatter: '24h', fontSize: 9, color: '#b26a00' },
            data: [{ yAxis: 24 }]
          }
        }
      : {})
  }))
  series.push({
    name: '效率',
    type: 'line',
    yAxisIndex: 1,
    data: eff.map((t) => (t.totalEfficiency === null ? null : Number(t.totalEfficiency.toFixed(4)))),
    smooth: true,
    connectNulls: true,
    symbolSize: 5,
    lineStyle: { color: '#f59e0b', width: 2 },
    itemStyle: { color: '#f59e0b' }
  })
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''))
    },
    legend: { type: 'scroll', top: 0, itemHeight: 8, textStyle: { fontSize: 10 }, pageTextStyle: { fontSize: 10 } },
    grid: { left: 38, right: 46, top: 34, bottom: 24 },
    xAxis: {
      type: 'category',
      data: stack.labels,
      axisLabel: {
        fontSize: 9,
        color: (_value: string, index: number) =>
          exceedPeriods.value.includes(index) ? '#d14343' : '#8b95a1'
      },
      axisLine: { lineStyle: { color: '#e8eaee' } }
    },
    yAxis: [
      {
        type: 'value',
        name: 'h',
        nameTextStyle: { fontSize: 10, color: '#8b95a1' },
        axisLabel: { fontSize: 9, color: '#8b95a1' },
        splitLine: { lineStyle: { color: '#f2f3f5' } }
      },
      {
        type: 'value',
        name: '效率',
        nameTextStyle: { fontSize: 10, color: '#8b95a1' },
        axisLabel: { fontSize: 9, color: '#8b95a1', formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
        splitLine: { show: false }
      }
    ],
    series
  } as EChartsOption
})

// ------------------------------------------------------------ 工序 / 空隙
const inRange = computed(() =>
  scopeRecords.value.filter((r) => r.date >= range.value.from && r.date <= range.value.to)
)

const procAgg = computed(() => aggregateByProcess(inRange.value, processById.value, wbsById.value))
const itemAgg = computed(() => aggregateByItem(inRange.value, processById.value, wbsById.value))

// ------------------------------------------------------- 循环用时（开挖 / 支护）
const allCycles = computed(() => buildCycles(scopeRecords.value, processById.value))
const periodCycles = computed(() => cyclesInPeriod(allCycles.value, range.value.from, range.value.to))
const excCycle = computed(() => summarizeCycles(periodCycles.value, 'exc'))
const supCycle = computed(() => summarizeCycles(periodCycles.value, 'sup'))

function cycleHint(s: { count: number; avgHours: number; spanning: number; incomplete: number }): string {
  if (!s.count) return '本期无完整循环'
  const bits = [`${s.count} 轮`, `平均 ${fmtHoursShort(s.avgHours)}`]
  if (s.spanning) bits.push(`跨天 ${s.spanning}`)
  if (s.incomplete) bits.push(`未完 ${s.incomplete}`)
  return bits.join(' · ')
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours()
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 图里最多画最近 12 轮；编号按所选周期内的全部轮次算，避免月份视图编号跳 */
const cycleChart = computed(() => {
  const counter = new Map<string, number>()
  const labeled = periodCycles.value.map((c) => {
    const cfg = CYCLE_FAMILIES[c.family]
    const itemName = wbsById.value.get(c.itemId)?.name ?? cfg.label
    const k = `${c.startDate}-${c.family}-${c.itemId}`
    const n = (counter.get(k) ?? 0) + 1
    counter.set(k, n)
    return {
      ...c,
      itemName,
      label: `${c.startDate.slice(5)} ${shortItemLabel(itemName)}#${n}`,
      color: cfg.color
    }
  })
  const shown = labeled.slice(-12)
  const rest = labeled.slice(0, Math.max(0, labeled.length - 12))
  return {
    rows: shown.reverse(),
    restCount: rest.length,
    restHours: rest.reduce((s, c) => s + c.activeHours, 0)
  }
})

const cycleChartOption = computed<EChartsOption>(() => {
  const rows = cycleChart.value.rows
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        const row = rows[arr[0]?.dataIndex ?? 0]
        if (!row) return ''
        const lines = [
          `<b>${row.label}</b>`,
          `工作面：${row.itemName}`,
          `${fmtTs(row.startAt)} → ${fmtTs(row.boundaryEndAt)}${row.incomplete ? '（截至数据末）' : '（下一轮起点）'}`,
          `作业 ${row.activeHours.toFixed(1)}h · 轮内停工 ${row.idleHours.toFixed(1)}h 已剔除`,
          `${row.steps} 条记录${row.spansDays ? ' · 跨天作业' : ''}`
        ]
        const chainLine = cycleChainageText(row)
        if (chainLine) lines.push(chainLine)
        return lines.join('<br/>')
      }
    },
    grid: { left: 120, right: 54, top: 8, bottom: 22 },
    xAxis: {
      type: 'value',
      name: 'h',
      nameTextStyle: { fontSize: 9, color: '#8b95a1' },
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.label),
      axisLabel: { fontSize: 9, color: '#4a5461' }
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 12,
        data: rows.map((r) => ({ value: Number(r.activeHours.toFixed(2)), itemStyle: { color: r.color } })),
        label: {
          show: true,
          position: 'right',
          fontSize: 8,
          color: '#4a5461',
          formatter: (p: unknown) => {
            const idx = (p as { dataIndex: number }).dataIndex
            const r = rows[idx]
            if (!r) return ''
            return `${r.activeHours.toFixed(1)}h${r.spansDays ? ' 跨天' : ''}${r.incomplete ? ' 未完' : ''}`
          }
        }
      }
    ]
  } as EChartsOption
})

/** 24 小时圆盘：只在"日"模式用，数据就是当天范围内的记录 */
const dayRing = computed(() =>
  buildDayRing({
    date: anchor.value,
    records: inRange.value,
    processById: processById.value,
    wbsById: wbsById.value,
    byProcess: state.scope.level === 'item'
  })
)

/** 范围=整体时，工序条目要带上所属分项工程，否则同名工序分不清 */
const rankRows = computed(() => {
  const rows = procAgg.value.slice(0, 10)
  const withLabel = rows.map((p) => ({
    ...p,
    label:
      state.scope.level === 'all'
        ? `${p.processName}\n${shortItemLabel(p.itemName)}`
        : p.processName
  }))
  return withLabel.reverse()
})

const rankHasReference = computed(() => rankRows.value.some((p) => p.baselineKind === 'reference'))

const processRankOption = computed<EChartsOption>(() => {
  const rows = rankRows.value
  const baselineName = rankHasReference.value ? '标准 / 参考用时' : '标准用时'
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        const row = rows[arr[0]?.dataIndex ?? 0]
        if (!row) return ''
        const base = row.baselineTotal === null ? null : row.baselineTotal
        const dev = row.deviation === null ? '—' : fmtPercent(row.deviation)
        return [
          `<b>${row.processName}</b>`,
          row.itemName,
          `实际 ${row.actualHours.toFixed(1)}h（${row.count} 次）`,
          base === null ? '基准：未设置' : `基准 ${base.toFixed(1)}h（${row.baselineKind === 'reference' ? '参考' : '标准'}）`,
          `偏差 ${dev}`
        ].join('<br/>')
      }
    },
    legend: { data: ['实际用时', baselineName], top: 0, itemHeight: 8, textStyle: { fontSize: 11 } },
    grid: { left: 118, right: 18, top: 30, bottom: 18 },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    yAxis: {
      type: 'category',
      data: rows.map((p) => p.label),
      axisLabel: {
        fontSize: 9,
        color: '#4a5461',
        lineHeight: 11,
        formatter: (value: string) => value
      }
    },
    series: [
      {
        name: '实际用时',
        type: 'bar',
        data: rows.map((p) => Number(p.actualHours.toFixed(2))),
        itemStyle: { color: '#2b7fff', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 9
      },
      {
        name: baselineName,
        type: 'bar',
        data: rows.map((p) => (p.baselineTotal === null ? 0 : Number(p.baselineTotal.toFixed(2)))),
        itemStyle: { color: '#c9d8f5', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 9
      }
    ]
  }
})

/** 用时占比饼图：整体/单位工程看工作面，选定分项后看工序 */
const timePieRows = computed(() => {
  if (state.scope.level === 'item' && state.scope.processId) return []
  if (state.scope.level === 'item') {
    return procAgg.value.map((p) => ({ name: p.processName, value: Number(p.actualHours.toFixed(2)), detail: p.itemName, count: p.count }))
  }
  return itemAgg.value.map((i) => ({ name: i.shortName, value: Number(i.actualHours.toFixed(2)), detail: i.itemName, count: i.count }))
})

const timePieTitle = computed(() =>
  state.scope.level === 'item' ? '各工序用时占比' : '各分项工程用时占比'
)

const timePieOption = computed<EChartsOption>(() => ({
  tooltip: {
    trigger: 'item',
    formatter: (p: unknown) => {
      const item = p as { dataIndex: number; percent: number }
      const row = timePieRows.value[item.dataIndex]
      if (!row) return ''
      return `${row.name}<br/>${row.detail}<br/>${row.value} 小时（${item.percent}%）· ${row.count} 条`
    }
  },
  legend: { bottom: 0, type: 'scroll', itemHeight: 8, textStyle: { fontSize: 10 } },
  series: [
    {
      type: 'pie',
      radius: ['38%', '62%'],
      center: ['50%', '42%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 1 },
      label: { fontSize: 10, formatter: '{b}\n{d}%' },
      data: timePieRows.value.map((r) => ({ name: r.name, value: r.value }))
    }
  ]
}))

const gapRows = computed(() => computeGapRows(inRange.value, processById.value))
const gapTop = computed(() =>
  topGaps(gapRows.value, 8).map((g) => ({ ...g, itemName: wbsById.value.get(g.itemId)?.name ?? '' }))
)

const gapRankOption = computed<EChartsOption>(() => {
  const top = [...gapTop.value].reverse()
  const labelOf = (g: (typeof top)[number]) =>
    state.scope.level === 'all'
      ? `${shortItemLabel(g.itemName)}\n${g.prevProcessName}→${g.processName}`
      : `${g.prevProcessName}→${g.processName}`
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        const item = top[arr[0]?.dataIndex ?? 0]
        if (!item) return ''
        return `${item.itemName}<br/>${item.prevProcessName} → ${item.processName}<br/>空隙 ${item.gapHours.toFixed(1)} 小时<br/>${item.date}${
          item.reason ? '<br/>原因：' + item.reason : ''
        }`
      }
    },
    grid: { left: 108, right: 26, top: 12, bottom: 18 },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    yAxis: {
      type: 'category',
      data: top.map(labelOf),
      axisLabel: { fontSize: 9, color: '#4a5461', lineHeight: 11 }
    },
    series: [
      {
        type: 'bar',
        data: top.map((g) => Number(g.gapHours.toFixed(2))),
        itemStyle: { color: '#f59e0b', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 10,
        label: { show: true, position: 'right', fontSize: 9, formatter: '{c}h' }
      }
    ]
  }
})

const reasonAgg = computed(() => aggregateByReason(gapRows.value))

const reasonOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}<br/>{c} 小时（{d}%）' },
  legend: { bottom: 0, type: 'scroll', itemHeight: 8, textStyle: { fontSize: 10 } },
  series: [
    {
      type: 'pie',
      radius: ['38%', '62%'],
      center: ['50%', '42%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 1 },
      label: { fontSize: 10, formatter: '{b}\n{c}h' },
      data: reasonAgg.value.map((r) => ({
        name: r.label,
        value: Number(r.hours.toFixed(2)),
        itemStyle: { color: r.color }
      }))
    }
  ]
}))

const itemProgress = computed(() => completionByItem(inRange.value, processById.value, wbsById.value))

// ------------------------------------------------------- 选日期 / 选周期
// 不再只靠左右箭头：点周期标签就能跳到任意一天、任意一月
function move(delta: number) {
  anchorTouched = true
  if (periodType.value === 'day') anchor.value = addDays(anchor.value, delta)
  else if (periodType.value === 'week') anchor.value = addDays(anchor.value, delta * 7)
  else anchor.value = `${addMonths(monthKey(anchor.value), delta)}-01`
}

function goToday() {
  anchorTouched = true
  anchor.value = todayStr()
}

/** 当前范围内最近 12 个有记录的日期 / 月份，一点直达 */
const datesWithData = computed(() => {
  const set = new Set(scopeRecords.value.map((r) => r.date))
  return Array.from(set).sort().reverse().slice(0, 12)
})

const monthsWithData = computed(() => monthsWithRecords(scopeRecords.value).slice(-12).reverse())

/** 年 + 月 两列，给"月"模式用 */
const monthColumns = computed(() => {
  const thisYear = new Date().getFullYear()
  const years: Array<{ text: string; value: string }> = []
  for (let y = 2024; y <= thisYear; y += 1) years.push({ text: `${y}年`, value: String(y) })
  const months = Array.from({ length: 12 }, (_, i) => ({
    text: `${i + 1}月`,
    value: String(i + 1).padStart(2, '0')
  }))
  return [years, months]
})

const monthPickerValue = ref<string[]>([anchor.value.slice(0, 4), anchor.value.slice(5, 7)])

/** 打开选择器时把当前所在月份同步给年月选择器，避免它显示成上一次的值 */
function openPeriodPicker() {
  monthPickerValue.value = [anchor.value.slice(0, 4), anchor.value.slice(5, 7)]
  showPeriodPicker.value = true
}

const pickerTitle = computed(() => {
  if (periodType.value === 'day') return '选择日期'
  if (periodType.value === 'week') return '选择某一周（选那天所在的周）'
  return '选择月份'
})

function pickAnchorDate(date: string) {
  anchorTouched = true
  showPeriodPicker.value = false
  anchor.value = date
}

function pickAnchorMonth(month: string) {
  anchorTouched = true
  showPeriodPicker.value = false
  anchor.value = `${month}-01`
}

function openPeriodCalendar() {
  showPeriodPicker.value = false
  showPeriodCalendar.value = true
}

function onPeriodCalendarConfirm(value: Date) {
  anchorTouched = true
  showPeriodCalendar.value = false
  anchor.value = fmtDate(value)
}

function onMonthPickerConfirm(payload: { selectedValues?: Array<string | number> }) {
  const values = payload.selectedValues ?? []
  const y = String(values[0] ?? '')
  const m = String(values[1] ?? '').padStart(2, '0')
  if (y && m) pickAnchorMonth(`${y}-${m}`)
}

/** 底部按钮：把当前正在看的周期带进明细页 */
function openRecords() {
  if (periodType.value === 'day') {
    void router.push({ path: '/records', query: { month: monthKey(anchor.value), date: anchor.value } })
  } else {
    void router.push({ path: '/records', query: { month: monthKey(range.value.from) } })
  }
}

/** 圆盘上的扇段 / 清单点一下，进那条记录的编辑页 */
function openRecord(recordId: string) {
  void router.push({ path: '/record', query: { id: recordId } })
}

const recordsButtonLabel = computed(() =>
  periodType.value === 'day'
    ? `查看记录明细（${anchor.value.slice(5)}）`
    : `查看记录明细（${monthKey(range.value.from)}）`
)

// 记住上次看的周期与位置（本机），切来切去不会跳回今天
watch([periodType, anchor], () => {
  calendarValue.value = parseDate(anchor.value)
  void setKv(DASHBOARD_KV, { periodType: periodType.value, anchor: anchor.value })
})

async function initPosition() {
  // 首次打开时同步可能还没跑完：等它落定，否则会按"空数据"默认到今天
  await waitForSyncSettled()
  const qPeriod = typeof route.query.period === 'string' ? route.query.period : ''
  const qDate =
    typeof route.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(route.query.date) ? route.query.date : ''
  if (qPeriod === 'day' || qPeriod === 'week' || qPeriod === 'month') periodType.value = qPeriod
  if (qDate) {
    anchor.value = qDate
    return
  }
  if (!qPeriod) {
    const saved = await getKv<{ periodType?: PeriodType; anchor?: string } | null>(DASHBOARD_KV, null)
    if (saved?.periodType) periodType.value = saved.periodType
    if (saved?.anchor) anchor.value = saved.anchor
    else anchor.value = latestDayWithRecords()
  }
}

function waitForSyncSettled(): Promise<void> {
  if (state.ready && !state.sync.syncing) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(
      [() => state.ready, () => state.sync.syncing],
      ([ready, syncing]) => {
        if (ready && !syncing) {
          stop()
          resolve()
        }
      }
    )
    window.setTimeout(() => {
      stop()
      resolve()
    }, 20000)
  })
}

// 同步在页面打开后才完成时，把仍停在"无记录的一天"的锚点挪到最近有记录的一天
watch([() => state.records.length, () => state.ready], () => {
  if (anchorTouched || !state.ready || !state.records.length) return
  const hasCurrent = state.records.some((r) => !r.deletedAt && r.date === anchor.value)
  if (hasCurrent) return
  const latest = latestDayWithRecords()
  if (latest !== anchor.value) anchor.value = latest
})

/**
 * 默认定位：今天有记录就看今天；今天还没记（早上刚打开、或最近停工），
 * 直接落到最近有记录的那一天，省得一进来是空图。
 */
function latestDayWithRecords(): string {
  const today = todayStr()
  const dates = scopeRecords.value.map((r) => r.date)
  if (!dates.length || dates.includes(today)) return today
  return dates.sort()[dates.length - 1]
}

onMounted(() => {
  void initPosition()
})
</script>

<template>
  <van-nav-bar title="效率看板" fixed placeholder />

  <div class="page">
    <ScopePicker />

    <van-tabs v-model:active="periodType" type="card">
      <van-tab title="日" name="day" />
      <van-tab title="周" name="week" />
      <van-tab title="月" name="month" />
    </van-tabs>

    <div class="card" style="margin-top: 12px">
      <div class="row-between">
        <van-icon name="arrow-left" size="18" @click="move(-1)" />
        <div class="period-center" @click="openPeriodPicker">
          <div class="num period-label">{{ periodLabel }}<van-icon name="arrow-down" size="12" /></div>
          <div class="muted">点这里选日期</div>
        </div>
        <van-icon name="arrow" size="18" @click="move(1)" />
      </div>
      <div class="divider" />
      <div class="muted scope-echo">当前范围：{{ scopeName }}</div>
      <div class="muted today-link" @click="goToday">回到今天</div>
    </div>

    <div class="kpi-grid">
      <StatCard label="实际工时" :value="fmtHoursShort(stats.actualHours)" :hint="`${stats.recordCount} 条记录`" />
      <StatCard label="基准工时" :value="fmtHoursShort(stats.baselineHours)" :hint="caliberText" />
      <StatCard
        label="效率（总量口径）"
        :value="fmtPercent(stats.totalEfficiency)"
        tone="efficiency"
        :ratio="stats.totalEfficiency"
        :hint="
          efficiencyDelta === null
            ? caliberText
            : `较上期 ${efficiencyDelta >= 0 ? '+' : ''}${(efficiencyDelta * 100).toFixed(1)} 个百分点`
        "
      />
      <StatCard
        label="效率（工序平均）"
        :value="fmtPercent(stats.avgDeviation)"
        tone="efficiency"
        :ratio="stats.avgDeviation"
        hint="各工序偏差率的平均值"
      />
      <StatCard
        label="衔接空隙"
        :value="fmtHoursShort(stats.gapHours)"
        :hint="`占周期 ${(gapRatio * 100).toFixed(1)}% · ${stats.gapCount} 处`"
      />
      <StatCard
        label="工时环比"
        :value="hoursDelta === null ? '—' : `${hoursDelta >= 0 ? '+' : ''}${(hoursDelta * 100).toFixed(1)}%`"
        :hint="`上期 ${fmtHoursShort(prevStats.actualHours)}`"
      />
      <StatCard
        label="开挖循环总用时"
        :value="excCycle.count ? fmtHoursShort(excCycle.totalHours) : '—'"
        :hint="cycleHint(excCycle)"
      />
      <StatCard
        label="支护循环总用时"
        :value="supCycle.count ? fmtHoursShort(supCycle.totalHours) : '—'"
        :hint="cycleHint(supCycle)"
      />
    </div>

    <div v-if="stats.recordCount === 0" class="card tip-card">
      该范围在本周期内没有记录。可切换分析范围，或点上面的“点这里回到今天 / 往前翻”。
    </div>
    <div v-else-if="stats.baselineSource === 'none'" class="card tip-card" @click="router.push('/manage')">
      该范围还没有基准：标准用时与参考用时都为空，效率显示“—”。可到「工程 → 标准用时」补上 →
    </div>
    <div v-else-if="stats.baselineSource !== 'standard'" class="card tip-card">
      当前按<b>参考口径</b>计算（标准用时未填的工序用实测参考用时）。到「工程 → 标准用时」一键采用后自动切回标准口径。
    </div>
    <div v-if="exceedPeriods.length" class="card tip-card warn">
      有 {{ exceedPeriods.length }} 天单日工时超过 24 小时（图中日期标红），可能是同一天有重复或重叠记录，建议到明细页核对。
    </div>

    <div class="card">
      <div class="card-title">
        循环用时（开挖 / 支护）
        <span class="sub">每轮作业用时 · 已剔除 &gt;6h 停工</span>
      </div>
      <ChartBox
        v-if="cycleChart.rows.length"
        :option="cycleChartOption"
        :height="Math.max(180, cycleChart.rows.length * 34 + 50)"
      />
      <van-empty v-else description="本期没有完整循环" image-size="60" />
      <div v-if="cycleChart.restCount" class="muted" style="margin-top: 6px; text-align: right">
        另有 {{ cycleChart.restCount }} 轮（合计 {{ fmtHoursShort(cycleChart.restHours) }}）未画出
      </div>
    </div>

    <div v-if="periodType === 'day'" class="card">
      <div class="card-title">
        一天在干什么（24 小时圆盘）
        <span class="sub">整圈 24h · 半圈 12h</span>
      </div>
      <DayRing v-if="dayRing.stats.count" :data="dayRing" :date-label="anchor.slice(5)" @pick="openRecord" />
      <van-empty v-else description="这一天没有记录" image-size="60" />
    </div>

    <div class="card">
      <div class="card-title">
        工序用时排行
        <span class="sub">{{ rankHasReference ? '实际 vs 标准/参考' : '实际 vs 标准' }}</span>
      </div>
      <ChartBox
        v-if="rankRows.length"
        :option="processRankOption"
        :height="Math.max(200, rankRows.length * 38 + 60)"
      />
      <van-empty v-else description="本期没有工序记录" image-size="60" />
    </div>

    <div v-if="timePieRows.length > 1" class="card">
      <div class="card-title">
        {{ timePieTitle }}
        <span class="sub">按工时</span>
      </div>
      <ChartBox :option="timePieOption" :height="260" />
    </div>

    <div class="card">
      <div class="card-title">
        {{ trendTitle }}
        <span class="sub">柱：工时构成　线：效率</span>
      </div>
      <ChartBox :option="trendOption" :height="270" />
    </div>

    <div class="card">
      <div class="card-title">
        衔接空隙排行
        <span class="sub">超过 {{ GAP_TOLERANCE_MINUTES }} 分钟、6 小时以内</span>
      </div>
      <ChartBox
        v-if="gapTop.length"
        :option="gapRankOption"
        :height="Math.max(180, gapTop.length * 38 + 40)"
      />
      <van-empty v-else description="本期衔接顺畅，未发现明显空档" image-size="60" />
    </div>

    <div class="card">
      <div class="card-title">
        空隙原因分布
        <span class="sub">按等待时长</span>
      </div>
      <ChartBox v-if="reasonAgg.length" :option="reasonOption" :height="250" />
      <van-empty v-else description="还没有填写等待原因" image-size="60" />
    </div>

    <div v-if="itemProgress.some((i) => i.doneQty > 0)" class="card">
      <div class="card-title">
        分项工程完成情况
        <span class="sub">已完成 / 设计总量</span>
      </div>
      <div v-for="item in itemProgress" :key="item.itemId" class="progress-row">
        <div class="row-between">
          <div class="progress-name">{{ item.itemName }}</div>
          <div class="num muted">
            {{ item.doneQty.toFixed(1) }}<template v-if="item.designQty"> / {{ item.designQty }}</template>
            <template v-if="item.percent"> （{{ (item.percent * 100).toFixed(1) }}%）</template>
          </div>
        </div>
        <van-progress
          :percentage="Math.min(100, Math.round(item.percent * 100))"
          :show-pivot="false"
          stroke-width="6"
          color="#2b7fff"
          track-color="#eef1f5"
        />
      </div>
    </div>

    <van-button block plain type="primary" @click="openRecords">{{ recordsButtonLabel }}</van-button>
    <div class="bottom-space" />
  </div>

  <!-- 选日期：有记录的日期一点直达，要更早的再开日历 -->
  <van-popup v-model:show="showPeriodPicker" round position="bottom" :style="{ maxHeight: '76%' }">
    <div class="sheet">
      <div class="sheet-head">
        <div class="sheet-title">{{ pickerTitle }}</div>
        <span class="muted" @click="showPeriodPicker = false">关闭</span>
      </div>
      <div class="sheet-body">
        <template v-if="periodType === 'month'">
          <div class="group-title">有记录的月份（近 12 个）</div>
          <div class="chip-row">
            <button v-for="m in monthsWithData" :key="m" type="button" class="chip" @click="pickAnchorMonth(m)">
              {{ m }}
            </button>
          </div>
          <div class="group-title">或按月选择</div>
          <div class="sheet-actions">
            <van-picker
              :columns="monthColumns"
              :model-value="monthPickerValue"
              title=""
              @confirm="onMonthPickerConfirm"
            />
          </div>
        </template>

        <template v-else>
          <div class="group-title">有记录的日期（近 12 个）</div>
          <div v-if="datesWithData.length" class="chip-row">
            <button v-for="d in datesWithData" :key="d" type="button" class="chip" @click="pickAnchorDate(d)">
              {{ d.slice(5) }}
            </button>
          </div>
          <div v-else class="group-title">当前范围内还没有记录</div>
          <div class="group-title">
            {{ periodType === 'week' ? '选那一天，看它所在的周（周一~周日）' : '或按日历选任意一天' }}
          </div>
          <div class="sheet-actions">
            <van-button block round type="primary" plain @click="openPeriodCalendar">打开日历选择</van-button>
          </div>
        </template>
      </div>
    </div>
  </van-popup>

  <van-calendar
    v-model:show="showPeriodCalendar"
    :default-date="calendarValue"
    :min-date="new Date(2024, 0, 1)"
    :max-date="new Date()"
    switch-mode="year-month"
    @confirm="onPeriodCalendarConfirm"
  />
</template>

<style scoped>
.progress-row {
  padding: 8px 0;
}

.progress-name {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
}

.tip-card {
  font-size: 13px;
  color: #b26a00;
  background: #fff8e6;
  box-shadow: none;
}

.tip-card.warn {
  color: #d14343;
  background: #fdecec;
}

.scope-echo {
  word-break: break-all;
}

.period-center {
  min-width: 0;
  text-align: center;
}

.period-label {
  font-size: 14px;
  font-weight: 600;
}

.today-link {
  text-align: center;
  margin-top: 6px;
  color: #1f6feb;
}

.sheet {
  display: flex;
  flex-direction: column;
  max-height: 76vh;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid #f0f2f5;
}

.sheet-title {
  font-size: 16px;
  font-weight: 600;
  color: #1b2430;
}

.sheet-body {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 16px;
}

.group-title {
  padding: 12px 16px 6px;
  font-size: 12px;
  color: #8b95a1;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px;
}

.chip {
  border: 1px solid #dfe4ea;
  background: #f8f9fb;
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  color: #33404f;
}

.sheet-actions {
  padding: 6px 8px 0;
}
</style>
