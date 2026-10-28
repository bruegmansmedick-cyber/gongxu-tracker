import { describe, expect, it } from 'vitest'
import { filterStandardHoursRows, type StandardHoursFilterRow } from '@/core/standardFilter'

const rows: StandardHoursFilterRow[] = [
  {
    unitId: 'u1',
    unitName: '导流洞',
    divisionId: 'd1',
    divisionName: '洞身段',
    itemId: 'i1',
    itemName: '1#支洞开挖',
    processName: '装药爆破'
  },
  {
    unitId: 'u1',
    unitName: '导流洞',
    divisionId: 'd1',
    divisionName: '洞身段',
    itemId: 'i2',
    itemName: '通风洞支护',
    processName: '喷护'
  },
  {
    unitId: 'u2',
    unitName: '闸室',
    divisionId: 'd2',
    divisionName: '交通洞',
    itemId: 'i3',
    itemName: '闸室交通洞开挖',
    processName: '钻孔'
  }
]

function filter(patch: Partial<{ query: string; unitId: string; divisionId: string; itemId: string }> = {}) {
  return { query: '', unitId: '', divisionId: '', itemId: '', ...patch }
}

describe('标准用时搜索与范围筛选', () => {
  it('按单位、分部、分项逐级收窄', () => {
    expect(filterStandardHoursRows(rows, filter({ unitId: 'u1' }))).toHaveLength(2)
    expect(filterStandardHoursRows(rows, filter({ unitId: 'u1', divisionId: 'd1' }))).toHaveLength(2)
    expect(filterStandardHoursRows(rows, filter({ itemId: 'i2' }))[0].processName).toBe('喷护')
  })

  it('搜索覆盖工序和各级工程名称，并忽略空格', () => {
    expect(filterStandardHoursRows(rows, filter({ query: '喷 护' }))).toHaveLength(1)
    expect(filterStandardHoursRows(rows, filter({ query: '导流洞' }))).toHaveLength(2)
    expect(filterStandardHoursRows(rows, filter({ query: '闸室交通洞' }))[0].itemId).toBe('i3')
  })

  it('范围与搜索可以叠加', () => {
    expect(filterStandardHoursRows(rows, filter({ unitId: 'u1', query: '开挖' }))[0].itemId).toBe('i1')
    expect(filterStandardHoursRows(rows, filter({ unitId: 'u2', query: '喷护' }))).toHaveLength(0)
  })
})
