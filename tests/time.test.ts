import { describe, expect, it } from 'vitest'
import { addDays, addMonths, endOfMonth, endOfWeek, fmtHours, listDates, monthKey, startOfMonth, startOfWeek } from '@/core/time'
import { monthPeriods, weekPeriods } from '@/core/compute'

describe('周与月的边界', () => {
  it('周一为一周的第一天', () => {
    expect(startOfWeek('2026-09-30')).toBe('2026-09-28')
    expect(endOfWeek('2026-09-30')).toBe('2026-10-04')
    expect(startOfWeek('2026-10-04')).toBe('2026-09-28')
  })

  it('月份首末日与跨年计算正确', () => {
    expect(startOfMonth('2026-09-30')).toBe('2026-09-01')
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(monthKey('2026-09-30')).toBe('2026-09')
  })

  it('日期加减与区间列举', () => {
    expect(addDays('2026-09-30', 2)).toBe('2026-10-02')
    expect(listDates('2026-09-29', '2026-10-01')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'])
  })
})

describe('趋势周期', () => {
  it('周周期连续且覆盖 12 周', () => {
    const weeks = weekPeriods('2026-09-30', 12)
    expect(weeks).toHaveLength(12)
    expect(weeks[11].to).toBe('2026-10-04')
    expect(weeks[0].from).toBe('2026-07-13')
  })

  it('月周期按自然月切分', () => {
    const months = monthPeriods('2026-10', 3)
    expect(months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(months[2].to).toBe('2026-10-31')
  })
})

describe('工时格式化', () => {
  it('按中文习惯显示', () => {
    expect(fmtHours(8.5)).toBe('8小时30分')
    expect(fmtHours(0.5)).toBe('30分')
    expect(fmtHours(0)).toBe('0小时')
  })
})
