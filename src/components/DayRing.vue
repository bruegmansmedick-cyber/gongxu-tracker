<script setup lang="ts">
/**
 * 24 小时圆盘：整圈 24 小时、半圈 12 小时，0 点在正上方、顺时针。
 * 手绘 SVG（不依赖 ECharts）：刻度精确、并行工序分成同心环带、每段都能点。
 */
import { computed } from 'vue'
import { DAY_MINUTES, ringArcPath, type DayRingData } from '@/core/dayRing'
import { fmtHoursShort } from '@/core/time'

const props = defineProps<{ data: DayRingData; dateLabel: string }>()
const emit = defineEmits<{ pick: [recordId: string] }>()

const SIZE = 200
const C = SIZE / 2
const R_OUTER = 80
const R_INNER = 44
const R_TICK = 84
const R_LABEL = 94

const lanes = computed(() => Math.max(1, props.data.stats.lanes))
const laneWidth = computed(() => (R_OUTER - R_INNER) / lanes.value)

const hourTicks = Array.from({ length: 24 }, (_, h) => h)
const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21]

function polar(r: number, minutes: number) {
  const rad = ((minutes / DAY_MINUTES) * 360 - 90) * (Math.PI / 180)
  return { x: C + r * Math.cos(rad), y: C + r * Math.sin(rad) }
}

function band(lane: number) {
  const w = laneWidth.value
  return { rInner: R_INNER + lane * w + 0.6, rOuter: R_INNER + (lane + 1) * w - 0.6 }
}

function segPath(lane: number, startMin: number, endMin: number): string {
  const { rInner, rOuter } = band(lane)
  return ringArcPath({ size: SIZE, rInner, rOuter, startMin, endMin })
}

/** 圆盘外圈的时间刻度线 */
const ticks = computed(() =>
  hourTicks.map((h) => {
    const major = hourLabels.includes(h)
    const a = polar(R_TICK, h * 60)
    const b = polar(R_TICK - (major ? 5 : 2.5), h * 60)
    return { h, major, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
  })
)

const labels = computed(() =>
  hourLabels.map((h) => {
    const p = polar(R_LABEL, h * 60)
    return { h, x: p.x, y: p.y }
  })
)
</script>

<template>
  <div class="ring-wrap">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="ring-svg" role="img" aria-label="24 小时施工时段圆盘">
      <circle :cx="C" :cy="C" :r="(R_OUTER + R_INNER) / 2" fill="none" stroke="#eef1f5" :stroke-width="R_OUTER - R_INNER" />

      <line
        v-for="t in ticks"
        :key="`t${t.h}`"
        :x1="t.x1"
        :y1="t.y1"
        :x2="t.x2"
        :y2="t.y2"
        :stroke="t.major ? '#c9d0d8' : '#e6e9ee'"
        :stroke-width="t.major ? 1 : 0.6"
      />
      <text
        v-for="l in labels"
        :key="`l${l.h}`"
        :x="l.x"
        :y="l.y + 3"
        text-anchor="middle"
        class="ring-tick-label"
      >
        {{ l.h }}
      </text>

      <path
        v-for="s in data.segments"
        :key="s.recordId"
        :d="segPath(s.lane, s.startMin, s.endMin)"
        :fill="s.color"
        fill-opacity="0.92"
        stroke="#fff"
        stroke-width="0.8"
        class="ring-seg"
        @click="emit('pick', s.recordId)"
      />

      <text :x="C" :y="C - 12" text-anchor="middle" class="ring-center-date">{{ dateLabel }}</text>
      <text :x="C" :y="C + 8" text-anchor="middle" class="ring-center-big">{{ fmtHoursShort(data.stats.hours) }}</text>
      <text :x="C" :y="C + 24" text-anchor="middle" class="ring-center-sub">
        覆盖 {{ data.stats.coveredHours.toFixed(1) }}h · {{ data.stats.count }} 条
      </text>
      <text v-if="data.stats.overflow" :x="C" :y="C + 38" text-anchor="middle" class="ring-center-warn">
        另有 {{ data.stats.overflow }} 条并行
      </text>
    </svg>

    <div class="ring-list">
      <button
        v-for="s in data.segments"
        :key="s.recordId"
        type="button"
        class="ring-row"
        @click="emit('pick', s.recordId)"
      >
        <span class="dot" :style="{ background: s.color }" />
        <span class="time num">{{ s.timeLabel }}</span>
        <span class="name">{{ s.name }}<span class="muted">（{{ s.itemShort }}）</span></span>
        <span class="hours num">{{ fmtHoursShort(s.hours) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ring-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.ring-svg {
  width: 100%;
  max-width: 260px;
  height: auto;
}

.ring-tick-label {
  font-size: 7px;
  fill: #8b95a1;
}

.ring-seg {
  cursor: pointer;
}

.ring-center-date {
  font-size: 8px;
  fill: #8b95a1;
}

.ring-center-big {
  font-size: 17px;
  font-weight: 600;
  fill: #1f2329;
}

.ring-center-sub {
  font-size: 7.5px;
  fill: #8b95a1;
}

.ring-center-warn {
  font-size: 7px;
  fill: #b26a00;
}

.ring-list {
  width: 100%;
  margin-top: 10px;
}

.ring-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 2px;
  border: none;
  border-top: 1px solid #f2f3f5;
  background: transparent;
  font-size: 13px;
  color: #1f2329;
  text-align: left;
}

.ring-row:first-child {
  border-top: none;
}

.ring-row .dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.ring-row .time {
  flex-shrink: 0;
  font-size: 12px;
  color: #4a5461;
}

.ring-row .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ring-row .hours {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: #1f6feb;
}
</style>
