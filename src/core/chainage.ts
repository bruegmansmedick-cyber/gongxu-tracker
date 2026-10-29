/**
 * 桩号解析与区间合并。
 *
 * 现场写法很杂：545-548、K0+413、0+413、K0+413～0+438、0+413-0+438。
 * 完整写法统一成 `0+413~0+438`（去掉 K），短写法显示成 `413-438`，并换算成米。
 * 纯函数，无法识别时返回 null，不猜。
 */
import type { ProcessRecord } from '@/types'

export interface ChainageRange {
  /** 起始里程（米） */
  startM: number
  /** 结束里程（米） */
  endM: number
  /** 规范化后的文本，如 0+413~0+438 */
  text: string
  /** 便于手机端图表显示的短文本，如 413-438 */
  shortText: string
}

/** 解析单个桩号，如 K1+050.5、545 → 1050.5、545 */
export function parseChainage(value: string): number | null {
  const s = String(value ?? '')
    .trim()
    .replace(/[kK]/g, '')
    .replace(/\s+/g, '')
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const meters = Number(s)
    return Number.isFinite(meters) ? meters : null
  }
  const m = /^(\d+)\+(\d+(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  const km = Number(m[1])
  const meter = Number(m[2])
  if (!Number.isFinite(km) || !Number.isFinite(meter) || meter < 0) return null
  return km * 1000 + meter
}

/** 米 → 桩号文本：413 → 0+413；33.7 → 0+033.7 */
export function formatChainage(meters: number): string {
  const km = Math.floor(meters / 1000)
  const rest = Number((meters - km * 1000).toFixed(3))
  const whole = Math.trunc(rest)
  const frac = Number((rest - whole).toFixed(3))
  const mm = String(whole).padStart(3, '0') + (frac > 0 ? `.${String(frac).slice(2).replace(/0+$/, '')}` : '')
  return `${km}+${mm}`
}

/** 米 → 手机端短桩号：413 → 413；33.7 → 33.7；1050.5 → 1+050.5 */
export function formatChainageShort(meters: number): string {
  if (meters < 1000) return String(Number(meters.toFixed(3)))
  return formatChainage(meters)
}

/** 解析一段桩号；单点也接受（长度为 0），端点为负/反向时返回 null */
export function parseChainageRange(value: string | null | undefined): ChainageRange | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const parts = s.split(/\s*(?:~|～|至|—|－|-)\s*/)
  if (parts.length === 1) {
    const one = parseChainage(parts[0])
    if (one === null) return null
    return { startM: one, endM: one, text: formatChainage(one), shortText: formatChainageShort(one) }
  }
  if (parts.length !== 2) return null
  const a = parseChainage(parts[0])
  const b = parseChainage(parts[1])
  if (a === null || b === null || b < a) return null
  return {
    startM: a,
    endM: b,
    text: a === b ? formatChainage(a) : `${formatChainage(a)}~${formatChainage(b)}`,
    shortText: a === b ? formatChainageShort(a) : `${formatChainageShort(a)}-${formatChainageShort(b)}`
  }
}

/** 新字段 chainage 优先；历史数据继续从 location 中识别，不批量改写 */
export function recordChainage(record: Pick<ProcessRecord, 'chainage' | 'location'>): string {
  const own = String(record.chainage ?? '').trim()
  if (own) return own
  const legacy = String(record.location ?? '').trim()
  return parseChainageRange(legacy) ? legacy : ''
}

/** 任意桩号文本的简写；无法识别时原样返回，避免吞掉“左侧边坡”等历史部位 */
export function shortChainageText(value: string | null | undefined): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const parsed = parseChainageRange(raw)
  return parsed?.shortText ?? raw
}

/** 记录桩号是否与筛选桩号有交集；用于查看某一段的全部工序 */
export function chainageOverlaps(
  value: string | null | undefined,
  target: string | null | undefined
): boolean {
  const a = parseChainageRange(value)
  const b = parseChainageRange(target)
  if (!a || !b) return false
  return a.startM <= b.endM + 0.001 && a.endM + 0.001 >= b.startM
}

/** 按本次桩号终点 + 本次米数推荐下一段，如 545-548 + 3m → 548-551 */
export function recommendNextChainage(
  current: string | null | undefined,
  meters: number
): ChainageRange | null {
  const range = parseChainageRange(current)
  if (!range || !Number.isFinite(meters) || meters <= 0) return null
  const start = range.endM
  const end = start + meters
  return {
    startM: start,
    endM: end,
    text: `${formatChainage(start)}~${formatChainage(end)}`,
    shortText: `${formatChainageShort(start)}-${formatChainageShort(end)}`
  }
}

/** 一串桩号文本 → 合并后的区间 + 总长度（重叠/相邻不重复计） */
export function mergeChainages(values: Array<string | null | undefined>): { ranges: string[]; lengthM: number } {
  const parsed = values
    .map((v) => parseChainageRange(v))
    .filter((v): v is ChainageRange => !!v)
    .sort((a, b) => a.startM - b.startM)
  const merged: Array<[number, number]> = []
  parsed.forEach((r) => {
    const last = merged[merged.length - 1]
    if (last && r.startM <= last[1] + 0.001) {
      last[1] = Math.max(last[1], r.endM)
    } else {
      merged.push([r.startM, r.endM])
    }
  })
  return {
    ranges: merged.map(([a, b]) => (a === b ? formatChainage(a) : `${formatChainage(a)}~${formatChainage(b)}`)),
    lengthM: Number(merged.reduce((s, [a, b]) => s + (b - a), 0).toFixed(3))
  }
}
