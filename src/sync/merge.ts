import type { Syncable } from '@/types'

export interface MergeResult<T> {
  rows: T[]
  /** 合并结果和远端不一致 -> 需要推送 */
  remoteDiffers: boolean
  /** 合并结果和本地不一致 -> 需要写回本地 */
  localDiffers: boolean
  remoteMissing: number
}

/** 同一 id 以 updatedAt 新者为准；时间戳相同则删除操作优先，避免记录被"复活" */
export function pickWinner<T extends Syncable>(a: T, b: T): T {
  if (a.updatedAt > b.updatedAt) return a
  if (b.updatedAt > a.updatedAt) return b
  const aDel = a.deletedAt ? 1 : 0
  const bDel = b.deletedAt ? 1 : 0
  if (aDel !== bDel) return aDel > bDel ? a : b
  return a
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function mergeSyncable<T extends Syncable>(local: T[], remote: T[]): MergeResult<T> {
  const localMap = new Map(local.map((r) => [r.id, r]))
  const remoteMap = new Map(remote.map((r) => [r.id, r]))
  const ids = new Set<string>([...localMap.keys(), ...remoteMap.keys()])
  const rows: T[] = []
  let remoteDiffers = false
  let localDiffers = false
  let remoteMissing = 0

  ids.forEach((id) => {
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    let winner: T
    if (l && r) winner = pickWinner(l, r)
    else if (l) {
      winner = l
      remoteMissing += 1
      remoteDiffers = true
    } else {
      winner = r as T
    }

    rows.push(winner)
    if (!r || !same(winner, r)) remoteDiffers = true
    if (!l || !same(winner, l)) localDiffers = true
  })

  return { rows, remoteDiffers, localDiffers, remoteMissing }
}

/** 记录按 startAt 排序后再比较，避免同一份数据因顺序不同被判定为"有变化" */
export function normalizeForCompare<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
