<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { afterChange, refreshRecords, runSync, setOperator, setProject, state } from '@/store'
import { applyBenchTemplate, saveProject, seedHistoryRecords } from '@/db'
import { BENCH_PROJECT_ID, BENCH_PROJECT_NAME, HISTORY_FACES } from '@/db/seed'
import { HISTORY_ROWS } from '@/db/history'
import { computeStats, recordsOfDate } from '@/core/compute'
import type { Process, ProcessRecord } from '@/types'
import { endOfWeek, fmtHoursShort, friendlyDate, startOfWeek, todayStr } from '@/core/time'
import { reasonLabel } from '@/core/reasons'

const router = useRouter()
const today = todayStr()
const refreshing = ref(false)
const creating = ref(false)
const showOperatorSheet = ref(false)
const showProjectSheet = ref(false)

const project = computed(() => state.projects.find((p) => p.id === state.currentProjectId))
const operator = computed(() => state.operators.find((o) => o.id === state.currentOperatorId))
const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

const todayRecords = computed(() => recordsOfDate(state.records, today))
const todayStats = computed(() => computeStats(state.records, processById.value, today, today))
const weekStats = computed(() =>
  computeStats(state.records, processById.value, startOfWeek(today), endOfWeek(today))
)

interface Group {
  itemId: string
  itemName: string
  divisionName: string
  records: ProcessRecord[]
  totalHours: number
}

const groups = computed<Group[]>(() => {
  const map = new Map<string, Group>()
  todayRecords.value.forEach((r) => {
    const p = processById.value.get(r.processId)
    if (!p) return
    const item = wbsById.value.get(p.itemId)
    const div = item?.parentId ? wbsById.value.get(item.parentId) : undefined
    const g =
      map.get(p.itemId) ??
      ({
        itemId: p.itemId,
        itemName: item?.name ?? '未归类',
        divisionName: div?.name ?? '',
        records: [],
        totalHours: 0
      } satisfies Group)
    g.records.push(r)
    g.totalHours += r.hours
    map.set(p.itemId, g)
  })
  return Array.from(map.values())
})

/** 最近两周用过的工序，用于一键补录 */
const recentProcesses = computed<Process[]>(() => {
  const since = new Date(Date.now() - 14 * 86400000)
  const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(
    since.getDate()
  ).padStart(2, '0')}`
  const counter = new Map<string, number>()
  state.records.forEach((r) => {
    if (r.date < sinceStr) return
    counter.set(r.processId, (counter.get(r.processId) ?? 0) + 1)
  })
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => processById.value.get(id))
    .filter((p): p is Process => !!p)
    .slice(0, 8)
})

const projectActions = computed(() =>
  state.projects.map((p) => ({ name: p.name + (p.archived ? '（已归档）' : ''), value: p.id }))
)
const operatorActions = computed(() =>
  state.operators.map((o) => ({ name: `${o.name}（${o.shift}）`, value: o.id }))
)

async function onProjectSelect(action: { value: string }) {
  showProjectSheet.value = false
  await setProject(action.value)
}

async function onOperatorSelect(action: { value: string }) {
  showOperatorSheet.value = false
  await setOperator(action.value)
  showToast(`当前记录人：${operator.value?.name ?? ''}`)
}

function addRecord(processId?: string) {
  if (!state.processes.length) {
    showToast('请先在“工程”页建立工序')
    return
  }
  router.push({ path: '/record', query: { date: today, processId: processId ?? '' } })
}

function editRecord(id: string) {
  router.push({ path: '/record', query: { id } })
}

/** 一键建立本标段项目：套用项目划分模板并补录已有循环作业记录 */
async function createBenchProject() {
  creating.value = true
  try {
    const existing = state.projects.find((p) => p.id === BENCH_PROJECT_ID)
    if (existing) {
      await setProject(existing.id)
      await afterChange('projects')
      showToast('本标段项目已存在，已切换过去')
      return
    }
    // 固定项目 id：两台手机分别点击也会合并成同一个项目，不会重复
    const row = await saveProject({ id: BENCH_PROJECT_ID, name: BENCH_PROJECT_NAME })
    const tpl = await applyBenchTemplate(row.id)
    const n = await seedHistoryRecords(row.id)
    await setProject(row.id)
    await afterChange('projects')
    showToast(`已建立本标段项目：${tpl.units} 个单位工程、${tpl.processes} 道工序，补录 ${n} 条记录`)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '创建失败')
  } finally {
    creating.value = false
  }
}

async function onRefresh() {
  refreshing.value = true
  try {
    if (state.sync.configured) await runSync(true)
    else {
      await refreshRecords()
      await afterChange('records')
    }
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <van-nav-bar :title="project?.name ?? '工序用时记录'" fixed placeholder>
    <template #right>
      <span class="muted" @click="showOperatorSheet = true">{{ operator?.name ?? '选择记录人' }}</span>
    </template>
  </van-nav-bar>

  <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
    <div class="page">
      <div class="card">
        <div class="row-between">
          <div>
            <div class="muted">今天是</div>
            <div class="today-label">{{ friendlyDate(today) }}</div>
          </div>
          <div class="project-cell" @click="showProjectSheet = true">
            <div class="muted">当前项目</div>
            <div class="project-name">
              {{ project?.name ?? '未选择' }} <van-icon name="arrow-down" />
            </div>
          </div>
        </div>
        <div class="divider" />
        <div class="kpi-grid">
          <div>
            <div class="muted">今日记录工时</div>
            <div class="num" style="font-size: 20px; font-weight: 600">
              {{ fmtHoursShort(todayStats.actualHours) }}
              <span class="muted" style="font-size: 12px">/ {{ todayStats.recordCount }} 条</span>
            </div>
          </div>
          <div>
            <div class="muted">本周累计</div>
            <div class="num" style="font-size: 20px; font-weight: 600">
              {{ fmtHoursShort(weekStats.actualHours) }}
              <span class="muted" style="font-size: 12px">/ {{ weekStats.recordCount }} 条</span>
            </div>
          </div>
        </div>
        <div v-if="todayStats.gapHours > 0" class="muted" style="margin-top: 8px">
          今日衔接空隙合计 {{ fmtHoursShort(todayStats.gapHours) }}
        </div>
      </div>

      <template v-if="!state.projects.length">
        <div class="card">
          <van-empty description="还没有项目，先建立本标段项目" image-size="72" />
          <van-button type="primary" block round :loading="creating" @click="createBenchProject">
            一键建立本标段项目
          </van-button>
          <div class="muted" style="text-align: center; margin-top: 10px; line-height: 1.6">
            自动套用《项目划分》10 个单位工程、57 道循环作业工序，<br />
            并补录 2026 年 9 月 {{ HISTORY_ROWS.length }} 条循环作业记录
          </div>
          <div class="muted" style="text-align: center; margin-top: 8px">
            三条工作面：{{ Object.values(HISTORY_FACES).map((f) => f.label).join(' / ') }}
          </div>
          <van-button plain block round style="margin-top: 12px" @click="router.push('/manage')">
            或自己到“工程”页新建
          </van-button>
        </div>
      </template>

      <template v-else>
        <div class="card">
          <div class="card-title">
            今日工序记录
            <span class="sub">{{ today }}</span>
          </div>

          <van-empty v-if="!groups.length" description="今天还没有记录" image-size="72" />

          <div v-for="g in groups" :key="g.itemId" class="group">
            <div class="group-head">
              <span>{{ g.divisionName ? g.divisionName + ' / ' : '' }}{{ g.itemName }}</span>
              <span class="num muted">{{ fmtHoursShort(g.totalHours) }}</span>
            </div>
            <div v-for="r in g.records" :key="r.id" class="record-row" @click="editRecord(r.id)">
              <div class="record-main">
                <div class="record-name">{{ processById.get(r.processId)?.name ?? '未知工序' }}</div>
                <div class="muted">
                  {{ r.startTime }} - {{ r.endTime }}
                  <template v-if="r.location"> · {{ r.location }}</template>
                  <template v-if="r.quantity"> · {{ r.quantity }}{{ processById.get(r.processId)?.unit ?? '' }}</template>
                </div>
                <div v-if="r.gapReason && r.gapReason !== 'none'" class="muted">
                  开工前等待：{{ reasonLabel(r.gapReason) }}
                </div>
              </div>
              <div class="record-hours num">{{ fmtHoursShort(r.hours) }}</div>
            </div>
          </div>
        </div>

        <div v-if="recentProcesses.length" class="card">
          <div class="card-title">
            常用工序（近两周）
            <span class="sub">点一下直接记录</span>
          </div>
          <div class="chips">
            <button v-for="p in recentProcesses" :key="p.id" class="chip" @click="addRecord(p.id)">
              {{ p.name }}
            </button>
          </div>
        </div>
      </template>

      <div class="bottom-space" />
    </div>
  </van-pull-refresh>

  <button class="fab" @click="addRecord()">+</button>

  <van-action-sheet
    v-model:show="showProjectSheet"
    :actions="projectActions"
    cancel-text="取消"
    title="切换项目"
    @select="onProjectSelect"
  />
  <van-action-sheet
    v-model:show="showOperatorSheet"
    :actions="operatorActions"
    cancel-text="取消"
    title="当前记录人"
    @select="onOperatorSelect"
  />
</template>

<style scoped>
.group + .group {
  margin-top: 14px;
}

.today-label {
  font-size: 18px;
  font-weight: 600;
  white-space: nowrap;
}

.project-cell {
  text-align: right;
  min-width: 0;
  flex: 1;
  margin-left: 12px;
}

.project-name {
  font-size: 14px;
  color: #1f6feb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.group-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: #3d4650;
  padding: 6px 0;
}

.record-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid #f2f3f5;
}

.record-row:active {
  background: #fafbfc;
}

.record-main {
  min-width: 0;
}

.record-name {
  font-size: 14px;
  font-weight: 500;
}

.record-hours {
  font-size: 15px;
  font-weight: 600;
  color: #1f6feb;
  white-space: nowrap;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  border: 1px solid #dfe4ea;
  background: #f8f9fb;
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  color: #33404f;
}

.chip:active {
  background: #eef3ff;
  border-color: #cdddff;
}
</style>
