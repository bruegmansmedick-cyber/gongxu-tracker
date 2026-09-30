import type { HHMM, ISODate } from '@/types'

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function fmtDate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function todayStr(): ISODate {
  return fmtDate(new Date())
}

export function nowHhmm(): HHMM {
  const d = new Date()
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 解析成当天 00:00 的本地时间戳 */
export function parseDate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map((v) => Number(v))
  return new Date(y, (m || 1) - 1, d || 1)
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return fmtDate(d)
}

/** 周一为一周的开始 */
export function startOfWeek(s: ISODate): ISODate {
  const d = parseDate(s)
  const dow = d.getDay() === 0 ? 7 : d.getDay()
  d.setDate(d.getDate() - (dow - 1))
  return fmtDate(d)
}

export function endOfWeek(s: ISODate): ISODate {
  return addDays(startOfWeek(s), 6)
}

export function startOfMonth(s: ISODate): ISODate {
  return `${s.slice(0, 7)}-01`
}

export function endOfMonth(s: ISODate): ISODate {
  const d = parseDate(startOfMonth(s))
  d.setMonth(d.getMonth() + 1)
  d.setDate(0)
  return fmtDate(d)
}

/** YYYY-MM */
export function monthKey(s: ISODate): string {
  return s.slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map((v) => Number(v))
  const d = new Date(y, (m || 1) - 1 + n, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

export function listDates(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = []
  let cur = from
  let guard = 0
  while (cur <= to && guard < 5000) {
    out.push(cur)
    cur = addDays(cur, 1)
    guard += 1
  }
  return out
}

export function hhmmToMinutes(h: HHMM): number {
  const [a, b] = h.split(':').map((v) => Number(v))
  return (a || 0) * 60 + (b || 0)
}

export function minutesToHhmm(m: number): HHMM {
  const v = ((m % 1440) + 1440) % 1440
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`
}

/** 小时数转 "8小时30分" */
export function fmtHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '0小时'
  const totalMin = Math.round(h * 60)
  const hh = Math.floor(totalMin / 60)
  const mm = totalMin % 60
  if (hh === 0) return `${mm}分`
  if (mm === 0) return `${hh}小时`
  return `${hh}小时${mm}分`
}

/** 小时数转 "8.5h" */
export function fmtHoursShort(h: number, digits = 1): string {
  if (!Number.isFinite(h)) return '-'
  return `${h.toFixed(digits)}h`
}

export function fmtPercent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const pct = v * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(digits)}%`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekdayLabel(s: ISODate): string {
  return WEEKDAYS[parseDate(s).getDay()]
}

export function friendlyDate(s: ISODate): string {
  return `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日 ${weekdayLabel(s)}`
}

export function rangeLabel(from: ISODate, to: ISODate): string {
  if (from === to) return friendlyDate(from)
  return `${from.slice(0, 7).replace('-', '/')} 起 ${from.slice(8)} 日 — ${to.slice(5).replace('-', '/')}`
}
