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
  saveProcess,
  saveProject,
  saveWbsNode,
  seedHistoryRecords,
  setProjectArchived
} from '@/db'
import { suggestStandardHours } from '@/core/compute'
import { HISTORY_ROWS } from '@/db/history'
import type { Process, WbsLevel } from '@/types'
import { fmtHoursShort } from '@/core/time'

const tab = ref<'structure' | 'standard'>('structure')
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
        showToast(`已套用项目划分模板：${res.processes} 道工序，补录 ${n} 条历史记录`)
      } else {
        showToast(`已套用项目划分模板：${res.processes} 道工序`)
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
  showToast(`已新增 ${res.units} 个单位工程、${res.processes} 道工序`)
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
  }
)

// -------------------------------------------------------------- 标准用时
const standardDrafts = reactive<Record<string, string>>({})

const standardRows = computed(() =>
  state.processes
    .map((p) => {
      const item = state.wbs.find((w) => w.id === p.itemId)
      const div = item?.parentId ? state.wbs.find((w) => w.id === item.parentId) : undefined
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
      return { process: p, itemName: item?.name ?? '', divisionName: div?.name ?? '', refValue, refText }
    })
    .sort((a, b) => (a.divisionName + a.itemName + a.process.name).localeCompare(b.divisionName + b.itemName + b.process.name, 'zh'))
)

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
  standardRows.value.forEach((row) => {
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

    <template v-else>
      <div class="card" style="margin-top: 12px">
        <div class="muted">
          标准用时留着由你确认：<b>参考用时</b>是三份循环作业记录实测出来的中位数（样本少于 5 次的不给参考值），
          点“采用”可填入标准用时；标准用时保存后才参与效率计算。
        </div>
        <div class="btn-row">
          <van-button size="small" type="primary" plain @click="adoptAllRefHours">
            全部采用参考用时（{{ refCount }} 道）
          </van-button>
          <van-button size="small" plain @click="resetAllStandards">清空标准用时</van-button>
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
        <van-empty v-if="!standardRows.length" description="当前项目还没有工序" image-size="60" />
      </div>
      <van-button block type="primary" round @click="saveStandards">保存标准用时</van-button>
    </template>

    <div class="bottom-space" />
  </div>

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
</style>
