/**
 * 工作面（Workface）：把同一洞室 / 部位下的开挖、支护等分项工程归到一起。
 *
 * 命名口径：分项名 = 单元工程（部位），所以「土石方洞挖（导流洞1#施工支洞）」
 * 的工作面就是括号里的部位，再按看板的短名规则压成「1#支洞」。
 * 嵌套括号只取洞室层：「封堵混凝土（导流洞1#施工支洞（DZ1#封堵段））」→ 1#支洞。
 *
 * 全部是纯函数：解析、稳定 ID、初始化规划、绑定解析、桩号身份。
 */
import type { WbsNode, Workface } from '@/types'

/** 部位名 → 工作面短名：与看板图例（scope.shortSpot）保持同一套说法 */
const NAME_RULES: Array<[string, string]> = [
  ['导流洞闸室交通洞', '闸室交通洞'],
  ['导流洞主洞', '导流洞洞身'],
  ['通风兼安全洞主洞', '通风洞'],
  ['主变通风兼安全洞', '主变通风洞'],
  ['尾闸通风兼安全洞', '尾闸通风洞'],
  ['进厂交通洞主洞', '进厂交通洞'],
  ['临时生态放水洞', '放水洞']
]

/** 导流洞 N# 支洞（有没有"施工"两字都认）：1#施工支洞 / 2#支洞 / 3#施工支洞 → N#支洞 */
const ADIT_PATTERN = /导流洞(\d+)#(?:施工)?支洞/

const OPEN = new Set(['（', '('])
const CLOSE = new Set(['）', ')'])

/** 取最外层括号里的内容；没有括号或括号没闭合时返回 '' */
export function outerBracketText(name: string): string {
  const text = String(name ?? '')
  let start = -1
  for (let i = 0; i < text.length; i += 1) {
    if (OPEN.has(text[i])) {
      start = i
      break
    }
  }
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (OPEN.has(ch)) depth += 1
    else if (CLOSE.has(ch)) {
      depth -= 1
      if (depth === 0) return text.slice(start + 1, i)
    }
  }
  return text.slice(start + 1)
}

/** 去掉文本里所有括号层（嵌套括号只留最外层洞室名） */
export function stripNestedBrackets(text: string): string {
  let out = ''
  let depth = 0
  for (const ch of String(text ?? '')) {
    if (OPEN.has(ch)) {
      depth += 1
      continue
    }
    if (CLOSE.has(ch)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) out += ch
  }
  return out.trim()
}

/** 部位名归一成工作面短名；不认识的名称原样保留，不猜 */
export function normalizeWorkfaceName(raw: string): string {
  const name = String(raw ?? '').trim()
  if (!name) return ''
  const adit = name.replace(ADIT_PATTERN, '$1#支洞')
  if (adit !== name) return adit.trim()
  for (const [from, to] of NAME_RULES) {
    if (name.includes(from)) return name.replace(from, to).trim()
  }
  return name
}

/**
 * 分项工程名 → 工作面名。
 * 有括号取最外层括号（再去掉嵌套层），没有括号就退回到单位工程名。
 */
export function workfaceNameOf(itemName: string, unitName: string): string {
  const part = stripNestedBrackets(outerBracketText(itemName))
  const base = part || String(unitName ?? '').trim() || String(itemName ?? '').trim()
  return normalizeWorkfaceName(base)
}

/** FNV-1a 32 位；只用来生成稳定 id，不参与业务计算 */
export function hash32(input: string): string {
  let h = 2166136261
  const text = String(input ?? '')
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * 稳定确定性 id：同一项目 + 同一单位工程 + 同一工作面名，在任何设备上算出来都一样。
 * 因此两台手机各自初始化后合并，不会出现两份同名工作面。
 */
export function workfaceIdOf(projectId: string, unitId: string, name: string): string {
  return `wf-${projectId}-${hash32(`${unitId}|${name}`)}`
}

/** 顺着 mergedInto 找到仍然有效的工作面；悬空或已删且无去向时返回 undefined */
export function resolveWorkface(
  workfaceId: string | undefined,
  byId: Map<string, Workface>
): Workface | undefined {
  let cur = workfaceId ? byId.get(workfaceId) : undefined
  const seen = new Set<string>()
  while (cur && cur.deletedAt && cur.mergedInto && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = byId.get(cur.mergedInto)
  }
  return cur && !cur.deletedAt ? cur : undefined
}

/** 分项工程 → 工作面：优先用绑定，绑定缺失时按名称回退（旧数据/迁移未落定时也能算） */
export function buildItemWorkfaceMap(wbs: WbsNode[], workfaces: Workface[]): Map<string, string> {
  const byId = new Map(workfaces.map((w) => [w.id, w]))
  const wbsById = new Map(wbs.map((w) => [w.id, w]))
  const activeByName = new Map<string, Workface>()
  workfaces
    .filter((w) => !w.deletedAt)
    .forEach((w) => activeByName.set(`${w.unitId}|${w.name}`, w))

  const out = new Map<string, string>()
  wbs
    .filter((w) => w.level === 3 && !w.deletedAt)
    .forEach((item) => {
      const direct = resolveWorkface(item.workfaceId, byId)
      if (direct) {
        out.set(item.id, direct.id)
        return
      }
      const div = item.parentId ? wbsById.get(item.parentId) : undefined
      const unit = div?.parentId ? wbsById.get(div.parentId) : undefined
      if (!unit) return
      const hit = activeByName.get(`${unit.id}|${workfaceNameOf(item.name, unit.name)}`)
      if (hit) out.set(item.id, hit.id)
    })
  return out
}

export interface WorkfaceInitPlan {
  /** 需要新建的工作面 */
  create: Workface[]
  /** 需要复位（软删后又被重新解析出来）的工作面 id */
  revive: string[]
  /** 需要改绑的分项：itemId → workfaceId */
  bind: Array<{ itemId: string; workfaceId: string }>
}

/**
 * 规划工作面初始化 / 补建。
 *
 * 幂等要点：
 *   - 分项已经有有效绑定就**不动**（尊重人工改名与重绑）；
 *   - 没有绑定时先按「单位工程 + 工作面名」找现有工作面，找到就复用；
 *   - 都找不到才用稳定 id 新建；同 id 已被软删且没有合并去向时复用原行（不产生 -2、-3 的碎片）。
 *
 * @param workfaces 本项目全部工作面，含软删除的（用来判断 id 是否已被占用）
 */
export function planWorkfaceInit(input: {
  projectId: string
  units: WbsNode[]
  divisions: WbsNode[]
  items: WbsNode[]
  workfaces: Workface[]
  now?: number
}): WorkfaceInitPlan {
  const now = input.now ?? Date.now()
  const byId = new Map(input.workfaces.map((w) => [w.id, w]))
  const activeByName = new Map<string, Workface>()
  input.workfaces
    .filter((w) => !w.deletedAt)
    .forEach((w) => activeByName.set(`${w.unitId}|${w.name}`, w))

  const unitById = new Map(input.units.map((u) => [u.id, u]))
  const divisionById = new Map(input.divisions.map((d) => [d.id, d]))
  const sortOf = new Map<string, number>()
  input.workfaces
    .filter((w) => !w.deletedAt)
    .forEach((w) => sortOf.set(w.unitId, Math.max(sortOf.get(w.unitId) ?? 0, w.sort)))

  const create = new Map<string, Workface>()
  const revive = new Set<string>()
  const bind: Array<{ itemId: string; workfaceId: string }> = []

  input.items.forEach((item) => {
    const division = item.parentId ? divisionById.get(item.parentId) : undefined
    const unit = division?.parentId ? unitById.get(division.parentId) : undefined
    if (!unit) return

    // 已有有效绑定：保持不动（改名 / 人工重绑都靠这条稳定下来）
    const bound = resolveWorkface(item.workfaceId, byId)
    if (bound && bound.unitId === unit.id) return

    const name = workfaceNameOf(item.name, unit.name)
    if (!name) return

    let target = activeByName.get(`${unit.id}|${name}`)
    if (!target) {
      const detId = workfaceIdOf(input.projectId, unit.id, name)
      const existing = byId.get(detId)
      if (!existing) {
        const sort = (sortOf.get(unit.id) ?? 0) + 1
        sortOf.set(unit.id, sort)
        target = {
          id: detId,
          projectId: input.projectId,
          unitId: unit.id,
          name,
          sort,
          source: item.name,
          updatedAt: now
        }
        create.set(detId, target)
        byId.set(detId, target)
      } else if (!existing.deletedAt) {
        target = existing
      } else {
        const revived = resolveWorkface(detId, byId)
        if (revived) {
          target = revived
        } else {
          target = { ...existing, deletedAt: undefined, mergedInto: undefined, updatedAt: now }
          revive.add(detId)
          byId.set(detId, target)
        }
      }
      activeByName.set(`${unit.id}|${name}`, target)
    }

    if (item.workfaceId !== target.id) bind.push({ itemId: item.id, workfaceId: target.id })
  })

  return { create: Array.from(create.values()), revive: Array.from(revive), bind }
}

/** 桩号身份：工作面 + 规范化桩号，避免两个工作面同桩号被当成同一段 */
export function chainageKey(workfaceId: string, normalizedChainage: string): string {
  return `${workfaceId}|${normalizedChainage}`
}

/** 快速筛选按钮上的桩号文本，如「1#支洞 · 0-5」 */
export function chainageOptionLabel(workfaceName: string, shortText: string): string {
  const name = String(workfaceName ?? '').trim()
  return name ? `${name} · ${shortText}` : shortText
}

/** 工作面显示名；找不到时退回「未分工作面」 */
export function workfaceLabel(workfaceId: string, byId: Map<string, Workface>): string {
  const wf = byId.get(workfaceId)
  return wf?.name ?? '未分工作面'
}

/**
 * 旧云端目录 / 旧备份容错：没有 workfaces 字段、或字段不是数组时按空数组处理。
 * 这样旧数据可直接读取，加载后再由 ensureWorkfaces 幂等补建，不会报错也不会造重复。
 */
export function workfacesOfCatalog(payload: unknown): Workface[] {
  if (!payload || typeof payload !== 'object') return []
  const rows = (payload as { workfaces?: unknown }).workfaces
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is Workface =>
      Boolean(row) && typeof row === 'object' && typeof (row as Workface).id === 'string'
  )
}
