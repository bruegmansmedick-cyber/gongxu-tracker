export interface StandardHoursFilter {
  query: string
  unitId: string
  divisionId: string
  itemId: string
}

export interface StandardHoursFilterRow {
  unitId: string
  unitName: string
  divisionId: string
  divisionName: string
  itemId: string
  itemName: string
  processName: string
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
}

/**
 * 标准用时列表的范围与搜索筛选。
 * 层级选择与首页一致：单位 → 分部 → 分项，上一级为空时不限制下一级。
 */
export function matchesStandardHoursFilter(
  row: StandardHoursFilterRow,
  filter: StandardHoursFilter
): boolean {
  if (filter.unitId && row.unitId !== filter.unitId) return false
  if (filter.divisionId && row.divisionId !== filter.divisionId) return false
  if (filter.itemId && row.itemId !== filter.itemId) return false
  const query = normalizeQuery(filter.query)
  if (!query) return true
  const text = normalizeQuery(
    [row.unitName, row.divisionName, row.itemName, row.processName].join('')
  )
  return text.includes(query)
}

export function filterStandardHoursRows<T extends StandardHoursFilterRow>(
  rows: T[],
  filter: StandardHoursFilter
): T[] {
  return rows.filter((row) => matchesStandardHoursFilter(row, filter))
}
