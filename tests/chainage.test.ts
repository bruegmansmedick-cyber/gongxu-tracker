import { describe, expect, it } from 'vitest'
import {
  chainageOverlaps,
  formatChainage,
  formatChainageShort,
  mergeChainages,
  parseChainage,
  parseChainageRange,
  recommendNextChainage,
  recordChainage,
  shortChainageText
} from '@/core/chainage'

describe('桩号解析', () => {
  it('单点桩号支持 K 前缀、小数和空格', () => {
    expect(parseChainage('0+413')).toBe(413)
    expect(parseChainage('K0+413')).toBe(413)
    expect(parseChainage(' k1+050.5 ')).toBe(1050.5)
    expect(parseChainage('0+033.7')).toBe(33.7)
    expect(parseChainage('545')).toBe(545)
    expect(parseChainage('548.5')).toBe(548.5)
  })

  it('米换算回桩号', () => {
    expect(formatChainage(413)).toBe('0+413')
    expect(formatChainage(33.7)).toBe('0+033.7')
    expect(formatChainage(1050.5)).toBe('1+050.5')
    expect(formatChainageShort(74)).toBe('74')
    expect(formatChainageShort(33.7)).toBe('33.7')
    expect(formatChainageShort(1050.5)).toBe('1+050.5')
  })
})

describe('区间规范化与合并', () => {
  it('全角波浪号、短横线、K 前缀都统一成 0+413~0+438', () => {
    expect(parseChainageRange('K0+413～0+438')?.text).toBe('0+413~0+438')
    expect(parseChainageRange('0+413-0+438')?.text).toBe('0+413~0+438')
    expect(parseChainageRange('0+413 至 K0+438')?.text).toBe('0+413~0+438')
    expect(parseChainageRange('545-548')?.text).toBe('0+545~0+548')
    expect(parseChainageRange('545~548')?.shortText).toBe('545-548')
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

describe('桩号兼容、筛选与下一段推荐', () => {
  it('新字段优先，旧 location 能解析时继续使用', () => {
    expect(recordChainage({ chainage: '548-551', location: '0+545~0+548' })).toBe('548-551')
    expect(recordChainage({ location: 'K0+545~0+548' })).toBe('K0+545~0+548')
    expect(recordChainage({ location: '左侧边坡' })).toBe('')
  })

  it('短桩号显示去掉 0+，不能识别的历史部位原样保留', () => {
    expect(shortChainageText('0+074~0+077')).toBe('74-77')
    expect(shortChainageText('545-548')).toBe('545-548')
    expect(shortChainageText('左侧边坡')).toBe('左侧边坡')
  })

  it('筛选桩号时按区间交集匹配', () => {
    expect(chainageOverlaps('545-548', '547-551')).toBe(true)
    expect(chainageOverlaps('0+545~0+548', '548')).toBe(true)
    expect(chainageOverlaps('545-548', '549-551')).toBe(false)
    expect(chainageOverlaps('', '545-548')).toBe(false)
  })

  it('从本段终点加米数得到下一段', () => {
    expect(recommendNextChainage('545-548', 3)?.shortText).toBe('548-551')
    expect(recommendNextChainage('0+074~0+077', 3)?.text).toBe('0+077~0+080')
    expect(recommendNextChainage('545-548', 0)).toBeNull()
  })
})
