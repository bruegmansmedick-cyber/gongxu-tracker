import { describe, expect, it } from 'vitest'
import { formatChainage, mergeChainages, parseChainage, parseChainageRange } from '@/core/chainage'

describe('桩号解析', () => {
  it('单点桩号支持 K 前缀、小数和空格', () => {
    expect(parseChainage('0+413')).toBe(413)
    expect(parseChainage('K0+413')).toBe(413)
    expect(parseChainage(' k1+050.5 ')).toBe(1050.5)
    expect(parseChainage('0+033.7')).toBe(33.7)
  })

  it('米换算回桩号', () => {
    expect(formatChainage(413)).toBe('0+413')
    expect(formatChainage(33.7)).toBe('0+033.7')
    expect(formatChainage(1050.5)).toBe('1+050.5')
  })
})

describe('区间规范化与合并', () => {
  it('全角波浪号、短横线、K 前缀都统一成 0+413~0+438', () => {
    expect(parseChainageRange('K0+413～0+438')?.text).toBe('0+413~0+438')
    expect(parseChainageRange('0+413-0+438')?.text).toBe('0+413~0+438')
    expect(parseChainageRange('0+413 至 K0+438')?.text).toBe('0+413~0+438')
  })

  it('反向或非法区间返回 null', () => {
    expect(parseChainageRange('0+438~0+413')).toBeNull()
    expect(parseChainageRange('左侧边坡')).toBeNull()
    expect(parseChainageRange('')).toBeNull()
  })

  it('多个区间合并时重叠不重复计长度', () => {
    const merged = mergeChainages(['0+459~0+462', 'K0+460~0+464', '0+466~0+470', '', '乱写'])
    expect(merged.ranges).toEqual(['0+459~0+464', '0+466~0+470'])
    expect(merged.lengthM).toBeCloseTo(9, 3)
  })

  it('没有有效桩号时返回空区间和 0 米', () => {
    expect(mergeChainages(['', null, undefined])).toEqual({ ranges: [], lengthM: 0 })
  })
})
