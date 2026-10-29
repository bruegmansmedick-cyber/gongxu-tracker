import { describe, expect, it } from 'vitest'
import { GAP_REASONS, MAX_CUSTOM_REASONS, mergeCustomReasons, reasonColor, reasonLabel } from '@/core/reasons'
import { aggregateByReason, type GapRow } from '@/core/compute'

function gap(reason: string, hours = 1): GapRow {
  return {
    recordId: `r-${reason}`,
    prevRecordId: 'prev',
    date: '2026-09-20',
    processId: 'p1',
    processName: '装药爆破',
    prevProcessName: '钻孔',
    itemId: 'i1',
    location: '',
    chainage: '',
    gapHours: hours,
    reason
  }
}

describe('自定义等待原因', () => {
  it('排除内置原因、空值和超长文字，并去重', () => {
    const saved = ['等监理旁站', 'other', '其他原因', 'none', '', '  等设计变更  ', '等监理旁站']
    const rows = mergeCustomReasons(saved, ['等爆破审批', '等监理旁站', 'x'.repeat(21)])
    expect(rows).toEqual(['等监理旁站', '等设计变更', '等爆破审批'])
  })

  it('本机记住的排在前面，且有数量上限', () => {
    const many = Array.from({ length: MAX_CUSTOM_REASONS + 5 }, (_, i) => `自定义原因${i}`)
    const rows = mergeCustomReasons(many)
    expect(rows).toHaveLength(MAX_CUSTOM_REASONS)
    expect(rows[0]).toBe('自定义原因0')
    const mixed = mergeCustomReasons(['先记的'], ['记录里的'])
    expect(mixed).toEqual(['先记的', '记录里的'])
  })

  it('自定义原因按原文显示，颜色稳定', () => {
    expect(reasonLabel('等监理旁站')).toBe('等监理旁站')
    expect(reasonLabel('unknown')).toBe('未填写原因')
    expect(reasonLabel('')).toBe('未填写')
    expect(reasonColor('等监理旁站')).toBe(reasonColor('等监理旁站'))
    expect(reasonColor('none')).toBe(GAP_REASONS[0].color)
  })

  it('空隙原因分布里，自定义原因用原文当标签（不再显示"未填写原因"）', () => {
    const rows = aggregateByReason([gap('等监理旁站', 1.5), gap('machine', 2)])
    const custom = rows.find((r) => r.key === '等监理旁站')
    expect(custom?.label).toBe('等监理旁站')
    expect(custom?.hours).toBe(1.5)
    expect(rows.find((r) => r.key === 'machine')?.label).toBe('等机械到位')
    expect(rows[0].key).toBe('machine')
  })
})
