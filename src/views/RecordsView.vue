<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ScopePicker from '@/components/ScopePicker.vue'
import { getKv, setKv } from '@/db'
import { state } from '@/store'
import { computeGapRows, daySummaries, isCompleteRecord, isEndPending } from '@/core/compute'
import { filterByScope, scopeLabel } from '@/core/scope'
import { buildItemWorkfaceMap } from '@/core/workface'
import { recordChainage, shortChainageText } from '@/core/chainage'
import { reasonLabel } from '@/core/reasons'
import { addMonths, endOfMonth, fmtDate, fmtHoursShort, friendlyDate, monthKey, parseDate, todayStr } from '@/core/time'

const router = useRouter()
const route = useRoute()

const MONTH_KV = 'ui.records.month'

const routeMonth =
  typeof route.query.month === 'string' && /^\d{4}-\d{2}$/.test(route.query.month) ? route.query.month : ''
const month = ref(routeMonth || monthKey(todayStr()))
const keyword = ref('')
/** 展开的日期集合：默认全部收起，只留每天一行 */
const expanded = ref<Set<string>>(new Set())
const showPicker = ref(false)
const showCalendar = ref(false)
/** 跳转后短暂高亮的那一天 */
const highlight = ref('')
const calendarValue = ref(parseDate(`${month.value}-01`))
/** 用户主动翻过月份后，不再自动跳到"最近有记录的月份" */
let monthTouched = false

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))
const workfaceById = computed(() => new Map(state.workfaces.map((w) => [w.id, w])))
const itemWorkface = computed(() => buildItemWorkfaceMap(state.wbs, state.workfaces))

/** 先按分析范围过滤，再按月份与关键词过滤 */
const scopeRecords = computed(() =>
  filterByScope(state.records, state.scope, processById.value, wbsById.value, itemWorkface.value)
)

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
          recordChainage(r).includes(kw) ||
          shortChainageText(recordChainage(r)).includes(kw) ||
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
  const hours = rows.reduce((s, r) => s + (isCompleteRecord(r) ? r.hours : 0), 0)
  const gap = rows.reduce((s, r) => s + (gapByRecord.value.get(r.id) ?? 0), 0)
  const days = new Set(rows.map((r) => r.date)).size
  const pending = rows.filter(isEndPending).length
  return { count: rows.length, hours, gap, days, pending }
})

const scopeName = computed(() => scopeLabel(state.scope, wbsById.value, workfaceById.value))

const searching = computed(() => keyword.value.trim().length > 0)

/** 每天一行汇总（搜索时按命中结果汇总，条数才和展开的内容对得上） */
const summaries = computed(() =>
  daySummaries(searching.value ? filtered.value : monthRecords.value, gapByRecord.value)
)

const rowsByDate = computed(() => {
  const map = new Map<string, typeof filtered.value>()
  filtered.value.forEach((r) => {
    const list = map.get(r.date) ?? []
    list.push(r)
    map.set(r.date, list)
  })
  return map
})

/** 搜索时自动展开命中的日期，否则折叠状态下等于搜不到 */
function isExpanded(date: string): boolean {
  return searching.value || expanded.value.has(date)
}

const allExpanded = computed(
  () => summaries.value.length > 0 && summaries.value.every((s) => expanded.value.has(s.date))
)

function toggleDay(date: string) {
  const next = new Set(expanded.value)
  if (next.has(date)) next.delete(date)
  else next.add(date)
  expanded.value = next
}

function toggleAll() {
  expanded.value = allExpanded.value ? new Set() : new Set(summaries.value.map((s) => s.date))
}

/** 当前范围内最近 12 个有记录的日期，一点直达 */
const recentDates = computed(() => {
  const set = new Set(scopeRecords.value.map((r) => r.date))
  return Array.from(set).sort().reverse().slice(0, 12)
})

async function focusDate(date: string) {
  await nextTick()
  document.getElementById(`day-${date}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  highlight.value = date
  window.setTimeout(() => {
    if (highlight.value === date) highlight.value = ''
  }, 2000)
}

/** 跳到某一天：切到它所在的月份、展开那一天、滚动定位并高亮 */
function jumpTo(date: string) {
  monthTouched = true
  showPicker.value = false
  month.value = monthKey(date)
  expanded.value = new Set([date])
  void focusDate(date)
}

function onCalendarConfirm(value: Date) {
  showCalendar.value = false
  jumpTo(fmtDate(value))
}

function openCalendar() {
  showPicker.value = false
  showCalendar.value = true
}

function changeMonth(delta: number) {
  monthTouched = true
  month.value = addMonths(month.value, delta)
  expanded.value = new Set()
}

function pathOf(processId: string): string {
  const p = processById.value.get(processId)
  if (!p) return ''
  const item = wbsById.value.get(p.itemId)
  const div = item?.parentId ? wbsById.value.get(item.parentId) : undefined
  const face = workfaceById.value.get(itemWorkface.value.get(p.itemId) ?? '')?.name
  // 有工作面就先显示工作面（1#支洞），否则退回分部工程名
  return [face || div?.name, item?.name].filter(Boolean).join(' / ')
}

watch(month, (m) => {
  calendarValue.value = parseDate(`${m}-01`)
  void setKv(MONTH_KV, m)
})

/** 从看板/首页带参数过来时定位过去；没有参数就沿用本机上次看的月份 */
async function initFromRoute() {
  const qDate =
    typeof route.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(route.query.date) ? route.query.date : ''
  if (routeMonth) month.value = routeMonth
  if (qDate) {
    month.value = monthKey(qDate)
    expanded.value = new Set([qDate])
    await focusDate(qDate)
    return
  }
  if (!routeMonth) {
    const saved = await getKv<string>(MONTH_KV, '')
    month.value = saved || latestMonthWithRecords()
  }
}

/**
 * 默认月份：本月有记录就用本月；本月还没有记录（比如月初或停工），
 * 直接落到最近有记录的月份，免得一打开是空白还得自己翻。
 */
function latestMonthWithRecords(): string {
  const current = monthKey(todayStr())
  const dates = scopeRecords.value.map((r) => r.date)
  if (!dates.length) return current
  if (dates.some((d) => monthKey(d) === current)) return current
  return monthKey(dates.sort()[dates.length - 1])
}

// 同步在页面打开后才完成时，若当前月份还是空的，就补到最近有记录的月份
watch([() => state.records.length, () => state.ready], () => {
  if (monthTouched || !state.ready || !state.records.length) return
  const has = state.records.some((r) => !r.deletedAt && monthKey(r.date) === month.value)
  if (!has) month.value = latestMonthWithRecords()
})

onMounted(() => {
  void initFromRoute()
})

watch(
  () => route.query,
  () => {
    void initFromRoute()
  }
)
</script>

<template>
  <van-nav-bar title="记录明细" fixed placeholder />

  <div class="page">
    <ScopePicker />

    <div class="card">
      <div class="row-between">
        <van-icon name="arrow-left" size="18" @click="changeMonth(-1)" />
        <div class="month-center" @click="showPicker = true">
          <div class="num month-label">{{ month }}<van-icon name="arrow-down" size="12" /></div>
          <div class="muted">点这里选日期</div>
        </div>
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
        <template v-if="filteredStats.pending"> · 待补完工 {{ filteredStats.pending }} 条（不计工时）</template>
        <template v-if="searching"> （已按“{{ keyword }}”筛选）</template>
      </div>
    </div>

    <van-search v-model="keyword" placeholder="搜索工序 / 桩号 / 备注" />

    <div v-if="summaries.length" class="card list-head">
      <span class="muted">{{ summaries.length }} 天有记录</span>
      <span v-if="searching" class="muted">搜索时自动展开</span>
      <span v-else class="switch-all" @click="toggleAll">{{ allExpanded ? '全部收起' : '全部展开' }}</span>
    </div>

    <van-empty
      v-if="!summaries.length"
      description="当前范围与月份内没有记录"
      image-size="72"
    />

    <div
      v-for="s in summaries"
      :id="`day-${s.date}`"
      :key="s.date"
      class="card day-card"
      :class="{ 'day-highlight': highlight === s.date }"
    >
      <div class="day-head" @click="toggleDay(s.date)">
        <div class="day-main">
          <div class="day-title">{{ friendlyDate(s.date) }}</div>
          <div class="muted">
            {{ s.count }} 条 · {{ fmtHoursShort(s.hours) }}
            <template v-if="s.gapHours > 0"> · 空隙 {{ fmtHoursShort(s.gapHours) }}</template>
          </div>
        </div>
        <van-icon :name="isExpanded(s.date) ? 'arrow-up' : 'arrow-down'" />
      </div>

      <div v-if="isExpanded(s.date)">
        <div
          v-for="r in rowsByDate.get(s.date) ?? []"
          :key="r.id"
          class="row"
          @click="router.push({ path: '/record', query: { id: r.id } })"
        >
          <div class="row-main">
            <div class="row-name">
              {{ processById.get(r.processId)?.name ?? '未知工序' }}
              <span v-if="isEndPending(r)" class="tag-soft pending-tag">待补完工</span>
              <span v-if="r.quantity" class="tag-soft">{{ r.quantity }}{{ processById.get(r.processId)?.unit ?? '' }}</span>
            </div>
            <div class="muted">{{ pathOf(r.processId) }}</div>
            <div class="muted">
              {{ r.startTime }} - {{ r.endTime ?? '待补' }}
              <template v-if="recordChainage(r)"> · 桩号 {{ shortChainageText(recordChainage(r)) }}</template>
              <template v-if="r.location && r.location !== recordChainage(r)"> · {{ r.location }}</template>
              <template v-if="r.operatorName"> · {{ r.operatorName }}</template>
            </div>
            <div v-if="(gapByRecord.get(r.id) ?? 0) > 0" class="muted gap">
              衔接空隙 {{ fmtHoursShort(gapByRecord.get(r.id) ?? 0) }}
              <template v-if="r.gapStartTime && r.gapEndTime">
                （等待 {{ r.gapStartTime }} - {{ r.gapEndTime }}）
              </template>
              <template v-if="r.gapReason && r.gapReason !== 'none'">（{{ reasonLabel(r.gapReason) }}）</template>
            </div>
          </div>
          <div v-if="isCompleteRecord(r)" class="row-hours num">{{ fmtHoursShort(r.hours) }}</div>
          <div v-else class="row-hours pending-hours">未完工</div>
        </div>
      </div>
    </div>

    <div class="bottom-space" />
  </div>

  <!-- 选日期：先给"有记录的日期"，要去更早的再打开日历 -->
  <van-popup v-model:show="showPicker" round position="bottom" :style="{ maxHeight: '76%' }">
    <div class="sheet">
      <div class="sheet-head">
        <div class="sheet-title">跳到某一天</div>
        <span class="muted" @click="showPicker = false">关闭</span>
      </div>
      <div class="sheet-body">
        <template v-if="recentDates.length">
          <div class="group-title">有记录的日期（近 12 个）</div>
          <div class="chip-row">
            <button v-for="d in recentDates" :key="d" type="button" class="chip" @click="jumpTo(d)">
              {{ d.slice(5) }}
            </button>
          </div>
        </template>
        <div class="group-title">要更早的日期</div>
        <div class="sheet-actions">
          <van-button block round type="primary" plain @click="openCalendar">打开日历选择</van-button>
        </div>
      </div>
    </div>
  </van-popup>

  <van-calendar
    v-model:show="showCalendar"
    :default-date="calendarValue"
    :min-date="new Date(2024, 0, 1)"
    :max-date="new Date()"
    switch-mode="year-month"
    @confirm="onCalendarConfirm"
  />
</template>

<style scoped>
.month-center {
  min-width: 0;
  text-align: center;
}

.month-label {
  font-size: 16px;
  font-weight: 600;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
}

.switch-all {
  font-size: 13px;
  color: #1f6feb;
}

.day-card {
  padding: 4px 14px 10px;
}

.day-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
}

.day-main {
  min-width: 0;
}

.day-title {
  font-size: 14px;
  font-weight: 600;
}

.day-highlight {
  box-shadow: 0 0 0 2px #1f6feb inset;
  transition: box-shadow 0.3s ease;
}

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

.pending-tag {
  color: #9a4f00;
  background: #fff1e4;
}

.pending-hours {
  color: #9a4f00;
  font-size: 13px;
}

.gap {
  color: #b26a00;
}

.scope-echo {
  word-break: break-all;
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
  padding: 10px 16px 0;
}
</style>
