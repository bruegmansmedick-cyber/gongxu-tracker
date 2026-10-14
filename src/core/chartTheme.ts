/**
 * 图表在手机上的统一约束。
 *
 * ECharts 默认把 tooltip 摆在触点旁边，手指靠近屏幕边缘时会有一半跑到屏幕外、
 * 看起来"被边框隔断"。这里统一收紧：限制在图表容器内 + 允许换行 + 字号降到手机上能读的大小。
 * 各图自己的 formatter / trigger 保持不变，只在渲染前合并这几项。
 */
import type { EChartsOption } from 'echarts'

export const MOBILE_TOOLTIP = {
  confine: true,
  textStyle: { fontSize: 12 },
  extraCssText: 'max-width: 78vw; white-space: normal; word-break: break-word; line-height: 1.5;'
} as const

type TooltipConfig = Record<string, unknown>

function mergeOne(tip: TooltipConfig): TooltipConfig {
  const own = typeof tip.extraCssText === 'string' && tip.extraCssText.trim() ? `${tip.extraCssText};` : ''
  const textStyle = (tip.textStyle ?? {}) as Record<string, unknown>
  return {
    ...MOBILE_TOOLTIP,
    ...tip,
    // 这两项强制生效：宁可贴着边，也不要出框
    confine: true,
    textStyle: { ...MOBILE_TOOLTIP.textStyle, ...textStyle },
    extraCssText: `${own}${MOBILE_TOOLTIP.extraCssText}`
  }
}

/** 给 option 里所有 tooltip（单个或数组）合并手机端约束；没有 tooltip 的原样返回 */
export function withMobileTooltip<T extends EChartsOption>(option: T): T {
  const raw = (option as Record<string, unknown>).tooltip
  if (!raw) return option
  const tooltip = Array.isArray(raw) ? raw.map((one) => mergeOne(one as TooltipConfig)) : mergeOne(raw as TooltipConfig)
  return { ...(option as Record<string, unknown>), tooltip } as unknown as T
}
