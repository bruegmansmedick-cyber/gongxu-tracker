<script setup lang="ts">
/**
 * 分析范围选择器：单位工程 → 工作面 → 桩号。
 *
 * 默认收起成一行摘要，点「修改筛选」才打开底部面板；
 * 所有快速选项都是真正的 <button>：可 Tab 聚焦、回车/空格触发、带焦点样式与无障碍名称。
 * 桩号身份 = 工作面 + 规范化桩号，所以「1#支洞 · 0-5」和「2#支洞 · 0-5」是两个选项。
 */
import { computed, ref } from 'vue'
import { showToast } from 'vant'
import { setScope, state } from '@/store'
import { ALL_SCOPE, chainageOptionsOf, filterByScope, scopeLabel, type AnalysisScope } from '@/core/scope'
import { parseChainageRange, shortChainageText } from '@/core/chainage'
import { buildItemWorkfaceMap } from '@/core/workface'
import type { Workface } from '@/types'

const showSheet = ref(false)
const chainageDraft = ref('')

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))
const workfaceById = computed(() => new Map(state.workfaces.map((w) => [w.id, w])))

const itemWorkface = computed(() => buildItemWorkfaceMap(state.wbs, state.workfaces))

const currentUnitId = computed(() => {
  if (state.scope.level === 'unit') return state.scope.unitId ?? ''
  if (state.scope.level === 'workface') return workfaceById.value.get(state.scope.workfaceId ?? '')?.unitId ?? ''
  return ''
})

const unitOptions = computed(() =>
  state.wbs.filter((w) => w.level === 1).sort((a, b) => a.sort - b.sort)
)

/** 已经有记录的工作面：没选单位工程时只列这些，否则 30 多个按钮要滚很久 */
const facesWithRecords = computed(() => {
  const set = new Set<string>()
  state.records.forEach((r) => {
    const p = processById.value.get(r.processId)
    if (!p) return
    const workfaceId = itemWorkface.value.get(p.itemId)
    if (workfaceId) set.add(workfaceId)
  })
  return set
})

/** 当前单位工程下的工作面；还没选单位工程时只列有记录的 */
const workfaceOptions = computed<Workface[]>(() => {
  const unitId = currentUnitId.value
  const rows = unitId
    ? state.workfaces.filter((w) => w.unitId === unitId)
    : state.workfaces.filter((w) => facesWithRecords.value.has(w.id))
  return [...rows].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh'))
})

/** 当前结构范围（不含桩号）内的记录，用来列已出现过的桩号 */
const baseRecords = computed(() =>
  filterByScope(
    state.records,
    { ...state.scope, chainage: undefined } as AnalysisScope,
    processById.value,
    wbsById.value,
    itemWorkface.value
  )
)

const chainageOptions = computed(() =>
  chainageOptionsOf({
    records: baseRecords.value,
    processById: processById.value,
    wbsById: wbsById.value,
    itemWorkface: itemWorkface.value,
    workfaceById: workfaceById.value
  })
)

const summaryText = computed(() => {
  const label = scopeLabel(state.scope, wbsById.value, workfaceById.value)
  return state.scope.chainage ? label : `${label} · 全部桩号`
})

const currentChainageText = computed(() => {
  const parsed = parseChainageRange(state.scope.chainage)
  return parsed?.text ?? ''
})

/** 桩号身份 = 工作面 + 规范化桩号；只比较短桩号会把两个工作面的同名桩号混在一起 */
function isChainageActive(opt: { text: string; workfaceId: string }): boolean {
  if (!currentChainageText.value || currentChainageText.value !== opt.text) return false
  if (state.scope.level === 'workface') return state.scope.workfaceId === opt.workfaceId
  return false
}

function isUnitActive(unitId: string): boolean {
  return state.scope.level === 'unit' && state.scope.unitId === unitId
}

function isWorkfaceActive(workfaceId: string): boolean {
  return state.scope.level === 'workface' && state.scope.workfaceId === workfaceId
}

async function pickAll() {
  await setScope({ ...ALL_SCOPE })
}

async function pickUnit(unitId: string) {
  if (!unitId) {
    await pickAll()
    return
  }
  await setScope({ level: 'unit', unitId })
}

async function pickWorkface(workfaceId: string) {
  if (!workfaceId) {
    await setScope(currentUnitId.value ? { level: 'unit', unitId: currentUnitId.value } : { ...ALL_SCOPE })
    return
  }
  await setScope({ level: 'workface', workfaceId })
}

/**
 * 选桩号。点已有桩号时连同所属工作面一起选上（桩号身份就是工作面 + 桩号），
 * 这样「1#支洞 · 0-5」和「2#支洞 · 0-5」不会互相串。
 */
async function pickChainage(value: string | null | undefined, workfaceId?: string) {
  const text = String(value ?? '').trim()
  if (!text) {
    await setScope({ ...state.scope, chainage: undefined } as AnalysisScope)
    return
  }
  const parsed = parseChainageRange(text)
  if (!parsed) {
    showToast('桩号格式示例：545-548')
    return
  }
  if (workfaceId) {
    await setScope({ level: 'workface', workfaceId, chainage: parsed.text })
    return
  }
  await setScope({ ...state.scope, chainage: parsed.text } as AnalysisScope)
}

async function applyDraft() {
  await pickChainage(chainageDraft.value)
}

async function clearAll() {
  chainageDraft.value = ''
  await pickAll()
}

function openSheet() {
  chainageDraft.value = state.scope.chainage ? shortChainageText(state.scope.chainage) : ''
  showSheet.value = true
}
</script>

<template>
  <div class="card scope-card">
    <div class="scope-summary">
      <div class="scope-main">
        <div class="muted">分析范围</div>
        <div class="scope-value">{{ summaryText }}</div>
        <div class="muted scope-order">单位工程 → 工作面 → 桩号</div>
      </div>
      <button type="button" class="scope-edit" aria-haspopup="dialog" @click="openSheet">修改筛选</button>
    </div>
  </div>

  <van-popup v-model:show="showSheet" round position="bottom" :style="{ maxHeight: '82%' }">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="修改筛选">
      <div class="sheet-head">
        <div class="sheet-title">修改筛选</div>
        <button type="button" class="link-btn" aria-label="关闭筛选面板" @click="showSheet = false">关闭</button>
      </div>

      <div class="sheet-body">
        <section class="group" role="group" aria-label="按单位工程筛选">
          <div class="group-title">单位工程</div>
          <div class="chips">
            <button
              type="button"
              class="chip"
              :class="{ active: state.scope.level === 'all' }"
              :aria-pressed="state.scope.level === 'all'"
              aria-label="全部工程"
              @click="pickAll"
            >
              全部工程
            </button>
            <button
              v-for="unit in unitOptions"
              :key="unit.id"
              type="button"
              class="chip"
              :class="{ active: isUnitActive(unit.id) }"
              :aria-pressed="isUnitActive(unit.id)"
              :aria-label="`单位工程 ${unit.name}`"
              @click="pickUnit(unit.id)"
            >
              {{ unit.name }}
            </button>
          </div>
        </section>

        <section v-if="workfaceOptions.length" class="group" role="group" aria-label="按工作面筛选">
          <div class="group-title">工作面</div>
          <div class="chips">
            <button
              type="button"
              class="chip"
              :class="{ active: state.scope.level !== 'workface' }"
              :aria-pressed="state.scope.level !== 'workface'"
              aria-label="全部工作面"
              @click="pickWorkface('')"
            >
              全部工作面
            </button>
            <button
              v-for="face in workfaceOptions"
              :key="face.id"
              type="button"
              class="chip"
              :class="{ active: isWorkfaceActive(face.id) }"
              :aria-pressed="isWorkfaceActive(face.id)"
              :aria-label="`工作面 ${face.name}`"
              @click="pickWorkface(face.id)"
            >
              {{ face.name }}
            </button>
          </div>
          <div class="group-hint">
            工作面按洞室 / 部位归组：同一洞室的开挖与支护算同一个工作面。未选单位工程时只列有记录的工作面。
          </div>
        </section>

        <section class="group" role="group" aria-label="按桩号筛选">
          <div class="group-title">桩号</div>
          <div class="chips">
            <button
              type="button"
              class="chip"
              :class="{ active: !state.scope.chainage }"
              :aria-pressed="!state.scope.chainage"
              aria-label="全部桩号"
              @click="pickChainage('')"
            >
              全部桩号
            </button>
            <button
              v-for="opt in chainageOptions"
              :key="opt.key"
              type="button"
              class="chip"
              :class="{ active: isChainageActive(opt) }"
              :aria-pressed="isChainageActive(opt)"
              :aria-label="`桩号 ${opt.label}`"
              @click="pickChainage(opt.text, opt.workfaceId)"
            >
              {{ opt.label }}
            </button>
          </div>
          <div class="chainage-input">
            <van-field
              v-model="chainageDraft"
              label="自定义"
              placeholder="如 545-548、K0+545~0+548"
              @keyup.enter="applyDraft"
            />
            <button type="button" class="chip apply" aria-label="应用自定义桩号" @click="applyDraft">应用</button>
          </div>
          <div class="group-hint">
            连接符支持 -、~、～ 或“至”；点已有桩号会连同它所属的工作面一起选中，同一个短桩号在不同工作面分开显示。
          </div>
        </section>
      </div>

      <div class="sheet-foot">
        <button type="button" class="chip" aria-label="清除全部筛选" @click="clearAll">清除筛选</button>
        <button type="button" class="chip primary" aria-label="完成筛选" @click="showSheet = false">完成</button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.scope-card {
  padding: 4px 14px;
}

.scope-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
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

.scope-order {
  margin-top: 2px;
  font-size: 11px;
}

.scope-edit {
  flex-shrink: 0;
  border: 1px solid #cdddff;
  background: #eef3ff;
  color: #1f6feb;
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
}

.scope-edit:focus-visible,
.chip:focus-visible,
.link-btn:focus-visible {
  outline: 2px solid #1f6feb;
  outline-offset: 2px;
}

.sheet {
  display: flex;
  flex-direction: column;
  max-height: 82vh;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid #f0f2f5;
}

.sheet-title {
  font-size: 16px;
  font-weight: 600;
  color: #1b2430;
}

.link-btn {
  border: none;
  background: transparent;
  color: #8b95a1;
  font-size: 13px;
  padding: 4px 2px;
}

.sheet-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 12px;
}

.group {
  padding: 6px 0 2px;
}

.group-title {
  padding: 8px 16px 6px;
  font-size: 12px;
  color: #8b95a1;
}

.group-hint {
  padding: 4px 16px 2px;
  font-size: 11px;
  line-height: 1.5;
  color: #9aa4b0;
}

.chips {
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
  font-family: inherit;
}

.chip.active {
  border-color: #1f6feb;
  background: #eef3ff;
  color: #1f6feb;
  font-weight: 600;
}

.chip.primary {
  border-color: #1f6feb;
  background: #1f6feb;
  color: #fff;
}

.chainage-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 0;
}

.chainage-input .apply {
  flex-shrink: 0;
}

.sheet-foot {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 10px 16px calc(14px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid #f0f2f5;
}
</style>
