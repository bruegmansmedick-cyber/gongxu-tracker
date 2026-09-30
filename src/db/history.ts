/**
 * 三份循环作业 Word 记录解析出的历史数据（由 scripts/parse_loop_logs.py 生成）。
 * 随项目创建一并补录，记录 id 由项目 id 推导，因此重复补录不会产生重复数据。
 */
import historyData from '@/db/data/loop-history.json'
import { HISTORY_FACES, type FaceKey } from '@/db/seed'
import type { ProcessRecord } from '@/types'
import { buildTimeFields } from '@/core/compute'

export interface HistoryRow {
  face: FaceKey
  key: string
  date: string
  startTime: string
  endTime: string
  crossMidnight: boolean
  hours: number
  location: string
  reason: string | null
  abnormal?: boolean
  note: string
}

export const HISTORY_ROWS = (historyData.records ?? []) as HistoryRow[]
export const HISTORY_GENERATED_AT = String(historyData.generatedAt ?? '')

/** 历史补录数据的固定时间戳：保证每台手机生成的内容完全一致，便于合并 */
export const HISTORY_TS = Date.parse('2026-09-30T20:00:00+08:00')
export const HISTORY_OPERATOR_ID = 'op-history'
export const HISTORY_OPERATOR_NAME = '历史补录'

/** 历史记录用的工序 id（与套用模板时创建的工序 id 保持一致） */
export function historyProcessId(projectId: string, face: FaceKey, processKey: string): string {
  const f = HISTORY_FACES[face]
  const itemKey = processKey.startsWith('s-') ? f.supItem : f.excItem
  return `prc-${projectId}-${itemKey}--${processKey}`
}

export function historyRecordId(projectId: string, index: number): string {
  return `rec-his-${projectId}-${index}`
}

export function buildHistoryRecords(projectId: string): ProcessRecord[] {
  return HISTORY_ROWS.map((row, index) => {
    const times = buildTimeFields(row.date, row.startTime, row.endTime)
    const noteParts: string[] = ['补录']
    if (row.abnormal) noteParts.push('原记录时长异常，可能是笔误')
    if (row.note) noteParts.push(row.note)
    return {
      id: historyRecordId(projectId, index),
      projectId,
      processId: historyProcessId(projectId, row.face, row.key),
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      ...times,
      location: row.location || undefined,
      gapReason: row.reason ?? 'none',
      note: noteParts.join('：'),
      operatorId: HISTORY_OPERATOR_ID,
      operatorName: HISTORY_OPERATOR_NAME,
      deviceId: 'history',
      createdAt: HISTORY_TS,
      updatedAt: HISTORY_TS
    } satisfies ProcessRecord
  })
}

export function historyRecordIds(projectId: string): string[] {
  return HISTORY_ROWS.map((_row, index) => historyRecordId(projectId, index))
}

/** 按工作面统计历史条数，用于界面提示 */
export function historyCountByFace(): Array<{ face: FaceKey; label: string; count: number }> {
  return (Object.keys(HISTORY_FACES) as FaceKey[]).map((face) => ({
    face,
    label: HISTORY_FACES[face].label,
    count: HISTORY_ROWS.filter((r) => r.face === face).length
  }))
}
