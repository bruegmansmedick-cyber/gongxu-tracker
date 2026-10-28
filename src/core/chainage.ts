/**
 * 桩号解析与区间合并。
 *
 * 现场写法很杂：K0+413、0+413、K0+413～K0+438、0+413-0+438。
 * 统一成 `0+413~0+438`（去掉 K），并换算成米，供支护工作量与每米用时使用。
 * 纯函数，无法识别时返回 null，不猜。
 */

export interface ChainageRange {
  /** 起始里程（米） */
  startM: number
  /** 结束里程（米） */
  endM: number
  /** 规范化后的文本，如 0+413~0+438 */
  text: string
}

/** 解析单个桩号，如 K1+050.5 → 1050.5 */
export function parseChainage(value: string): number | null {
  const s = String(value ?? '')
    .trim()
    .replace(/[kK]/g, '')
    .replace(/\s+/g, '')
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

/** 解析一段桩号；单点也接受（长度为 0），端点为负/反向时返回 null */
export function parseChainageRange(value: string | null | undefined): ChainageRange | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const parts = s.split(/\s*(?:~|～|至|—|－|-)\s*/)
  if (parts.length === 1) {
    const one = parseChainage(parts[0])
    if (one === null) return null
    return { startM: one, endM: one, text: formatChainage(one) }
  }
  if (parts.length !== 2) return null
  const a = parseChainage(parts[0])
  const b = parseChainage(parts[1])
  if (a === null || b === null || b < a) return null
  return { startM: a, endM: b, text: a === b ? formatChainage(a) : `${formatChainage(a)}~${formatChainage(b)}` }
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
