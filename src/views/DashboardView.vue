<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { EChartsOption } from 'echarts'
import ChartBox from '@/components/ChartBox.vue'
import StatCard from '@/components/StatCard.vue'
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

const periodLabel = computed(() => (periodType.value === 'day' ? anchor.value : `${range.value.from} ~ ${range.value.to}`))

const stats = computed(() => computeStats(state.records, processById.value, range.value.from, range.value.to))
const prevStats = computed(() => computeStats(state.records, processById.value, prevRange.value.from, prevRange.value.to))

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

const trend = computed(() => buildTrend(state.records, processById.value, trendPeriods.value))
const trendTitle = computed(() =>
  periodType.value === 'day' ? '近 14 天效率走势' : periodType.value === 'week' ? '近 12 周对比' : '近 12 月对比'
)

const trendOption = computed<EChartsOption>(() => ({
  tooltip: {
    trigger: 'axis',
    valueFormatter: (v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''))
  },
  legend: { data: ['实际工时', '总量口径效率'], top: 0, itemHeight: 8, textStyle: { fontSize: 11 } },
  grid: { left: 38, right: 46, top: 32, bottom: 24 },
  xAxis: {
    type: 'category',
    data: trend.value.map((t) => t.label),
    axisLabel: { fontSize: 9, color: '#8b95a1' },
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
  series: [
    {
      name: '实际工时',
      type: 'bar',
      data: trend.value.map((t) => Number(t.actualHours.toFixed(2))),
      itemStyle: { color: '#2b7fff', borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 16
    },
    {
      name: '总量口径效率',
      type: 'line',
      yAxisIndex: 1,
      data: trend.value.map((t) => (t.totalEfficiency === null ? null : Number(t.totalEfficiency.toFixed(4)))),
      smooth: true,
      connectNulls: true,
      symbolSize: 5,
      lineStyle: { color: '#f59e0b', width: 2 },
      itemStyle: { color: '#f59e0b' }
    }
  ]
}))

// ------------------------------------------------------------ 工序 / 空隙
const inRange = computed(() => state.records.filter((r) => r.date >= range.value.from && r.date <= range.value.to))

const procAgg = computed(() => aggregateByProcess(inRange.value, processById.value, wbsById.value))

const processRankOption = computed<EChartsOption>(() => {
  const top = procAgg.value.slice(0, 8).reverse()
  const hasRef = top.some((p) => !p.standardTotal && p.refTotal)
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {
      data: ['实际用时', hasRef ? '标准 / 参考用时' : '标准用时'],
      top: 0,
      itemHeight: 8,
      textStyle: { fontSize: 11 }
    },
    grid: { left: 74, right: 16, top: 30, bottom: 18 },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    yAxis: {
      type: 'category',
      data: top.map((p) => p.processName),
      axisLabel: { fontSize: 10, color: '#4a5461' }
    },
    series: [
      {
        name: '实际用时',
        type: 'bar',
        data: top.map((p) => Number(p.actualHours.toFixed(2))),
        itemStyle: { color: '#2b7fff', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 10
      },
      {
        name: hasRef ? '标准 / 参考用时' : '标准用时',
        type: 'bar',
        data: top.map((p) => {
          const baseline = p.standardTotal ?? p.refTotal
          return baseline === null || baseline === undefined ? 0 : Number(baseline.toFixed(2))
        }),
        itemStyle: { color: '#c9d8f5', borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 10
      }
    ]
  }
})

const gapRows = computed(() => computeGapRows(inRange.value, processById.value))
const gapTop = computed(() => topGaps(gapRows.value, 8))

const gapRankOption = computed<EChartsOption>(() => {
  const top = [...gapTop.value].reverse()
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number; value: number }>
        const item = top[arr[0]?.dataIndex ?? 0]
        if (!item) return ''
        return `${item.prevProcessName} → ${item.processName}<br/>空隙 ${item.gapHours.toFixed(1)} 小时<br/>${item.date}${item.reason ? '<br/>原因：' + item.reason : ''}`
      }
    },
    grid: { left: 88, right: 24, top: 12, bottom: 18 },
    xAxis: {
      type: 'value',
      axisLabel: { fontSize: 9, color: '#8b95a1' },
      splitLine: { lineStyle: { color: '#f2f3f5' } }
    },
    yAxis: {
      type: 'category',
      data: top.map((g) => `${g.prevProcessName}→${g.processName}`.slice(0, 14)),
      axisLabel: { fontSize: 9, color: '#4a5461' }
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
  legend: { bottom: 0, itemHeight: 8, textStyle: { fontSize: 10 } },
  series: [
    {
      type: 'pie',
      radius: ['38%', '62%'],
      center: ['50%', '44%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 1 },
      label: { fontSize: 10, formatter: '{b}\n{c}h' },
      data: reasonAgg.value.map((r) => ({ name: r.label, value: Number(r.hours.toFixed(2)), itemStyle: { color: r.color } }))
    }
  ]
}))

// ------------------------------------------------------------------ 日历
const hoursMap = computed(() => hoursByDate(state.records))

const calendarOption = computed<EChartsOption>(() => {
  // 整月每一天都画格子（没有记录的天为 0），这样才像一张真正的日历
  const days: Array<[string, number]> = daysOfPeriod(`${calendarMonth.value}-01`, endOfMonth(`${calendarMonth.value}-01`)).map(
    (d) => [d, Number((hoursMap.value.get(d) ?? 0).toFixed(2))]
  )
  const max = Math.max(4, ...days.map((d) => d[1]))
  return {
    tooltip: { formatter: (p: unknown) => {
      const v = p as { data?: [string, number] }
      return `${v.data?.[0]}<br/>工时 ${v.data?.[1]} 小时`
    } },
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
    <van-tabs v-model:active="periodType" type="card" @change="goToday">
      <van-tab title="日" name="day" />
      <van-tab title="周" name="week" />
      <van-tab title="月" name="month" />
    </van-tabs>

    <div class="card" style="margin-top: 12px">
      <div class="row-between">
        <van-icon name="arrow-left" size="18" @click="move(-1)" />
        <div style="text-align: center">
          <div class="num" style="font-size: 14px; font-weight: 600">{{ periodLabel }}</div>
          <div class="muted" @click="goToday">点这里回到今天</div>
        </div>
        <van-icon name="arrow" size="18" @click="move(1)" />
      </div>
    </div>

    <div class="kpi-grid">
      <StatCard label="实际工时" :value="fmtHoursShort(stats.actualHours)" :hint="`${stats.recordCount} 条记录`" />
      <StatCard
        label="标准工时"
        :value="fmtHoursShort(stats.standardHours)"
        :hint="`按 ${stats.standardCovered} 条有标准值的记录`"
      />
      <StatCard
        label="效率（总量口径）"
        :value="fmtPercent(stats.totalEfficiency)"
        tone="efficiency"
        :ratio="stats.totalEfficiency"
        :hint="efficiencyDelta === null ? '无上期数据' : `较上期 ${efficiencyDelta >= 0 ? '+' : ''}${(efficiencyDelta * 100).toFixed(1)} 个百分点`"
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

    <div v-if="stats.recordCount > 0 && stats.standardCovered === 0" class="card tip-card" @click="router.push('/manage')">
      本期记录都还没有标准用时，效率暂时显示“—”。可到「工程 → 标准用时」一键采用实测参考用时 →
    </div>

    <div class="card">
      <div class="card-title">
        {{ trendTitle }}
        <span class="sub">柱：实际工时　线：效率</span>
      </div>
      <ChartBox :option="trendOption" :height="250" />
    </div>

    <div class="card">
      <div class="card-title">
        工序用时排行
        <span class="sub">实际 vs 标准（未设标准时用参考）</span>
      </div>
      <ChartBox v-if="procAgg.length" :option="processRankOption" :height="Math.max(180, procAgg.slice(0, 8).length * 34 + 60)" />
      <van-empty v-else description="本期没有工序记录" image-size="60" />
    </div>

    <div class="card">
      <div class="card-title">
        衔接空隙排行
        <span class="sub">超过 {{ GAP_TOLERANCE_MINUTES }} 分钟、6 小时以内的空档</span>
      </div>
      <ChartBox v-if="gapTop.length" :option="gapRankOption" :height="Math.max(180, gapTop.length * 34 + 40)" />
      <van-empty v-else description="本期衔接顺畅，未发现明显空档" image-size="60" />
    </div>

    <div class="card">
      <div class="card-title">
        空隙原因分布
        <span class="sub">按等待时长</span>
      </div>
      <ChartBox v-if="reasonAgg.length" :option="reasonOption" :height="240" />
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

    <van-button block plain type="primary" @click="router.push('/records')">查看记录明细</van-button>
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
</style>
