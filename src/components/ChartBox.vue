<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts'
import {
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { withMobileTooltip } from '@/core/chartTheme'

echarts.use([
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
])

const props = withDefaults(defineProps<{ option: EChartsOption; height?: number }>(), { height: 240 })

const el = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function render() {
  if (!chart) return
  // 统一兜底：手机上 tooltip 不出框、长文字换行（各图自己的 formatter 不受影响）
  chart.setOption(withMobileTooltip(props.option), true)
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value, undefined, { renderer: 'canvas' })
  render()
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(el.value)
})

watch(() => props.option, render, { deep: true })

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="el" class="chart-box" :style="{ height: `${height}px` }" />
</template>
