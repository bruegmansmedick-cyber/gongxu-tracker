import { describe, expect, it } from 'vitest'
import {
  buildItemWorkfaceMap,
  canMergeWorkfaces,
  chainageKey,
  chainageOptionLabel,
  hash32,
  normalizeWorkfaceName,
  outerBracketText,
  planWorkfaceInit,
  resolveWorkface,
  stripNestedBrackets,
  workfaceIdOf,
  workfaceNameOf,
  workfacesOfCatalog
} from '@/core/workface'
import type { WbsNode, Workface } from '@/types'

const wbs = (id: string, level: 1 | 2 | 3, parentId: string | null, name: string, sort = 1): WbsNode => ({
  id,
  projectId: 'prj',
  parentId,
  level,
  name,
  sort,
  updatedAt: 1
})

const units = [wbs('u1', 1, null, '导流洞'), wbs('u2', 1, null, '通风兼安全洞B段', 2)]
const divisions = [
  wbs('d1', 2, 'u1', '洞身段'),
  wbs('d2', 2, 'u1', '灌浆工程', 2),
  wbs('d3', 2, 'u2', '洞身段')
]
const items = [
  wbs('i1', 3, 'd1', '土石方洞挖（导流洞1#施工支洞）'),
  wbs('i2', 3, 'd1', '支护工程（导流洞1#施工支洞）', 2),
  wbs('i3', 3, 'd1', '土石方洞挖（导流洞2#施工支洞）', 3),
  wbs('i4', 3, 'd2', '封堵混凝土（导流洞1#施工支洞（DZ1#封堵段））', 1),
  wbs('i5', 3, 'd3', '土石方洞挖（通风兼安全洞主洞）', 1)
]

function plan(workfaces: Workface[] = [], now = 1000) {
  return planWorkfaceInit({ projectId: 'prj', units, divisions, items, workfaces, now })
}

describe('分项名称解析', () => {
  it('取最外层括号，嵌套括号只留洞室层', () => {
    expect(outerBracketText('土石方洞挖（导流洞1#施工支洞）')).toBe('导流洞1#施工支洞')
    expect(outerBracketText('封堵混凝土（导流洞1#施工支洞（DZ1#封堵段））')).toBe(
      '导流洞1#施工支洞（DZ1#封堵段）'
    )
    expect(outerBracketText('没有括号')).toBe('')
    expect(stripNestedBrackets('导流洞1#施工支洞（DZ1#封堵段）')).toBe('导流洞1#施工支洞')
  })

  it('括号里的部位名压成工作面短名', () => {
    expect(workfaceNameOf('土石方洞挖（导流洞1#施工支洞）', '导流洞')).toBe('1#支洞')
    expect(workfaceNameOf('封堵混凝土（导流洞1#施工支洞（DZ1#封堵段））', '导流洞')).toBe('1#支洞')
    expect(workfaceNameOf('支护工程（导流洞2#施工支洞（DZ2#封堵段））', '导流洞')).toBe('2#支洞')
    // 编号是通配的，以后新开 3# / 4# 支洞不用改代码
    expect(workfaceNameOf('土石方洞挖（导流洞3#施工支洞）', '导流洞')).toBe('3#支洞')
    expect(workfaceNameOf('土石方洞挖（通风兼安全洞主洞）', '通风兼安全洞B段')).toBe('通风洞')
    expect(workfaceNameOf('混凝土衬砌（进厂交通洞主洞）', '进厂交通洞')).toBe('进厂交通洞')
    expect(workfaceNameOf('洞脸开挖（洞口（洞脸边坡））', '进厂交通洞')).toBe('洞口')
  })

  it('没有部位括号时退回单位工程名，不猜', () => {
    expect(workfaceNameOf('土石方开挖', '左岸消能防护区')).toBe('左岸消能防护区')
    expect(normalizeWorkfaceName('  导流洞闸室交通洞 ')).toBe('闸室交通洞')
    expect(normalizeWorkfaceName('')).toBe('')
  })
})

describe('稳定 ID', () => {
  it('同一项目 + 单位工程 + 名称，任何设备算出来都一样', () => {
    const a = workfaceIdOf('prj', 'u1', '1#支洞')
    const b = workfaceIdOf('prj', 'u1', '1#支洞')
    expect(a).toBe(b)
    expect(a).toBe(`wf-prj-${hash32('u1|1#支洞')}`)
  })

  it('单位工程不同或名称不同就是两个工作面', () => {
    expect(workfaceIdOf('prj', 'u1', '洞口')).not.toBe(workfaceIdOf('prj', 'u2', '洞口'))
    expect(workfaceIdOf('prj', 'u1', '1#支洞')).not.toBe(workfaceIdOf('prj', 'u1', '2#支洞'))
  })
})

describe('工作面初始化', () => {
  it('按单位工程 + 分项名称自动建并绑定，嵌套括号归到同一个洞室', () => {
    const result = plan()
    const names = result.create.map((w) => w.name).sort()
    expect(names).toEqual(['1#支洞', '2#支洞', '通风洞'])
    // i1 / i2 / i4 都是 1#支洞
    const bindIds = new Set(result.bind.map((b) => b.workfaceId))
    expect(bindIds.size).toBe(3)
    expect(result.bind).toHaveLength(5)
    const first = result.create.find((w) => w.name === '1#支洞')!
    expect(result.bind.filter((b) => b.workfaceId === first.id).map((b) => b.itemId).sort()).toEqual([
      'i1',
      'i2',
      'i4'
    ])
  })

  it('重复初始化幂等：不新建、不改绑', () => {
    const first = plan()
    const bound = items.map((item) => ({
      ...item,
      workfaceId: first.bind.find((b) => b.itemId === item.id)?.workfaceId
    }))
    const second = planWorkfaceInit({
      projectId: 'prj',
      units,
      divisions,
      items: bound,
      workfaces: first.create,
      now: 2000
    })
    expect(second.create).toHaveLength(0)
    expect(second.bind).toHaveLength(0)
    expect(second.revive).toHaveLength(0)
  })

  it('两台设备各自初始化，ID 相同，合并后不会出现两份', () => {
    const phoneA = plan([], 1000)
    const phoneB = plan([], 2000)
    const idsA = phoneA.create.map((w) => w.id).sort()
    const idsB = phoneB.create.map((w) => w.id).sort()
    expect(idsA).toEqual(idsB)
  })

  it('人工改名后重跑初始化，不会按旧名再建一个', () => {
    const first = plan()
    const renamed = first.create.map((w) => (w.name === '1#支洞' ? { ...w, name: '一号支洞', updatedAt: 3000 } : w))
    const bound = items.map((item) => ({
      ...item,
      workfaceId: first.bind.find((b) => b.itemId === item.id)?.workfaceId
    }))
    const second = planWorkfaceInit({
      projectId: 'prj',
      units,
      divisions,
      items: bound,
      workfaces: renamed,
      now: 4000
    })
    expect(second.create).toHaveLength(0)
    expect(second.bind).toHaveLength(0)
  })

  it('人工重绑保持不动，不会被名称解析抢回去', () => {
    const first = plan()
    const target = first.create.find((w) => w.name === '2#支洞')!
    const rebindItems = items.map((item) => ({
      ...item,
      workfaceId: item.id === 'i1' ? target.id : first.bind.find((b) => b.itemId === item.id)?.workfaceId
    }))
    const second = planWorkfaceInit({
      projectId: 'prj',
      units,
      divisions,
      items: rebindItems,
      workfaces: first.create,
      now: 5000
    })
    expect(second.bind).toHaveLength(0)
  })

  it('分项还没绑定时，优先复用同单位同名工作面', () => {
    const existing: Workface[] = [
      {
        id: 'wf-manual',
        projectId: 'prj',
        unitId: 'u1',
        name: '1#支洞',
        sort: 1,
        updatedAt: 1
      }
    ]
    const result = plan(existing)
    const bind101 = result.bind.filter((b) => b.workfaceId === 'wf-manual')
    expect(bind101.map((b) => b.itemId).sort()).toEqual(['i1', 'i2', 'i4'])
    expect(result.create.some((w) => w.name === '1#支洞')).toBe(false)
  })

  it('软删除且没有合并去向时复用原行，不产生 -2 碎片', () => {
    const first = plan()
    const wf1 = first.create.find((w) => w.name === '1#支洞')!
    const deleted: Workface[] = [{ ...wf1, deletedAt: 9999, updatedAt: 9999 }]
    const other = first.create.filter((w) => w.id !== wf1.id)
    const result = plan([...deleted, ...other])
    expect(result.revive).toEqual([wf1.id])
    expect(result.create).toHaveLength(0)
    expect(result.bind.filter((b) => b.workfaceId === wf1.id).map((b) => b.itemId).sort()).toEqual([
      'i1',
      'i2',
      'i4'
    ])
  })

  it('软删除且已合并到别的工作面时，直接把绑定指向目标', () => {
    const first = plan()
    const wf1 = first.create.find((w) => w.name === '1#支洞')!
    const wf2 = first.create.find((w) => w.name === '2#支洞')!
    const merged: Workface[] = first.create.map((w) =>
      w.id === wf1.id ? { ...w, deletedAt: 9999, mergedInto: wf2.id, updatedAt: 9999 } : w
    )
    const result = plan(merged)
    const boundToWf2 = result.bind.filter((b) => b.workfaceId === wf2.id).map((b) => b.itemId)
    expect(boundToWf2.sort()).toEqual(['i1', 'i2', 'i3', 'i4'])
    expect(result.revive).toHaveLength(0)
  })
})

describe('绑定解析', () => {
  it('顺着 mergedInto 找到有效工作面', () => {
    const byId = new Map<string, Workface>([
      ['a', { id: 'a', projectId: 'p', unitId: 'u', name: 'A', sort: 1, deletedAt: 2, mergedInto: 'b', updatedAt: 2 }],
      ['b', { id: 'b', projectId: 'p', unitId: 'u', name: 'B', sort: 2, deletedAt: 3, mergedInto: 'c', updatedAt: 3 }],
      ['c', { id: 'c', projectId: 'p', unitId: 'u', name: 'C', sort: 3, updatedAt: 3 }]
    ])
    expect(resolveWorkface('a', byId)?.id).toBe('c')
    expect(resolveWorkface('missing', byId)).toBeUndefined()
  })

  it('旧数据没有 workfaceId 时按名称回退（1#支洞 与 封堵段归到一起）', () => {
    const faces: Workface[] = [
      { id: 'wf-a', projectId: 'prj', unitId: 'u1', name: '1#支洞', sort: 1, updatedAt: 1 }
    ]
    const legacy = items.map((item) => ({ ...item }))
    const map = buildItemWorkfaceMap([...units, ...divisions, ...legacy], faces)
    expect(map.get('i1')).toBe('wf-a')
    expect(map.get('i2')).toBe('wf-a')
    expect(map.get('i4')).toBe('wf-a')
    expect(map.get('i3')).toBeUndefined()
    expect(map.get('i5')).toBeUndefined()
  })
})

describe('桩号身份与旧目录兼容', () => {
  it('桩号 key 带上工作面，标签是「工作面 · 短桩号」', () => {
    expect(chainageKey('wf1', '0+005')).not.toBe(chainageKey('wf2', '0+005'))
    expect(chainageOptionLabel('1#支洞', '0-5')).toBe('1#支洞 · 0-5')
    expect(chainageOptionLabel('2#支洞', '0-5')).toBe('2#支洞 · 0-5')
    expect(chainageOptionLabel('', '0-5')).toBe('0-5')
  })

  it('旧云端目录 / 旧备份没有 workfaces 字段时按空数组处理', () => {
    expect(workfacesOfCatalog(null)).toEqual([])
    expect(workfacesOfCatalog({})).toEqual([])
    expect(workfacesOfCatalog({ workfaces: 'bad' })).toEqual([])
    expect(workfacesOfCatalog({ workfaces: [{ id: 'wf1', name: '1#支洞' }] })).toHaveLength(1)
    expect(workfacesOfCatalog({ workfaces: [null, { noId: 1 }, { id: 'wf2' }] })).toHaveLength(1)
  })
})

describe('工作面合并的前置校验', () => {
  const base = (over: Partial<Workface> = {}): Workface => ({
    id: 'a',
    projectId: 'prj',
    unitId: 'u1',
    name: '1#支洞',
    sort: 1,
    updatedAt: 1,
    ...over
  })

  it('同项目同单位工程、都未删除才能合并', () => {
    expect(canMergeWorkfaces(base(), base({ id: 'b', name: '2#支洞' }))).toBe(true)
  })

  it('跨单位工程、跨项目、自己合并自己、任一方已删除都拒绝', () => {
    expect(canMergeWorkfaces(base(), base({ id: 'b', unitId: 'u2' }))).toBe(false)
    expect(canMergeWorkfaces(base(), base({ id: 'b', projectId: 'other' }))).toBe(false)
    expect(canMergeWorkfaces(base(), base())).toBe(false)
    expect(canMergeWorkfaces(base({ deletedAt: 9 }), base({ id: 'b' }))).toBe(false)
    expect(canMergeWorkfaces(base(), base({ id: 'b', deletedAt: 9 }))).toBe(false)
    expect(canMergeWorkfaces(undefined, base())).toBe(false)
  })
})
