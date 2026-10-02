<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { state } from '@/store'
import { ALERT_ACTIONS, AUDIT_ACTION_LABEL, listAudit, type AuditEntry } from '@/db/audit'
import { HEALTH_RULE_LABEL, scanHealth, type HealthIssue, type HealthLevel } from '@/core/health'
import { checkSecurityPin, saveSecurityPin, listDataCommits, type CloudCommit } from '@/sync'

const router = useRouter()
const tab = ref<'health' | 'alerts' | 'audit' | 'history'>('health')

const processById = computed(() => new Map(state.processes.map((p) => [p.id, p])))
const wbsById = computed(() => new Map(state.wbs.map((w) => [w.id, w])))

const health = computed(() => scanHealth(state.records, processById.value, wbsById.value))
const healthHigh = computed(() => health.value.filter((i) => i.level === 'high').length)

const audits = ref<AuditEntry[]>([])
const alerts = ref<AuditEntry[]>([])
const commits = ref<CloudCommit[]>([])
const loadingHistory = ref(false)
const historyError = ref('')

const pinForm = reactive({ show: false, oldPin: '', newPin: '', error: '' })

const LEVEL_LABEL: Record<HealthLevel, string> = { high: '严重', mid: '注意', low: '提示' }
const LEVEL_STYLE: Record<HealthLevel, string> = {
  high: 'background:#fdecec;color:#d14343',
  mid: 'background:#fff8e6;color:#b26a00',
  low: 'background:#eef3ff;color:#1f6feb'
}

function issueTap(issue: HealthIssue) {
  if (issue.recordId) router.push({ path: '/record', query: { id: issue.recordId } })
}

function actionStyle(entry: AuditEntry): string {
  if (ALERT_ACTIONS.includes(entry.action)) return 'background:#fdecec;color:#d14343'
  if (entry.action === 'create') return 'background:#e8f5ee;color:#12805c'
  if (entry.action === 'update') return 'background:#eef3ff;color:#1f6feb'
  return 'background:#f2f4f7;color:#4a5461'
}

function timeText(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load() {
  audits.value = await listAudit({ limit: 300 })
  alerts.value = await listAudit({ alertsOnly: true, limit: 200 })
}

async function loadHistory() {
  loadingHistory.value = true
  historyError.value = ''
  try {
    commits.value = await listDataCommits(20)
  } catch (err) {
    historyError.value = err instanceof Error ? err.message : '读取失败'
  } finally {
    loadingHistory.value = false
  }
}

function openPinForm() {
  pinForm.oldPin = ''
  pinForm.newPin = ''
  pinForm.error = ''
  pinForm.show = true
}

async function submitPin() {
  if (!(await checkSecurityPin(pinForm.oldPin))) {
    pinForm.error = '原口令不对'
    return
  }
  if (!/^\d{6}$/.test(pinForm.newPin)) {
    pinForm.error = '新口令必须是 6 位数字'
    return
  }
  await saveSecurityPin(pinForm.newPin)
  pinForm.show = false
  showToast('管理口令已修改（只对本机生效）')
}

async function copySha(sha: string) {
  try {
    await navigator.clipboard.writeText(sha)
    showToast('已复制版本号')
  } catch {
    showToast(sha.slice(0, 8))
  }
}

onMounted(async () => {
  await load()
  void loadHistory()
})

async function confirmRollbackHint() {
  await showConfirmDialog({
    title: '回滚怎么做',
    message:
      '回滚由维护者（我）在云端执行：把要恢复的版本时间或版本号发给我即可。\n你现在可以先在这份列表里找到出事前后的两次提交时间，一起发过来。',
    confirmButtonText: '知道了',
    showCancelButton: false
  })
}
</script>

<template>
  <van-nav-bar title="数据安全" left-arrow fixed placeholder @click-left="router.back()" />

  <div class="page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab title="体检" name="health" />
      <van-tab title="告警" name="alerts" />
      <van-tab title="留痕" name="audit" />
      <van-tab title="版本历史" name="history" />
    </van-tabs>

    <!-- 体检 -->
    <template v-if="tab === 'health'">
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          自动体检
          <span class="sub">{{ health.length }} 项待核对</span>
        </div>
        <div class="muted">
          规则：单条用时 &gt;12h 或 &lt;5min、同一天同一工作面 &gt;24h、与相邻工序重叠、间隔 &gt;6h、有量无时间、重复录入。
          <template v-if="healthHigh">其中 <b style="color:#d14343">严重 {{ healthHigh }} 项</b>。</template>
        </div>
      </div>
      <van-empty v-if="!health.length" description="没有发现异常，数据很干净" image-size="72" />
      <div v-for="issue in health" :key="issue.id" class="card issue" @click="issueTap(issue)">
        <div class="issue-head">
          <span class="pill" :style="LEVEL_STYLE[issue.level]">{{ LEVEL_LABEL[issue.level] }}</span>
          <span class="pill" style="background:#f2f4f7;color:#4a5461">{{ HEALTH_RULE_LABEL[issue.rule] }}</span>
          <span v-if="issue.date" class="muted num">{{ issue.date }}</span>
        </div>
        <div class="issue-title">{{ issue.title }}</div>
        <div class="muted">{{ issue.itemName }}</div>
        <div class="muted">{{ issue.detail }}</div>
      </div>
    </template>

    <!-- 告警 -->
    <template v-else-if="tab === 'alerts'">
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          告警记录
          <span class="sub">同步时自动汇总</span>
        </div>
        <div class="muted">
          出现大批量修改、删除、回滚、数据异常时会记在这里；每次同步都会汇总，不用额外配置。
        </div>
      </div>
      <van-empty v-if="!alerts.length" description="暂无告警" image-size="72" />
      <div v-for="a in alerts" :key="a.id" class="card issue">
        <div class="issue-head">
          <span class="pill" :style="actionStyle(a)">{{ AUDIT_ACTION_LABEL[a.action] }}</span>
          <span class="muted num">{{ timeText(a.at) }}</span>
          <span class="muted">{{ a.operatorName || '未署名' }}</span>
        </div>
        <div class="issue-title">{{ a.summary }}</div>
        <div v-if="a.changes?.length" class="muted">
          <span v-for="c in a.changes" :key="c.field">{{ c.field }}：{{ c.from }} → {{ c.to }}；</span>
        </div>
      </div>
    </template>

    <!-- 留痕 -->
    <template v-else-if="tab === 'audit'">
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          操作留痕
          <span class="sub">最近 {{ audits.length }} 条</span>
        </div>
        <div class="muted">
          只追加、不修改、不删除，并随同步保存到云端；任何人用 App 都抹不掉历史。
        </div>
        <div class="btn-row">
          <van-button size="small" plain @click="openPinForm">修改管理口令</van-button>
        </div>
      </div>
      <van-empty v-if="!audits.length" description="还没有留痕" image-size="72" />
      <div v-for="a in audits" :key="a.id" class="card issue">
        <div class="issue-head">
          <span class="pill" :style="actionStyle(a)">{{ AUDIT_ACTION_LABEL[a.action] }}</span>
          <span class="muted num">{{ timeText(a.at) }}</span>
          <span class="muted">{{ a.operatorName || '未署名' }}</span>
        </div>
        <div class="issue-title">{{ a.summary }}</div>
        <div v-if="a.changes?.length" class="muted">
          <span v-for="c in a.changes" :key="c.field">{{ c.field }}：{{ c.from }} → {{ c.to }}；</span>
        </div>
      </div>
    </template>

    <!-- 版本历史 -->
    <template v-else>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          云端版本历史
          <span class="sub">每次同步一次提交</span>
        </div>
        <div class="muted">云端每个数据文件都保留完整提交历史，回滚就是恢复某个版本。</div>
        <div class="btn-row">
          <van-button size="small" type="primary" plain :loading="loadingHistory" @click="loadHistory">
            刷新
          </van-button>
          <van-button size="small" plain @click="confirmRollbackHint">怎么回滚</van-button>
        </div>
        <div v-if="historyError" class="muted" style="color: #d14343; margin-top: 8px">{{ historyError }}</div>
      </div>
      <van-empty v-if="!commits.length && !loadingHistory" description="没有读到版本记录" image-size="72" />
      <div v-for="c in commits" :key="c.sha" class="card issue" @click="copySha(c.sha)">
        <div class="issue-head">
          <span class="pill" style="background:#eef3ff;color:#1f6feb">{{ c.sha.slice(0, 7) }}</span>
          <span class="muted num">{{ c.date.replace('T', ' ').slice(0, 16) }}</span>
        </div>
        <div class="issue-title">{{ c.message }}</div>
        <div class="muted">点一下复制版本号</div>
      </div>
    </template>

    <div class="bottom-space" />
  </div>

  <van-popup v-model:show="pinForm.show" round position="bottom">
    <div style="padding: 16px">
      <div class="card-title">修改管理口令</div>
      <van-cell-group inset>
        <van-field v-model="pinForm.oldPin" type="password" label="原口令" placeholder="默认 070010" />
        <van-field v-model="pinForm.newPin" type="password" label="新口令" placeholder="6 位数字" />
      </van-cell-group>
      <div v-if="pinForm.error" class="muted" style="color: #d14343; margin-top: 8px">{{ pinForm.error }}</div>
      <div class="muted" style="margin-top: 8px">口令只存在本机、不参与同步；用于放行大批量改动。</div>
      <div style="display: flex; gap: 10px; margin-top: 16px">
        <van-button block plain @click="pinForm.show = false">取消</van-button>
        <van-button block type="primary" @click="submitPin">保存</van-button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.issue {
  padding: 12px 14px;
}

.issue-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 11px;
}

.issue-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  word-break: break-all;
}

.btn-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
</style>
