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
  return GAP_REASONS.find((r) => r.key === key)?.label ?? key
}

export function reasonColor(key?: string): string {
  return GAP_REASONS.find((r) => r.key === key)?.color ?? '#9ca3af'
}

/** 衔接小于该值（分钟）视为正常衔接，不计入"空隙问题" */
export const GAP_TOLERANCE_MINUTES = 30
