<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'
import ChartBox from '@/components/ChartBox.vue'
import StatCard from '@/components/StatCard.vue'
import ScopePicker from '@/components/ScopePicker.vue'
import { state } from '@/store'
import {
  aggregateByProcess,
  aggregateByReason,
  buildTrend,
  computeGapRows,
  computeStats,
  completionByItem,
  daysOfPeriod,
  hoursByDate,
  monthPeriods,
  topGaps,
  weekPeriods,
  type PeriodRange
} from '@/core/compute'
import { aggregateByItem, filterByScope, shortItemLabel, stackedTrend } from '@/core/scope'
import { GAP_TOLERANCE_MINUTES } from '@/core/reasons'
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  fmtHoursShort,
  fmtPercent,
  monthKey,
  startOfMonth,
  startOfWeek,
  todayStr
} from '@/core/time'

type PeriodType = 'day' | 'week' | 'month'

const router = useRouter()
const periodType = ref<PeriodType>('week')
const anchor = ref(todayStr())
const calendarMonth = ref(monthKey(todayStr()))

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
const exceedPeriods = computed(() =>
  trendStack.value.totals.map((t, i) => (periodType.value === 'day' && t > 24.01 ? i : -1)).filter((i) => i >= 0)
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

// ------------------------------------------------------------------ 日历
const hoursMap = computed(() => hoursByDate(scopeRecords.value))

const calendarOption = computed<EChartsOption>(() => {
  const days: Array<[string, number]> = daysOfPeriod(
    `${calendarMonth.value}-01`,
    endOfMonth(`${calendarMonth.value}-01`)
  ).map((d) => [d, Number((hoursMap.value.get(d) ?? 0).toFixed(2))])
  const max = Math.max(4, ...days.map((d) => d[1]))
  return {
    tooltip: {
      formatter: (p: unknown) => {
        const v = p as { data?: [string, number] }
        return `${v.data?.[0]}<br/>工时 ${v.data?.[1]} 小时`
      }
    },
    visualMap: {
      min: 0,
      max,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 80,
      textStyle: { fontSize: 9 },
      inRange: { color: ['#eef4ff', '#a9c8ff', '#5b96ff', '#1f6feb'] }
    },
    calendar: {
      top: 22,
      left: 30,
      right: 10,
      bottom: 46,
      range: calendarMonth.value,
      cellSize: ['auto', 'auto'],
      splitLine: { show: false },
      itemStyle: { borderWidth: 2, borderColor: '#fff', color: '#f2f4f7' },
      dayLabel: { firstDay: 1, fontSize: 9, color: '#8b95a1', nameMap: ['日', '一', '二', '三', '四', '五', '六'] },
      monthLabel: { show: false },
      yearLabel: { show: false }
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: days,
        label: {
          show: true,
          fontSize: 9,
          color: '#4a5461',
          formatter: (p: unknown) => String((p as { data: [string, number] }).data[0]).slice(-2)
        }
      }
    ]
  }
})

const itemProgress = computed(() => completionByItem(inRange.value, processById.value, wbsById.value))

function move(delta: number) {
  if (periodType.value === 'day') anchor.value = addDays(anchor.value, delta)
  else if (periodType.value === 'week') anchor.value = addDays(anchor.value, delta * 7)
  else anchor.value = `${addMonths(monthKey(anchor.value), delta)}-01`
  calendarMonth.value = monthKey(anchor.value)
}

function goToday() {
  anchor.value = todayStr()
  calendarMonth.value = monthKey(anchor.value)
}
</script>

<template>
  <van-nav-bar title="效率看板" fixed placeholder />

  <div class="page">
    <ScopePicker />

    <van-tabs v-model:active="periodType" type="card" @change="goToday">
      <van-tab title="日" name="day" />
      <van-tab title="周" name="week" />
      <van-tab title="月" name="month" />
    </van-tabs>

    <div class="card" style="margin-top: 12px">
      <div class="row-between">
        <van-icon name="arrow-left" size="18" @click="move(-1)" />
        <div style="text-align: center; min-width: 0">
          <div class="num" style="font-size: 14px; font-weight: 600">{{ periodLabel }}</div>
          <div class="muted" @click="goToday">点这里回到今天</div>
        </div>
        <van-icon name="arrow" size="18" @click="move(1)" />
      </div>
      <div class="divider" />
      <div class="muted scope-echo">当前范围：{{ scopeName }}</div>
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
        {{ trendTitle }}
        <span class="sub">柱：工时构成　线：效率</span>
      </div>
      <ChartBox :option="trendOption" :height="270" />
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

    <div class="card">
      <div class="card-title">
        日历热力图
        <span class="sub">{{ calendarMonth }} 每日工时</span>
      </div>
      <ChartBox :option="calendarOption" :height="260" />
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

    <van-button
      block
      plain
      type="primary"
      @click="router.push({ path: '/records', query: { month: calendarMonth } })"
    >
      查看记录明细（{{ calendarMonth }}）
    </van-button>
    <div class="bottom-space" />
  </div>
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
</style>
