<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, state } from '@/store'
import { deleteRecord as removeRecord, getKv, getRecord, saveProcess, saveRecord, setKv } from '@/db'
import { buildTimeFields, suggestStandardHours } from '@/core/compute'
import { checkBeforeSave } from '@/core/health'
import { GAP_REASONS } from '@/core/reasons'
import { recommendProcesses, rememberProcess, type ProcessMemory } from '@/core/recommend'
import { buildUsageIndex, predictSelection, rankByUsage } from '@/core/predict'
import { addDays, fmtDate, fmtHours, friendlyDate, nowHhmm, todayStr } from '@/core/time'
import type { Process, WbsLevel, WbsNode } from '@/types'

const route = useRoute()
const router = useRouter()

const recordId = ref<string | null>(null)
/** 四级选择：单位工程 → 分部工程 → 分项工程 → 工序 */
const unitId = ref('')
const divisionId = ref('')
const itemId = ref('')
const processId = ref('')

const date = ref(todayStr())
const startTime = ref('08:00')
const endTime = ref('12:00')
const quantity = ref<string>('')
const gapReason = ref('none')
const location = ref('')
const note = ref('')
const saving = ref(false)

const showCalendar = ref(false)
const showStartPicker = ref(false)
const showEndPicker = ref(false)
const showReasonPicker = ref(false)
const showProcessSheet = ref(false)

/** 结构选择弹层：unit / division / item 三选一，空串表示关闭 */
const pickerLevel = ref<'' | 'unit' | 'division' | 'item'>('')
const search = ref('')
const showPicker = computed({
  get: () => pickerLevel.value !== '',
  set: (v: boolean) => {
    if (!v) pickerLevel.value = ''
  }
})

const processEditor = reactive({
  show: false,
  id: '',
  name: '',
  unit: ''
})
const savingProcess = ref(false)

/**
 * 手工新增工序的记忆（本机保存，不参与云同步）。
 * 用 shallowRef 是有意的：IndexedDB 存不了 Vue 的响应式代理（会报 DataCloneError），
 * 所以这里始终保持普通对象。
 */
const memory = shallowRef<ProcessMemory>({})

const startPickerValue = ref<string[]>(startTime.value.split(':'))
const endPickerValue = ref<string[]>(endTime.value.split(':'))

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

function childrenOf(parentId: string | null, level: WbsLevel): WbsNode[] {
  return state.wbs
    .filter((w) => w.parentId === parentId && w.level === level)
    .sort((a, b) => a.sort - b.sort)
}

const units = computed(() => childrenOf(null, 1))
/** 使用习惯：最近常记的单位 / 分部 / 分项 / 工序排前面（已完工、没开工的自然沉下去） */
const usageIndex = computed(() => buildUsageIndex(state.records, processById.value, wbsById.value))
const orderedUnits = computed(() => rankByUsage(units.value, usageIndex.value))
const orderedDivisions = computed(() =>
  unitId.value ? rankByUsage(childrenOf(unitId.value, 2), usageIndex.value) : []
)
const orderedItems = computed(() =>
  divisionId.value ? rankByUsage(childrenOf(divisionId.value, 3), usageIndex.value) : []
)

const unit = computed(() => wbsById.value.get(unitId.value))
const division = computed(() => wbsById.value.get(divisionId.value))
const item = computed(() => wbsById.value.get(itemId.value))
const selectedProcess = computed(() => processById.value.get(processId.value))

/** 该分项下已有的工序（工程管理里建的、别的设备同步过来的都算） */
const itemProcesses = computed(() =>
  rankByUsage(
    state.processes.filter((p) => p.itemId === itemId.value && p.enabled),
    usageIndex.value
  )
)

/** 预判标记：这一级是系统按近期常用自动填的，不是人选的 */
const predicted = reactive({ division: false, item: false })
const predictedHint = ref('')

/** 推荐 = 本分项已有 + 同类分项用过（记忆）+ 按项目划分匹配的通用工序 */
const recommendation = computed(() =>
  recommendProcesses({
    itemName: item.value?.name ?? '',
    note: item.value?.note,
    existing: itemProcesses.value.map((p) => p.name),
    memory: memory.value
  })
)

const pickerTitle = computed(() => {
  if (pickerLevel.value === 'unit') return '选择单位工程'
  if (pickerLevel.value === 'division') return '选择分部工程'
  if (pickerLevel.value === 'item') return '选择分项工程'
  return ''
})

const pickerOptions = computed<WbsNode[]>(() => {
  if (pickerLevel.value === 'unit') return orderedUnits.value
  if (pickerLevel.value === 'division') return orderedDivisions.value
  if (pickerLevel.value !== 'item') return []
  const kw = search.value.trim()
  if (!kw) return orderedItems.value
  return orderedItems.value.filter((i) => i.name.includes(kw) || (i.note ?? '').includes(kw))
})

const currentPickId = computed(() => {
  if (pickerLevel.value === 'unit') return unitId.value
  if (pickerLevel.value === 'division') return divisionId.value
  return itemId.value
})

const hours = computed(() => buildTimeFields(date.value, startTime.value, endTime.value).hours)
const crossMidnight = computed(() => {
  const [sh, sm] = startTime.value.split(':').map(Number)
  const [eh, em] = endTime.value.split(':').map(Number)
  return eh * 60 + em <= sh * 60 + sm
})

const reasonActions = GAP_REASONS.map((r) => ({ name: r.label, value: r.key }))
const reasonText = computed(() => GAP_REASONS.find((r) => r.key === gapReason.value)?.label ?? '')

const historyHint = computed(() => {
  if (!processId.value) return ''
  const s = suggestStandardHours(processId.value, state.records)
  if (!s.value) return ''
  return `历史平均 ${fmtHours(s.value)}（${s.sample} 条记录）`
})

function openPicker(level: 'unit' | 'division' | 'item') {
  search.value = ''
  pickerLevel.value = level
}

/**
 * 按近期使用习惯预判下一级并自动填上（可改）。
 * 只在真的有使用记录时才预判；给不出结果就什么都不做。
 */
function applyPrediction(from: 'unit' | 'division') {
  predicted.division = false
  predicted.item = false
  predictedHint.value = ''
  const res = predictSelection({
    unitId: unitId.value,
    divisionId: from === 'division' ? divisionId.value : '',
    wbs: state.wbs,
    index: usageIndex.value,
    processes: state.processes
  })
  if (from === 'unit' && res.divisionId) {
    divisionId.value = res.divisionId
    predicted.division = true
  }
  if (res.itemId) {
    itemId.value = res.itemId
    predicted.item = true
  }
  if (res.processId) processId.value = res.processId

  if (predicted.division || predicted.item) {
    const parts = [division.value?.name, item.value?.name].filter(Boolean)
    predictedHint.value = `按近期常用预填：${parts.join(' / ')}`
    showToast(predictedHint.value)
  }
}

function chooseNode(id: string) {
  const level = pickerLevel.value
  pickerLevel.value = ''
  search.value = ''
  if (level === 'unit') {
    unitId.value = id
    divisionId.value = ''
    itemId.value = ''
    processId.value = ''
    applyPrediction('unit')
    return
  }
  if (level === 'division') {
    divisionId.value = id
    itemId.value = ''
    processId.value = ''
    predicted.division = false
    applyPrediction('division')
    return
  }
  if (level === 'item') {
    itemId.value = id
    processId.value = ''
    predicted.item = false
    predictedHint.value = ''
    // 这个分项一道工序都没有时，直接把工序表推出来，省得录不进去还不知道为什么
    const siblings = state.processes.filter((p) => p.itemId === id && p.enabled)
    if (!siblings.length) showProcessSheet.value = true
  }
}

function pickProcess(p: Process) {
  processId.value = p.id
  predictedHint.value = ''
  showProcessSheet.value = false
}

async function rememberThisItem(name: string) {
  const target = item.value
  if (!target) return
  // 新对象、普通字段：既触发更新，又能安全写进 IndexedDB
  const next = rememberProcess(memory.value, target.name, name, target.note)
  memory.value = next
  await setKv('ui.processMemory', next)
}

/** 新增一道工序到当前分项，并自动选中 */
async function createProcess(name: string, unitText?: string): Promise<Process | null> {
  const target = item.value
  if (!state.currentProjectId || !target) {
    showToast('请先选到分项工程')
    return null
  }
  const row = await saveProcess({
    projectId: state.currentProjectId,
    itemId: target.id,
    name,
    unit: unitText?.trim() || target.unit
  })
  await rememberThisItem(name)
  await afterChange('structure')
  processId.value = row.id
  return row
}

/** 点推荐里的工序：直接建到本分项并选中（推荐只是推荐，落了库才是真工序） */
async function pickRecommended(name: string) {
  savingProcess.value = true
  try {
    await createProcess(name)
    showProcessSheet.value = false
    showToast(`已新增工序「${name}」`)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '新增工序失败')
  } finally {
    savingProcess.value = false
  }
}

function openNewProcess() {
  processEditor.id = ''
  processEditor.name = ''
  processEditor.unit = item.value?.unit ?? ''
  processEditor.show = true
}

function openRenameProcess(p: Process) {
  processEditor.id = p.id
  processEditor.name = p.name
  processEditor.unit = p.unit ?? ''
  processEditor.show = true
}

async function submitProcess() {
  const name = processEditor.name.trim()
  if (!name) {
    showToast('请填工序名称')
    return
  }
  const editing = processEditor.id
  savingProcess.value = true
  try {
    if (editing) {
      const old = processById.value.get(editing)
      if (!old) {
        showToast('这道工序已不存在')
        return
      }
      await saveProcess({
        id: editing,
        projectId: old.projectId,
        itemId: old.itemId,
        name,
        unit: processEditor.unit.trim() || undefined,
        designQty: old.designQty,
        standardHours: old.standardHours,
        enabled: old.enabled
      })
      await afterChange('structure')
      showToast('工序名称已修改')
    } else {
      await createProcess(name, processEditor.unit)
      showProcessSheet.value = false
      showToast(`已新增工序「${name}」`)
    }
    processEditor.show = false
  } catch (err) {
    showToast(err instanceof Error ? err.message : '保存工序失败')
  } finally {
    savingProcess.value = false
  }
}

function onCalendarConfirm(value: Date) {
  date.value = fmtDate(value)
  showCalendar.value = false
}

/** 补填常用日期：默认日历只能选今天及以后，这里给三个快捷入口 */
const quickDates = computed(() => [todayStr(), addDays(todayStr(), -1), addDays(todayStr(), -2)])

function quickLabel(value: string): string {
  if (value === todayStr()) return '今天'
  if (value === addDays(todayStr(), -1)) return '昨天'
  return '前天'
}

function setQuickDate(value: string) {
  date.value = value
}

function onStartConfirm() {
  startTime.value = startPickerValue.value.map((v) => String(v).padStart(2, '0')).join(':')
  showStartPicker.value = false
}

function onEndConfirm() {
  endTime.value = endPickerValue.value.map((v) => String(v).padStart(2, '0')).join(':')
  showEndPicker.value = false
}

function onReasonSelect(action: { value: string }) {
  gapReason.value = action.value
  showReasonPicker.value = false
}

function fillNowStart() {
  startTime.value = nowHhmm()
  startPickerValue.value = startTime.value.split(':')
}

function fillNowEnd() {
  endTime.value = nowHhmm()
  endPickerValue.value = endTime.value.split(':')
}

async function save() {
  if (!processId.value) {
    if (itemId.value) showProcessSheet.value = true
    else showToast('请先选择工序')
    return
  }
  if (!state.currentProjectId) {
    showToast('请先选择项目')
    return
  }
  if (!state.currentOperatorId) {
    showToast('请先在“设置”里添加记录人')
    return
  }
  saving.value = true
  try {
    const op = state.operators.find((o) => o.id === state.currentOperatorId)
    // 保存前做一次衔接体检：重叠 / 间隔过长 / 重复录入 → 先让人确认
    const times = buildTimeFields(date.value, startTime.value, endTime.value)
    const warnings = checkBeforeSave(
      { id: recordId.value ?? undefined, processId: processId.value, date: date.value, startAt: times.startAt, endAt: times.endAt },
      state.records,
      processById.value
    )
    if (warnings.length) {
      try {
        await showConfirmDialog({
          title: '这条记录有点异常，请确认',
          message: `${warnings.join('\n')}\n\n确认无误可选“仍然保存”，异常会记入留痕。`,
          confirmButtonText: '仍然保存',
          cancelButtonText: '返回修改'
        })
      } catch {
        return
      }
    }
    await saveRecord({
      id: recordId.value ?? undefined,
      projectId: state.currentProjectId,
      processId: processId.value,
      date: date.value,
      startTime: startTime.value,
      endTime: endTime.value,
      quantity: quantity.value === '' ? undefined : Number(quantity.value),
      gapReason: gapReason.value,
      location: location.value.trim() || undefined,
      note: note.value.trim() || undefined,
      operatorId: state.currentOperatorId,
      operatorName: op?.name ?? '未署名'
    })
    await afterChange('records')
    const isToday = date.value === todayStr()
    if (recordId.value) {
      showToast('已保存修改')
    } else if (isToday) {
      showToast('记录已保存')
    } else {
      showToast(`已保存 ${friendlyDate(date.value)} 的记录（不在“今日”列表里）`)
    }
    // 补填历史日期时直接跳到那个月的明细，免得以为没存上
    if (!isToday) router.replace({ path: '/records', query: { month: date.value.slice(0, 7) } })
    else router.replace('/')
  } catch (err) {
    showToast(err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!recordId.value) return
  await showConfirmDialog({ title: '删除记录', message: '删除后其他设备同步时也会删除该条记录，确定吗？' })
  await removeRecord(recordId.value)
  await afterChange('records')
  showToast('已删除')
  router.replace('/records')
}

/** 由工序反推它所属的单位 / 分部 / 分项（编辑记录、从别处带参数进来时用） */
function applyProcess(pid: string): boolean {
  const p = processById.value.get(pid)
  if (!p) return false
  processId.value = p.id
  itemId.value = p.itemId
  const target = wbsById.value.get(p.itemId)
  divisionId.value = target?.parentId ?? ''
  const div = divisionId.value ? wbsById.value.get(divisionId.value) : undefined
  unitId.value = div?.parentId ?? ''
  return true
}

/** 结构还没加载完时先把要选的工序记下来，加载完再补上 */
const pendingProcessId = ref('')

function applyPending() {
  if (!pendingProcessId.value) return
  if (applyProcess(pendingProcessId.value)) pendingProcessId.value = ''
}

watch([() => state.ready, () => state.wbs.length], applyPending)

async function loadMemory() {
  memory.value = await getKv<ProcessMemory>('ui.processMemory', {})
}

/** 按地址栏参数初始化表单；query 变化时也重跑，避免路由复用组件时串数据 */
async function loadFromQuery() {
  const q = route.query
  const id = typeof q.id === 'string' ? q.id : ''
  const pid = typeof q.processId === 'string' ? q.processId : ''
  const wantedItem = typeof q.itemId === 'string' ? q.itemId : ''
  const d = typeof q.date === 'string' ? q.date : ''

  recordId.value = null
  unitId.value = ''
  divisionId.value = ''
  itemId.value = ''
  processId.value = ''
  pendingProcessId.value = ''
  predicted.division = false
  predicted.item = false
  predictedHint.value = ''
  date.value = d || todayStr()
  startTime.value = '08:00'
  endTime.value = '12:00'
  quantity.value = ''
  gapReason.value = 'none'
  location.value = ''
  note.value = ''

  if (pid) {
    if (!applyProcess(pid)) pendingProcessId.value = pid
  } else if (wantedItem) {
    itemId.value = wantedItem
    const target = wbsById.value.get(wantedItem)
    divisionId.value = target?.parentId ?? ''
    const div = divisionId.value ? wbsById.value.get(divisionId.value) : undefined
    unitId.value = div?.parentId ?? ''
  }

  if (id) {
    const row = await getRecord(id)
    if (row) {
      recordId.value = row.id
      if (!pid) {
        if (!applyProcess(row.processId)) pendingProcessId.value = row.processId
      }
      date.value = row.date
      startTime.value = row.startTime
      endTime.value = row.endTime
      startPickerValue.value = row.startTime.split(':')
      endPickerValue.value = row.endTime.split(':')
      quantity.value = row.quantity === undefined ? '' : String(row.quantity)
      gapReason.value = row.gapReason ?? 'none'
      location.value = row.location ?? ''
      note.value = row.note ?? ''
    }
  }
  startPickerValue.value = startTime.value.split(':')
  endPickerValue.value = endTime.value.split(':')
}

watch(
  () => route.query,
  () => {
    void loadFromQuery()
  }
)

onMounted(() => {
  void loadMemory()
  void loadFromQuery()
})
</script>

<template>
  <van-nav-bar :title="recordId ? '修改工序记录' : '记录工序用时'" left-arrow fixed placeholder @click-left="router.back()" />

  <div class="page">
    <van-cell-group inset>
      <van-field
        :model-value="unit?.name ?? ''"
        label="单位工程"
        placeholder="选择单位工程"
        readonly
        is-link
        required
        @click="openPicker('unit')"
      />
      <van-field
        :model-value="division?.name ?? ''"
        label="分部工程"
        :placeholder="unitId ? '选择分部工程' : '请先选单位工程'"
        readonly
        is-link
        required
        :disabled="!unitId"
        @click="openPicker('division')"
      >
        <template #button>
          <van-tag v-if="predicted.division" plain type="primary">预判</van-tag>
        </template>
      </van-field>
      <van-field
        :model-value="item?.name ?? ''"
        label="分项工程"
        :placeholder="divisionId ? '选择分项工程（可搜索）' : '请先选分部工程'"
        readonly
        is-link
        required
        :disabled="!divisionId"
        @click="openPicker('item')"
      >
        <template #button>
          <van-tag v-if="predicted.item" plain type="primary">预判</van-tag>
        </template>
      </van-field>
      <van-field
        :model-value="selectedProcess?.name ?? ''"
        label="工序"
        :placeholder="itemId ? '选择工序，或新增一道' : '请先选分项工程'"
        readonly
        is-link
        required
        :disabled="!itemId"
        @click="showProcessSheet = true"
      />
      <div v-if="predictedHint" class="item-note predicted">{{ predictedHint }}，可点开上面任意一栏修改</div>
      <div v-if="item?.note" class="item-note">{{ item.note }}</div>
    </van-cell-group>

    <van-cell-group inset style="margin-top: 12px">
      <van-field :model-value="date" label="施工日期" readonly is-link required @click="showCalendar = true" />
      <van-field label="快捷补填">
        <template #input>
          <div class="quick-dates">
            <button
              v-for="d in quickDates"
              :key="d"
              type="button"
              class="quick-date"
              :class="{ active: date === d }"
              @click="setQuickDate(d)"
            >
              {{ quickLabel(d) }}
            </button>
            <span class="muted">或用上面的日期自由选</span>
          </div>
        </template>
      </van-field>
      <van-field :model-value="startTime" label="开工时刻" readonly is-link required @click="showStartPicker = true">
        <template #button>
          <van-button size="mini" plain type="primary" @click.stop="fillNowStart">现在</van-button>
        </template>
      </van-field>
      <van-field :model-value="endTime" label="完工时刻" readonly is-link required @click="showEndPicker = true">
        <template #button>
          <van-button size="mini" plain type="primary" @click.stop="fillNowEnd">现在</van-button>
        </template>
      </van-field>
      <van-field label="净用时">
        <template #input>
          <span class="num" style="font-size: 17px; font-weight: 600; color: #1f6feb">{{ fmtHours(hours) }}</span>
          <span v-if="crossMidnight" class="tag-soft" style="margin-left: 8px">跨零点</span>
        </template>
      </van-field>
    </van-cell-group>

    <van-cell-group inset style="margin-top: 12px">
      <van-field
        v-model="quantity"
        type="number"
        label="完成工程量"
        :placeholder="selectedProcess?.unit ? `单位：${selectedProcess.unit}` : '可留空'"
      >
        <template #extra>
          <span class="muted">{{ selectedProcess?.unit ?? '' }}</span>
        </template>
      </van-field>
      <van-field
        :model-value="reasonText"
        label="开工前等待"
        readonly
        is-link
        placeholder="选择本条记录开工前的等待原因"
        @click="showReasonPicker = true"
      />
      <van-field v-model="location" label="部位/桩号" placeholder="如：0+120 左侧边坡（选填）" />
      <van-field v-model="note" type="textarea" rows="2" autosize label="备注" placeholder="选填" />
    </van-cell-group>

    <div v-if="selectedProcess" class="hint">
      <template v-if="selectedProcess.standardHours">标准用时 {{ fmtHours(selectedProcess.standardHours) }}</template>
      <template v-if="selectedProcess.refHours">
        <template v-if="selectedProcess.standardHours"> · </template>
        参考 {{ fmtHours(selectedProcess.refHours) }}（实测 {{ selectedProcess.refSamples ?? 0 }} 次）
      </template>
      <template v-if="!selectedProcess.standardHours && !selectedProcess.refHours && historyHint">
        该工序尚未设标准用时，{{ historyHint }}
      </template>
    </div>
  </div>

  <div class="footer-bar">
    <van-button v-if="recordId" type="danger" plain @click="remove">删除</van-button>
    <van-button type="primary" round :loading="saving" @click="save">保存记录</van-button>
  </div>

  <!-- 单位 / 分部 / 分项：按上一级筛选，分项可搜索 -->
  <van-popup v-model:show="showPicker" round position="bottom" :style="{ maxHeight: '78%' }">
    <div class="sheet">
      <div class="sheet-head">
        <div class="sheet-title">{{ pickerTitle }}</div>
        <span class="muted" @click="pickerLevel = ''">关闭</span>
      </div>
      <van-search v-if="pickerLevel === 'item'" v-model="search" placeholder="搜索分项工程名称或桩号" />
      <div class="sheet-body">
        <van-cell
          v-for="opt in pickerOptions"
          :key="opt.id"
          :title="opt.name"
          :label="opt.note"
          clickable
          @click="chooseNode(opt.id)"
        >
          <template #right-icon>
            <van-icon v-if="opt.id === currentPickId" name="success" color="#1f6feb" />
          </template>
        </van-cell>
        <van-empty v-if="!pickerOptions.length" description="没有可选项" image-size="60" />
      </div>
    </div>
  </van-popup>

  <!-- 工序：先看已有的，再看同类分项用过的和按项目划分推荐的，都没有就现场新增 -->
  <van-popup v-model:show="showProcessSheet" round position="bottom" :style="{ maxHeight: '82%' }">
    <div class="sheet">
      <div class="sheet-head">
        <div>
          <div class="sheet-title">选择工序</div>
          <div class="muted">{{ item?.name ?? '未选分项工程' }}</div>
        </div>
        <van-button size="small" type="primary" plain :disabled="!itemId" @click="openNewProcess">＋ 新增工序</van-button>
      </div>
      <div class="sheet-body">
        <template v-if="itemProcesses.length">
          <div class="group-title">本分项已有（{{ itemProcesses.length }}）</div>
          <van-cell v-for="p in itemProcesses" :key="p.id" :title="p.name" clickable @click="pickProcess(p)">
            <template #right-icon>
              <van-icon v-if="p.id === processId" name="success" color="#1f6feb" style="margin-right: 8px" />
              <span class="mini-link" @click.stop="openRenameProcess(p)">改名</span>
            </template>
          </van-cell>
        </template>

        <template v-if="recommendation.learned.length">
          <div class="group-title">同类分项用过（点一下即建到本分项）</div>
          <van-cell
            v-for="name in recommendation.learned"
            :key="`learned-${name}`"
            :title="name"
            clickable
            @click="pickRecommended(name)"
          >
            <template #right-icon><van-tag plain type="warning">记忆</van-tag></template>
          </van-cell>
        </template>

        <template v-if="recommendation.preset.length">
          <div class="group-title">{{ recommendation.label }}推荐（点一下即建到本分项）</div>
          <van-cell
            v-for="name in recommendation.preset"
            :key="`preset-${name}`"
            :title="name"
            clickable
            @click="pickRecommended(name)"
          >
            <template #right-icon><van-tag plain type="primary">推荐</van-tag></template>
          </van-cell>
        </template>

        <van-empty
          v-if="!itemProcesses.length && !recommendation.learned.length && !recommendation.preset.length"
          description="这道分项还没有工序，点右上角新增一道"
          image-size="60"
        />
      </div>
    </div>
  </van-popup>

  <!-- 新增 / 改名 -->
  <van-popup v-model:show="processEditor.show" round position="bottom">
    <div class="sheet">
      <div class="sheet-head">
        <div class="sheet-title">{{ processEditor.id ? '修改工序名称' : '新增工序' }}</div>
      </div>
      <div class="sheet-body">
        <van-field v-model="processEditor.name" label="工序名称" placeholder="如：掌子面清理" maxlength="30" />
        <van-field v-model="processEditor.unit" label="计量单位" placeholder="可留空，默认沿用分项工程" maxlength="10" />
        <div class="muted" style="padding: 10px 16px 0">
          <template v-if="processEditor.id">改名会同步到另一台手机；已有记录不受影响。</template>
          <template v-else>新增后自动选中，并记住“这类分项常用这道工序”，下次会自动出现在推荐里。</template>
        </div>
      </div>
      <div class="sheet-foot">
        <van-button block round @click="processEditor.show = false">取消</van-button>
        <van-button block round type="primary" :loading="savingProcess" @click="submitProcess">保存工序</van-button>
      </div>
    </div>
  </van-popup>

  <van-calendar
    v-model:show="showCalendar"
    :default-date="new Date(date)"
    :min-date="new Date(2024, 0, 1)"
    :max-date="new Date(Date.now() + 31 * 86400000)"
    switch-mode="year-month"
    @confirm="onCalendarConfirm"
  />

  <van-popup v-model:show="showStartPicker" round position="bottom">
    <van-time-picker v-model="startPickerValue" title="开工时刻" @confirm="onStartConfirm" @cancel="showStartPicker = false" />
  </van-popup>
  <van-popup v-model:show="showEndPicker" round position="bottom">
    <van-time-picker v-model="endPickerValue" title="完工时刻" @confirm="onEndConfirm" @cancel="showEndPicker = false" />
  </van-popup>

  <van-action-sheet
    v-model:show="showReasonPicker"
    :actions="reasonActions"
    cancel-text="取消"
    title="开工前等待的原因"
    @select="onReasonSelect"
  />

  <div class="bottom-space" />
</template>

<style scoped>
.hint {
  margin: 10px 16px 0;
  font-size: 12px;
  color: #8b95a1;
}

.item-note {
  padding: 0 16px 10px;
  font-size: 12px;
  color: #8b95a1;
}

.item-note.predicted {
  color: #1f6feb;
}

.quick-dates {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.quick-date {
  border: 1px solid #dfe4ea;
  background: #f8f9fb;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  color: #33404f;
}

.quick-date.active {
  border-color: #1f6feb;
  background: #eef3ff;
  color: #1f6feb;
}

.sheet {
  display: flex;
  flex-direction: column;
  max-height: 80vh;
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
  padding-bottom: 8px;
}

.group-title {
  padding: 12px 16px 4px;
  font-size: 12px;
  color: #8b95a1;
}

.mini-link {
  font-size: 12px;
  color: #1f6feb;
}

.sheet-foot {
  display: flex;
  gap: 12px;
  padding: 12px 16px 18px;
  border-top: 1px solid #f0f2f5;
}
</style>
