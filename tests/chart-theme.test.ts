import { describe, expect, it } from 'vitest'
import type { EChartsOption } from 'echarts'
import { MOBILE_TOOLTIP, withMobileTooltip } from '@/core/chartTheme'

describe('手机端 tooltip 约束', () => {
  it('单个 tooltip：强制限制在框内，并保留原来的 formatter', () => {
    const formatter = (p: unknown) => String(p)
    const option = withMobileTooltip({ tooltip: { trigger: 'axis', formatter } } as EChartsOption)
    const tip = option.tooltip as Record<string, unknown>
    expect(tip.confine).toBe(true)
    expect(tip.trigger).toBe('axis')
    expect(tip.formatter).toBe(formatter)
    expect(String(tip.extraCssText)).toContain('max-width: 78vw')
    expect(String(tip.extraCssText)).toContain('word-break')
  })

  it('原来的 extraCssText 会被保留，不会被覆盖掉', () => {
    const option = withMobileTooltip({
      tooltip: { extraCssText: 'border-radius:8px' }
    } as EChartsOption)
    const tip = option.tooltip as Record<string, unknown>
    expect(String(tip.extraCssText)).toContain('border-radius:8px')
    expect(String(tip.extraCssText)).toContain('max-width: 78vw')
  })

  it('数组写法（多 tooltip）每个都合并', () => {
    const option = withMobileTooltip({
      tooltip: [{ trigger: 'axis' }, { trigger: 'item' }]
    } as unknown as EChartsOption)
    const tips = option.tooltip as Array<Record<string, unknown>>
    expect(tips).toHaveLength(2)
    expect(tips.every((t) => t.confine === true)).toBe(true)
    expect(tips.map((t) => t.trigger)).toEqual(['axis', 'item'])
  })

  it('各图自己的字号优先，没有 tooltip 的 option 原样返回', () => {
    const option = withMobileTooltip({ tooltip: { textStyle: { fontSize: 14 } } } as EChartsOption)
    expect((option.tooltip as Record<string, unknown>).textStyle).toMatchObject({ fontSize: 14 })
    expect(MOBILE_TOOLTIP.textStyle.fontSize).toBe(12)
    const plain = { series: [] } as unknown as EChartsOption
    expect(withMobileTooltip(plain)).toBe(plain)
  })
})
