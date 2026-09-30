<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, state } from '@/store'
import { deleteRecord as removeRecord, getRecord, saveRecord } from '@/db'
import { buildTimeFields, suggestStandardHours } from '@/core/compute'
import { GAP_REASONS } from '@/core/reasons'
import { fmtDate, fmtHours, nowHhmm, todayStr } from '@/core/time'

const route = useRoute()
const router = useRouter()

const recordId = ref<string | null>(null)
const processId = ref('')
const processPath = ref('')
const date = ref(todayStr())
const startTime = ref('08:00')
const endTime = ref('12:00')
const quantity = ref<string>('')
const gapReason = ref('none')
const location = ref('')
const note = ref('')
const saving = ref(false)

const showCascader = ref(false)
const showCalendar = ref(false)
const showStartPicker = ref(false)
const showEndPicker = ref(false)
const showReasonPicker = ref(false)

const cascaderValue = ref<string | number>('')
const startPickerValue = ref<string[]>(startTime.value.split(':'))
const endPickerValue = ref<string[]>(endTime.value.split(':'))

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))
const selectedProcess = computed(() => processById.value.get(processId.value))

interface CascaderOption {
  text: string
  value: string
  children?: CascaderOption[]
}

const cascaderOptions = computed<CascaderOption[]>(() => {
  const nodes = state.wbs
  const units = nodes.filter((n) => n.level === 1).sort((a, b) => a.sort - b.sort)
  return units.map((unit) => ({
    text: unit.name,
    value: unit.id,
    children: nodes
      .filter((n) => n.parentId === unit.id)
      .sort((a, b) => a.sort - b.sort)
      .map((div) => ({
        text: div.name,
        value: div.id,
        children: nodes
          .filter((n) => n.parentId === div.id)
          .sort((a, b) => a.sort - b.sort)
          .map((item) => ({
            text: item.name,
            value: item.id,
            children: state.processes
              .filter((p) => p.itemId === item.id && p.enabled)
              .sort((a, b) => a.sort - b.sort)
              .map((p) => ({ text: p.name, value: p.id }))
          }))
          .filter((item) => (item.children?.length ?? 0) > 0)
      }))
      .filter((div) => (div.children?.length ?? 0) > 0)
  }))
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

function pathOf(pid: string): string {
  const p = processById.value.get(pid)
  if (!p) return ''
  const item = wbsById.value.get(p.itemId)
  const div = item?.parentId ? wbsById.value.get(item.parentId) : undefined
  const unit = div?.parentId ? wbsById.value.get(div.parentId) : undefined
  return [unit?.name, div?.name, item?.name, p.name].filter(Boolean).join(' / ')
}

function onCascaderFinish(payload: { selectedOptions: Array<{ value: string | number }> }) {
  const last = payload.selectedOptions[payload.selectedOptions.length - 1]
  processId.value = String(last?.value ?? '')
  cascaderValue.value = processId.value
  processPath.value = pathOf(processId.value)
  showCascader.value = false
  if (!location.value) {
    const item = selectedProcess.value ? wbsById.value.get(selectedProcess.value.itemId) : undefined
    if (item?.name) location.value = ''
  }
}

function onCalendarConfirm(value: Date) {
  date.value = fmtDate(value)
  showCalendar.value = false
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
    showToast('请先选择工序')
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
    showToast(recordId.value ? '已保存修改' : '记录已保存')
    router.replace('/')
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

onMounted(async () => {
  const q = route.query
  const id = typeof q.id === 'string' ? q.id : ''
  const pid = typeof q.processId === 'string' ? q.processId : ''
  const d = typeof q.date === 'string' ? q.date : ''
  if (d) date.value = d
  if (pid) {
    processId.value = pid
    cascaderValue.value = pid
    processPath.value = pathOf(pid)
  }
  if (id) {
    const row = await getRecord(id)
    if (row) {
      recordId.value = row.id
      processId.value = row.processId
      cascaderValue.value = row.processId
      processPath.value = pathOf(row.processId)
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
  if (id && recordId.value && (!endTime.value || endTime.value === '12:00')) {
    endTime.value = nowHhmm()
    endPickerValue.value = endTime.value.split(':')
  }
  if (!id && !pid) {
    startPickerValue.value = startTime.value.split(':')
    endPickerValue.value = endTime.value.split(':')
  }
})
</script>

<template>
  <van-nav-bar :title="recordId ? '修改工序记录' : '记录工序用时'" left-arrow fixed placeholder @click-left="router.back()" />

  <div class="page">
    <van-cell-group inset>
      <van-field
        :model-value="processPath || ''"
        label="工序"
        placeholder="选择单位工程 / 分部 / 分项 / 工序"
        readonly
        is-link
        required
        @click="showCascader = true"
      />
      <van-field :model-value="date" label="施工日期" readonly is-link required @click="showCalendar = true" />
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

  <van-popup v-model:show="showCascader" round position="bottom">
    <van-cascader
      v-model="cascaderValue"
      title="选择工序"
      :options="cascaderOptions"
      active-color="#1f6feb"
      @close="showCascader = false"
      @finish="onCascaderFinish"
    />
  </van-popup>

  <van-calendar v-model:show="showCalendar" :default-date="new Date(date)" @confirm="onCalendarConfirm" />

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
</style>
