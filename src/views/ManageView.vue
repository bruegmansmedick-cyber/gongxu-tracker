<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, setProject, state } from '@/store'
import {
  applyBenchTemplate,
  clearHistoryRecords,
  countHistoryRecords,
  deleteProcess,
  deleteProject,
  deleteWbsNode,
  mergeWorkfaces,
  rebindItemWorkface,
  saveProcess,
  saveProject,
  saveWbsNode,
  saveWorkface,
  seedHistoryRecords,
  setProjectArchived
} from '@/db'
import { suggestStandardHours } from '@/core/compute'
import {
  filterStandardHoursRows,
  type StandardHoursFilter
} from '@/core/standardFilter'
import { buildItemWorkfaceMap } from '@/core/workface'
import { HISTORY_ROWS } from '@/db/history'
import type { Process, WbsLevel, WbsNode, Workface } from '@/types'
import { fmtHoursShort } from '@/core/time'

const tab = ref<'structure' | 'standard' | 'workface'>('structure')
const expanded = ref<Set<string>>(new Set())

/** 参考用时最少样本数：少于 5 次不写参考值（宁缺勿假） */
const MIN_REF_SAMPLES = 5

const project = computed(() => state.projects.find((p) => p.id === state.currentProjectId))
const units = computed(() => state.wbs.filter((w) => w.level === 1).sort((a, b) => a.sort - b.sort))

function childrenOf(parentId: string | null, level?: WbsLevel) {
  return state.wbs
    .filter((w) => w.parentId === parentId && (level === undefined || w.level === level))
    .sort((a, b) => a.sort - b.sort)
}

function processesOf(itemId: string) {
  return state.processes.filter((p) => p.itemId === itemId).sort((a, b) => a.sort - b.sort)
}

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function expandAll() {
  expanded.value = new Set(state.wbs.map((w) => w.id))
}

// ------------------------------------------------------------------ 编辑器
interface EditorState {
  show: boolean
  kind: 'project' | 'wbs' | 'process'
  id: string
  level: WbsLevel
  parentId: string | null
  name: string
  unit: string
  designQty: string
  standardHours: string
  enabled: boolean
  code: string
  applyTemplate: boolean
  importHistory: boolean
}

const editor = reactive<EditorState>({
  show: false,
  kind: 'wbs',
  id: '',
  level: 1,
  parentId: null,
  name: '',
  unit: '',
  designQty: '',
  standardHours: '',
  enabled: true,
  code: '',
  applyTemplate: true,
  importHistory: true
})

const editorTitle = computed(() => {
  if (editor.kind === 'project') return editor.id ? '编辑项目' : '新建项目'
  if (editor.kind === 'process') return editor.id ? '编辑工序' : '新增工序'
  const names = ['', '单位工程', '分部工程', '分项工程']
  return (editor.id ? '编辑' : '新增') + names[editor.level]
})

function openProjectEditor() {
  Object.assign(editor, {
    show: true,
    kind: 'project',
    id: project.value?.id ?? '',
    name: project.value?.name ?? '',
    code: project.value?.code ?? '',
    // 第一次建项目时默认套用模板（首页也提示"新建项目并套用模板"），已有项目时该开关不显示
    applyTemplate: !project.value,
    importHistory: !project.value
  })
}

function openWbsEditor(level: WbsLevel, parentId: string | null, node?: { id: string; name: string; unit?: string; designQty?: number }) {
  Object.assign(editor, {
    show: true,
    kind: 'wbs',
    id: node?.id ?? '',
    level,
    parentId,
    name: node?.name ?? '',
    unit: node?.unit ?? '',
    designQty: node?.designQty === undefined ? '' : String(node.designQty)
  })
}

function openProcessEditor(itemId: string, proc?: Process) {
  Object.assign(editor, {
    show: true,
    kind: 'process',
    id: proc?.id ?? '',
    parentId: itemId,
    name: proc?.name ?? '',
    unit: proc?.unit ?? '',
    designQty: proc?.designQty === undefined ? '' : String(proc.designQty),
    standardHours: proc?.standardHours === undefined ? '' : String(proc.standardHours),
    enabled: proc ? proc.enabled === 1 : true
  })
}

async function submitEditor() {
  if (!editor.name.trim()) {
    showToast('请填写名称')
    return
  }
  if (editor.kind === 'project') {
    const row = await saveProject({
      id: editor.id || undefined,
      name: editor.name.trim(),
      code: editor.code.trim() || undefined
    })
    if (!editor.id && editor.applyTemplate) {
      const res = await applyBenchTemplate(row.id)
      if (editor.importHistory) {
        const n = await seedHistoryRecords(row.id)
        showToast(`已套用项目划分模板：${res.workfaces} 个工作面、${res.processes} 道工序，补录 ${n} 条历史记录`)
      } else {
        showToast(`已套用项目划分模板：${res.workfaces} 个工作面、${res.processes} 道工序`)
      }
    }
    await setProject(row.id)
    await afterChange('projects')
  } else if (editor.kind === 'wbs') {
    if (!state.currentProjectId) {
      showToast('请先选择项目')
      return
    }
    await saveWbsNode({
      id: editor.id || undefined,
      projectId: state.currentProjectId,
      parentId: editor.parentId,
      level: editor.level,
      name: editor.name.trim(),
      unit: editor.unit.trim() || undefined,
      designQty: editor.designQty === '' ? undefined : Number(editor.designQty)
    })
    if (editor.parentId) expanded.value = new Set([...expanded.value, editor.parentId])
    await afterChange('structure')
  } else {
    if (!state.currentProjectId) {
      showToast('请先选择项目')
      return
    }
    await saveProcess({
      id: editor.id || undefined,
      projectId: state.currentProjectId,
      itemId: editor.parentId as string,
      name: editor.name.trim(),
      unit: editor.unit.trim() || undefined,
      designQty: editor.designQty === '' ? undefined : Number(editor.designQty),
      standardHours: editor.standardHours === '' ? undefined : Number(editor.standardHours),
      enabled: editor.enabled ? 1 : 0
    })
    await afterChange('structure')
  }
  editor.show = false
}

async function removeWbs(id: string, name: string) {
  await showConfirmDialog({
    title: '删除结构',
    message: `将删除「${name}」及其下级全部工序和记录，且会同步到其他设备，确定吗？`
  })
  await deleteWbsNode(id, true)
  await afterChange('structure')
  showToast('已删除')
}

async function removeProcess(id: string, name: string) {
  await showConfirmDialog({
    title: '删除工序',
    message: `将删除「${name}」及其全部用时记录，且会同步到其他设备，确定吗？`
  })
  await deleteProcess(id, true)
  await afterChange('structure')
  showToast('已删除')
}

async function removeProject() {
  if (!project.value) return
  await showConfirmDialog({
    title: '删除项目',
    message: `将删除项目「${project.value.name}」的全部结构、工序和记录，确定吗？`
  })
  await deleteProject(project.value.id)
  await afterChange('projects')
  showToast('已删除')
}

async function toggleArchive() {
  if (!project.value) return
  const next = project.value.archived ? 0 : 1
  await setProjectArchived(project.value.id, next)
  await afterChange('projects')
  showToast(next ? '已归档' : '已取消归档')
}

async function applyTemplate() {
  if (!state.currentProjectId) {
    showToast('请先选择项目')
    return
  }
  await showConfirmDialog({
    title: '套用本标段项目划分',
    message: '将按《项目划分申报表》新增 10 个单位工程及全部分部 / 单元工程（三条洞含循环作业工序），不会删除已有内容，确定吗？'
  })
  const res = await applyBenchTemplate(state.currentProjectId)
  await afterChange('structure')
  showToast(`已新增 ${res.units} 个单位工程、${res.processes} 道工序、${res.workfaces} 个工作面`)
}

// ------------------------------------------------------------ 历史记录补录
const historyCount = ref(0)

async function loadHistoryCount() {
  historyCount.value = state.currentProjectId ? await countHistoryRecords(state.currentProjectId) : 0
}

async function doSeedHistory() {
  if (!state.currentProjectId) {
    showToast('请先选择项目')
    return
  }
  await showConfirmDialog({
    title: '补录历史循环作业记录',
    message: `将把三份循环作业 Word 记录（共 ${HISTORY_ROWS.length} 条，2026-09-16 ~ 09-30）补录到当前项目，重复执行不会产生重复数据。`
  })
  const n = await seedHistoryRecords(state.currentProjectId)
  await afterChange('records')
  await loadHistoryCount()
  showToast(`已补录 ${n} 条历史记录`)
}

async function doClearHistory() {
  if (!state.currentProjectId) return
  await showConfirmDialog({
    title: '清除补录数据',
    message: '将删除本项目下由历史补录产生的记录（自己录入的数据不受影响），确定吗？'
  })
  const n = await clearHistoryRecords(state.currentProjectId)
  await afterChange('records')
  await loadHistoryCount()
  showToast(`已清除 ${n} 条补录记录`)
}

onMounted(() => {
  void loadHistoryCount()
})

watch(
  () => state.currentProjectId,
  () => {
    void loadHistoryCount()
    clearStandardFilter()
  }
)

// -------------------------------------------------------------- 标准用时
const standardDrafts = reactive<Record<string, string>>({})
const standardFilter = reactive<StandardHoursFilter>({
  query: '',
  unitId: '',
  divisionId: '',
  itemId: ''
})
type StandardPickerLevel = '' | 'unit' | 'division' | 'item'
const standardPickerLevel = ref<StandardPickerLevel>('')

const allStandardRows = computed(() =>
  state.processes
    .map((p) => {
      const item = state.wbs.find((w) => w.id === p.itemId)
      const div = item?.parentId ? state.wbs.find((w) => w.id === item.parentId) : undefined
      const unit = div?.parentId ? state.wbs.find((w) => w.id === div.parentId) : undefined
      const local = suggestStandardHours(p.id, state.records)
      // 优先用模板里预置的实测参考用时；没有时用本机已有记录的平均值
      // 参考用时优先用模板预置的实测统计；没有时用本机记录的平均值，但同样要求样本 ≥ 5 次
      const localUsable = local.value !== null && local.sample >= MIN_REF_SAMPLES ? local.value : null
      const refValue = p.refHours ?? localUsable
      const refText = p.refHours
        ? `实测 ${p.refSamples ?? 0} 次${
            p.refMin !== undefined && p.refMax !== undefined
              ? ` · 区间 ${fmtHoursShort(p.refMin, 2)}~${fmtHoursShort(p.refMax, 2)}`
              : ''
          }`
        : localUsable !== null
          ? `本机 ${local.sample} 条记录平均 ${fmtHoursShort(localUsable)}`
          : ''
      return {
        process: p,
        unitId: unit?.id ?? '',
        unitName: unit?.name ?? '未归单位',
        divisionId: div?.id ?? '',
        divisionName: div?.name ?? '未归分部',
        itemId: item?.id ?? p.itemId,
        itemName: item?.name ?? '未知分项',
        processName: p.name,
        refValue,
        refText
      }
    })
    .sort((a, b) =>
      (a.unitName + a.divisionName + a.itemName + a.processName).localeCompare(
        b.unitName + b.divisionName + b.itemName + b.processName,
        'zh'
      )
    )
)

const standardRows = computed(() => filterStandardHoursRows(allStandardRows.value, standardFilter))

const standardDivisions = computed(() =>
  standardFilter.unitId ? childrenOf(standardFilter.unitId, 2) : []
)

const standardItems = computed<WbsNode[]>(() => {
  if (standardFilter.divisionId) return childrenOf(standardFilter.divisionId, 3)
  if (!standardFilter.unitId) return []
  const divisionIds = new Set(childrenOf(standardFilter.unitId, 2).map((d) => d.id))
  return state.wbs
    .filter((w) => w.level === 3 && w.parentId !== null && divisionIds.has(w.parentId))
    .sort((a, b) => a.sort - b.sort)
})

const standardPickerTitle = computed(() => {
  if (standardPickerLevel.value === 'unit') return '选择单位工程'
  if (standardPickerLevel.value === 'division') return '选择分部工程'
  if (standardPickerLevel.value === 'item') return '选择分项工程'
  return ''
})

const showStandardPicker = computed({
  get: () => standardPickerLevel.value !== '',
  set: (show: boolean) => {
    if (!show) standardPickerLevel.value = ''
  }
})

const standardPickerSelectedId = computed(() => {
  if (standardPickerLevel.value === 'unit') return standardFilter.unitId
  if (standardPickerLevel.value === 'division') return standardFilter.divisionId
  if (standardPickerLevel.value === 'item') return standardFilter.itemId
  return ''
})

const standardPickerAllLabel = computed(() => {
  if (standardPickerLevel.value === 'unit') return '全部单位工程'
  if (standardPickerLevel.value === 'division') return '全部分部工程'
  if (standardPickerLevel.value === 'item') return '全部分项工程'
  return '全部'
})

const standardPickerOptions = computed<WbsNode[]>(() => {
  if (standardPickerLevel.value === 'unit') return units.value
  if (standardPickerLevel.value === 'division') return standardDivisions.value
  if (standardPickerLevel.value === 'item') return standardItems.value
  return []
})

const standardUnitLabel = computed(
  () => state.wbs.find((w) => w.id === standardFilter.unitId)?.name ?? '全部单位工程'
)
const standardDivisionLabel = computed(
  () => state.wbs.find((w) => w.id === standardFilter.divisionId)?.name ?? '全部分部工程'
)
const standardItemLabel = computed(
  () => state.wbs.find((w) => w.id === standardFilter.itemId)?.name ?? '全部分项工程'
)
const standardHasScope = computed(() =>
  Boolean(standardFilter.unitId || standardFilter.divisionId || standardFilter.itemId)
)
const standardHasFilter = computed(() => standardHasScope.value || Boolean(standardFilter.query.trim()))

function openStandardPicker(level: Exclude<StandardPickerLevel, ''>) {
  standardPickerLevel.value = level
}

function chooseStandardFilter(id: string) {
  if (standardPickerLevel.value === 'unit') {
    standardFilter.unitId = id
    standardFilter.divisionId = ''
    standardFilter.itemId = ''
  } else if (standardPickerLevel.value === 'division') {
    standardFilter.divisionId = id
    standardFilter.itemId = ''
  } else if (standardPickerLevel.value === 'item') {
    standardFilter.itemId = id
  }
  standardPickerLevel.value = ''
}

function clearStandardFilter() {
  standardFilter.query = ''
  standardFilter.unitId = ''
  standardFilter.divisionId = ''
  standardFilter.itemId = ''
}

function draftValue(p: Process): string {
  if (standardDrafts[p.id] !== undefined) return standardDrafts[p.id]
  return p.standardHours === undefined ? '' : String(p.standardHours)
}

function adoptRefHour(processId: string, value: number | null) {
  if (value === null) return
  standardDrafts[processId] = String(value)
}

const refCount = computed(() => standardRows.value.filter((r) => r.refValue !== null).length)

function adoptAllRefHours() {
  let n = 0
  standardRows.value.forEach((row) => {
    if (row.refValue !== null) {
      standardDrafts[row.process.id] = String(row.refValue)
      n += 1
    }
  })
  showToast(n ? `已填入 ${n} 道工序，记得点“保存标准用时”` : '没有可采用的参考用时')
}

async function resetAllStandards() {
  await showConfirmDialog({ title: '清空标准用时', message: '将把所有工序的标准用时清空（参考用时不受影响），确定吗？' })
  allStandardRows.value.forEach((row) => {
    standardDrafts[row.process.id] = ''
  })
  showToast('已清空，记得点“保存标准用时”')
}

async function saveStandards() {
  const entries = Object.entries(standardDrafts)
  if (!entries.length) {
    showToast('没有需要保存的修改')
    return
  }
  for (const [id, value] of entries) {
    const p = state.processes.find((x) => x.id === id)
    if (!p) continue
    await saveProcess({
      id: p.id,
      projectId: p.projectId,
      itemId: p.itemId,
      name: p.name,
      unit: p.unit,
      designQty: p.designQty,
      standardHours: value === '' ? undefined : Number(value),
      enabled: p.enabled
    })
    delete standardDrafts[id]
  }
  await afterChange('structure')
  showToast('标准用时已保存')
}

// ---------------------------------------------------------------- 工作面
const itemFace = computed(() => buildItemWorkfaceMap(state.wbs, state.workfaces))

interface FaceGroupRow {
  workface: Workface
  items: WbsNode[]
}

interface FaceGroup {
  unit: WbsNode
  faces: FaceGroupRow[]
}

const faceGroups = computed<FaceGroup[]>(() =>
  units.value
    .map((unit) => ({
      unit,
      faces: state.workfaces
        .filter((w) => w.unitId === unit.id)
        .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh'))
        .map((workface) => ({
          workface,
          items: state.wbs
            .filter((w) => w.level === 3 && itemFace.value.get(w.id) === workface.id)
            .sort((a, b) => a.sort - b.sort)
        }))
    }))
    .filter((group) => group.faces.length > 0)
)

const workfaceCount = computed(() => state.workfaces.length)
const boundItemCount = computed(
  () => state.wbs.filter((w) => w.level === 3 && Boolean(itemFace.value.get(w.id))).length
)
const unboundItems = computed(() =>
  state.wbs.filter((w) => w.level === 3 && !itemFace.value.get(w.id)).sort((a, b) => a.sort - b.sort)
)

const showRename = ref(false)
const renameTarget = ref<Workface | null>(null)
const renameDraft = ref('')

/** 分项默认收起：33 个工作面全展开会让页面很长 */
const expandedFaces = ref<Set<string>>(new Set())

function toggleFace(id: string) {
  const next = new Set(expandedFaces.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedFaces.value = next
}

const pickerMode = ref<'rebind' | 'merge' | ''>('')
const rebindTarget = ref<WbsNode | null>(null)
const mergeSource = ref<Workface | null>(null)

/** 改名 */
function openRename(face: Workface) {
  renameTarget.value = face
  renameDraft.value = face.name
  showRename.value = true
}

async function submitRename() {
  const face = renameTarget.value
  if (!face) return
  const name = renameDraft.value.trim()
  if (!name) {
    showToast('请填写工作面名称')
    return
  }
  const clash = state.workfaces.some((w) => w.unitId === face.unitId && w.id !== face.id && w.name === name)
  if (clash) {
    showToast('同一单位工程下已有同名工作面，请换个名字')
    return
  }
  await saveWorkface({ id: face.id, projectId: face.projectId, unitId: face.unitId, name, sort: face.sort })
  showRename.value = false
  renameTarget.value = null
  await afterChange('structure')
  showToast('工作面已改名')
}

/** 分项重绑：只能挂到同一单位工程下的工作面 */
function openRebind(item: WbsNode) {
  rebindTarget.value = item
  mergeSource.value = null
  pickerMode.value = 'rebind'
}

function openMerge(face: Workface) {
  mergeSource.value = face
  rebindTarget.value = null
  pickerMode.value = 'merge'
}

function unitIdOfItemNode(item: WbsNode): string {
  const div = item.parentId ? state.wbs.find((w) => w.id === item.parentId) : undefined
  return div?.parentId ?? ''
}

const pickerFaces = computed<Workface[]>(() => {
  if (pickerMode.value === 'rebind' && rebindTarget.value) {
    const unitId = unitIdOfItemNode(rebindTarget.value)
    return state.workfaces
      .filter((w) => w.unitId === unitId && w.id !== itemFace.value.get(rebindTarget.value!.id))
      .sort((a, b) => a.sort - b.sort)
  }
  if (pickerMode.value === 'merge' && mergeSource.value) {
    return state.workfaces
      .filter((w) => w.unitId === mergeSource.value!.unitId && w.id !== mergeSource.value!.id && !w.deletedAt)
      .sort((a, b) => a.sort - b.sort)
  }
  return []
})

const pickerTitle = computed(() => {
  if (pickerMode.value === 'rebind') return `把「${rebindTarget.value?.name ?? ''}」改挂到`
  if (pickerMode.value === 'merge') return `把「${mergeSource.value?.name ?? ''}」合并到`
  return ''
})

const pickerHint = computed(() =>
  pickerMode.value === 'merge'
    ? '合并后源工作面的分项全部迁到目标，源工作面被软删除；历史记录不改写，仍按分项归属。'
    : '只改目录绑定，不改历史记录；同一单位工程内才能互挂。'
)

function onPickerShow(show: boolean) {
  if (!show) pickerMode.value = ''
}

async function chooseFace(faceId: string) {
  if (pickerMode.value === 'rebind' && rebindTarget.value) {
    await rebindItemWorkface(rebindTarget.value.id, faceId)
    pickerMode.value = ''
    rebindTarget.value = null
    await afterChange('structure')
    showToast('已改挂工作面')
    return
  }
  if (pickerMode.value === 'merge' && mergeSource.value) {
    const source = mergeSource.value
    const target = state.workfaces.find((w) => w.id === faceId)
    if (!target) return
    await showConfirmDialog({
      title: '合并工作面',
      message: `将把「${source.name}」下的分项全部改挂到「${target.name}」，并软删除「${source.name}」。历史记录不受影响，确定吗？`
    })
    const res = await mergeWorkfaces(source.id, faceId)
    pickerMode.value = ''
    mergeSource.value = null
    await afterChange('structure')
    showToast(`已合并，迁移 ${res.items} 个分项`)
  }
}
</script>

<template>
  <van-nav-bar title="工程管理" fixed placeholder>
    <template #right>
      <span class="muted" @click="openProjectEditor">{{ project ? '编辑项目' : '新建项目' }}</span>
    </template>
  </van-nav-bar>

  <div class="page">
    <div class="card">
      <div class="row-between">
        <div>
          <div class="muted">当前项目</div>
          <div style="font-size: 17px; font-weight: 600">{{ project?.name ?? '尚未创建项目' }}</div>
          <div v-if="project?.code" class="muted">{{ project.code }}</div>
        </div>
        <van-button size="small" plain type="primary" @click="openProjectEditor">新建项目</van-button>
      </div>
      <div v-if="project" class="divider" />
      <div v-if="project" class="btn-row">
        <van-button size="small" plain @click="applyTemplate">套用模板</van-button>
        <van-button size="small" plain @click="toggleArchive">{{ project.archived ? '取消归档' : '归档项目' }}</van-button>
        <van-button size="small" plain type="danger" @click="removeProject">删除项目</van-button>
      </div>
    </div>

    <van-tabs v-model:active="tab" type="card">
      <van-tab title="工程结构" name="structure" />
      <van-tab title="工作面" name="workface" />
      <van-tab title="标准用时" name="standard" />
    </van-tabs>

    <template v-if="tab === 'structure'">
      <div class="card" style="margin-top: 12px">
        <div class="row-between">
          <div class="muted">点击标题展开 / 收起</div>
          <span class="muted" @click="expandAll">全部展开</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          历史循环作业记录
          <span class="sub">来自 2026 年 9 月三份 Word 记录</span>
        </div>
        <div class="muted">
          三份记录共 {{ HISTORY_ROWS.length }} 条（1#施工支洞 / 通风兼安全洞 / 闸室交通洞），
          当前项目已补录 <b>{{ historyCount }}</b> 条。
        </div>
        <div class="btn-row">
          <van-button size="small" type="primary" plain @click="doSeedHistory">补录历史记录</van-button>
          <van-button size="small" plain :disabled="!historyCount" @click="doClearHistory">清除补录</van-button>
        </div>
      </div>

      <van-empty v-if="!units.length" description="还没有工程结构，可点击上方“套用模板”一键生成" image-size="72" />

      <div v-for="unit in units" :key="unit.id" class="card">
        <div class="node-head" @click="toggle(unit.id)">
          <van-icon :name="expanded.has(unit.id) ? 'arrow-down' : 'arrow'" />
          <span class="node-name level1">{{ unit.name }}</span>
          <van-icon name="plus" class="node-add" @click.stop="openWbsEditor(2, unit.id)" />
        </div>

        <template v-if="expanded.has(unit.id)">
          <div v-for="div in childrenOf(unit.id, 2)" :key="div.id" class="node indent1">
            <div class="node-head" @click="toggle(div.id)">
              <van-icon :name="expanded.has(div.id) ? 'arrow-down' : 'arrow'" />
              <span class="node-name level2" @click.stop="openWbsEditor(2, unit.id, div)">{{ div.name }}</span>
              <van-icon name="plus" class="node-add" @click.stop="openWbsEditor(3, div.id)" />
              <van-icon name="delete-o" class="node-del" @click.stop="removeWbs(div.id, div.name)" />
            </div>

            <template v-if="expanded.has(div.id)">
              <div v-for="item in childrenOf(div.id, 3)" :key="item.id" class="node indent2">
                <div class="node-head" @click="toggle(item.id)">
                  <van-icon :name="expanded.has(item.id) ? 'arrow-down' : 'arrow'" />
                  <span class="node-name level3" @click.stop="openWbsEditor(3, div.id, item)">{{ item.name }}</span>
                  <span v-if="item.designQty" class="muted num">{{ item.designQty }}{{ item.unit ?? '' }}</span>
                  <van-icon name="plus" class="node-add" @click.stop="openProcessEditor(item.id)" />
                  <van-icon name="delete-o" class="node-del" @click.stop="removeWbs(item.id, item.name)" />
                </div>
                <div v-if="item.note" class="node-note">{{ item.note }}</div>

                <div v-if="expanded.has(item.id)" class="process-list">
                  <div v-for="p in processesOf(item.id)" :key="p.id" class="process-row">
                    <div class="process-main" @click="openProcessEditor(item.id, p)">
                      <div class="process-name">
                        {{ p.name }}
                        <span v-if="p.enabled === 0" class="muted">（已停用）</span>
                      </div>
                      <div class="muted">
                        <template v-if="p.standardHours">标准 {{ fmtHoursShort(p.standardHours) }}</template>
                        <template v-else>未设标准用时</template>
                        <template v-if="p.refHours"> · 参考 {{ fmtHoursShort(p.refHours, 2) }}</template>
                        <template v-if="p.unit"> · 单位 {{ p.unit }}</template>
                      </div>
                    </div>
                    <van-icon name="delete-o" class="node-del" @click="removeProcess(p.id, p.name)" />
                  </div>
                  <div v-if="!processesOf(item.id).length" class="muted" style="padding: 6px 0">还没有工序</div>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
    </template>

    <template v-else-if="tab === 'standard'">
      <div class="card standard-filter-card" style="margin-top: 12px">
        <van-search
          v-model="standardFilter.query"
          shape="round"
          placeholder="搜索工序、分项、分部或单位工程"
        />
        <van-field
          :model-value="standardUnitLabel"
          label="单位工程"
          readonly
          is-link
          @click="openStandardPicker('unit')"
        />
        <van-field
          :model-value="standardDivisionLabel"
          label="分部工程"
          :placeholder="standardFilter.unitId ? '全部分部工程' : '请先选单位工程'"
          readonly
          is-link
          :disabled="!standardFilter.unitId"
          @click="openStandardPicker('division')"
        />
        <van-field
          :model-value="standardItemLabel"
          label="分项工程"
          :placeholder="standardFilter.unitId ? '全部分项工程' : '请先选单位工程'"
          readonly
          is-link
          :disabled="!standardFilter.unitId"
          @click="openStandardPicker('item')"
        />
        <div class="row-between standard-filter-foot">
          <span class="muted">显示 {{ standardRows.length }} / {{ allStandardRows.length }} 道工序</span>
          <span v-if="standardHasFilter" class="clear-filter" @click="clearStandardFilter">清除范围</span>
        </div>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="muted">
          标准用时留着由你确认：<b>参考用时</b>是三份循环作业记录实测出来的中位数（样本少于 5 次的不给参考值），
          点“采用”可填入标准用时；标准用时保存后才参与效率计算。
        </div>
        <div class="btn-row">
          <van-button size="small" type="primary" plain @click="adoptAllRefHours">
            采用当前范围参考用时（{{ refCount }} 道）
          </van-button>
          <van-button size="small" plain @click="resetAllStandards">清空全部标准用时</van-button>
        </div>
      </div>
      <div class="card">
        <div v-for="row in standardRows" :key="row.process.id" class="std-row">
          <div class="std-main">
            <div class="process-name">{{ row.process.name }}</div>
            <div class="muted">{{ row.divisionName }} / {{ row.itemName }}</div>
            <div v-if="row.refText" class="muted ref-line" @click="adoptRefHour(row.process.id, row.refValue)">
              参考 {{ fmtHoursShort(row.refValue ?? 0, 2) }} · {{ row.refText }} · 点击采用
            </div>
            <div v-else class="muted">暂无参考用时（实测样本不足 5 次）</div>
          </div>
          <van-field
            :model-value="draftValue(row.process)"
            type="number"
            placeholder="小时"
            input-align="right"
            style="width: 96px; padding: 4px 0"
            @update:model-value="(v: string) => (standardDrafts[row.process.id] = v)"
          />
        </div>
        <van-empty
          v-if="!standardRows.length"
          :description="standardHasFilter ? '当前搜索或范围内没有工序' : '当前项目还没有工序'"
          image-size="60"
        />
      </div>
      <van-button block type="primary" round @click="saveStandards">保存标准用时</van-button>
    </template>

    <template v-else>
      <div class="card" style="margin-top: 12px">
        <div class="muted" style="line-height: 1.65">
          工作面按<b>单位工程 + 分项名称最外层括号</b>自动建：同一洞室的开挖与支护算同一个工作面，
          看板按它筛「单位工程 → 工作面 → 桩号」。改名、重绑、合并都只改目录绑定，<b>不改写历史记录</b>。
        </div>
        <div class="btn-row">
          <span class="muted">{{ workfaceCount }} 个工作面 · 已绑 {{ boundItemCount }} 个分项</span>
          <span v-if="unboundItems.length" class="clear-filter">{{ unboundItems.length }} 个分项未绑</span>
        </div>
      </div>

      <van-empty v-if="!faceGroups.length" description="还没有工作面，套用模板或新建分项后会自动补建" image-size="64" />

      <div v-for="group in faceGroups" :key="group.unit.id" class="card">
        <div class="card-title">{{ group.unit.name }}<span class="sub">{{ group.faces.length }} 个工作面</span></div>
        <div v-for="row in group.faces" :key="row.workface.id" class="face-block">
          <div class="face-head" @click="toggleFace(row.workface.id)">
            <van-icon :name="expandedFaces.has(row.workface.id) ? 'arrow-down' : 'arrow'" />
            <div class="face-main">
              <div class="face-name">{{ row.workface.name }}</div>
              <div class="muted">{{ row.items.length }} 个分项 · 点开可重绑</div>
            </div>
            <div class="face-actions">
              <button
                type="button"
                class="mini-btn"
                :aria-label="`重命名工作面 ${row.workface.name}`"
                @click.stop="openRename(row.workface)"
              >
                改名
              </button>
              <button
                type="button"
                class="mini-btn danger"
                :disabled="group.faces.length < 2"
                :aria-label="`合并工作面 ${row.workface.name}`"
                @click.stop="openMerge(row.workface)"
              >
                合并
              </button>
            </div>
          </div>
          <div v-if="expandedFaces.has(row.workface.id)" class="face-items">
            <div v-for="item in row.items" :key="item.id" class="face-item">
              <span class="face-item-name">{{ item.name }}</span>
              <button
                type="button"
                class="mini-btn"
                :aria-label="`把 ${item.name} 改挂到其他工作面`"
                @click="openRebind(item)"
              >
                重绑
              </button>
            </div>
            <div v-if="!row.items.length" class="muted">这个工作面还没有分项</div>
          </div>
        </div>
      </div>

      <div v-if="unboundItems.length" class="card">
        <div class="card-title">未绑工作面<span class="sub">下次加载会自动按名称补建</span></div>
        <div v-for="item in unboundItems" :key="item.id" class="face-item">
          <span class="face-item-name">{{ item.name }}</span>
          <button type="button" class="mini-btn" :aria-label="`把 ${item.name} 挂到工作面`" @click="openRebind(item)">
            挂载
          </button>
        </div>
      </div>
    </template>

    <div class="bottom-space" />
  </div>

  <van-popup v-model:show="showStandardPicker" round position="bottom" :style="{ maxHeight: '70%' }">
    <div class="standard-picker">
      <div class="standard-picker-head">
        <b>{{ standardPickerTitle }}</b>
        <span class="muted" @click="standardPickerLevel = ''">关闭</span>
      </div>
      <div class="standard-picker-body">
        <div class="standard-picker-item all" @click="chooseStandardFilter('')">
          <span>{{ standardPickerAllLabel }}</span>
          <van-icon v-if="!standardPickerSelectedId" name="success" color="#1f6feb" />
        </div>
        <div
          v-for="opt in standardPickerOptions"
          :key="opt.id"
          class="standard-picker-item"
          @click="chooseStandardFilter(opt.id)"
        >
          <span>{{ opt.name }}</span>
          <van-icon
            v-if="standardPickerSelectedId === opt.id"
            name="success"
            color="#1f6feb"
          />
        </div>
        <van-empty v-if="!standardPickerOptions.length" description="没有可选项" image-size="60" />
      </div>
    </div>
  </van-popup>

  <van-popup v-model:show="showRename" round position="bottom">
    <div class="standard-picker">
      <div class="standard-picker-head">
        <b>重命名工作面</b>
        <span class="muted" @click="showRename = false">关闭</span>
      </div>
      <div style="padding: 12px 8px 0">
        <van-field v-model="renameDraft" label="名称" placeholder="如 1#支洞" />
        <div class="muted" style="padding: 6px 16px 0">
          只改显示名，分项绑定与历史记录都不动；同名工作面不会被自动合并。
        </div>
        <div style="display: flex; gap: 10px; padding: 14px 16px">
          <van-button block plain @click="showRename = false">取消</van-button>
          <van-button block type="primary" @click="submitRename">保存</van-button>
        </div>
      </div>
    </div>
  </van-popup>

  <van-popup :show="pickerMode !== ''" round position="bottom" :style="{ maxHeight: '70%' }" @update:show="onPickerShow">
    <div class="standard-picker">
      <div class="standard-picker-head">
        <b>{{ pickerTitle }}</b>
        <span class="muted" @click="pickerMode = ''">关闭</span>
      </div>
      <div class="muted" style="padding: 8px 16px 0; line-height: 1.6">{{ pickerHint }}</div>
      <div class="standard-picker-body">
        <button
          v-for="face in pickerFaces"
          :key="face.id"
          type="button"
          class="standard-picker-item as-button"
          :aria-label="`选择工作面 ${face.name}`"
          @click="chooseFace(face.id)"
        >
          <span>{{ face.name }}</span>
          <van-icon name="arrow" />
        </button>
        <van-empty v-if="!pickerFaces.length" description="同一单位工程下没有其他工作面" image-size="60" />
      </div>
    </div>
  </van-popup>

  <van-popup v-model:show="editor.show" round position="bottom" :style="{ paddingBottom: '16px' }">
    <div style="padding: 16px">
      <div class="card-title">{{ editorTitle }}</div>
      <van-cell-group inset>
        <van-field v-model="editor.name" label="名称" placeholder="必填" />
        <van-field v-if="editor.kind === 'project'" v-model="editor.code" label="编号" placeholder="选填，如 SCZQ-10" />
        <van-field
          v-if="editor.kind !== 'project'"
          v-model="editor.unit"
          label="单位"
          placeholder="如 m³、m²、m、根、台"
        />
        <van-field
          v-if="editor.kind !== 'project'"
          v-model="editor.designQty"
          type="number"
          label="设计总量"
          placeholder="选填"
        />
        <van-field
          v-if="editor.kind === 'process'"
          v-model="editor.standardHours"
          type="number"
          label="标准用时"
          placeholder="小时，选填"
        />
        <van-cell v-if="editor.kind === 'process'" title="启用该工序">
          <template #right-icon>
            <van-switch v-model="editor.enabled" size="20" />
          </template>
        </van-cell>
        <van-cell v-if="editor.kind === 'project' && !editor.id" title="套用本标段项目划分模板">
          <template #right-icon>
            <van-switch v-model="editor.applyTemplate" size="20" />
          </template>
        </van-cell>
        <van-cell
          v-if="editor.kind === 'project' && !editor.id && editor.applyTemplate"
          title="同时补录 2026 年 9 月已记录数据"
          :label="`${HISTORY_ROWS.length} 条循环作业记录`"
        >
          <template #right-icon>
            <van-switch v-model="editor.importHistory" size="20" />
          </template>
        </van-cell>
      </van-cell-group>
      <div style="display: flex; gap: 10px; margin-top: 16px">
        <van-button block plain @click="editor.show = false">取消</van-button>
        <van-button block type="primary" @click="submitEditor">保存</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.standard-filter-card {
  padding: 4px 0 10px;
}

.standard-filter-foot {
  padding: 8px 16px 0;
}

.clear-filter {
  color: #1f6feb;
  font-size: 12px;
}

.standard-picker {
  padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));
}

.standard-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #f0f2f5;
}

.standard-picker-body {
  max-height: 58vh;
  overflow-y: auto;
  padding: 0 16px;
}

.standard-picker-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 2px;
  border-bottom: 1px solid #f4f5f7;
  font-size: 14px;
}

.standard-picker-item.all {
  color: #33404f;
  font-weight: 600;
}

.btn-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.node-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
}

.node + .node {
  border-top: 1px solid #f4f5f7;
}

.indent1 {
  padding-left: 14px;
}

.indent2 {
  padding-left: 28px;
}

.node-name {
  flex: 1;
  font-size: 14px;
  min-width: 0;
}

.level1 {
  font-weight: 600;
}

.level2 {
  color: #33404f;
}

.level3 {
  color: #4a5461;
  font-size: 13px;
}

.node-add,
.node-del {
  font-size: 17px;
  color: #9aa4b0;
  padding: 2px 4px;
}

.node-del {
  color: #d14343;
}

.process-list {
  padding-left: 42px;
  padding-bottom: 6px;
}

.process-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 0;
  border-top: 1px dashed #f0f1f4;
}

.process-main {
  flex: 1;
  min-width: 0;
}

.process-name {
  font-size: 13px;
}

.node-note {
  font-size: 11px;
  color: #9aa4b0;
  padding: 0 0 6px 42px;
}

.ref-line {
  color: #1f6feb;
}

.std-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f4f5f7;
}

.std-main {
  flex: 1;
  min-width: 0;
}

.face-block {
  padding: 10px 0;
  border-top: 1px solid #f4f5f7;
}

.face-block:first-of-type {
  border-top: none;
}

.face-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
}

.face-main {
  flex: 1;
  min-width: 0;
}

.face-name {
  font-size: 14px;
  font-weight: 600;
}

.face-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.mini-btn {
  border: 1px solid #dfe4ea;
  background: #f8f9fb;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  color: #33404f;
  font-family: inherit;
}

.mini-btn:disabled {
  color: #b6bec8;
  background: #fafbfc;
}

.mini-btn.danger {
  color: #d14343;
  border-color: #f3c9c9;
  background: #fdf3f3;
}

.mini-btn:focus-visible,
.standard-picker-item.as-button:focus-visible {
  outline: 2px solid #1f6feb;
  outline-offset: 2px;
}

.face-items {
  margin-top: 8px;
  padding-left: 8px;
}

.face-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0;
  border-top: 1px dashed #f0f1f4;
  font-size: 13px;
  color: #4a5461;
}

.face-item:first-child {
  border-top: none;
}

.face-item-name {
  min-width: 0;
}

.standard-picker-item.as-button {
  width: 100%;
  border: none;
  border-bottom: 1px solid #f4f5f7;
  background: transparent;
  text-align: left;
  font-family: inherit;
}
</style>
