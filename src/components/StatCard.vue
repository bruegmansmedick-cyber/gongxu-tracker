<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string
    unit?: string
    /** 正数显示为绿色（效率类指标：越快越好） */
    tone?: 'neutral' | 'efficiency'
    ratio?: number | null
    hint?: string
  }>(),
  { unit: '', tone: 'neutral', ratio: null, hint: '' }
)

const valueClass = computed(() => {
  if (props.tone !== 'efficiency' || props.ratio === null || props.ratio === undefined) return 'flat'
  if (props.ratio > 0.001) return 'up'
  if (props.ratio < -0.001) return 'down'
  return 'flat'
})
</script>

<template>
  <div class="kpi">
    <div class="label">{{ label }}</div>
    <div class="value" :class="valueClass">
      {{ value }}<small v-if="unit">{{ unit }}</small>
    </div>
    <div v-if="hint" class="muted" style="margin-top: 4px">{{ hint }}</div>
  </div>
</template>
