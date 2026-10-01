<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ScopePicker from '@/components/ScopePicker.vue'
import { state } from '@/store'
import { computeGapRows } from '@/core/compute'
import { filterByScope } from '@/core/scope'
import { reasonLabel } from '@/core/reasons'
import { addMonths, endOfMonth, fmtHoursShort, friendlyDate, monthKey, todayStr } from '@/core/time'

const router = useRouter()
const route = useRoute()
// 从看板跳过来时带着月份，避免"看的是 9 月、翻到明细却是 10 月"的困惑
const month = ref(typeof route.query.month === 'string' && /^\d{4}-\d{2}$/.test(route.query.month) ? route.query.month : monthKey(todayStr()))
const keyword = ref('')

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

/** 先按分析范围过滤，再按月份与关键词过滤 */
const scopeRecords = computed(() => filterByScope(state.records, state.scope, processById.value, wbsById.value))

const from = computed(() => `${month.value}-01`)
const to = computed(() => endOfMonth(from.value))

const monthRecords = computed(() =>
  scopeRecords.value.filter((r) => r.date >= from.value && r.date <= to.value)
)

/** 空隙要在"范围内的整月记录"上算，否则关键词筛选会打断工序衔接 */
const gapByRecord = computed(() => {
  const rows = computeGapRows(monthRecords.value, processById.value)
  return new Map(rows.map((g) => [g.recordId, g.gapHours]))
})

const filtered = computed(() => {
  const kw = keyword.value.trim()
  const list = kw
    ? monthRecords.value.filter((r) => {
        const p = processById.value.get(r.processId)
        return (
          (p?.name ?? '').includes(kw) ||
          (r.location ?? '').includes(kw) ||
          (r.note ?? '').includes(kw)
        )
      })
    : monthRecords.value
  return [...list].sort((a, b) => b.startAt - a.startAt)
})

/** 顶部统计跟随筛选结果，避免数字和列表对不上 */
const filteredStats = computed(() => {
  const rows = filtered.value
  const hours = rows.reduce((s, r) => s + (Number.isFinite(r.hours) ? r.hours : 0), 0)
  const gap = rows.reduce((s, r) => s + (gapByRecord.value.get(r.id) ?? 0), 0)
  const days = new Set(rows.map((r) => r.date)).size
  return { count: rows.length, hours, gap, days }
})

const scopeName = computed(() => {
  const s = state.scope
  if (s.level === 'all') return '全部工程'
  if (s.level === 'unit') return wbsById.value.get(s.unitId ?? '')?.name ?? ''
  const item = wbsById.value.get(s.itemId ?? '')?.name ?? ''
  const proc = s.processId ? processById.value.get(s.processId) : undefined
  return proc ? `${item} · ${proc.name}` : item
})

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
    <ScopePicker />

    <div class="card">
      <div class="row-between">
        <van-icon name="arrow-left" size="18" @click="changeMonth(-1)" />
        <div class="num" style="font-size: 16px; font-weight: 600">{{ month }}</div>
        <van-icon name="arrow" size="18" @click="changeMonth(1)" />
      </div>
      <div class="muted scope-echo" style="text-align: center; margin-top: 4px">
        {{ scopeName }}
      </div>
      <div class="divider" />
      <div class="kpi-grid">
        <div>
          <div class="muted">记录条数</div>
          <div class="num" style="font-size: 18px; font-weight: 600">{{ filteredStats.count }} 条</div>
        </div>
        <div>
          <div class="muted">合计工时</div>
          <div class="num" style="font-size: 18px; font-weight: 600">{{ fmtHoursShort(filteredStats.hours) }}</div>
        </div>
      </div>
      <div class="muted" style="margin-top: 6px">
        衔接空隙合计 {{ fmtHoursShort(filteredStats.gap) }} · 有记录天数 {{ filteredStats.days }} 天
        <template v-if="keyword"> （已按“{{ keyword }}”筛选）</template>
      </div>
    </div>

    <van-search v-model="keyword" placeholder="搜索工序 / 部位 / 备注" />

    <van-empty v-if="!grouped.length" description="当前范围与月份内没有记录" image-size="72" />

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

.scope-echo {
  word-break: break-all;
}
</style>
