export interface ReasonOption {
  key: string
  label: string
  color: string
}

/** 本工序开工前等待的原因标签 */
export const GAP_REASONS: ReasonOption[] = [
  { key: 'none', label: '衔接正常（无等待）', color: '#9ca3af' },
  { key: 'explosive', label: '等炸药 / 火工品', color: '#d14343' },
  { key: 'shotcrete', label: '等喷浆料（拌合楼 / 等补方）', color: '#f59e0b' },
  { key: 'material', label: '等材料转运（锚杆 / 网片 / 注浆料）', color: '#f97316' },
  { key: 'machine', label: '等机械到位', color: '#3b82f6' },
  { key: 'repair', label: '设备故障维修', color: '#0ea5e9' },
  { key: 'occupied', label: '机械被其他工作面占用', color: '#6366f1' },
  { key: 'inspect', label: '等验收（监理 / 三方）', color: '#8b5cf6' },
  { key: 'measure', label: '等测量放样', color: '#a855f7' },
  { key: 'design', label: '等图纸 / 设计答复', color: '#ec4899' },
  { key: 'weather', label: '天气原因', color: '#06b6d4' },
  { key: 'cross', label: '交叉作业干扰', color: '#14b8a6' },
  { key: 'labor', label: '人员不足', color: '#ef4444' },
  { key: 'rework', label: '欠挖 / 补炮返工', color: '#b91c1c' },
  { key: 'prep', label: '交接班 / 班前准备', color: '#64748b' },
  { key: 'other', label: '其他原因', color: '#78716c' }
]

export function reasonLabel(key?: string): string {
  if (!key) return '未填写'
  if (key === 'unknown') return '未填写原因'
  return GAP_REASONS.find((r) => r.key === key)?.label ?? key
}

/** 自定义原因没有固定色号：按文字稳定取色，保证同一个原因在饼图里始终同色 */
const CUSTOM_REASON_COLORS = [
  '#78716c',
  '#0d9488',
  '#7c3aed',
  '#c026d3',
  '#db2777',
  '#ca8a04',
  '#0284c7',
  '#65a30d'
]

export function reasonColor(key?: string): string {
  const hit = GAP_REASONS.find((r) => r.key === key)
  if (hit) return hit.color
  if (!key) return '#9ca3af'
  let hash = 0
  for (const ch of key) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 100000
  return CUSTOM_REASON_COLORS[hash % CUSTOM_REASON_COLORS.length]
}

/** 本机自定义等待原因的上限（防止列表无限变长） */
export const MAX_CUSTOM_REASONS = 20

/**
 * 合并自定义等待原因：本机记住的 + 历史记录里出现过的。
 *
 * 自定义原因的 key 直接就是文字本身，所以它随记录一起同步——另一台手机即使没加过，
 * 也能从已有记录里把这条原因收进候选列表。
 * 内置原因的 key 和文字都会被排除，避免重复。
 */
export function mergeCustomReasons(saved: string[], fromRecords: string[] = []): string[] {
  const taken = new Set<string>()
  GAP_REASONS.forEach((r) => {
    taken.add(r.key)
    taken.add(r.label)
  })
  const out: string[] = []
  const push = (raw: string) => {
    const text = String(raw ?? '').trim()
    if (!text || text === 'none' || taken.has(text) || text.length > 20) return
    taken.add(text)
    out.push(text)
  }
  saved.forEach(push)
  fromRecords.forEach(push)
  return out.slice(0, MAX_CUSTOM_REASONS)
}

/** 衔接小于该值（分钟）视为正常衔接，不计入"空隙问题" */
export const GAP_TOLERANCE_MINUTES = 30
