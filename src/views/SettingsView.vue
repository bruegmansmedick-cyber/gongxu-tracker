<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { afterChange, refreshSyncState, runSync, setOperator, state } from '@/store'
import {
  deleteOperator as removeOperator,
  exportBackup,
  getKv,
  hasImportSnapshot,
  importBackup,
  restoreImportSnapshot,
  saveOperator,
  setKv,
  wipeLocalData,
  type BackupFile
} from '@/db'
import {
  clearSyncConfig,
  createDataSpace,
  getSyncConfig,
  isConfigured,
  runDiagnostics,
  saveSyncConfig,
  type ProbeResult,
  type SyncConfig
} from '@/sync'
import { createStore } from '@/sync/stores'
import { exportProjectExcel } from '@/utils/exportExcel'
import { downloadText, pickFile, readFileText, stamp } from '@/utils/download'
import { endOfMonth, fmtDate, fmtHoursShort, monthKey, startOfMonth, todayStr } from '@/core/time'

const busy = ref('')
const syncCfg = reactive<SyncConfig>({
  backend: 'gitee',
  githubToken: '',
  gistId: '',
  giteeToken: '',
  giteeRepo: '',
  giteeDir: 'data'
})
const probes = ref<ProbeResult[]>([])
const probing = ref(false)
const snapshotAvailable = ref(false)
const exportRange = reactive({ from: startOfMonth(todayStr()), to: endOfMonth(todayStr()) })

const showPat = ref(false)
const showFromCalendar = ref(false)
const showToCalendar = ref(false)
const showOperatorEditor = ref(false)
const operatorDraft = reactive({ id: '', name: '', shift: '白班' })

const project = computed(() => state.projects.find((p) => p.id === state.currentProjectId))
const lastSyncText = computed(() =>
  state.sync.lastSyncAt ? new Date(state.sync.lastSyncAt).toLocaleString('zh-CN') : '尚未同步过'
)

onMounted(async () => {
  const cfg = await getSyncConfig()
  Object.assign(syncCfg, cfg)
  snapshotAvailable.value = await hasImportSnapshot()
})

async function persistSync() {
  await saveSyncConfig({ ...syncCfg })
  await setKv('sync.pending', true)
  await refreshSyncState()
}

async function doCreateSpace() {
  const isGitee = syncCfg.backend === 'gitee'
  if (isGitee && !syncCfg.giteeToken.trim()) {
    showToast('请先填写 Gitee 私人令牌')
    return
  }
  if (!isGitee && !syncCfg.githubToken.trim()) {
    showToast('请先填写 GitHub 令牌')
    return
  }
  busy.value = 'create'
  try {
    const res = await createDataSpace({ ...syncCfg }, state.deviceId)
    if (res.repo) syncCfg.giteeRepo = res.repo
    if (res.gistId) syncCfg.gistId = res.gistId
    await persistSync()
    if (!isGitee) {
      showToast('数据空间已创建并保存')
    } else if (res.reused) {
      showToast(`已连接现有数据仓库 ${res.repo}（云端已有数据，未覆盖），现在可以点“立即同步”`)
    } else {
      showToast(`已创建私有仓库 ${res.repo} 并写入初始文件`)
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : '创建失败')
  } finally {
    busy.value = ''
  }
}

async function doTest() {
  busy.value = 'test'
  try {
    await persistSync()
    if (!isConfigured({ ...syncCfg })) {
      showToast('配置不完整，无法测试')
      return
    }
    const msg = await createStore({ ...syncCfg }).test()
    showToast(msg)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '连接失败')
  } finally {
    busy.value = ''
  }
}

async function doDiagnose() {
  probing.value = true
  try {
    probes.value = await runDiagnostics()
  } finally {
    probing.value = false
  }
}

async function doSync() {
  busy.value = 'sync'
  try {
    await persistSync()
    if (!isConfigured({ ...syncCfg })) {
      showToast('配置不完整，无法同步')
      return
    }
    const ok = await runSync(true)
    showToast(state.sync.message || (ok ? '同步完成' : '同步失败'))
  } finally {
    busy.value = ''
  }
}

async function doClearSync() {
  await showConfirmDialog({ title: '解除同步', message: '仅清除本机保存的令牌与数据空间，云端数据不受影响。' })
  await clearSyncConfig()
  Object.assign(syncCfg, await getSyncConfig())
  await refreshSyncState()
  showToast('已解除同步配置')
}

// ------------------------------------------------------------------ 操作人
function openOperatorEditor(id = '') {
  const row = state.operators.find((o) => o.id === id)
  operatorDraft.id = id
  operatorDraft.name = row?.name ?? ''
  operatorDraft.shift = row?.shift ?? '白班'
  showOperatorEditor.value = true
}

async function submitOperator() {
  if (!operatorDraft.name.trim()) {
    showToast('请填写姓名或岗位')
    return
  }
  const row = await saveOperator({
    id: operatorDraft.id || undefined,
    name: operatorDraft.name.trim(),
    shift: operatorDraft.shift
  })
  showOperatorEditor.value = false
  await afterChange('operators')
  if (!state.currentOperatorId) await setOperator(row.id)
  showToast('已保存')
}

async function doRemoveOperator(id: string, name: string) {
  await showConfirmDialog({ title: '删除记录人', message: `删除「${name}」？已有记录仍会保留其姓名。` })
  await removeOperator(id)
  await afterChange('operators')
}

// ------------------------------------------------------------------ 数据
function doExportExcel() {
  if (!project.value) {
    showToast('请先选择项目')
    return
  }
  exportProjectExcel({
    projectName: project.value.name,
    from: exportRange.from,
    to: exportRange.to,
    records: state.records,
    processes: state.processes,
    wbs: state.wbs
  })
  showToast('Excel 已生成')
}

async function doExportJson() {
  const data = await exportBackup()
  downloadText(JSON.stringify(data, null, 2), `工序用时备份-${stamp()}.json`)
  showToast('备份已导出')
}

async function doImportJson() {
  const file = await pickFile('.json')
  if (!file) return
  const text = await readFileText(file)
  let parsed: BackupFile
  try {
    parsed = JSON.parse(text) as BackupFile
  } catch {
    showToast('文件不是合法的 JSON')
    return
  }
  if (!parsed?.meta || parsed.meta.app !== 'gongxu-tracker') {
    showToast('这不是本系统导出的备份文件')
    return
  }
  await showConfirmDialog({
    title: '导入备份',
    message: '导入的数据会与本地数据按时间戳合并，不会直接覆盖。导入前会自动留一份可回滚快照。'
  })
  await importBackup(parsed)
  snapshotAvailable.value = await hasImportSnapshot()
  await afterChange('all')
  showToast('导入完成，将自动同步')
}

async function doRestore() {
  await showConfirmDialog({ title: '回滚', message: '恢复到最近一次导入备份之前的状态？' })
  const ok = await restoreImportSnapshot()
  await afterChange('all')
  showToast(ok ? '已回滚' : '没有可回滚的快照')
}

async function doWipe() {
  await showConfirmDialog({
    title: '清空本机数据',
    message: '将删除本机保存的全部项目、工序和记录（云端不受影响，可通过同步重新拉取）。确定吗？'
  })
  await wipeLocalData()
  await getKv('ui.currentProjectId', '')
  await setKv('ui.currentProjectId', '')
  await afterChange('all')
  showToast('本机数据已清空')
}

function pickFrom(value: Date) {
  exportRange.from = fmtDate(value)
  showFromCalendar.value = false
}

function pickTo(value: Date) {
  exportRange.to = fmtDate(value)
  showToCalendar.value = false
}

const monthQuick = computed(() => monthKey(todayStr()))

function quickMonth() {
  exportRange.from = startOfMonth(`${monthQuick.value}-01`)
  exportRange.to = endOfMonth(`${monthQuick.value}-01`)
}

function quickAll() {
  const dates = state.records.map((r) => r.date).sort()
  exportRange.from = dates[0] ?? startOfMonth(todayStr())
  exportRange.to = dates[dates.length - 1] ?? todayStr()
}
</script>

<template>
  <van-nav-bar title="设置" fixed placeholder />

  <div class="page">
    <div class="card">
      <div class="card-title">记录人</div>
      <div v-for="o in state.operators" :key="o.id" class="line">
        <div class="line-main" @click="openOperatorEditor(o.id)">
          <div>{{ o.name }} <span class="tag-soft">{{ o.shift }}</span></div>
          <div v-if="o.id === state.currentOperatorId" class="muted">当前记录人</div>
        </div>
        <van-icon name="delete-o" color="#d14343" @click="doRemoveOperator(o.id, o.name)" />
      </div>
      <van-button size="small" plain type="primary" @click="openOperatorEditor()">添加记录人</van-button>
    </div>

    <div class="card">
      <div class="card-title">
        数据同步
        <span class="sub">
          <template v-if="state.sync.syncing">同步中…</template>
          <template v-else-if="!state.sync.configured">未配置</template>
          <template v-else-if="state.sync.pending">待同步</template>
          <template v-else>已是最新</template>
        </span>
      </div>
      <div class="muted" style="margin-bottom: 10px">
        每次同步都会先合并云端和本机的数据（按每条记录的时间取新），再上传变化部分，所以两台手机分别记录也不会互相覆盖。
      </div>
      <van-tabs v-model:active="syncCfg.backend" type="card" @change="persistSync">
        <van-tab title="Gitee（国内推荐）" name="gitee" />
        <van-tab title="GitHub Gist" name="gist" />
      </van-tabs>
      <van-cell-group v-if="syncCfg.backend === 'gitee'" inset style="margin-top: 12px">
        <van-field
          v-model="syncCfg.giteeToken"
          :type="showPat ? 'text' : 'password'"
          label="私人令牌"
          placeholder="Gitee：设置 → 安全设置 → 私人令牌"
          @update:model-value="persistSync"
        />
        <van-field
          v-model="syncCfg.giteeRepo"
          label="数据仓库"
          placeholder="用户名/仓库名，如 wsq/gongxu-data"
          @update:model-value="persistSync"
        />
        <van-field v-model="syncCfg.giteeDir" label="数据目录" placeholder="data" @update:model-value="persistSync" />
      </van-cell-group>
      <van-cell-group v-else inset style="margin-top: 12px">
        <van-field
          v-model="syncCfg.githubToken"
          :type="showPat ? 'text' : 'password'"
          label="令牌"
          placeholder="GitHub 细粒度令牌（Gist 读写）"
          @update:model-value="persistSync"
        />
        <van-field v-model="syncCfg.gistId" label="数据空间" placeholder="Gist ID" @update:model-value="persistSync" />
      </van-cell-group>
      <van-cell-group inset style="margin-top: 8px">
        <van-cell title="显示令牌" center>
          <template #right-icon>
            <van-switch v-model="showPat" size="20" />
          </template>
        </van-cell>
      </van-cell-group>
      <div class="btn-grid">
        <van-button size="small" :loading="busy === 'create'" @click="doCreateSpace">创建数据空间</van-button>
        <van-button size="small" :loading="busy === 'test'" @click="doTest">测试连接</van-button>
        <van-button size="small" type="primary" :loading="busy === 'sync'" @click="doSync">立即同步</van-button>
        <van-button size="small" plain @click="doClearSync">解除配置</van-button>
      </div>
      <div class="muted" style="margin-top: 8px">
        Gitee 是国内的代码托管平台：注册后在「设置 → 安全设置 → 私人令牌」生成一个令牌（勾选 projects 权限），
        再点上面的“创建数据空间”，会自动建一个<b>私有仓库</b>并把数据写进去。两台手机填同一个仓库即可。
      </div>
      <div class="divider" />
      <div class="muted">上次同步：{{ lastSyncText }}</div>
      <div v-if="state.sync.message" class="muted" :style="{ color: state.sync.error ? '#d14343' : '#12805c' }">
        {{ state.sync.message }}
      </div>
      <div class="muted" style="margin-top: 8px">
        数据始终先存在本机，网络不通不影响记录；实在连不上时可用下方“导出/导入备份”两台手机人工合并。
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        网络诊断
        <span class="sub">测一下当前网络能不能连上同步接口</span>
      </div>
      <div v-for="p in probes" :key="p.name" class="line">
        <div class="line-main">
          <div>
            {{ p.name }}
            <span class="tag-soft" :style="{ background: p.ok ? '#e8f5ee' : '#fdecec', color: p.ok ? '#12805c' : '#d14343' }">
              {{ p.ok ? '可用' : '不可达' }}
            </span>
          </div>
          <div class="muted">{{ p.detail }}</div>
        </div>
      </div>
      <div v-if="!probes.length" class="muted">还没有测试过。建议在工地的手机上测一次，哪个能连就用哪个。</div>
      <div class="btn-grid">
        <van-button size="small" type="primary" plain :loading="probing" @click="doDiagnose">开始诊断</van-button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">导出报表</div>
      <van-cell-group inset>
        <van-field :model-value="exportRange.from" label="起始日期" readonly is-link @click="showFromCalendar = true" />
        <van-field :model-value="exportRange.to" label="结束日期" readonly is-link @click="showToCalendar = true" />
      </van-cell-group>
      <div class="btn-grid" style="margin-top: 10px">
        <van-button size="small" @click="quickMonth">本月</van-button>
        <van-button size="small" @click="quickAll">全部</van-button>
        <van-button size="small" type="primary" @click="doExportExcel">导出 Excel</van-button>
      </div>
      <div class="muted" style="margin-top: 8px">
        Excel 含统计概览、记录明细、工序汇总、周对比、月对比、衔接空隙明细、分项完成情况共 7 张表。
      </div>
    </div>

    <div class="card">
      <div class="card-title">备份与恢复</div>
      <div class="btn-grid">
        <van-button size="small" @click="doExportJson">导出 JSON 备份</van-button>
        <van-button size="small" @click="doImportJson">导入备份合并</van-button>
        <van-button size="small" :disabled="!snapshotAvailable" @click="doRestore">回滚到导入前</van-button>
      </div>
      <div class="muted" style="margin-top: 8px">
        备份文件可用于换手机、人工合并或在没有网络时通过微信互传。
      </div>
    </div>

    <div class="card">
      <div class="card-title">本机数据</div>
      <div class="muted">
        当前项目 {{ project?.name ?? '—' }} · 记录 {{ state.records.length }} 条 · 工序 {{ state.processes.length }} 条 ·
        累计工时 {{ fmtHoursShort(state.records.reduce((s, r) => s + r.hours, 0)) }}
      </div>
      <div class="btn-grid" style="margin-top: 10px">
        <van-button size="small" type="danger" plain @click="doWipe">清空本机数据</van-button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">使用说明</div>
      <div class="muted">
        1. 在“工程”页新建项目，可一键套用水利通用模板，再按实际增删工序。<br />
        2. 首页点“+”记录工序用时，填开工与完工时刻，程序自动算用时；若完工早于开工则视为跨零点。<br />
        3. 同一分项工程内按开工时间排序，相邻两道工序之间的空档即为“衔接空隙”，开工前等待的原因记在本条记录上。<br />
        4. 效率两个口径：总量口径 = Σ标准用时 ÷ Σ实际用时 − 1；工序平均口径 = 各工序（标准−实际）÷标准 的平均。<br />
        5. 建议用手机浏览器“添加到主屏幕”作为主入口，微信里打开的链接作为分享入口。
      </div>
    </div>

    <div class="bottom-space" />
  </div>

  <van-calendar v-model:show="showFromCalendar" @confirm="pickFrom" />
  <van-calendar v-model:show="showToCalendar" @confirm="pickTo" />

  <van-popup v-model:show="showOperatorEditor" round position="bottom">
    <div style="padding: 16px">
      <div class="card-title">记录人</div>
      <van-cell-group inset>
        <van-field v-model="operatorDraft.name" label="姓名" placeholder="如：张三" />
        <van-field v-model="operatorDraft.shift" label="班次" placeholder="白班 / 夜班" />
      </van-cell-group>
      <div style="display: flex; gap: 10px; margin-top: 16px">
        <van-button block plain @click="showOperatorEditor = false">取消</van-button>
        <van-button block type="primary" @click="submitOperator">保存</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid #f4f5f7;
}

.line-main {
  flex: 1;
  min-width: 0;
}

.btn-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
</style>
