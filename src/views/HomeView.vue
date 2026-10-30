<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, refreshRecords, runSync, setOperator, setProject, state } from '@/store'
import { applyBenchTemplate, deleteRecordDraft, saveProject, seedHistoryRecords } from '@/db'
import { BENCH_PROJECT_ID, BENCH_PROJECT_NAME, HISTORY_FACES } from '@/db/seed'
import { HISTORY_ROWS } from '@/db/history'
import {
  computeStats,
  isCompleteRecord,
  isEndPending,
  recordsOfDate,
  type CompletedProcessRecord
} from '@/core/compute'
import type { RecordDraft } from '@/core/recordDraft'
import { shortKind, shortSpot } from '@/core/scope'
import { buildItemWorkfaceMap } from '@/core/workface'
import { recordChainage, shortChainageText } from '@/core/chainage'
import type { Process } from '@/types'
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
const workfaceById = computed(() => new Map(state.workfaces.map((w) => [w.id, w])))
const itemWorkface = computed(() => buildItemWorkfaceMap(state.wbs, state.workfaces))

const todayRecords = computed(() => recordsOfDate(state.records, today).filter(isCompleteRecord))
const pendingRecords = computed(() =>
  state.records.filter(isEndPending).sort((a, b) => b.startAt - a.startAt)
)
const drafts = computed(() => state.drafts)
const todayStats = computed(() => computeStats(state.records, processById.value, today, today))
const weekStats = computed(() =>
  computeStats(state.records, processById.value, startOfWeek(today), endOfWeek(today))
)

interface DraftRow {
  draft: RecordDraft
  processName: string
  path: string
  timeText: string
  statusText: string
}

function draftRowOf(draft: RecordDraft): DraftRow {
  const process = processById.value.get(draft.processId)
  const item = wbsById.value.get(process?.itemId || draft.itemId)
  const division = item?.parentId ? wbsById.value.get(item.parentId) : undefined
  const face = item
    ? workfaceById.value.get(itemWorkface.value.get(item.id) ?? item.workfaceId ?? '')?.name
    : ''
  const names = [face || division?.name]
  if (process || !item) names.push(item?.name)
  const start = draft.startInput || draft.startTime || '开工待填'
  const end = draft.endInput.trim() || '完工待填'
  let statusText = '内容待正式保存'
  if (!item) statusText = '工程结构待选'
  else if (!process) statusText = '已选分项，工序待补'
  else if (!draft.endInput.trim()) statusText = '已填开工，待补完工'
  return {
    draft,
    processName: process?.name || item?.name || '未选工序',
    path: names.filter(Boolean).join(' / '),
    timeText: `${start} → ${end}`,
    statusText
  }
}

const draftRows = computed(() => drafts.value.map(draftRowOf))
const draftSyncText = computed(() => {
  if (!state.sync.configured) return '仅本机保存'
  return state.sync.pending ? '待同步' : '已同步'
})

function recordPath(processId: string): string {
  const process = processById.value.get(processId)
  const item = process ? wbsById.value.get(process.itemId) : undefined
  const division = item?.parentId ? wbsById.value.get(item.parentId) : undefined
  const face = item
    ? workfaceById.value.get(itemWorkface.value.get(item.id) ?? item.workfaceId ?? '')?.name
    : ''
  return [face || division?.name, item?.name].filter(Boolean).join(' / ')
}

interface Group {
  itemId: string
  itemName: string
  divisionName: string
  records: CompletedProcessRecord[]
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

/**
 * 最近两周用过的工序，按分项工程（工作面）分成小组，用于一键补录。
 * 组标题只给最短的提示（如"1#支洞""通风洞"），组内是这个工作面常记的工序。
 */
interface RecentGroup {
  itemId: string
  label: string
  processes: Process[]
}

/** 每个工作组最多列几道工序、最多列几个组 */
const GROUP_LIMIT = 5
const GROUP_PROCESS_LIMIT = 4

const recentGroups = computed<RecentGroup[]>(() => {
  const since = new Date(Date.now() - 14 * 86400000)
  const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(
    since.getDate()
  ).padStart(2, '0')}`
  const counter = new Map<string, number>()
  state.records.forEach((r) => {
    if (r.date < sinceStr) return
    counter.set(r.processId, (counter.get(r.processId) ?? 0) + 1)
  })

  const byItem = new Map<string, Process[]>()
  const groupCount = new Map<string, number>()
  Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([processId, times]) => {
      const p = processById.value.get(processId)
      if (!p) return
      const list = byItem.get(p.itemId) ?? []
      list.push(p)
      byItem.set(p.itemId, list)
      groupCount.set(p.itemId, (groupCount.get(p.itemId) ?? 0) + times)
    })

  const raw = Array.from(byItem.entries())
    .map(([itemId, list]) => ({
      itemId,
      itemName: wbsById.value.get(itemId)?.name ?? '未归类',
      processes: list.slice(0, GROUP_PROCESS_LIMIT),
      total: groupCount.get(itemId) ?? 0
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, GROUP_LIMIT)

  // 同一工作面有好几个分项时（比如 1#支洞 既有开挖又有支护），标题补一个工序类别，免得两组同名
  const spotCount = new Map<string, number>()
  raw.forEach((g) => {
    const spot = shortSpot(g.itemName)
    spotCount.set(spot, (spotCount.get(spot) ?? 0) + 1)
  })
  return raw.map((g) => {
    const spot = shortSpot(g.itemName)
    const label = (spotCount.get(spot) ?? 0) > 1 ? `${spot}·${shortKind(g.itemName)}` : spot
    return { itemId: g.itemId, label, processes: g.processes }
  })
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
  const query = processId ? { date: today, processId } : {}
  router.push({ path: '/record', query })
}

function editRecord(id: string) {
  router.push({ path: '/record', query: { id } })
}

function resumeDraftEntry(draftId: string) {
  router.push({ path: '/record', query: { draftId } })
}

async function removeDraft(draftId: string) {
  try {
    await showConfirmDialog({
      title: '删除暂存',
      message: '这条暂存将从首页移除，并同步到其他设备。正式记录不受影响。',
      confirmButtonText: '删除'
    })
  } catch {
    return
  }
  await deleteRecordDraft(draftId)
  await afterChange('drafts')
  showToast('暂存已删除')
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
    showToast(
      `已建立本标段项目：${tpl.units} 个单位工程、${tpl.workfaces} 个工作面、${tpl.processes} 道工序，补录 ${n} 条记录`
    )
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
        <div v-if="pendingRecords.length" class="muted" style="margin-top: 8px; color: #9a6200">
          另有 {{ pendingRecords.length }} 条未完工，已单独列出，完工前不计工时
        </div>
      </div>

      <template v-if="!state.projects.length">
        <div class="card">
          <van-empty description="还没有项目，先建立本标段项目" image-size="72" />
          <van-button type="primary" block round :loading="creating" @click="createBenchProject">
            一键建立本标段项目
          </van-button>
          <div class="muted" style="text-align: center; margin-top: 10px; line-height: 1.6">
            自动套用《项目划分》10 个单位工程、84 道循环作业工序，<br />
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
        <div v-if="draftRows.length" class="card">
          <div class="card-title">
            暂存记录
            <span class="sub">{{ draftRows.length }} 条 · {{ draftSyncText }}</span>
          </div>
          <div class="draft-list">
            <div v-for="row in draftRows" :key="row.draft.id" class="draft-row">
              <button type="button" class="draft-main" @click="resumeDraftEntry(row.draft.id)">
                <div class="record-main">
                  <div class="record-name">
                    <van-tag class="draft-tag" color="#fff1cc" text-color="#9a6200">暂存</van-tag>
                    {{ row.processName }}
                  </div>
                  <div class="muted">{{ row.draft.date }} · {{ row.timeText }}</div>
                  <div v-if="row.path" class="muted">{{ row.path }}</div>
                  <div class="draft-status">{{ row.statusText }}</div>
                </div>
                <span class="draft-continue">继续填写 <van-icon name="arrow" /></span>
              </button>
              <button
                type="button"
                class="draft-delete"
                :aria-label="`删除暂存 ${row.processName}`"
                @click="removeDraft(row.draft.id)"
              >
                <van-icon name="delete-o" />
              </button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            今日工序记录
            <span class="sub">{{ today }}</span>
          </div>

          <div v-if="pendingRecords.length" class="pending-block">
            <div class="pending-head">
              <span>未完工 · 待补结束时间</span>
              <span class="muted">含跨日 {{ pendingRecords.length }} 条</span>
            </div>
            <button
              v-for="r in pendingRecords"
              :key="r.id"
              type="button"
              class="record-row pending-row pending-row-button"
              :aria-label="`补填 ${r.date} ${processById.get(r.processId)?.name ?? '工序'} 的完工时间`"
              @click="editRecord(r.id)"
            >
              <div class="record-main">
                <div class="record-name">
                  <van-tag class="pending-tag" color="#fff0e6" text-color="#a34c00">待补完工</van-tag>
                  {{ processById.get(r.processId)?.name ?? '未知工序' }}
                </div>
                <div class="muted">
                  {{ r.date }} · {{ r.startTime }} → 待补
                  <template v-if="shortChainageText(recordChainage(r))">
                    · 桩号 {{ shortChainageText(recordChainage(r)) }}
                  </template>
                  <template v-if="r.location"> · {{ r.location }}</template>
                </div>
                <div class="muted">{{ recordPath(r.processId) }}</div>
              </div>
              <div class="pending-hours">未完工</div>
            </button>
          </div>

          <van-empty v-if="!groups.length && !pendingRecords.length" description="今天还没有记录" image-size="72" />

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

        <div v-if="recentGroups.length" class="card">
          <div class="card-title">
            常用工序（近两周）
            <span class="sub">点一下直接记录</span>
          </div>
          <div v-for="g in recentGroups" :key="g.itemId" class="recent-group">
            <div class="recent-label">{{ g.label }}</div>
            <div class="chips">
              <button v-for="p in g.processes" :key="p.id" class="chip" @click="addRecord(p.id)">
                {{ p.name }}
              </button>
            </div>
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

.draft-row {
  display: flex;
  align-items: stretch;
  gap: 4px;
  margin: 4px 0 10px;
  padding: 6px;
  border: 1px solid #f3d590;
  border-radius: 10px;
  background: #fffaf0;
}

.draft-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
}

.draft-main:active {
  background: #fff4d8;
  border-radius: 8px;
}

.draft-delete {
  flex: 0 0 44px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #a36a00;
}

.draft-delete:active {
  background: #fff0c7;
}

.draft-status {
  margin-top: 4px;
  color: #9a6200;
  font-size: 12px;
  font-weight: 600;
}

.draft-tag {
  margin-right: 6px;
}

.draft-continue {
  display: flex;
  align-items: center;
  gap: 2px;
  color: #9a6200;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.pending-block {
  margin: 4px 0 12px;
  padding: 10px;
  border: 1px solid #f2c9a8;
  border-radius: 10px;
  background: #fff9f4;
}

.pending-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 2px 8px;
  color: #8f4300;
  font-size: 13px;
  font-weight: 600;
}

.pending-row {
  padding-left: 2px;
  padding-right: 2px;
}

.pending-row-button {
  width: 100%;
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}

.pending-tag {
  margin-right: 6px;
}

.pending-hours {
  color: #a34c00;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
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

  .recent-group + .recent-group {
    margin-top: 12px;
  }

  .recent-label {
    font-size: 12px;
    color: #8b95a1;
    margin-bottom: 6px;
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
