import { describe, expect, it } from 'vitest'
import {
  BENCH_PROJECT_ID,
  BENCH_TEMPLATE,
  EXC_PROCESSES,
  HISTORY_FACES,
  SUP_PROCESSES,
  faceOfItem,
  refHoursOf
} from '@/db/seed'
import { HISTORY_ROWS, buildHistoryRecords, historyProcessId } from '@/db/history'
import { computeStats } from '@/core/compute'
import { mergeSyncable } from '@/sync/merge'
import type { Process, ProcessRecord } from '@/types'

function flattenItems() {
  const out: Array<{ unit: string; division: string; key: string; name: string; note?: string; processes: number }> = []
  BENCH_TEMPLATE.forEach((unit) =>
    unit.divisions.forEach((div) =>
      div.items.forEach((item) =>
        out.push({
          unit: unit.name,
          division: div.name,
          key: item.key,
          name: item.name,
          note: item.note,
          processes: item.processes.length
        })
      )
    )
  )
  return out
}

describe('本标段项目划分模板', () => {
  it('包含项目划分里的 10 个单位工程', () => {
    expect(BENCH_TEMPLATE).toHaveLength(10)
    expect(BENCH_TEMPLATE.map((u) => u.name)).toEqual([
      '导流洞',
      '临时生态放水洞',
      '泄洪放空洞',
      '左岸消能防护区',
      '场地平整',
      '左岸1#转存场环水保工程',
      '左岸3#转存场环水保工程',
      '场平区环水保工程',
      '通风兼安全洞B段',
      '进厂交通洞'
    ])
  })

  it('分项工程名 = 单元工程（部位），并带桩号与单元划分原则', () => {
    const items = flattenItems()
    expect(items.find((i) => i.key === 'dld-zd-exc')?.name).toBe('土石方洞挖（导流洞主洞）')
    expect(items.find((i) => i.key === 'dld-zd-exc')?.note).toBe('导0+000~0+866.3 · 12m/单元')
    expect(items.find((i) => i.key === 'tf-zd-sup')?.name).toBe('支护工程（通风兼安全洞主洞）')
  })

  it('只有三个工作面配了循环作业工序，其余单元工程只建结构', () => {
    const items = flattenItems().filter((i) => i.processes > 0)
    expect(items).toHaveLength(6)
    expect(items.map((i) => i.key).sort()).toEqual([
      'dld-1zd-exc',
      'dld-1zd-sup',
      'dld-zst-exc',
      'dld-zst-sup',
      'tf-zd-exc',
      'tf-zd-sup'
    ])
  })

  it('开挖循环 9 道、支护循环 10 道工序，且每个工作面共用同一套', () => {
    expect(EXC_PROCESSES.map((p) => p.name)).toEqual([
      '测量放样（爆破孔）',
      '钻孔（爆破孔）',
      '爆破孔验收',
      '装药爆破',
      '通风散烟',
      '出渣',
      '扒渣排险',
      '超前地质预报',
      '洞内辅助作业（排水 / 清理）'
    ])
    expect(SUP_PROCESSES).toHaveLength(10)
    const items = flattenItems()
    expect(items.find((i) => i.key === 'tf-zd-exc')?.processes).toBe(9)
    expect(items.find((i) => i.key === 'tf-zd-sup')?.processes).toBe(10)
  })

  it('工作面与分项工程能互相反查', () => {
    expect(faceOfItem('dld-1zd-exc')).toBe('zd1')
    expect(faceOfItem('tf-zd-sup')).toBe('tf')
    expect(faceOfItem('dld-zst-exc')).toBe('zs')
    expect(faceOfItem('dld-zd-exc')).toBeNull()
    expect(HISTORY_FACES.tf.label).toBe('通风兼安全洞')
  })
})

describe('实测参考用时', () => {
  it('样本足够时给出中位数与区间', () => {
    const ref = refHoursOf('zd1', 'm-survey')
    expect(ref).toBeDefined()
    expect(ref!.hours).toBeCloseTo(0.67, 2)
    expect(ref!.samples).toBeGreaterThanOrEqual(5)
    expect(ref!.min).toBeLessThanOrEqual(ref!.hours)
    expect(ref!.max).toBeGreaterThanOrEqual(ref!.hours)
  })

  it('样本不足 5 次的工序不给参考值', () => {
    // 闸室交通洞记录只有 17 条，所有工序样本都不足
    expect(refHoursOf('zs', 'm-blast')).toBeUndefined()
    expect(refHoursOf('zd1', 'm-geo')).toBeUndefined()
  })
})

describe('历史记录补录', () => {
  it('三份记录共 209 条，且全部能对应到工序', () => {
    expect(HISTORY_ROWS).toHaveLength(209)
    const keys = new Set(HISTORY_ROWS.map((r) => `${r.face}|${r.key}`))
    keys.forEach((k) => {
      const [face, key] = k.split('|')
      const f = HISTORY_FACES[face as keyof typeof HISTORY_FACES]
      expect(f).toBeDefined()
      expect([...EXC_PROCESSES, ...SUP_PROCESSES].some((p) => p.key === key)).toBe(true)
    })
  })

  it('生成的记录 id 与工序 id 都由项目 id 推导，重复补录不会重复', () => {
    const a = buildHistoryRecords('prj-1')
    const b = buildHistoryRecords('prj-1')
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id))
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length)
    expect(a[0].processId).toBe(historyProcessId('prj-1', HISTORY_ROWS[0].face, HISTORY_ROWS[0].key))
  })

  it('跨零点、等待原因、部位都带过来了', () => {
    const rows = buildHistoryRecords('prj-1')
    const cross = rows.filter((r) => r.endAt - r.startAt > 0 && r.startTime > r.endTime)
    expect(cross.length).toBeGreaterThan(10)
    const withReason = rows.filter((r) => r.gapReason && r.gapReason !== 'none')
    expect(withReason.length).toBeGreaterThanOrEqual(30)
    expect(rows.some((r) => (r.location ?? '').includes('+'))).toBe(true)
    expect(rows.every((r) => r.operatorName === '历史补录')).toBe(true)
  })

  it('两台手机各自补录后合并，不会出现两份记录（固定项目 id）', () => {
    const phoneA = buildHistoryRecords(BENCH_PROJECT_ID)
    const phoneB = buildHistoryRecords(BENCH_PROJECT_ID)
    expect(phoneA.map((r) => r.id)).toEqual(phoneB.map((r) => r.id))
    const merged = mergeSyncable(phoneA, phoneB)
    expect(merged.rows).toHaveLength(HISTORY_ROWS.length)
    // 内容完全一致，双方都不需要再推送
    expect(merged.localDiffers).toBe(false)
    expect(merged.remoteDiffers).toBe(false)
  })

  it('历史记录带不出效率（标准用时未填），但实际工时与空隙照常统计', () => {
    const records = buildHistoryRecords('prj-1')
    // 用模板造出与历史记录对应的工序表（id 规则与套用模板时一致）
    const processes: Process[] = []
    BENCH_TEMPLATE.forEach((unit) =>
      unit.divisions.forEach((div) =>
        div.items.forEach((item) => {
          const face = faceOfItem(item.key)
          if (!face) return
          item.processes.forEach((p) =>
            processes.push({
              id: historyProcessId('prj-1', face, p.key),
              projectId: 'prj-1',
              itemId: `wbs-prj-1-${item.key}`,
              name: p.name,
              sort: 1,
              enabled: 1,
              updatedAt: 0
            })
          )
        })
      )
    )
    const processById = new Map(processes.map((p) => [p.id, p]))
    const stats = computeStats(records as ProcessRecord[], processById, '2026-09-16', '2026-09-30')
    expect(stats.recordCount).toBe(209)
    expect(stats.actualHours).toBeGreaterThan(300)
    expect(stats.standardHours).toBe(0)
    expect(stats.totalEfficiency).toBeNull()
    expect(stats.gapHours).toBeGreaterThan(0)
  })
})
