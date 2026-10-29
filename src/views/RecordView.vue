<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, state } from '@/store'
import { deleteRecord as removeRecord, delKv, getKv, getRecord, saveProcess, saveRecord, setKv } from '@/db'
import { buildTimeFields, suggestStandardHours } from '@/core/compute'
import { checkBeforeSave } from '@/core/health'
import { parseChainageRange } from '@/core/chainage'
import { GAP_REASONS, MAX_CUSTOM_REASONS, mergeCustomReasons } from '@/core/reasons'
import { recommendProcesses, rememberProcess, type ProcessMemory } from '@/core/recommend'
import { buildUsageIndex, predictSelection, rankByUsage } from '@/core/predict'
import {
  RECORD_DRAFT_KEY,
  isRecordDraft,
  makeRecordDraft,
  shouldRestoreRecordDraft,
  type RecordDraftInput
} from '@/core/recordDraft'
import { addDays, fmtDate, fmtHours, friendlyDate, nowHhmm, parseLooseTime, todayStr } from '@/core/time'
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
/** 输入框里的原始文字；失焦或保存时再校验并写回 startTime / endTime */
const startInput = ref(startTime.value)
const endInput = ref(endTime.value)
/** 输入的时刻格式不对时标红提示（不偷偷改回旧值） */
const timeInvalid = reactive({ start: false, end: false })
const quantity = ref<string>('')
const gapReason = ref('none')
const location = ref('')
const locationError = ref('')
const note = ref('')
const saving = ref(false)
/** 当前本机草稿的暂存时间；0 表示本次表单没有恢复/保存草稿 */
const draftSavedAt = ref(0)

const showCalendar = ref(false)
const showReasonPicker = ref(false)
const showProcessSheet = ref(false)
const reasonEditor = reactive({ show: false, name: '' })

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
/** 本机记住的自定义等待原因 */
const customReasons = shallowRef<string[]>([])

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
/** 支护类工序（s-*）：桩号建议填写，用于看板按桩号看工作量 */
const isSupport = computed(() => {
  const key = selectedProcess.value?.id.split('--').pop() ?? ''
  return key.startsWith('s-')
})

/** 支护/桩号失焦时规范化；开挖的自由文本保持原样 */
function normalizeLocation() {
  const text = location.value.trim()
  if (!text) {
    locationError.value = ''
    return
  }
  const parsed = parseChainageRange(text)
  if (parsed) {
    location.value = parsed.text
    locationError.value = ''
    return
  }
  if (isSupport.value || text.includes('+')) {
    locationError.value = '格式示例：0+413~0+438'
  } else {
    locationError.value = ''
  }
}

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

/** 等待原因显示：内置的查表，自己加的显示原文 */
const reasonText = computed(() => {
  if (!gapReason.value || gapReason.value === 'none') return '衔接正常（无等待）'
  return GAP_REASONS.find((r) => r.key === gapReason.value)?.label ?? gapReason.value
})

/** 记录里出现过的自定义原因（可能是另一台手机加的，随记录同步过来） */
const recordReasons = computed(() =>
  state.records.map((r) => r.gapReason ?? '').filter((k) => k && k !== 'none')
)

/** 选择器里"自己加过"的那一组 */
const customReasonOptions = computed(() => mergeCustomReasons(customReasons.value, recordReasons.value))

const historyHint = computed(() => {
  if (!processId.value) return ''
  const s = suggestStandardHours(processId.value, state.records)
  if (!s.value) return ''
  return `历史平均 ${fmtHours(s.value)}（${s.sample} 条记录）`
})

const draftSavedLabel = computed(() => {
  if (!draftSavedAt.value) return ''
  const d = new Date(draftSavedAt.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

/** 输入框只留数字和冒号，其它字符直接挡掉 */
function onTimeInput(kind: 'start' | 'end', raw: string) {
  const cleaned = String(raw ?? '').replace(/[^\d:]/g, '').slice(0, 5)
  timeInvalid[kind] = false
  if (kind === 'start') startInput.value = cleaned
  else endInput.value = cleaned
}

/** 失焦或保存时校验并规范成 HH:mm；不合法就保留原文并标红，等用户改 */
function commitTime(kind: 'start' | 'end'): boolean {
  const raw = kind === 'start' ? startInput.value : endInput.value
  const parsed = parseLooseTime(raw)
  if (!parsed) {
    timeInvalid[kind] = true
    return false
  }
  timeInvalid[kind] = false
  if (kind === 'start') {
    startTime.value = parsed
    startInput.value = parsed
  } else {
    endTime.value = parsed
    endInput.value = parsed
  }
  return true
}

function commitTimes(): boolean {
  const okStart = commitTime('start')
  const okEnd = commitTime('end')
  return okStart && okEnd
}

function setTime(kind: 'start' | 'end', value: string) {
  timeInvalid[kind] = false
  if (kind === 'start') {
    startTime.value = value
    startInput.value = value
  } else {
    endTime.value = value
    endInput.value = value
  }
}

function fillNowStart() {
  setTime('start', nowHhmm())
}

function fillNowEnd() {
  setTime('end', nowHhmm())
}

function pickReason(key: string) {
  gapReason.value = key
  showReasonPicker.value = false
}

function openReasonEditor() {
  reasonEditor.name = ''
  reasonEditor.show = true
}

/** 新增原因：文字本身就是 key，随记录同步；同时记住到本机候选列表 */
async function submitReason() {
  const text = reasonEditor.name.trim()
  if (!text) {
    showToast('请填原因')
    return
  }
  if (text.length > 20) {
    showToast('原因最多 20 字')
    return
  }
  const builtin = GAP_REASONS.find((r) => r.label === text || r.key === text)
  if (builtin) {
    pickReason(builtin.key)
    reasonEditor.show = false
    showToast(`已选：${builtin.label}`)
    return
  }
  const next = mergeCustomReasons([text, ...customReasons.value], recordReasons.value)
  customReasons.value = next
  await setKv('ui.customReasons', next)
  gapReason.value = text
  reasonEditor.show = false
  showReasonPicker.value = false
  showToast(`已新增原因：${text}`)
}

function draftSnapshot(): RecordDraftInput {
  return {
    projectId: state.currentProjectId,
    unitId: unitId.value,
    divisionId: divisionId.value,
    itemId: itemId.value,
    processId: processId.value,
    date: date.value,
    startTime: startTime.value,
    endTime: endTime.value,
    startInput: startInput.value,
    endInput: endInput.value,
    quantity: quantity.value,
    gapReason: gapReason.value,
    location: location.value,
    note: note.value
  }
}

/** 只暂存到本机 IndexedDB；刷新、离开页面后再回来仍能恢复。 */
async function saveDraft() {
  if (recordId.value) return
  if (!state.currentProjectId) {
    showToast('请先选择项目')
    return
  }
  const savedAt = Date.now()
  try {
    await setKv(RECORD_DRAFT_KEY, makeRecordDraft(draftSnapshot(), savedAt))
    draftSavedAt.value = savedAt
    showToast('已暂存，可在首页“今日工序记录”继续填写')
  } catch {
    showToast('暂存失败，请稍后再试')
  }
}

async function removeStoredDraft() {
  await delKv(RECORD_DRAFT_KEY)
  draftSavedAt.value = 0
}

async function discardDraft() {
  try {
    await showConfirmDialog({
      title: '清除暂存',
      message: '只会清除本机保存的草稿，当前页面填写的内容仍保留。确定清除吗？',
      confirmButtonText: '清除'
    })
  } catch {
    return
  }
  await removeStoredDraft()
  showToast('暂存已清除')
}

async function restoreDraft() {
  const raw = await getKv<unknown>(RECORD_DRAFT_KEY, null)
  if (!isRecordDraft(raw) || raw.projectId !== state.currentProjectId) return

  const processApplied = raw.processId ? applyProcess(raw.processId) : false
  if (!processApplied) {
    const savedUnit = wbsById.value.get(raw.unitId)
    if (savedUnit?.level === 1 && savedUnit.projectId === state.currentProjectId) unitId.value = savedUnit.id
    const savedDivision = wbsById.value.get(raw.divisionId)
    if (savedDivision?.level === 2 && savedDivision.parentId === unitId.value) {
      divisionId.value = savedDivision.id
    }
    const savedItem = wbsById.value.get(raw.itemId)
    if (savedItem?.level === 3 && savedItem.parentId === divisionId.value) itemId.value = savedItem.id
  }

  date.value = raw.date || todayStr()
  startTime.value = raw.startTime || '08:00'
  endTime.value = raw.endTime || '12:00'
  // 完工时刻允许先留空，恢复时不能被默认 12:00 偷偷补回去。
  startInput.value = raw.startInput
  endInput.value = raw.endInput
  timeInvalid.start = false
  timeInvalid.end = false
  quantity.value = raw.quantity
  gapReason.value = raw.gapReason || 'none'
  location.value = raw.location
  locationError.value = ''
  note.value = raw.note
  draftSavedAt.value = raw.savedAt
  showToast('已恢复上次暂存')
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
  // 输入框可能还没失焦，先校验并规范成 HH:mm
  if (!commitTimes()) {
    showToast('请先改正时间格式，如 08:30')
    return
  }
  // 支护桩号不强制，但没填/写错时提醒一次，允许先存后补
  if (isSupport.value) {
    const parsed = parseChainageRange(location.value)
    if (parsed) {
      location.value = parsed.text
      locationError.value = ''
    } else {
      locationError.value = '格式示例：0+413~0+438'
      try {
        await showConfirmDialog({
          title: '支护桩号未填',
          message: '这条支护记录还没有有效桩号，建议补上后再保存，方便看板按桩号看工作量。也可以先保存，之后在明细里补填。',
          confirmButtonText: '仍然保存',
          cancelButtonText: '去填写'
        })
      } catch {
        return
      }
    }
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
    // 只有这一张表单本身就是草稿时才清除；从常用工序另存新记录不能误删旧草稿。
    if (!recordId.value && draftSavedAt.value) await removeStoredDraft()
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
  customReasons.value = await getKv<string[]>('ui.customReasons', [])
}

/** 按地址栏参数初始化表单；query 变化时也重跑，避免路由复用组件时串数据 */
async function loadFromQuery() {
  const q = route.query
  const id = typeof q.id === 'string' ? q.id : ''
  const pid = typeof q.processId === 'string' ? q.processId : ''
  const wantedItem = typeof q.itemId === 'string' ? q.itemId : ''
  const d = typeof q.date === 'string' ? q.date : ''
  const resumeDraft = q.draft === '1'

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
  startInput.value = startTime.value
  endInput.value = endTime.value
  timeInvalid.start = false
  timeInvalid.end = false
  quantity.value = ''
  gapReason.value = 'none'
  location.value = ''
  locationError.value = ''
  note.value = ''
  draftSavedAt.value = 0

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
      startInput.value = row.startTime
      endInput.value = row.endTime
      quantity.value = row.quantity === undefined ? '' : String(row.quantity)
      gapReason.value = row.gapReason ?? 'none'
      location.value = row.location ?? ''
      note.value = row.note ?? ''
    }
  }
  startInput.value = startTime.value
  endInput.value = endTime.value

  // 首页加号显式恢复草稿；编辑旧记录、快捷工序或指定日期入口以本次选择为准。
  if (shouldRestoreRecordDraft({ id, processId: pid, itemId: wantedItem, date: d, resumeDraft })) {
    await restoreDraft()
  }
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
    <div v-if="draftSavedAt && !recordId" class="draft-banner">
      <div>
        <b>已暂存</b>
        <span>{{ draftSavedLabel }} · 返回首页可从今日记录继续，正式保存后清除</span>
      </div>
      <van-button size="mini" plain type="primary" @click="discardDraft">清除</van-button>
    </div>
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
      <van-field
        :model-value="startInput"
        label="开工时刻"
        type="text"
        inputmode="numeric"
        maxlength="5"
        placeholder="如 08:30，或只输 830"
        :error-message="timeInvalid.start ? '格式不对，请按 08:30 填' : ''"
        required
        @update:model-value="onTimeInput('start', $event)"
        @blur="commitTime('start')"
      >
        <template #button>
          <van-button size="mini" plain type="primary" @click.stop="fillNowStart">现在</van-button>
        </template>
      </van-field>
      <van-field
        :model-value="endInput"
        label="完工时刻"
        type="text"
        inputmode="numeric"
        maxlength="5"
        placeholder="如 12:00，或只输 1200"
        :error-message="timeInvalid.end ? '格式不对，请按 12:00 填' : ''"
        required
        @update:model-value="onTimeInput('end', $event)"
        @blur="commitTime('end')"
      >
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
      <div class="time-hint muted">直接输入时间，如 08:30；也可只输 830。完工早于开工会自动按跨零点算。</div>
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
      <van-field
        v-model="location"
        :label="isSupport ? '支护桩号' : '部位/桩号'"
        :placeholder="isSupport ? '如 0+413~0+438（可后补，建议填写）' : '如：0+120 左侧边坡（选填）'"
        :error-message="locationError"
        @blur="normalizeLocation"
      />
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
    <van-button v-else plain type="primary" @click="saveDraft">暂存</van-button>
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

  <!-- 等待原因：内置 + 自己加过的 + 现场新增 -->
  <van-popup v-model:show="showReasonPicker" round position="bottom" :style="{ maxHeight: '74%' }">
    <div class="sheet">
      <div class="sheet-head">
        <div class="sheet-title">开工前等待的原因</div>
        <van-button size="small" type="primary" plain @click="openReasonEditor">＋ 新增原因</van-button>
      </div>
      <div class="sheet-body">
        <van-cell v-for="r in GAP_REASONS" :key="r.key" :title="r.label" clickable @click="pickReason(r.key)">
          <template #right-icon>
            <van-icon v-if="gapReason === r.key" name="success" color="#1f6feb" />
          </template>
        </van-cell>

        <template v-if="customReasonOptions.length">
          <div class="group-title">自己加过的（本机记住）</div>
          <van-cell
            v-for="name in customReasonOptions"
            :key="name"
            :title="name"
            clickable
            @click="pickReason(name)"
          >
            <template #right-icon>
              <van-icon v-if="gapReason === name" name="success" color="#1f6feb" />
            </template>
          </van-cell>
        </template>

        <div class="muted" style="padding: 12px 16px 0">
          没有合适的就点右上角「＋ 新增原因」，写一次会记住，下次直接选。
        </div>
      </div>
    </div>
  </van-popup>

  <van-popup v-model:show="reasonEditor.show" round position="bottom">
    <div class="sheet">
      <div class="sheet-head">
        <div class="sheet-title">新增等待原因</div>
      </div>
      <div class="sheet-body">
        <van-field v-model="reasonEditor.name" label="原因" placeholder="如：等监理旁站" maxlength="20" />
        <div class="muted" style="padding: 10px 16px 0">
          保存后会自动选中；本机最多记 {{ MAX_CUSTOM_REASONS }} 条，写的文字会随记录同步到另一台手机。
        </div>
      </div>
      <div class="sheet-foot">
        <van-button block round @click="reasonEditor.show = false">取消</van-button>
        <van-button block round type="primary" @click="submitReason">保存并选中</van-button>
      </div>
    </div>
  </van-popup>

  <div class="bottom-space" />
</template>

<style scoped>
.draft-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #cfe0ff;
  border-radius: 12px;
  background: #eef3ff;
  color: #24539b;
  font-size: 13px;
  line-height: 1.45;
}

.draft-banner span {
  margin-left: 6px;
  color: #62789a;
}

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

.time-hint {
  padding: 0 16px 10px;
  font-size: 12px;
  color: #8b95a1;
  line-height: 1.5;
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
