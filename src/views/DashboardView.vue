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
  computeGapRows,
  computeStats,
  isCompleteRecord,
  isEndPending,
  topGaps,
  type PeriodRange
} from '@/core/compute'
import { buildDayRing } from '@/core/dayRing'
import {
  CYCLE_FAMILIES,
  buildCombinedCycles,
  buildCycles,
  cycleChainageText,
  cycleLabel,
  cyclesInPeriod,
  filterCombinedByPeriod,
  filterCyclesByChainage,
  summarizeCycles,
  type Cycle,
  type CycleFamily
} from '@/core/cycles'
import { aggregateByWorkface, chainageOptionsOf, filterByScope, shortItemLabel, stackedTrend } from '@/core/scope'
import { buildItemWorkfaceMap } from '@/core/workface'
import { mergeChainages, parseChainageRange, recordChainage, shortChainageText } from '@/core/chainage'
import { GAP_TOLERANCE_MINUTES } from '@/core/reasons'
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  fmtDate,
  fmtHoursShort,
  fmtPercent,
  listDates,
  monthKey,
  parseDate,
  startOfMonth,
  startOfWeek,
  todayStr
} from '@/core/time'

type PeriodType = 'day' | 'week' | 'month'
type DashTab = 'overview' | 'cycles' | 'issues'
type CycleTab = CycleFamily | 'both'

const route = useRoute()
const router = useRouter()
const DASHBOARD_KV = 'ui.dashboard'

const tab = ref<DashTab>('overview')
const cycleTab = ref<CycleTab>('exc')
const periodType = ref<PeriodType>('day')
const anchor = ref(todayStr())
const showPeriodPicker = ref(false)
const showPeriodCalendar = ref(false)
const calendarValue = ref(parseDate(todayStr()))
/** 用户主动选过日期后，就不再自动把锚点挪到"最近有记录的一天" */
let anchorTouched = false

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))
const workfaceById = computed(() => new Map(state.workfaces.map((w) => [w.id, w])))
const itemWorkface = computed(() => buildItemWorkfaceMap(state.wbs, state.workfaces))

function faceNameOf(workfaceId: string | undefined): string {
  return workfaceId ? workfaceById.value.get(workfaceId)?.name ?? '' : ''
}

/** 只按单位工程 / 工作面筛，不含桩号与日期：循环必须在这份完整记录上识别 */
const baseRecords = computed(() =>
  filterByScope(
    state.records,
    { level: state.scope.level, unitId: state.scope.unitId, workfaceId: state.scope.workfaceId },
    processById.value,
    wbsById.value,
    itemWorkface.value
  )
)

/** 当前分析范围内的记录（含桩号筛选） */
const scopeRecords = computed(() =>
  filterByScope(state.records, state.scope, processById.value, wbsById.value, itemWorkface.value)
)

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

const inRange = computed(() =>
  scopeRecords.value.filter((r) => r.date >= range.value.from && r.date <= range.value.to)
)

const stats = computed(() => computeStats(scopeRecords.value, processById.value, range.value.from, range.value.to))
const prevStats = computed(() =>
  computeStats(scopeRecords.value, processById.value, prevRange.value.from, prevRange.value.to)
)

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

// ------------------------------------------------------------- 一天在干什么
const dayRing = computed(() =>
  buildDayRing({
    date: anchor.value,
    records: inRange.value,
    processById: processById.value,
    wbsById: wbsById.value,
    byProcess: state.scope.level === 'workface',
    itemWorkface: itemWorkface.value,
    workfaceById: workfaceById.value
  })
)

const dayPeriods = computed<PeriodRange[]>(() =>
  listDates(range.value.from, range.value.to).map((d) => ({ from: d, to: d, key: d, label: d.slice(5) }))
)

const dailyStack = computed(() =>
  stackedTrend(inRange.value, processById.value, wbsById.value, dayPeriods.value, 'workface', 6, {
    itemWorkface: itemWorkface.value,
    workfaceById: workfaceById.value
  })
)

/** 每天涉及的桩号，tooltip 里一并给出 */
const dailyChainages = computed(() =>
  dayPeriods.value.map((period) => {
    const values = inRange.value
      .filter((r) => r.date >= period.from && r.date <= period.to)
      .map(recordChainage)
    return mergeChainages(values).ranges.map(shortChainageText)
  })
)

const dailyMainOption = computed<EChartsOption>(() => {
  const stack = dailyStack.value
  const series = stack.series.map((s) => ({
    name: s.name,
    type: 'bar',
    stack: 'hours',
    data: s.data,
    barMaxWidth: 16,
    emphasis: { focus: 'series' }
  }))
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as Array<{ dataIndex: number; marker: string; seriesName: string; value: number }>
        const first = list[0]
        if (!first) return ''
        const lines = [`<b>${dayPeriods.value[first.dataIndex]?.from ?? ''}</b>`]
        list.forEach((p) => lines.push(`${p.marker}${p.seriesName}：${Number(p.value).toFixed(1)}h`))
        lines.push(`合计 ${Number(stack.totals[first.dataIndex] ?? 0).toFixed(1)}h`)
        const chains = dailyChainages.value[first.dataIndex] ?? []
        if (chains.length) lines.push(`桩号 ${chains.slice(0, 3).join(' / ')}${chains.length > 3 ? ' 等' : ''}`)
        return lines.join('<br/>')
      }
    },
    legend: { type: 'scroll', top: 0, itemHeight: 8, textStyle: { fontSize: 10 }, pageTextStyle: { fontSize: 10 } },
    grid: { left: 38, right: 14, top: 34, bottom: 24 },
    xAxis: {
      type: 'category',
      data: stack.labels,
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      axisLine: { lineStyle: { color: '#e8eaee' } }
    },
    yAxis: {
      type: 'value',
      name: 'h',
      nameTextStyle: { fontSize: 10, color: '#8b95a1' },
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    series
  } as EChartsOption
})

const workfaceAgg = computed(() =>
  aggregateByWorkface(inRange.value, processById.value, wbsById.value, itemWorkface.value, workfaceById.value)
)

// ------------------------------------------------------------------ 循环
const cycleContext = computed(() => ({
  processById: processById.value,
  itemWorkface: itemWorkface.value
}))

/** 先在"单位工程 / 工作面"的完整记录上识别，再套桩号与日期，桩号缺失不会打断轮次边界 */
const allCycles = computed(() => buildCycles(baseRecords.value, cycleContext.value))
const periodCycles = computed(() =>
  filterCyclesByChainage(cyclesInPeriod(allCycles.value, range.value.from, range.value.to), state.scope.chainage)
)
const excSummary = computed(() => summarizeCycles(periodCycles.value, 'exc'))
const supSummary = computed(() => summarizeCycles(periodCycles.value, 'sup'))

/** 综合模式只在"单一工作面 + 桩号"时启用 */
const combinedAvailable = computed(() => state.scope.level === 'workface' && Boolean(state.scope.chainage))
const combinedResult = computed(() => {
  if (!combinedAvailable.value) return null
  // 配对用全量循环（不按日期裁剪），再按综合轮结束日裁周期：
  // 否则周期前开工、周期内完工的开挖会被裁掉，支护就会被误判成"缺开挖"。
  const built = buildCombinedCycles(
    allCycles.value.filter((c) => c.family === 'exc'),
    allCycles.value.filter((c) => c.family === 'sup'),
    state.scope.chainage
  )
  return filterCombinedByPeriod(built, range.value.from, range.value.to)
})
const combinedAvgText = computed(() => {
  const avg = combinedResult.value?.avgHours
  return avg === null || avg === undefined ? '—' : fmtHoursShort(avg)
})
/** 综合视图里把某轮的日期说清楚 */
function combinedLabel(startDate: string, endDate: string, spansDays: boolean): string {
  return `${startDate.slice(5)}${spansDays ? `→${endDate.slice(5)}` : ''}`
}

watch(combinedAvailable, (ok) => {
  if (!ok && cycleTab.value === 'both') cycleTab.value = 'exc'
})

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

interface CycleRow {
  cycle: Cycle
  label: string
  faceName: string
  color: string
}

const cycleRows = computed(() => {
  if (cycleTab.value === 'both') return { rows: [] as CycleRow[], rest: 0, restHours: 0 }
  const rows = periodCycles.value.filter((c) => c.family === cycleTab.value)
  const counter = new Map<string, number>()
  const labeled: CycleRow[] = rows.map((c) => {
    const key = `${c.startDate}-${c.workfaceId || c.itemId}-${c.family}`
    const n = (counter.get(key) ?? 0) + 1
    counter.set(key, n)
    const faceName = faceNameOf(c.workfaceId)
    const itemName = wbsById.value.get(c.itemId)?.name ?? ''
    return {
      cycle: c,
      label: cycleLabel(c, { workfaceName: faceName, itemName, index: n }),
      faceName: faceName || (itemName ? shortItemLabel(itemName) : '未分工作面'),
      color: CYCLE_FAMILIES[c.family].color
    }
  })
  const shown = labeled.slice(-12)
  const rest = labeled.slice(0, Math.max(0, labeled.length - shown.length))
  return {
    rows: shown.reverse(),
    rest: rest.length,
    restHours: rest.reduce((s, r) => s + r.cycle.hours, 0)
  }
})

const cycleChartOption = computed<EChartsOption>(() => {
  const rows = cycleRows.value.rows
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        const row = rows[arr[0]?.dataIndex ?? 0]
        if (!row) return ''
        const c = row.cycle
        const lines = [
          `<b>${row.label}</b>`,
          `工作面：${row.faceName}`,
          `时间：${fmtTs(c.startAt)} → ${fmtTs(c.endAt)}（首道开工 → 末道完工）`,
          `用时 ${c.hours.toFixed(1)}h · ${c.steps} 条记录${c.spansDays ? ' · 跨天作业' : ''}${
            c.incomplete ? ' · 未完' : ''
          }`
        ]
        const chainLine = cycleChainageText(c)
        if (chainLine) lines.push(chainLine)
        return lines.join('<br/>')
      }
    },
    grid: { left: 118, right: 52, top: 8, bottom: 22 },
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
      axisLabel: {
        fontSize: 9,
        color: '#4a5461',
        lineHeight: 11,
        width: 112,
        overflow: 'truncate',
        // 「工作面 · 桩号 · 类型」拆两行：第一行工作面+桩号，第二行开挖/支护
        formatter: (value: string) => {
          const parts = value.split(' · ')
          if (parts.length >= 3) return `${parts[0]} · ${parts[1]}\n${parts.slice(2).join(' · ')}`
          const m = /^(\d{2}-\d{2}) (.+)$/.exec(value)
          return m ? `${m[1]}\n${m[2]}` : value
        }
      }
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 12,
        data: rows.map((r) => ({ value: Number(r.cycle.hours.toFixed(2)), itemStyle: { color: r.color } })),
        label: {
          show: true,
          position: 'right',
          fontSize: 8,
          color: '#4a5461',
          formatter: (p: unknown) => {
            const idx = (p as { dataIndex: number }).dataIndex
            const r = rows[idx]
            if (!r) return ''
            return `${r.cycle.hours.toFixed(1)}h${r.cycle.spansDays ? ' 跨天' : ''}${
              r.cycle.incomplete ? ' 未完' : ''
            }`
          }
        }
      }
    ]
  } as EChartsOption
})

const combinedRows = computed(() => {
  const rounds = combinedResult.value?.rounds ?? []
  return rounds.slice(-12).reverse().map((r) => ({
    ...r,
    label: combinedLabel(r.startDate, r.endDate, r.spansDays)
  }))
})

const combinedChartOption = computed<EChartsOption>(() => {
  const rows = combinedRows.value
  const face = faceNameOf(state.scope.workfaceId)
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        const row = rows[arr[0]?.dataIndex ?? 0]
        if (!row) return ''
        const lines = [`<b>${row.label}</b>`, `工作面：${face}`]
        lines.push(row.excHours === null ? '开挖段：缺' : `开挖段 ${row.excHours.toFixed(1)}h`)
        if (row.gapHours !== null) lines.push(`间隔 ${row.gapHours.toFixed(1)}h`)
        lines.push(row.supHours === null ? '支护段：缺' : `支护段 ${row.supHours.toFixed(1)}h`)
        lines.push(row.hours === null ? '综合用时：缺环节，不计算' : `综合 ${row.hours.toFixed(1)}h`)
        if (state.scope.chainage) lines.push(`桩号 ${shortChainageText(state.scope.chainage)}`)
        return lines.join('<br/>')
      }
    },
    legend: { data: ['开挖段', '间隔', '支护段'], top: 0, itemHeight: 8, textStyle: { fontSize: 10 } },
    grid: { left: 62, right: 30, top: 30, bottom: 22 },
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
        name: '开挖段',
        type: 'bar',
        stack: 'span',
        data: rows.map((r) => (r.excHours === null ? null : Number(r.excHours.toFixed(2)))),
        barMaxWidth: 14,
        itemStyle: { color: CYCLE_FAMILIES.exc.color }
      },
      {
        name: '间隔',
        type: 'bar',
        stack: 'span',
        data: rows.map((r) => (r.gapHours === null ? null : Number(r.gapHours.toFixed(2)))),
        itemStyle: { color: '#d7dde5' }
      },
      {
        name: '支护段',
        type: 'bar',
        stack: 'span',
        data: rows.map((r) => (r.supHours === null ? null : Number(r.supHours.toFixed(2)))),
        itemStyle: { color: CYCLE_FAMILIES.sup.color }
      }
    ]
  } as EChartsOption
})

// --------------------------------------------------------------- 问题排查
const gapRows = computed(() => computeGapRows(inRange.value, processById.value))
const pendingInRange = computed(() => inRange.value.filter(isEndPending))
const gapTop = computed(() =>
  topGaps(gapRows.value, 8).map((g) => ({
    ...g,
    itemName: wbsById.value.get(g.itemId)?.name ?? '未归类',
    faceName: faceNameOf(itemWorkface.value.get(g.itemId))
  }))
)

/**
 * 单日超 24h 只在"单一工作面"范围内算异常：
 * 全部 / 单位工程是多条洞并行，合计超 24h 是正常的，不能误报。
 */
const singleWorkface = computed(() => state.scope.level === 'workface' && Boolean(state.scope.workfaceId))

const exceedDays = computed(() => {
  if (!singleWorkface.value) return []
  const map = new Map<string, { date: string; hours: number; count: number }>()
  inRange.value.filter(isCompleteRecord).forEach((r) => {
    const row = map.get(r.date) ?? { date: r.date, hours: 0, count: 0 }
    row.hours += r.hours
    row.count += 1
    map.set(r.date, row)
  })
  return Array.from(map.values())
    .filter((row) => row.hours > 24.01)
    .sort((a, b) => b.hours - a.hours)
})

/** 本周期内"结构范围"的完整记录（不含桩号筛选）：统计桩号缺失要用它当分母，否则选了桩号永远是 0 */
const periodBase = computed(() =>
  baseRecords.value.filter((r) => r.date >= range.value.from && r.date <= range.value.to)
)

const missingChainage = computed(() => periodBase.value.filter((r) => !parseChainageRange(recordChainage(r))))

const missingChainageFaces = computed(() => {
  const map = new Map<string, { name: string; count: number }>()
  missingChainage.value.forEach((r) => {
    const p = processById.value.get(r.processId)
    if (!p) return
    const face = faceNameOf(itemWorkface.value.get(p.itemId))
    const name = face || shortItemLabel(wbsById.value.get(p.itemId)?.name ?? '未归类')
    const row = map.get(name) ?? { name, count: 0 }
    row.count += 1
    map.set(name, row)
  })
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
})

/** 本周期已出现过的桩号段数（不受当前桩号筛选影响，便于判断筛掉多少） */
const chainageCount = computed(
  () =>
    chainageOptionsOf({
      records: periodBase.value,
      processById: processById.value,
      wbsById: wbsById.value,
      itemWorkface: itemWorkface.value,
      workfaceById: workfaceById.value
    }).length
)

/** 缺环节的轮（只有选定单工作面 + 桩号时才知道怎么配对） */
const combinedMissing = computed(() =>
  (combinedResult.value?.rounds ?? [])
    .filter((r) => r.missing.length > 0)
    .map((r) => ({ ...r, label: combinedLabel(r.startDate, r.endDate, r.spansDays) }))
)

const gapRankOption = computed<EChartsOption>(() => {
  const top = [...gapTop.value].reverse()
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        const item = top[arr[0]?.dataIndex ?? 0]
        if (!item) return ''
        return `${item.faceName || item.itemName}<br/>${item.prevProcessName} → ${item.processName}<br/>空隙 ${item.gapHours.toFixed(
          1
        )} 小时<br/>${item.date}${item.chainage ? '<br/>桩号 ' + item.chainage : ''}${
          item.reason ? '<br/>原因：' + item.reason : ''
        }`
      }
    },
    grid: { left: 116, right: 26, top: 12, bottom: 18 },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    yAxis: {
      type: 'category',
      data: top.map((g) => `${g.faceName || shortItemLabel(g.itemName)}\n${g.processName}`),
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
  } as EChartsOption
})

// ------------------------------------------------------- 选日期 / 选周期
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

const datesWithData = computed(() => {
  const set = new Set(scopeRecords.value.map((r) => r.date))
  return Array.from(set).sort().reverse().slice(0, 12)
})

const monthsWithData = computed(() =>
  Array.from(new Set(scopeRecords.value.map((r) => monthKey(r.date)))).sort().slice(-12).reverse()
)

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

function openRecords() {
  if (periodType.value === 'day') {
    void router.push({ path: '/records', query: { month: monthKey(anchor.value), date: anchor.value } })
  } else {
    void router.push({ path: '/records', query: { month: monthKey(range.value.from) } })
  }
}

function openRecord(recordId: string) {
  void router.push({ path: '/record', query: { id: recordId } })
}

function openDay(date: string) {
  void router.push({ path: '/records', query: { month: monthKey(date), date } })
}

const recordsButtonLabel = computed(() =>
  periodType.value === 'day'
    ? `查看记录明细（${anchor.value.slice(5)}）`
    : `查看记录明细（${monthKey(range.value.from)}）`
)

watch([periodType, anchor], () => {
  calendarValue.value = parseDate(anchor.value)
  void setKv(DASHBOARD_KV, { periodType: periodType.value, anchor: anchor.value })
})

async function initPosition() {
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

watch([() => state.records.length, () => state.ready], () => {
  if (anchorTouched || !state.ready || !state.records.length) return
  const hasCurrent = state.records.some((r) => !r.deletedAt && r.date === anchor.value)
  if (hasCurrent) return
  const latest = latestDayWithRecords()
  if (latest !== anchor.value) anchor.value = latest
})

function latestDayWithRecords(): string {
  const today = todayStr()
  const dates = scopeRecords.value.map((r) => r.date)
  if (!dates.length || dates.includes(today)) return today
  return dates.sort()[dates.length - 1]
}

/** 当前工作面名称（综合卡片标题用） */
const currentWorkfaceName = computed(() => faceNameOf(state.scope.workfaceId))

/** 综合视图当前桩号 */
const currentChainage = computed(() => (state.scope.chainage ? shortChainageText(state.scope.chainage) : ''))

onMounted(() => {
  void initPosition()
})
</script>

<template>
  <van-nav-bar title="效率看板" fixed placeholder />

  <div class="page">
    <ScopePicker />

    <van-tabs v-model:active="tab" type="card">
      <van-tab title="总览" name="overview" />
      <van-tab title="循环分析" name="cycles" />
      <van-tab title="问题排查" name="issues" />
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
      <van-tabs v-model:active="periodType" type="card">
        <van-tab title="日" name="day" />
        <van-tab title="周" name="week" />
        <van-tab title="月" name="month" />
      </van-tabs>
      <div class="muted today-link" @click="goToday">回到今天</div>
    </div>

    <!-- ------------------------------------------------------------ 总览 -->
    <template v-if="tab === 'overview'">
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
          label="衔接空隙"
          :value="fmtHoursShort(stats.gapHours)"
          :hint="`占周期 ${(gapRatio * 100).toFixed(1)}% · ${stats.gapCount} 处`"
        />
      </div>

      <div v-if="stats.recordCount === 0" class="card tip-card">
        该范围在本周期内没有记录。可修改筛选，或点上面的日期往前翻。
      </div>
      <div v-else-if="stats.baselineSource === 'none'" class="card tip-card" @click="router.push('/manage')">
        该范围还没有基准：标准用时与参考用时都为空，效率显示“—”。可到「工程 → 标准用时」补上 →
      </div>
      <div v-else-if="stats.baselineSource !== 'standard'" class="card tip-card">
        当前按<b>参考口径</b>计算（标准用时未填的工序用实测参考用时）。
      </div>

      <div class="card">
        <div class="card-title">
          一天在干什么
          <span class="sub">{{
            periodType === 'day' ? '整圈 24h · 详情含工作面与桩号' : '每天工时构成 · 按工作面'
          }}</span>
        </div>
        <template v-if="periodType === 'day'">
          <DayRing v-if="dayRing.stats.count" :data="dayRing" :date-label="anchor.slice(5)" @pick="openRecord" />
          <van-empty v-else description="这一天没有记录" image-size="60" />
        </template>
        <template v-else>
          <ChartBox v-if="inRange.length" :option="dailyMainOption" :height="280" />
          <van-empty v-else description="本周期没有记录" image-size="60" />
          <div v-if="workfaceAgg.length" class="face-summary">
            <span v-for="row in workfaceAgg.slice(0, 4)" :key="row.workfaceId" class="face-pill">
              {{ row.workfaceName }} {{ fmtHoursShort(row.actualHours) }}
            </span>
          </div>
        </template>
      </div>
    </template>

    <!-- -------------------------------------------------------- 循环分析 -->
    <template v-else-if="tab === 'cycles'">
      <div class="seg" role="group" aria-label="循环类型">
        <button
          type="button"
          class="seg-btn"
          :class="{ active: cycleTab === 'exc' }"
          :aria-pressed="cycleTab === 'exc'"
          aria-label="看开挖循环"
          @click="cycleTab = 'exc'"
        >
          开挖
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: cycleTab === 'sup' }"
          :aria-pressed="cycleTab === 'sup'"
          aria-label="看支护循环"
          @click="cycleTab = 'sup'"
        >
          支护
        </button>
        <button
          type="button"
          class="seg-btn"
          :class="{ active: cycleTab === 'both' }"
          :aria-pressed="cycleTab === 'both'"
          :disabled="!combinedAvailable"
          :aria-label="combinedAvailable ? '看开挖与支护综合' : '综合视图需先选定单一工作面和桩号'"
          @click="cycleTab = 'both'"
        >
          综合
        </button>
      </div>

      <div v-if="!combinedAvailable" class="card tip-card">
        综合模式只在<b>选定单一工作面 + 一个桩号</b>时可用：点「修改筛选」选好工作面与桩号后再回来。
      </div>

      <template v-if="cycleTab !== 'both'">
        <div class="kpi-grid three">
          <StatCard
            :label="cycleTab === 'exc' ? '开挖轮数' : '支护轮数'"
            :value="String(cycleTab === 'exc' ? excSummary.count : supSummary.count)"
            :hint="cycleHint(cycleTab === 'exc' ? excSummary : supSummary)"
          />
          <StatCard
            label="循环总用时"
            :value="fmtHoursShort(cycleTab === 'exc' ? excSummary.totalHours : supSummary.totalHours)"
            hint="首道开工 → 末道完工"
          />
          <StatCard
            label="平均每轮"
            :value="fmtHoursShort(cycleTab === 'exc' ? excSummary.avgHours : supSummary.avgHours)"
            :hint="`跨天 ${cycleTab === 'exc' ? excSummary.spanning : supSummary.spanning} 轮`"
          />
        </div>

        <div class="card">
          <div class="card-title">
            {{ cycleTab === 'exc' ? '开挖循环用时' : '支护循环用时' }}
            <span class="sub">{{ state.scope.chainage ? '已按桩号筛选' : '含跨天与中间停工' }}</span>
          </div>
          <ChartBox
            v-if="cycleRows.rows.length"
            :option="cycleChartOption"
            :height="Math.max(200, cycleRows.rows.length * 42 + 50)"
          />
          <van-empty v-else description="本期没有完整循环" image-size="60" />
          <div v-if="cycleRows.rest" class="muted" style="margin-top: 6px; text-align: right">
            另有 {{ cycleRows.rest }} 轮（合计 {{ fmtHoursShort(cycleRows.restHours) }}）未画出
          </div>
        </div>
      </template>

      <template v-else>
        <div class="kpi-grid three">
          <StatCard
            label="完整轮数"
            :value="String(combinedResult?.complete ?? 0)"
            :hint="`缺支护 ${combinedResult?.missingSup ?? 0} · 缺开挖 ${combinedResult?.missingExc ?? 0}`"
          />
          <StatCard label="综合总用时" :value="fmtHoursShort(combinedResult?.totalHours ?? 0)" hint="只累加完整轮" />
          <StatCard label="平均每轮" :value="combinedAvgText" hint="开挖首道 → 支护末道" />
        </div>

        <div v-if="combinedMissing.length" class="card tip-card warn">
          有 {{ combinedResult?.missingSup ?? 0 }} 轮缺支护、{{ combinedResult?.missingExc ?? 0 }} 轮缺开挖，
          这些轮不生成综合用时（避免造假数据），可在下方明细里核对。
        </div>

        <div class="card">
          <div class="card-title">
            综合用时（{{ currentWorkfaceName }} · {{ currentChainage }}）
            <span class="sub">开挖首道开工 → 支护末道完工</span>
          </div>
          <ChartBox
            v-if="combinedRows.length"
            :option="combinedChartOption"
            :height="Math.max(200, combinedRows.length * 42 + 60)"
          />
          <van-empty v-else description="本期没有可配对的循环" image-size="60" />
        </div>

        <div v-if="combinedRows.length" class="card">
          <div class="card-title">逐轮明细<span class="sub">开挖段 / 间隔 / 支护段</span></div>
          <div v-for="row in combinedRows" :key="row.id" class="combined-row">
            <div class="row-between">
              <span class="combined-date">{{ row.label }}</span>
              <span v-if="row.hours !== null" class="num combined-total">{{ fmtHoursShort(row.hours) }}</span>
              <span v-else class="missing-tag">
                {{ row.missing.includes('exc') ? '缺开挖' : '缺支护' }}
              </span>
            </div>
            <div class="muted combined-parts">
              开挖段 {{ row.excHours === null ? '—' : fmtHoursShort(row.excHours) }} · 间隔
              {{ row.gapHours === null ? '—' : fmtHoursShort(row.gapHours) }} · 支护段
              {{ row.supHours === null ? '—' : fmtHoursShort(row.supHours) }}
            </div>
          </div>
        </div>
      </template>
    </template>

    <!-- -------------------------------------------------------- 问题排查 -->
    <template v-else>
      <div class="card">
        <div class="card-title">
          待补完工
          <span class="sub">已上传，完工前不计工时</span>
        </div>
        <div v-if="pendingInRange.length" class="issue-list">
          <button
            v-for="r in pendingInRange"
            :key="r.id"
            type="button"
            class="issue-row as-button"
            :aria-label="`补填 ${r.date} ${processById.get(r.processId)?.name ?? '工序'} 的完工时间`"
            @click="openRecord(r.id)"
          >
            <div class="issue-main">
              <div class="issue-title">
                {{ faceNameOf(itemWorkface.get(processById.get(r.processId)?.itemId ?? '')) || shortItemLabel(wbsById.get(processById.get(r.processId)?.itemId ?? '')?.name ?? '未归类') }}
                · {{ processById.get(r.processId)?.name ?? '未知工序' }}
              </div>
              <div class="muted">
                {{ r.date }} {{ r.startTime }} 开工 · {{ shortChainageText(recordChainage(r)) || '桩号未填' }}
              </div>
            </div>
            <span class="missing-tag">待补</span>
          </button>
        </div>
        <div v-else class="muted empty-line">本期没有待补完工记录</div>
      </div>

      <div class="card">
        <div class="card-title">
          异常：单日工时超过 24 小时
          <span class="sub">同一天重复或重叠记录</span>
        </div>
        <template v-if="exceedDays.length">
          <div v-for="row in exceedDays" :key="row.date" class="issue-row">
            <div class="issue-main">
              <div class="issue-title">{{ row.date }} · {{ fmtHoursShort(row.hours) }}</div>
              <div class="muted">{{ row.count }} 条记录，超过一天 24 小时</div>
            </div>
            <button type="button" class="chip" :aria-label="`查看 ${row.date} 的记录`" @click="openDay(row.date)">
              看明细
            </button>
          </div>
        </template>
        <div v-else-if="!singleWorkface" class="muted empty-line">
          {{ state.scope.level === 'workface' ? '这一个工作面没有单日超 24 小时' : '选定单一工作面后才判断单日超 24 小时（多条洞并行时合计超 24h 是正常的）' }}
        </div>
        <div v-else class="muted empty-line">没有单日超 24 小时的异常</div>
      </div>

      <div class="card">
        <div class="card-title">
          长间隔（衔接空隙）
          <span class="sub">超过 {{ GAP_TOLERANCE_MINUTES }} 分钟、6 小时以内</span>
        </div>
        <ChartBox v-if="gapTop.length" :option="gapRankOption" :height="Math.max(180, gapTop.length * 38 + 40)" />
        <div v-else class="muted empty-line">本期衔接顺畅，未发现明显空档</div>
        <div v-if="gapTop.length" class="issue-list">
          <button
            v-for="g in gapTop"
            :key="g.recordId"
            type="button"
            class="issue-row as-button"
            :aria-label="`查看 ${g.date} ${g.processName} 的记录`"
            @click="openRecord(g.recordId)"
          >
            <div class="issue-main">
              <div class="issue-title">
                {{ g.faceName || shortItemLabel(g.itemName) }} · {{ g.prevProcessName }} → {{ g.processName }}
              </div>
              <div class="muted">
                {{ g.date }} · {{ g.chainage ? '桩号 ' + g.chainage + ' · ' : '' }}{{ g.reason || '未填原因' }}
              </div>
            </div>
            <span class="num gap-hours">{{ fmtHoursShort(g.gapHours) }}</span>
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          缺失：桩号未填
          <span class="sub">按桩号分析会漏掉这些记录</span>
        </div>
        <div class="issue-summary">
          本周期 {{ periodBase.length }} 条记录里，<b>{{ missingChainage.length }}</b> 条没有可识别桩号；
          已出现桩号 {{ chainageCount }} 段。
        </div>
        <div v-if="missingChainageFaces.length" class="face-summary">
          <span v-for="row in missingChainageFaces.slice(0, 6)" :key="row.name" class="face-pill">
            {{ row.name }} {{ row.count }} 条
          </span>
        </div>
        <div class="muted" style="margin-top: 6px">
          桩号不批量回填；打开对应记录补填后，下一次同步即可按桩号查看。
        </div>
      </div>

      <div v-if="combinedAvailable" class="card">
        <div class="card-title">
          缺失：循环缺环节
          <span class="sub">综合视图配对结果</span>
        </div>
        <template v-if="combinedMissing.length">
          <div v-for="row in combinedMissing" :key="row.id" class="issue-row">
            <div class="issue-main">
              <div class="issue-title">{{ row.label }}</div>
              <div class="muted">
                {{ row.missing.includes('exc') ? '这一轮只有支护，缺开挖' : '这一轮只有开挖，缺支护' }}
              </div>
            </div>
            <button
              type="button"
              class="chip"
              :aria-label="`查看 ${row.startDate} 的记录`"
              @click="openDay(row.startDate)"
            >
              看明细
            </button>
          </div>
        </template>
        <div v-else class="muted empty-line">开挖与支护都配上了，没有缺环节</div>
      </div>
    </template>

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
            <van-picker :columns="monthColumns" :model-value="monthPickerValue" title="" @confirm="onMonthPickerConfirm" />
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
.kpi-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.kpi-grid.three :deep(.kpi) {
  padding: 10px;
}

.kpi-grid.three :deep(.kpi .value) {
  font-size: 17px;
}

.kpi-grid.three :deep(.kpi .muted) {
  font-size: 11px;
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

.seg {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.seg-btn {
  flex: 1;
  border: 1px solid #dfe4ea;
  background: #fff;
  border-radius: 10px;
  padding: 9px 0;
  font-size: 14px;
  color: #33404f;
  font-family: inherit;
}

.seg-btn.active {
  border-color: #1f6feb;
  background: #eef3ff;
  color: #1f6feb;
  font-weight: 600;
}

.seg-btn:disabled {
  color: #b6bec8;
  background: #f7f8fa;
}

.seg-btn:focus-visible,
.chip:focus-visible,
.issue-row.as-button:focus-visible {
  outline: 2px solid #1f6feb;
  outline-offset: 2px;
}

.face-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.face-pill {
  border: 1px solid #e6e9ee;
  background: #f8f9fb;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  color: #4a5461;
}

.combined-row {
  padding: 10px 0;
  border-bottom: 1px solid #f4f5f7;
}

.combined-date {
  font-size: 13px;
  font-weight: 600;
}

.combined-total {
  font-size: 14px;
  font-weight: 600;
  color: #1f6feb;
}

.combined-parts {
  margin-top: 4px;
  font-size: 12px;
}

.missing-tag {
  font-size: 12px;
  color: #d14343;
  background: #fdecec;
  border-radius: 6px;
  padding: 2px 8px;
}

.issue-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid #f4f5f7;
  width: 100%;
  background: transparent;
  text-align: left;
  font-family: inherit;
  border-left: none;
  border-right: none;
  border-bottom: none;
}

.issue-row.as-button {
  cursor: pointer;
}

.issue-main {
  min-width: 0;
}

.issue-title {
  font-size: 13px;
  font-weight: 500;
}

.issue-list {
  margin-top: 6px;
}

.empty-line {
  padding: 12px 0;
  font-size: 13px;
}

.issue-summary {
  font-size: 13px;
  line-height: 1.6;
}

.gap-hours {
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 600;
  color: #b26a00;
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
  font-family: inherit;
}

.sheet-actions {
  padding: 6px 8px 0;
}
</style>
