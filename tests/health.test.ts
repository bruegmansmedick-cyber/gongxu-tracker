import { describe, expect, it } from 'vitest'
import { buildTimeFields } from '@/core/compute'
import { checkBeforeSave, scanHealth } from '@/core/health'
import { diffOf } from '@/db/audit'
import type { Process, ProcessRecord, WbsNode } from '@/types'

const wbs: WbsNode[] = [
  { id: 'u1', projectId: 'p', parentId: null, level: 1, name: '导流洞', sort: 1, updatedAt: 1 },
  { id: 'd1', projectId: 'p', parentId: 'u1', level: 2, name: '洞身段', sort: 1, updatedAt: 1 },
  { id: 'i1', projectId: 'p', parentId: 'd1', level: 3, name: '土石方洞挖（导流洞1#施工支洞）', sort: 1, updatedAt: 1 }
]
const processes: Process[] = [
  { id: 'pa', projectId: 'p', itemId: 'i1', name: '钻孔', sort: 1, standardHours: 3, enabled: 1, updatedAt: 1 },
  { id: 'pb', projectId: 'p', itemId: 'i1', name: '出渣', sort: 2, standardHours: 2, enabled: 1, updatedAt: 1 }
]
const wbsById = new Map(wbs.map((w) => [w.id, w]))
const processById = new Map(processes.map((p) => [p.id, p]))

function rec(id: string, processId: string, date: string, start: string, end: string, quantity?: number): ProcessRecord {
  const t = buildTimeFields(date, start, end)
  return {
    id,
    projectId: 'p',
    processId,
    date,
    startTime: start,
    endTime: end,
    ...t,
    quantity,
    operatorId: 'o',
    operatorName: '张三',
    deviceId: 'd',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('数据体检', () => {
  it('单条用时过长 / 过短 / 有量无时间', () => {
    const rows = [
      rec('r1', 'pa', '2026-10-01', '08:00', '23:00'), // 15h
      rec('r2', 'pa', '2026-10-02', '08:00', '08:02'), // 2min
      rec('r3', 'pb', '2026-10-03', '08:00', '08:01', 120) // 1min 且有工程量
    ]
    const rules = scanHealth(rows, processById, wbsById).map((i) => i.rule)
    expect(rules).toContain('too-long')
    expect(rules).toContain('too-short')
    expect(rules).toContain('qty-without-time')
  })

  it('同一天同一工作面合计超过 24 小时会被挑出来', () => {
    const rows = [
      rec('r1', 'pa', '2026-10-01', '00:00', '12:00'),
      rec('r2', 'pb', '2026-10-01', '12:00', '23:59'),
      rec('r3', 'pa', '2026-10-01', '08:00', '11:00') // 再叠 3h
    ]
    const issues = scanHealth(rows, processById, wbsById)
    expect(issues.some((i) => i.rule === 'day-over-24')).toBe(true)
  })

  it('识别时间重叠与间隔过长', () => {
    const rows = [
      rec('r1', 'pa', '2026-10-01', '08:00', '12:00'),
      rec('r2', 'pb', '2026-10-01', '11:00', '14:00'), // 与上一条重叠 1h
      rec('r3', 'pa', '2026-10-02', '21:00', '23:00') // 与 14:00 隔 7h
    ]
    const rules = scanHealth(rows, processById, wbsById).map((i) => i.rule)
    expect(rules).toContain('overlap')
    expect(rules).toContain('big-gap')
  })

  it('识别重复录入', () => {
    const rows = [
      rec('r1', 'pa', '2026-10-01', '08:00', '12:00'),
      rec('r2', 'pa', '2026-10-01', '08:00', '12:00')
    ]
    expect(scanHealth(rows, processById, wbsById).some((i) => i.rule === 'duplicate')).toBe(true)
  })

  it('干净数据不报问题', () => {
    const rows = [
      rec('r1', 'pa', '2026-10-01', '08:00', '11:00'),
      rec('r2', 'pb', '2026-10-01', '11:30', '13:30')
    ]
    expect(scanHealth(rows, processById, wbsById)).toHaveLength(0)
  })
})

describe('保存前提醒', () => {
  const existing = [
    rec('r1', 'pa', '2026-10-01', '08:00', '12:00'),
    rec('r2', 'pb', '2026-10-01', '14:00', '16:00')
  ]

  it('与上一条重叠会提醒', () => {
    const draft = { processId: 'pb', date: '2026-10-01', ...buildTimeFields('2026-10-01', '11:00', '13:00') }
    expect(checkBeforeSave(draft, existing, processById).join()).toContain('重叠')
  })

  it('间隔超过 6 小时会提醒可能漏填', () => {
    const draft = { processId: 'pb', date: '2026-10-01', ...buildTimeFields('2026-10-01', '23:00', '23:30') }
    expect(checkBeforeSave(draft, existing, processById).join()).toContain('漏填')
  })

  it('完全重复会提醒', () => {
    const draft = { processId: 'pa', date: '2026-10-01', ...buildTimeFields('2026-10-01', '08:00', '12:00') }
    expect(checkBeforeSave(draft, existing, processById).join()).toContain('重复录入')
  })

  it('正常记录不提醒', () => {
    const draft = { processId: 'pb', date: '2026-10-01', ...buildTimeFields('2026-10-01', '16:30', '18:00') }
    expect(checkBeforeSave(draft, existing, processById)).toHaveLength(0)
  })
})

describe('留痕字段差异', () => {
  it('只记录变化的字段，并转成可读文本', () => {
    const before = { startTime: '08:00', endTime: '12:00', note: '' }
    const after = { startTime: '08:30', endTime: '12:00', note: '' }
    const changes = diffOf(before, after, ['startTime', 'endTime', 'note'])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ field: 'startTime', from: '08:00', to: '08:30' })
  })

  it('空值显示为（空）', () => {
    expect(diffOf({ note: 'abc' }, { note: '' }, ['note'])[0].to).toBe('（空）')
  })
})
