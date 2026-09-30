<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { state } from '@/store'
import { computeGapRows, computeStats } from '@/core/compute'
import { reasonLabel } from '@/core/reasons'
import { addMonths, endOfMonth, fmtHoursShort, friendlyDate, monthKey, todayStr } from '@/core/time'

const router = useRouter()
const month = ref(monthKey(todayStr()))
const keyword = ref('')

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

const from = computed(() => `${month.value}-01`)
const to = computed(() => endOfMonth(from.value))

const monthRecords = computed(() =>
  state.records.filter((r) => r.date >= from.value && r.date <= to.value)
)

const gapByRecord = computed(() => {
  const rows = computeGapRows(monthRecords.value, processById.value)
  return new Map(rows.map((g) => [g.recordId, g.gapHours]))
})

const filtered = computed(() => {
  const kw = keyword.value.trim()
  const list = kw
    ? monthRecords.value.filter((r) => {
        const p = processById.value.get(r.processId)
        return (p?.name ?? '').includes(kw) || (r.location ?? '').includes(kw) || (r.note ?? '').includes(kw)
      })
    : monthRecords.value
  return [...list].sort((a, b) => b.startAt - a.startAt)
})

const stats = computed(() => computeStats(state.records, processById.value, from.value, to.value))

const grouped = computed(() => {
  const map = new Map<string, typeof filtered.value>()
  filtered.value.forEach((r) => {
    const list = map.get(r.date) ?? []
    list.push(r)
    map.set(r.date, list)
  })
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
})

function pathOf(processId: string): string {
  const p = processById.value.get(processId)
  if (!p) return ''
  const item = wbsById.value.get(p.itemId)
  const div = item?.parentId ? wbsById.value.get(item.parentId) : undefined
  return [div?.name, item?.name].filter(Boolean).join(' / ')
}

function changeMonth(delta: number) {
  month.value = addMonths(month.value, delta)
}
</script>

<template>
  <van-nav-bar title="记录明细" fixed placeholder />

  <div class="page">
    <div class="card">
      <div class="row-between">
        <van-icon name="arrow-left" size="18" @click="changeMonth(-1)" />
        <div class="num" style="font-size: 16px; font-weight: 600">{{ month }}</div>
        <van-icon name="arrow" size="18" @click="changeMonth(1)" />
      </div>
      <div class="divider" />
      <div class="kpi-grid">
        <div>
          <div class="muted">本月记录</div>
          <div class="num" style="font-size: 18px; font-weight: 600">{{ stats.recordCount }} 条</div>
        </div>
        <div>
          <div class="muted">本月工时</div>
          <div class="num" style="font-size: 18px; font-weight: 600">{{ fmtHoursShort(stats.actualHours) }}</div>
        </div>
      </div>
      <div class="muted" style="margin-top: 6px">
        衔接空隙合计 {{ fmtHoursShort(stats.gapHours) }} · 有效施工天数 {{ stats.activeDays }} 天
      </div>
    </div>

    <van-search v-model="keyword" placeholder="搜索工序 / 部位 / 备注" />

    <van-empty v-if="!grouped.length" description="这个月还没有记录" image-size="72" />

    <div v-for="[date, rows] in grouped" :key="date" class="card">
      <div class="card-title">
        {{ friendlyDate(date) }}
        <span class="sub num">
          {{ rows.length }} 条 · {{ fmtHoursShort(rows.reduce((s, r) => s + r.hours, 0)) }}
        </span>
      </div>
      <div v-for="r in rows" :key="r.id" class="row" @click="router.push({ path: '/record', query: { id: r.id } })">
        <div class="row-main">
          <div class="row-name">
            {{ processById.get(r.processId)?.name ?? '未知工序' }}
            <span v-if="r.quantity" class="tag-soft">{{ r.quantity }}{{ processById.get(r.processId)?.unit ?? '' }}</span>
          </div>
          <div class="muted">{{ pathOf(r.processId) }}</div>
          <div class="muted">
            {{ r.startTime }} - {{ r.endTime }}
            <template v-if="r.location"> · {{ r.location }}</template>
            <template v-if="r.operatorName"> · {{ r.operatorName }}</template>
          </div>
          <div v-if="(gapByRecord.get(r.id) ?? 0) > 0" class="muted gap">
            衔接空隙 {{ fmtHoursShort(gapByRecord.get(r.id) ?? 0) }}
            <template v-if="r.gapReason && r.gapReason !== 'none'">（{{ reasonLabel(r.gapReason) }}）</template>
          </div>
        </div>
        <div class="row-hours num">{{ fmtHoursShort(r.hours) }}</div>
      </div>
    </div>

    <div class="bottom-space" />
  </div>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid #f2f3f5;
}

.row-main {
  min-width: 0;
}

.row-name {
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.row-hours {
  font-size: 15px;
  font-weight: 600;
  color: #1f6feb;
  white-space: nowrap;
}

.gap {
  color: #b26a00;
}
</style>
