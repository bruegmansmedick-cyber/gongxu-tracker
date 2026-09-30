import { reactive } from 'vue'
import type { Operator, Process, ProcessRecord, Project, WbsNode } from '@/types'
import {
  ensureDeviceId,
  getKv,
  listOperators,
  listProcesses,
  listProjects,
  listRecords,
  listWbs,
  saveOperator,
  setKv
} from '@/db'
import { syncNow, syncState as readSyncState, type SyncBackend } from '@/sync'

export interface SyncViewState {
  configured: boolean
  backend: SyncBackend
  lastSyncAt: number
  pending: boolean
  syncing: boolean
  message: string
  error: boolean
}

interface AppState {
  ready: boolean
  deviceId: string
  projects: Project[]
  currentProjectId: string
  operators: Operator[]
  currentOperatorId: string
  wbs: WbsNode[]
  processes: Process[]
  records: ProcessRecord[]
  sync: SyncViewState
}

export const state = reactive<AppState>({
  ready: false,
  deviceId: '',
  projects: [] as Project[],
  currentProjectId: '',
  operators: [] as Operator[],
  currentOperatorId: '',
  wbs: [] as WbsNode[],
  processes: [] as Process[],
  records: [] as ProcessRecord[],
  sync: {
    configured: false,
    backend: 'gitee' as SyncBackend,
    lastSyncAt: 0,
    pending: false,
    syncing: false,
    message: '',
    error: false
  }
})

let syncTimer: number | undefined

export type ChangeScope = 'all' | 'structure' | 'records' | 'projects' | 'operators'

/** 任何本地写操作之后调用：刷新受影响的数据、打上待同步标记并安排自动同步 */
export async function afterChange(scope: ChangeScope = 'all'): Promise<void> {
  if (scope === 'all') await refreshAll()
  else if (scope === 'structure') {
    await refreshStructure()
    await refreshRecords()
  } else if (scope === 'records') await refreshRecords()
  else if (scope === 'projects') {
    await refreshProjects()
    await refreshStructure()
    await refreshRecords()
  } else await refreshOperators()
  await refreshSyncState()
  scheduleSync()
}

export async function refreshProjects(): Promise<void> {
  state.projects = await listProjects()
  if (!state.currentProjectId && state.projects.length) {
    state.currentProjectId = state.projects[0].id
  }
  if (state.currentProjectId && !state.projects.some((p) => p.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0]?.id ?? ''
  }
}

export async function refreshOperators(): Promise<void> {
  state.operators = await listOperators()
  if (!state.currentOperatorId && state.operators.length) {
    state.currentOperatorId = state.operators[0].id
  }
  if (state.currentOperatorId && !state.operators.some((o) => o.id === state.currentOperatorId)) {
    state.currentOperatorId = state.operators[0]?.id ?? ''
  }
}

export async function refreshStructure(): Promise<void> {
  if (!state.currentProjectId) {
    state.wbs = []
    state.processes = []
    return
  }
  const [wbs, processes] = await Promise.all([listWbs(state.currentProjectId), listProcesses(state.currentProjectId)])
  state.wbs = wbs
  state.processes = processes
}

export async function refreshRecords(): Promise<void> {
  if (!state.currentProjectId) {
    state.records = []
    return
  }
  state.records = await listRecords(state.currentProjectId)
}

export async function refreshAll(): Promise<void> {
  await Promise.all([refreshProjects(), refreshOperators()])
  await refreshStructure()
  await refreshRecords()
  await refreshSyncState()
}

export async function setProject(id: string): Promise<void> {
  state.currentProjectId = id
  await setKv('ui.currentProjectId', id)
  await refreshStructure()
  await refreshRecords()
}

export async function setOperator(id: string): Promise<void> {
  state.currentOperatorId = id
  await setKv('ui.currentOperatorId', id)
}

export async function refreshSyncState(): Promise<void> {
  const s = await readSyncState()
  state.sync.configured = s.configured
  state.sync.backend = s.backend
  state.sync.lastSyncAt = s.lastSyncAt
  state.sync.pending = s.pending
}

export async function initApp(): Promise<void> {
  state.deviceId = await ensureDeviceId()
  state.currentProjectId = await getKv<string>('ui.currentProjectId', '')
  state.currentOperatorId = await getKv<string>('ui.currentOperatorId', '')
  await refreshAll()

  // 首次使用自动建一个默认操作人，避免录入时无法选人
  if (!state.operators.length) {
    const op = await saveOperator({ name: '白班', shift: '白班' })
    await refreshOperators()
    await setOperator(op.id)
  }

  state.ready = true
  if (state.sync.configured) {
    window.setTimeout(() => {
      void runSync(false)
    }, 1500)
  }
  window.addEventListener('online', () => {
    if (state.sync.configured && state.sync.pending) void runSync(false)
  })
}

/** 本地写操作后调用：打上待同步标记并延迟自动同步 */
export function scheduleSync(delay = 4000): void {
  if (syncTimer) window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    void runSync(false)
  }, delay)
}

export async function runSync(manual: boolean): Promise<boolean> {
  if (state.sync.syncing) return false
  const cfg = await readSyncState()
  if (!cfg.configured) {
    state.sync.configured = false
    await refreshSyncState()
    if (manual) {
      state.sync.message = '尚未配置同步'
      state.sync.error = true
    }
    return false
  }
  state.sync.syncing = true
  state.sync.message = '正在同步…'
  state.sync.error = false
  try {
    const result = await syncNow()
    state.sync.message = result.message
    state.sync.error = !result.ok
    await refreshAll()
    return result.ok
  } catch (err) {
    state.sync.message = err instanceof Error ? err.message : '同步失败'
    state.sync.error = true
    return false
  } finally {
    state.sync.syncing = false
    await refreshSyncState()
  }
}

export function processMap(): Map<string, Process> {
  return new Map(state.processes.map((p) => [p.id, p]))
}

export function wbsMap(): Map<string, WbsNode> {
  return new Map(state.wbs.map((w) => [w.id, w]))
}

export function currentProject(): Project | undefined {
  return state.projects.find((p) => p.id === state.currentProjectId)
}

export function currentOperator(): Operator | undefined {
  return state.operators.find((o) => o.id === state.currentOperatorId)
}

/** 某分项工程下的工序（按排序） */
export function processesOfItem(itemId: string): Process[] {
  return state.processes.filter((p) => p.itemId === itemId && p.enabled)
}

export function unitOfItem(itemId: string): WbsNode | undefined {
  const map = wbsMap()
  const item = map.get(itemId)
  const div = item?.parentId ? map.get(item.parentId) : undefined
  return div?.parentId ? map.get(div.parentId) : undefined
}

export function divisionOfItem(itemId: string): WbsNode | undefined {
  const item = wbsMap().get(itemId)
  return item?.parentId ? wbsMap().get(item.parentId) : undefined
}
