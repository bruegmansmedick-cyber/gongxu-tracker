<script setup lang="ts">
import { computed, ref } from 'vue'
import { showToast } from 'vant'
import { setScope, state } from '@/store'
import { ALL_SCOPE, filterByScope, type AnalysisScope } from '@/core/scope'
import { parseChainageRange, recordChainage, shortChainageText } from '@/core/chainage'
import type { WbsNode } from '@/types'

const showScope = ref(false)
const showProcess = ref(false)
const showChainage = ref(false)
const chainageDraft = ref('')

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

/** 有工序或有记录的分项工程 */
const liveItemIds = computed(() => {
  const ids = new Set<string>()
  state.processes.forEach((p) => ids.add(p.itemId))
  state.records.forEach((r) => {
    const p = processById.value.get(r.processId)
    if (p) ids.add(p.itemId)
  })
  return ids
})

const divisionOf = (item: WbsNode) => (item.parentId ? wbsById.value.get(item.parentId) : undefined)
const unitOfItem = (item: WbsNode) => {
  const div = divisionOf(item)
  return div?.parentId ? wbsById.value.get(div.parentId) : undefined
}

/** 单位工程 → 它下面有内容的分项工程 */
const tree = computed(() =>
  state.wbs
    .filter((w) => w.level === 1)
    .sort((a, b) => a.sort - b.sort)
    .map((unit) => ({
      unit,
      items: state.wbs
        .filter((w) => w.level === 3 && unitOfItem(w)?.id === unit.id && liveItemIds.value.has(w.id))
        .sort((a, b) => a.sort - b.sort)
    }))
    .filter((row) => row.items.length > 0)
)

const currentLabel = computed(() => {
  const s = state.scope
  let label = '全部工程'
  if (s.level === 'unit') label = wbsById.value.get(s.unitId ?? '')?.name ?? '未知单位工程'
  if (s.level === 'item') {
    const item = wbsById.value.get(s.itemId ?? '')?.name ?? '未知分项工程'
    const proc = s.processId ? processById.value.get(s.processId) : undefined
    label = proc ? `${item} · ${proc.name}` : item
  }
  return s.chainage ? `${label} · ${shortChainageText(s.chainage)}` : label
})

const currentProcessLabel = computed(() => {
  const id = state.scope.processId
  if (!id) return '全部工序'
  return processById.value.get(id)?.name ?? '全部工序'
})

const itemProcesses = computed(() =>
  state.scope.itemId
    ? state.processes.filter((p) => p.itemId === state.scope.itemId).sort((a, b) => a.sort - b.sort)
    : []
)

const currentChainageLabel = computed(() =>
  state.scope.chainage ? shortChainageText(state.scope.chainage) : '全部桩号'
)

/** 当前结构范围内出现过的桩号，按里程排序，方便直接点选 */
const chainageOptions = computed(() => {
  const baseScope = { ...state.scope, chainage: undefined }
  const rows = filterByScope(state.records, baseScope, processById.value, wbsById.value)
  const map = new Map<string, { text: string; short: string; startM: number }>()
  rows.forEach((r) => {
    const text = recordChainage(r)
    const parsed = parseChainageRange(text)
    if (!parsed) return
    map.set(parsed.shortText, { text, short: parsed.shortText, startM: parsed.startM })
  })
  return Array.from(map.values()).sort((a, b) => a.startM - b.startM)
})

async function pick(scope: AnalysisScope) {
  await setScope(scope)
  showScope.value = false
}

async function pickProcess(processId: string) {
  await setScope({ ...state.scope, processId: processId || undefined })
  showProcess.value = false
}

function openChainage() {
  chainageDraft.value = state.scope.chainage ? shortChainageText(state.scope.chainage) : ''
  showChainage.value = true
}

async function applyChainage(value = chainageDraft.value) {
  const text = value.trim()
  if (!text) {
    await setScope({ ...state.scope, chainage: undefined })
    showChainage.value = false
    return
  }
  const parsed = parseChainageRange(text)
  if (!parsed) {
    showToast('桩号格式示例：545-548')
    return
  }
  await setScope({ ...state.scope, chainage: parsed.shortText })
  showChainage.value = false
}

function isUnitActive(unitId: string) {
  return state.scope.level === 'unit' && state.scope.unitId === unitId
}

function isItemActive(itemId: string) {
  return state.scope.level === 'item' && state.scope.itemId === itemId
}
</script>

<template>
  <div class="card scope-card">
    <div class="scope-row" @click="showScope = true">
      <div class="scope-main">
        <div class="muted">分析范围</div>
        <div class="scope-value">{{ currentLabel }}</div>
      </div>
      <span class="scope-switch">切换 <van-icon name="arrow" /></span>
    </div>
    <div v-if="state.scope.level === 'item'" class="divider" />
    <div v-if="state.scope.level === 'item'" class="scope-row" @click="showProcess = true">
      <div class="scope-main">
        <div class="muted">工序</div>
        <div class="scope-value">{{ currentProcessLabel }}</div>
      </div>
      <span class="scope-switch">切换 <van-icon name="arrow" /></span>
    </div>
    <div class="divider" />
    <div class="scope-row" @click="openChainage">
      <div class="scope-main">
        <div class="muted">桩号</div>
        <div class="scope-value">{{ currentChainageLabel }}</div>
      </div>
      <span class="scope-switch">筛选 <van-icon name="arrow" /></span>
    </div>
  </div>

  <van-popup v-model:show="showScope" round position="bottom" :style="{ maxHeight: '76vh' }">
    <div class="picker">
      <div class="picker-title">选择分析范围</div>
      <div class="picker-body">
        <div class="picker-item" :class="{ active: state.scope.level === 'all' }" @click="pick({ ...ALL_SCOPE })">
          <span>全部工程</span>
          <van-icon v-if="state.scope.level === 'all'" name="success" />
        </div>
        <div v-for="row in tree" :key="row.unit.id" class="picker-group">
          <div class="picker-item unit" :class="{ active: isUnitActive(row.unit.id) }" @click="pick({ level: 'unit', unitId: row.unit.id })">
            <span>{{ row.unit.name }}</span>
            <van-icon v-if="isUnitActive(row.unit.id)" name="success" />
          </div>
          <div
            v-for="item in row.items"
            :key="item.id"
            class="picker-item item"
            :class="{ active: isItemActive(item.id) }"
            @click="pick({ level: 'item', itemId: item.id })"
          >
            <span>{{ item.name }}</span>
            <van-icon v-if="isItemActive(item.id)" name="success" />
          </div>
        </div>
      </div>
    </div>
  </van-popup>

  <van-popup v-model:show="showProcess" round position="bottom" :style="{ maxHeight: '60vh' }">
    <div class="picker">
      <div class="picker-title">选择工序</div>
      <div class="picker-body">
        <div class="picker-item" :class="{ active: !state.scope.processId }" @click="pickProcess('')">
          <span>全部工序</span>
          <van-icon v-if="!state.scope.processId" name="success" />
        </div>
        <div
          v-for="p in itemProcesses"
          :key="p.id"
          class="picker-item"
          :class="{ active: state.scope.processId === p.id }"
          @click="pickProcess(p.id)"
        >
          <span>{{ p.name }}</span>
          <van-icon v-if="state.scope.processId === p.id" name="success" />
        </div>
      </div>
    </div>
  </van-popup>

  <van-popup v-model:show="showChainage" round position="bottom" :style="{ maxHeight: '70vh' }">
    <div class="picker">
      <div class="picker-title">按桩号筛选</div>
      <van-field
        v-model="chainageDraft"
        label="桩号"
        placeholder="如 545-548、545~548"
        @keyup.enter="applyChainage()"
      />
      <div class="muted chainage-tip">连接符支持 -、~、～ 或“至”；点已有桩号可直接筛选。</div>
      <div class="picker-actions">
        <van-button size="small" block @click="applyChainage('')">全部桩号</van-button>
        <van-button size="small" block type="primary" @click="applyChainage()">应用</van-button>
      </div>
      <div class="picker-body">
        <div
          v-for="row in chainageOptions"
          :key="row.short"
          class="picker-item"
          :class="{ active: currentChainageLabel === row.short }"
          @click="applyChainage(row.text)"
        >
          <span>{{ row.short }}</span>
          <van-icon v-if="currentChainageLabel === row.short" name="success" />
        </div>
        <van-empty v-if="!chainageOptions.length" description="当前范围内还没有可识别桩号" image-size="54" />
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.scope-card {
  padding: 4px 14px;
}

.scope-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  gap: 10px;
}

.scope-main {
  min-width: 0;
}

.scope-value {
  font-size: 15px;
  font-weight: 600;
  margin-top: 2px;
  word-break: break-all;
}

.scope-switch {
  flex-shrink: 0;
  font-size: 13px;
  color: #1f6feb;
}

.picker {
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px));
}

.picker-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
}

.picker-body {
  max-height: 62vh;
  overflow-y: auto;
}

.chainage-tip {
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.45;
}

.picker-actions {
  display: flex;
  gap: 10px;
  padding: 0 16px 8px;
}

.picker-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 4px;
  font-size: 14px;
  border-bottom: 1px solid #f4f5f7;
}

.picker-item.unit {
  font-weight: 600;
  color: #33404f;
}

.picker-item.item {
  padding-left: 18px;
  color: #4a5461;
  font-size: 13px;
}

.picker-item.active {
  color: #1f6feb;
}
</style>
