<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, state } from '@/store'
import {
  deleteRecord as removeRecord,
  deleteRecordDraft,
  getKv,
  getRecord,
  getRecordDraft,
  saveProcess,
  saveRecord,
  saveRecordDraft,
  setKv
} from '@/db'
import { buildTimeFields, manualGapHoursOf, suggestStandardHours } from '@/core/compute'
import { checkBeforeSave } from '@/core/health'
import { parseChainageRange, recommendNextChainage } from '@/core/chainage'
import { familyOfKey, processKeyOf } from '@/core/cycles'
import { GAP_REASONS, MAX_CUSTOM_REASONS, mergeCustomReasons } from '@/core/reasons'
import { recommendProcesses, rememberProcess, type ProcessMemory } from '@/core/recommend'
import { buildUsageIndex, predictSelection, rankByUsage } from '@/core/predict'
import type { RecordDraftInput } from '@/core/recordDraft'
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
const endTime = ref('')
/** 输入框里的原始文字；失焦或保存时再校验并写回 startTime / endTime */
const startInput = ref(startTime.value)
const endInput = ref(endTime.value)
/** 输入的时刻格式不对时标红提示（不偷偷改回旧值） */
const timeInvalid = reactive({ start: false, end: false })
const quantity = ref<string>('')
const gapReason = ref('none')
const gapStartTime = ref('')
const gapEndTime = ref('')
const gapStartInput = ref('')
const gapEndInput = ref('')
const gapTimeInvalid = reactive({ start: false, end: false })
const chainage = ref('')
const chainageError = ref('')
const location = ref('')
const locationError = ref('')
const note = ref('')
const saving = ref(false)
/** 当前草稿 id 与暂存时间；空 id 表示这是一张尚未暂存的新表单 */
const draftId = ref('')
const draftSavedAt = ref(0)
const NEXT_CHAINAGE_KEY = 'ui.nextChainage'

interface NextChainageMemory {
  itemId: string
  value: string
  savedAt: number
}

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
/** 桩号失焦时规范化成手机端短写法；连接符统一显示为 `-` */
function normalizeChainage() {
  const text = chainage.value.trim()
  if (!text) {
    chainageError.value = recordId.value ? '' : '请填写桩号'
    return
  }
  const parsed = parseChainageRange(text)
  if (parsed) {
    chainage.value = parsed.shortText
    chainageError.value = ''
    return
  }
  chainageError.value = '格式示例：545-548、545~548、0+545~0+548'
}

/** 历史数据在 location 中带桩号时，编辑这条记录会自动搬到新字段 */
function normalizeLocation() {
  const text = location.value.trim()
  if (!text) {
    locationError.value = ''
    return
  }
  const parsed = parseChainageRange(text)
  if (parsed && !chainage.value.trim()) {
    chainage.value = parsed.shortText
    chainageError.value = ''
    location.value = ''
    locationError.value = ''
    return
  }
  locationError.value = ''
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

const hours = computed(() => {
  if (!endTime.value) return null
  return buildTimeFields(date.value, startTime.value, endTime.value).hours
})
const crossMidnight = computed(() => {
  if (!endTime.value) return false
  const [sh, sm] = startTime.value.split(':').map(Number)
  const [eh, em] = endTime.value.split(':').map(Number)
  return eh * 60 + em <= sh * 60 + sm
})

const manualGapHours = computed(() => {
  if (!gapStartTime.value || !gapEndTime.value) return null
  return manualGapHoursOf({ gapStartTime: gapStartTime.value, gapEndTime: gapEndTime.value })
})

const cycleFamily = computed(() => familyOfKey(processKeyOf(selectedProcess.value?.id ?? '')))

/** 当前分项同一循环族里排序最后的一道工序 */
const isLastCycleProcess = computed(() => {
  if (!cycleFamily.value || !itemId.value || !processId.value) return false
  const peers = state.processes
    .filter(
      (p) =>
        p.itemId === itemId.value &&
        p.enabled &&
        familyOfKey(processKeyOf(p.id)) === cycleFamily.value
    )
    .sort((a, b) => a.sort - b.sort)
  return peers[peers.length - 1]?.id === processId.value
})

const recommendationMeters = computed(() => {
  const qty = Number(quantity.value)
  if (Number.isFinite(qty) && qty > 0) return qty
  const parsed = parseChainageRange(chainage.value)
  return parsed ? parsed.endM - parsed.startM : 0
})

const nextChainageRecommendation = computed(() =>
  !recordId.value && isLastCycleProcess.value
    ? recommendNextChainage(chainage.value, recommendationMeters.value)
    : null
)

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
    void prefillNextChainage(res.itemId)
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
  if (!recordId.value) {
    chainage.value = ''
    chainageError.value = ''
    location.value = ''
    locationError.value = ''
  }
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
    void prefillNextChainage(id)
  }
}

function pickProcess(p: Process) {
  processId.value = p.id
  predictedHint.value = ''
  showProcessSheet.value = false
}

/** 上一条循环末工序保存后预留的下一段桩号，只在本机用于下一次新建 */
async function prefillNextChainage(targetItemId = itemId.value) {
  if (!targetItemId || recordId.value || chainage.value.trim() || draftId.value) return
  const saved = await getKv<NextChainageMemory | null>(NEXT_CHAINAGE_KEY, null)
  if (saved?.itemId === targetItemId && saved.value) {
    chainage.value = saved.value
    chainageError.value = ''
  }
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

type TimeKind = 'start' | 'end' | 'gapStart' | 'gapEnd'

function timeInputOf(kind: TimeKind) {
  if (kind === 'start') return startInput
  if (kind === 'end') return endInput
  if (kind === 'gapStart') return gapStartInput
  return gapEndInput
}

function timeValueOf(kind: TimeKind) {
  if (kind === 'start') return startTime
  if (kind === 'end') return endTime
  if (kind === 'gapStart') return gapStartTime
  return gapEndTime
}

function markTimeInvalid(kind: TimeKind, invalid: boolean) {
  if (kind === 'gapStart') gapTimeInvalid.start = invalid
  else if (kind === 'gapEnd') gapTimeInvalid.end = invalid
  else timeInvalid[kind] = invalid
}

/** 输入框只留数字和冒号，其它字符直接挡掉 */
function onTimeInput(kind: TimeKind, raw: string) {
  const cleaned = String(raw ?? '').replace(/[^\d:]/g, '').slice(0, 5)
  markTimeInvalid(kind, false)
  timeInputOf(kind).value = cleaned
}

/** 失焦或保存时校验并规范成 HH:mm；不合法就保留原文并标红，等用户改 */
function commitTime(kind: TimeKind): boolean {
  const raw = timeInputOf(kind).value
  const parsed = parseLooseTime(raw)
  if (!parsed) {
    markTimeInvalid(kind, true)
    return false
  }
  markTimeInvalid(kind, false)
  timeValueOf(kind).value = parsed
  timeInputOf(kind).value = parsed
  return true
}

function commitTimes(): boolean {
  const okStart = commitTime('start')
  const okEnd = commitOptionalEnd()
  return okStart && okEnd
}

function commitOptionalEnd(): boolean {
  const hasEnd = Boolean(endInput.value.trim())
  if (!hasEnd) {
    endTime.value = ''
    timeInvalid.end = false
    return true
  }
  return commitTime('end')
}

function commitGapTimes(): boolean {
  const hasStart = Boolean(gapStartInput.value.trim())
  const hasEnd = Boolean(gapEndInput.value.trim())
  if (!hasStart && !hasEnd) {
    gapStartTime.value = ''
    gapEndTime.value = ''
    gapTimeInvalid.start = false
    gapTimeInvalid.end = false
    return true
  }
  if (!hasStart || !hasEnd) {
    gapTimeInvalid.start = !hasStart
    gapTimeInvalid.end = !hasEnd
    return false
  }
  return commitTime('gapStart') && commitTime('gapEnd')
}

function setTime(kind: TimeKind, value: string) {
  markTimeInvalid(kind, false)
  timeValueOf(kind).value = value
  timeInputOf(kind).value = value
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
    gapStartTime: gapStartTime.value,
    gapEndTime: gapEndTime.value,
    chainage: chainage.value,
    location: location.value,
    note: note.value
  }
}

/** 每条暂存都有独立 id；保存或删除只影响当前这条。 */
async function saveDraft() {
  if (recordId.value) return
  if (!state.currentProjectId) {
    showToast('请先选择项目')
    return
  }
  try {
    const saved = await saveRecordDraft({
      ...draftSnapshot(),
      id: draftId.value || undefined
    })
    draftId.value = saved.id
    draftSavedAt.value = saved.updatedAt
    await afterChange('drafts')
    showToast('已暂存，可在首页“暂存记录”继续填写')
  } catch {
    showToast('暂存失败，请稍后再试')
  }
}

async function removeStoredDraft() {
  if (draftId.value) await deleteRecordDraft(draftId.value)
  await afterChange('drafts')
  draftId.value = ''
  draftSavedAt.value = 0
}

async function discardDraft() {
  try {
    await showConfirmDialog({
      title: '清除暂存',
      message: '只清除首页中的这条暂存，当前页面填写的内容仍保留。确定清除吗？',
      confirmButtonText: '清除'
    })
  } catch {
    return
  }
  await removeStoredDraft()
  showToast('暂存已清除')
}

async function restoreDraft(id: string) {
  const raw = await getRecordDraft(id)
  if (!raw || raw.projectId !== state.currentProjectId) {
    showToast('这条暂存不存在或已被其他设备删除')
    return false
  }

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
  endTime.value = raw.endTime || ''
  // 完工时刻允许先留空，恢复时不能填入默认时刻。
  startInput.value = raw.startInput
  endInput.value = raw.endInput
  timeInvalid.start = false
  timeInvalid.end = false
  quantity.value = raw.quantity
  gapReason.value = raw.gapReason || 'none'
  gapStartTime.value = raw.gapStartTime ?? ''
  gapEndTime.value = raw.gapEndTime ?? ''
  gapStartInput.value = raw.gapStartTime ?? ''
  gapEndInput.value = raw.gapEndTime ?? ''
  gapTimeInvalid.start = false
  gapTimeInvalid.end = false
  chainage.value = raw.chainage ?? ''
  chainageError.value = ''
  location.value = raw.location
  locationError.value = ''
  note.value = raw.note
  draftId.value = raw.id
  draftSavedAt.value = raw.savedAt
  showToast('已恢复这条暂存')
  return true
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
  if (!commitGapTimes()) {
    showToast('等待开始和结束要同时填写，或都留空')
    return
  }
  // 新建记录必须填有效桩号；编辑历史无桩号记录时仍可保存，避免强行打断旧数据修订。
  const requiresChainage = !recordId.value || Boolean(chainage.value.trim())
  const chainageRange = parseChainageRange(chainage.value)
  if (requiresChainage && !chainageRange) {
    chainageError.value = '请填写有效桩号，格式示例：545-548'
    showToast(chainage.value.trim() ? '请改正桩号格式' : '请填写桩号')
    return
  }
  if (chainageRange) chainage.value = chainageRange.shortText
  saving.value = true
  try {
    const op = state.operators.find((o) => o.id === state.currentOperatorId)
    // 保存前做一次衔接体检：重叠 / 间隔过长 / 重复录入 → 先让人确认
    const times = endTime.value ? buildTimeFields(date.value, startTime.value, endTime.value) : null
    const warnings = times
      ? checkBeforeSave(
          {
            id: recordId.value ?? undefined,
            processId: processId.value,
            date: date.value,
            startAt: times.startAt,
            endAt: times.endAt
          },
          state.records,
          processById.value
        )
      : []
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
    const saved = await saveRecord({
      id: recordId.value ?? undefined,
      projectId: state.currentProjectId,
      processId: processId.value,
      date: date.value,
      startTime: startTime.value,
      endTime: endTime.value || undefined,
      quantity: quantity.value === '' ? undefined : Number(quantity.value),
      gapReason: gapReason.value,
      gapStartTime: gapStartTime.value || undefined,
      gapEndTime: gapEndTime.value || undefined,
      gapHours: manualGapHours.value ?? undefined,
      chainage: chainage.value.trim() || undefined,
      location: location.value.trim() || undefined,
      note: note.value.trim() || undefined,
      operatorId: state.currentOperatorId,
      operatorName: op?.name ?? '未署名'
    })
    const next = nextChainageRecommendation.value
    if (next && !recordId.value) {
      await setKv(NEXT_CHAINAGE_KEY, {
        itemId: saved.processId ? (processById.value.get(saved.processId)?.itemId ?? itemId.value) : itemId.value,
        value: next.shortText,
        savedAt: Date.now()
      })
    }
    await afterChange('records')
    // 只清除当前这张表单对应的草稿，其他工作面的暂存继续保留。
    if (!recordId.value && draftId.value) await removeStoredDraft()
    const isToday = date.value === todayStr()
    if (recordId.value) {
      showToast('已保存修改')
    } else if (!endTime.value) {
      showToast('已保存，待补完工时间')
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
  const wantedDraftId = typeof q.draftId === 'string' ? q.draftId : ''

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
  endTime.value = ''
  startInput.value = startTime.value
  endInput.value = endTime.value
  timeInvalid.start = false
  timeInvalid.end = false
  quantity.value = ''
  gapReason.value = 'none'
  gapStartTime.value = ''
  gapEndTime.value = ''
  gapStartInput.value = ''
  gapEndInput.value = ''
  gapTimeInvalid.start = false
  gapTimeInvalid.end = false
  chainage.value = ''
  chainageError.value = ''
  location.value = ''
  locationError.value = ''
  note.value = ''
  draftId.value = ''
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
      endTime.value = row.endTime ?? ''
      startInput.value = row.startTime
      endInput.value = row.endTime ?? ''
      quantity.value = row.quantity === undefined ? '' : String(row.quantity)
      gapReason.value = row.gapReason ?? 'none'
      gapStartTime.value = row.gapStartTime ?? ''
      gapEndTime.value = row.gapEndTime ?? ''
      gapStartInput.value = row.gapStartTime ?? ''
      gapEndInput.value = row.gapEndTime ?? ''
      const legacyChainage = parseChainageRange(row.location)
      chainage.value = parseChainageRange(row.chainage)?.shortText ?? legacyChainage?.shortText ?? ''
      location.value = legacyChainage && !row.chainage ? '' : (row.location ?? '')
      note.value = row.note ?? ''
    }
  }
  startInput.value = startTime.value
  endInput.value = endTime.value

  // 首页加号打开空白表单；只有点击某条暂存时才用 draftId 明确恢复。
  if (wantedDraftId) {
    const restored = await restoreDraft(wantedDraftId)
    if (restored && !chainage.value.trim()) await prefillNextChainage()
  } else if (!id) {
    await prefillNextChainage()
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
        <span>{{ draftSavedLabel }} · 首页“暂存记录”可继续填写，正式保存后只清除这一条</span>
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
        v-model="chainage"
        label="桩号"
        placeholder="如 545-548；也支持 545~548"
        required
        :error-message="chainageError"
        @blur="normalizeChainage"
      />
      <div class="item-note">连接符可用 ~、-、～ 或“至”；保存后统一显示为简写，如 545-548。</div>
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
      <div v-if="nextChainageRecommendation" class="chainage-recommend">
        <span>下一段建议 <b>{{ nextChainageRecommendation.shortText }}</b></span>
        <span>{{ recommendationMeters.toFixed(1) }}m 累加 · 保存后下次自动带入</span>
      </div>
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
      <div class="process-time-stack">
        <van-field
          class="process-time-row"
          :model-value="startInput"
          label="开工"
          type="text"
          inputmode="numeric"
          maxlength="5"
          placeholder="08:30"
          :error-message="timeInvalid.start ? '格式不对' : ''"
          required
          @update:model-value="onTimeInput('start', $event)"
          @blur="commitTime('start')"
        >
          <template #button>
            <van-button class="now-button" size="mini" plain type="primary" @click.stop="fillNowStart">现在</van-button>
          </template>
        </van-field>
        <van-field
          class="process-time-row"
          :model-value="endInput"
          label="完工"
          type="text"
          inputmode="numeric"
          maxlength="5"
          placeholder="可留空，稍后补填"
          :error-message="timeInvalid.end ? '格式不对' : ''"
          @update:model-value="onTimeInput('end', $event)"
          @blur="commitOptionalEnd"
        >
          <template #button>
            <van-button class="now-button" size="mini" plain type="primary" @click.stop="fillNowEnd">现在</van-button>
          </template>
        </van-field>
      </div>
      <van-field label="净用时">
        <template #input>
          <span v-if="hours !== null" class="num" style="font-size: 17px; font-weight: 600; color: #1f6feb">
            {{ fmtHours(hours) }}
          </span>
          <span v-else class="pending-time">— · 未完工</span>
          <span v-if="crossMidnight" class="tag-soft" style="margin-left: 8px">跨零点</span>
        </template>
      </van-field>
      <div class="time-hint muted">
        可直接输入 08:30 或 830；完工可留空，先上传为“待补完工”。完工早于开工自动按跨零点算。
      </div>
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
      <div class="time-pair">
        <van-field
          :model-value="gapStartInput"
          label="等待起"
          type="text"
          inputmode="numeric"
          maxlength="5"
          placeholder="05:30"
          :error-message="gapTimeInvalid.start ? '格式不对' : ''"
          @update:model-value="onTimeInput('gapStart', $event)"
          @blur="commitTime('gapStart')"
        />
        <van-field
          :model-value="gapEndInput"
          label="等待止"
          type="text"
          inputmode="numeric"
          maxlength="5"
          placeholder="07:35"
          :error-message="gapTimeInvalid.end ? '格式不对' : ''"
          @update:model-value="onTimeInput('gapEnd', $event)"
          @blur="commitTime('gapEnd')"
        />
      </div>
      <div class="time-hint muted">
        等待起止可不填；填了会直接作为本条开工前的等待时长
        <template v-if="manualGapHours !== null">（当前 {{ fmtHours(manualGapHours) }}）</template>，不再靠前后工序时差推算。
      </div>
      <van-field
        v-model="location"
        label="部位补充"
        placeholder="如：左侧边坡（选填）"
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

.chainage-recommend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 16px 10px;
  padding: 9px 11px;
  border: 1px solid #cfe0ff;
  border-radius: 10px;
  background: #f3f7ff;
  color: #24539b;
  font-size: 12px;
  line-height: 1.45;
}

.chainage-recommend b {
  font-size: 14px;
}

.chainage-recommend span:last-child {
  flex-shrink: 0;
  color: #62789a;
}

.process-time-stack :deep(.process-time-row) {
  min-height: 56px;
  padding-top: 8px;
  padding-bottom: 8px;
}

.process-time-stack :deep(.process-time-row + .process-time-row) {
  border-top: 1px solid #f0f2f5;
}

.process-time-stack :deep(.van-field__label) {
  width: 4.5em;
  margin-right: 10px;
  font-size: 14px;
}

.process-time-stack :deep(.van-field__control) {
  min-height: 32px;
  font-size: 16px;
}

.pending-time {
  color: #b26a00;
  font-size: 14px;
  font-weight: 600;
}

.time-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.time-pair :deep(.van-field) {
  min-width: 0;
  padding-left: 12px;
  padding-right: 8px;
}

.time-pair :deep(.van-field:first-child) {
  border-right: 1px solid #f0f2f5;
}

.time-pair :deep(.van-field__label) {
  width: 4.2em;
  margin-right: 6px;
  font-size: 13px;
}

.time-pair :deep(.van-field__control) {
  min-width: 0;
  font-size: 13px;
}

.time-pair :deep(.van-field__button) {
  margin-left: 2px;
}

.now-button {
  min-height: 44px;
  min-width: 52px;
  padding-left: 12px;
  padding-right: 12px;
  font-size: 13px;
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
