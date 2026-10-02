/**
 * 工序推荐：按"分项工程的名称 + 部位/项目划分特征"给出该分项可能需要的工序。
 *
 * 三个来源，按优先级合并（去重后依次排列）：
 *   1. 该分项下已有的工序（工程管理里建过、或别的设备同步过来的）；
 *   2. 本机记忆：同一"项目划分类型 + 分项名骨架"下曾经手工添加过的工序；
 *   3. 内置规则：按名称关键词匹配到的通用工序集。
 *
 * 本模块是纯函数，不读写数据库：记忆的落盘由调用方负责（记录页写在 kv 里）。
 * 说明：记忆按"设备"保存，不参与云同步；工序本身是真实的 Process 行，会正常同步，
 * 所以另一台手机打开同一分项时，那些工序在"本分项已有"里能看到。
 */
import { EXC_PROCESSES, SUP_PROCESSES } from '@/db/seed'

export type ProcessCategory =
  | 'tunnel-excavation'
  | 'support'
  | 'grout'
  | 'masonry'
  | 'metal'
  | 'paving'
  | 'concrete'
  | 'filling'
  | 'open-excavation'
  | 'drainage'
  | 'slope'
  | 'env'
  | 'other'

export interface CategoryRule {
  key: ProcessCategory
  label: string
  /** 命中即归入本类；名称里出现任意一个即算命中 */
  keywords: string[]
  /** 该类的通用工序（推荐用，不是强制） */
  processes: string[]
}

/**
 * 规则顺序 = 优先顺序：越靠前越"具体"，先匹配到的赢。
 * 顺序上的几个刻意安排：
 *   - 洞挖在普通开挖之前（"土石方洞挖"不能被当成明挖）；
 *   - 浆砌石/干砌石在混凝土与护坡之前（"浆砌石护坡"是砌筑，不是现浇）；
 *   - 混凝土在填筑与金属结构之前（"明洞混凝土回填""闸门埋件二期混凝土"都是混凝土）；
 *   - 开挖在排水沟之前（"临时排水沟开挖"要的是开挖工序），
 *     但混凝土/砌筑都排在开挖之前，所以"临时排水沟混凝土""浆砌石排水沟"不会被误判。
 */
export const CATEGORY_RULES: CategoryRule[] = [
  {
    key: 'tunnel-excavation',
    label: '洞挖循环',
    // 注意：不要放"洞脸开挖"——那是明挖削坡，属于下面的土石方开挖
    keywords: ['洞挖', '洞身开挖', '隧洞开挖', '竖井开挖'],
    processes: EXC_PROCESSES.map((p) => p.name)
  },
  {
    key: 'support',
    label: '支护循环',
    keywords: ['支护', '锚杆', '锚固', '挂网', '喷护', '喷混凝土', '钢拱架', '格栅'],
    processes: SUP_PROCESSES.map((p) => p.name)
  },
  {
    key: 'grout',
    label: '灌浆',
    keywords: ['灌浆'],
    processes: ['钻孔', '洗孔与压水试验', '埋设灌浆管', '制浆', '灌浆', '封孔', '质量检查']
  },
  {
    key: 'masonry',
    label: '砌筑',
    keywords: ['浆砌石', '干砌石', '砌筑', '砌砖', '砖砌'],
    processes: ['基础清理与验收', '测量放样', '砂浆拌制', '砌筑', '勾缝', '养护', '质量检查']
  },
  {
    key: 'paving',
    label: '路面',
    keywords: ['路面', '路面工程', '基层', '面层'],
    processes: ['路基（基层）整平', '测量放样', '模板安装', '混凝土摊铺', '振捣与抹面', '养护', '切缝（接缝）处理']
  },
  {
    key: 'concrete',
    label: '混凝土',
    keywords: ['混凝土', '衬砌', '浇筑', '垫层', '护坦'],
    processes: [
      '基础面清理与验收',
      '测量放样',
      '钢筋制安',
      '模板（台车）安装',
      '预埋件安装',
      '混凝土浇筑',
      '养护',
      '模板拆除'
    ]
  },
  {
    key: 'metal',
    label: '金属结构与机电',
    keywords: ['闸门', '启闭机', '压力钢管', '锥阀', '金属结构', '机电', '拦污栅', '埋件'],
    processes: ['到场验收', '基础（埋件）复测', '吊装就位', '找正固定', '焊接（连接）', '防腐处理', '调试试运行']
  },
  {
    key: 'filling',
    label: '填筑与回填',
    keywords: ['填筑', '回填', '土石方回填', '抛填'],
    processes: ['基础清理与验收', '测量放样', '分层填筑', '洒水碾压', '压实度检测', '边坡修整']
  },
  {
    key: 'open-excavation',
    label: '土石方开挖',
    // 不要放"剥离"——"表土剥离"归环水保，不归开挖
    keywords: ['开挖', '清基'],
    processes: ['测量放样', '表层清理', '分层开挖', '装车运输', '边坡修整', '基础面验收', '弃渣整理']
  },
  {
    key: 'drainage',
    label: '排水',
    keywords: ['排水沟', '截水沟', '排水管', '盲沟', '集水井'],
    processes: ['沟槽开挖', '基础清理与验收', '沟身砌筑（浇筑）', '抹面与养护', '盖板安装', '通水检查']
  },
  {
    key: 'slope',
    label: '边坡防护',
    keywords: ['边坡防护', '护坡', '挡土墙', '挡墙', '护脚', '防护网', '钢筋石笼', '网格梁', '喷播'],
    processes: [
      '坡面清理',
      '测量放样',
      '基础开挖',
      '锚杆（插筋）施工',
      '钢筋（格栅）制安',
      '模板安装',
      '混凝土浇筑（砌筑）',
      '养护与检查'
    ]
  },
  {
    key: 'env',
    label: '环水保与场平',
    keywords: ['表土剥离', '环水保', '绿化', '植被', '复垦', '场地平整'],
    processes: ['表土剥离', '表土堆放', '场地清理', '覆土回填', '平整与绿化', '验收']
  },
  {
    key: 'other',
    label: '通用',
    keywords: [],
    processes: ['施工准备', '测量放样', '作业施工', '质量检查与验收']
  }
]

const RULE_BY_KEY = new Map(CATEGORY_RULES.map((r) => [r.key, r]))

export function ruleOf(key: ProcessCategory): CategoryRule {
  return RULE_BY_KEY.get(key) ?? RULE_BY_KEY.get('other')!
}

/** 按名称（含部位）与说明文字判断属于哪一类项目划分；识别不出时归入 other */
export function classifyItem(name: string, note?: string): CategoryRule {
  const text = `${name} ${note ?? ''}`
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (text.includes(kw)) return rule
    }
  }
  return ruleOf('other')
}

/**
 * 分项工程的"骨架名"：去掉末尾的部位括号。
 * 模板里分项名统一是 `名称（部位）`，部位本身可能再带括号（如"导流洞1#施工支洞（DZ1#封堵段）"），
 * 所以取第一个"（"之前的部分最稳妥。
 */
export function itemBaseName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || !trimmed.endsWith('）')) return trimmed
  const cut = trimmed.indexOf('（')
  if (cut <= 0) return trimmed
  return trimmed.slice(0, cut).trim() || trimmed
}

/** 记忆键：同一类项目划分 + 同一分项骨架名，才算"同类分项" */
export function memoryKey(name: string, note?: string): string {
  return `${classifyItem(name, note).key}::${itemBaseName(name)}`
}

export interface ProcessMemoryEntry {
  name: string
  /** 被添加过几次，多的排前面 */
  count: number
  lastAt: number
}

/** 记忆表：key -> 手工添加过的工序。存在本机 kv 里，不参与云同步 */
export type ProcessMemory = Record<string, ProcessMemoryEntry[]>

/** 记住"这个分项手工加过这道工序"；返回新的普通对象（不能把 Vue 响应式代理写进 IndexedDB） */
export function rememberProcess(
  memory: ProcessMemory,
  itemName: string,
  processName: string,
  note?: string,
  now = Date.now()
): ProcessMemory {
  const key = memoryKey(itemName, note)
  const name = processName.trim()
  if (!name) return memory
  const list = memory[key] ?? []
  const hit = list.find((e) => e.name === name)
  const next: ProcessMemoryEntry[] = hit
    ? list.map((e) => (e.name === name ? { name, count: e.count + 1, lastAt: now } : { ...e }))
    : [...list.map((e) => ({ ...e })), { name, count: 1, lastAt: now }]
  // 常加的在前面，其次看最近一次
  next.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
  const out: ProcessMemory = {}
  for (const [k, v] of Object.entries(memory)) out[k] = v.map((e) => ({ ...e }))
  out[key] = next
  return out
}

/** 取某分项的记忆推荐（不排序去重，交给 recommendProcesses 统一处理） */
export function memoryFor(memory: ProcessMemory, itemName: string, note?: string): string[] {
  const list = memory[memoryKey(itemName, note)] ?? []
  return [...list].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).map((e) => e.name)
}

export interface RecommendInput {
  itemName: string
  note?: string
  /** 该分项下已有的工序名 */
  existing?: string[]
  memory?: ProcessMemory
  /** 记忆 + 内置推荐合计最多几条（已有工序不占名额） */
  limit?: number
}

export interface RecommendResult {
  category: ProcessCategory
  label: string
  /** 该分项已有工序 */
  existing: string[]
  /** 记忆推荐（该分项还没有的） */
  learned: string[]
  /** 内置规则推荐（该分项还没有、也没在记忆里的） */
  preset: string[]
}

/** 默认上限要装得下最长的内置工序集（支护循环 10 道），否则会把标准循环截断 */
const DEFAULT_LIMIT = 12

/** 合并三个来源，按 已有 → 记忆 → 内置规则 的顺序去重 */
export function recommendProcesses(input: RecommendInput): RecommendResult {
  const rule = classifyItem(input.itemName, input.note)
  const existing = dedupe(input.existing ?? [])
  const taken = new Set(existing)
  const limit = input.limit ?? DEFAULT_LIMIT

  const learnedAll: string[] = []
  for (const name of input.memory ? memoryFor(input.memory, input.itemName, input.note) : []) {
    if (taken.has(name)) continue
    taken.add(name)
    learnedAll.push(name)
  }

  const presetAll: string[] = []
  for (const name of rule.processes) {
    if (taken.has(name)) continue
    taken.add(name)
    presetAll.push(name)
  }

  const learned = learnedAll.slice(0, limit)
  return {
    category: rule.key,
    label: rule.label,
    existing,
    learned,
    preset: presetAll.slice(0, Math.max(0, limit - learned.length))
  }
}

function dedupe(names: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
