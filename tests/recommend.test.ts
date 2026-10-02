import { describe, expect, it } from 'vitest'
import {
  CATEGORY_RULES,
  classifyItem,
  itemBaseName,
  memoryFor,
  recommendProcesses,
  rememberProcess,
  ruleOf
} from '@/core/recommend'
import { BENCH_TEMPLATE, EXC_PROCESSES, SUP_PROCESSES } from '@/db/seed'

/** 模板里全部分项工程的显示名（与套用模板时写进库的一致） */
function templateItemNames(): string[] {
  const names: string[] = []
  BENCH_TEMPLATE.forEach((unit) =>
    unit.divisions.forEach((div) =>
      div.items.forEach((item) => {
        names.push(item.name)
      })
    )
  )
  return names
}

describe('项目划分归类', () => {
  it('洞挖不会被当成明挖，明挖也不会被当成洞挖', () => {
    expect(classifyItem('土石方洞挖', '导流洞主洞').key).toBe('tunnel-excavation')
    expect(classifyItem('土石方洞挖（闸室竖井）').key).toBe('tunnel-excavation')
    expect(classifyItem('土石方开挖', '导流洞进口').key).toBe('open-excavation')
    expect(classifyItem('洞脸开挖（洞口（洞脸边坡））').key).toBe('open-excavation')
  })

  it('砌筑、混凝土、回填、路面互不串味', () => {
    expect(classifyItem('浆砌石排水沟（左岸1#转存场）').key).toBe('masonry')
    expect(classifyItem('干砌石护坡（榆树沟场地平整）').key).toBe('masonry')
    expect(classifyItem('明渠底板混凝土（导流洞进口）').key).toBe('concrete')
    expect(classifyItem('明洞混凝土回填（导流洞进口）').key).toBe('concrete')
    expect(classifyItem('闸门埋件二期混凝土（导流洞闸室段）').key).toBe('concrete')
    expect(classifyItem('土石方回填（左岸1#转存料场）').key).toBe('filling')
    expect(classifyItem('围堰土石方填筑（导流洞出口）').key).toBe('filling')
    expect(classifyItem('一期路面（通风兼安全洞主洞）').key).toBe('paving')
  })

  it('开挖、排水、支护、灌浆、金属结构各归各类', () => {
    // "临时排水沟开挖"要的是开挖工序，但"浆砌石排水沟""临时排水沟混凝土"不能被开挖抢走
    expect(classifyItem('临时排水沟开挖（左岸1#转存场）').key).toBe('open-excavation')
    expect(classifyItem('纵向排水沟（左岸消能防护区）').key).toBe('drainage')
    expect(classifyItem('排水沟（泄洪放空洞出口）').key).toBe('drainage')
    expect(classifyItem('支护工程（通风兼安全洞主洞）').key).toBe('support')
    expect(classifyItem('挂网喷护（左岸消能防护区）').key).toBe('support')
    expect(classifyItem('固结灌浆（导流洞主洞）').key).toBe('grout')
    expect(classifyItem('闸门门体安装（导流洞闸室段）').key).toBe('metal')
    expect(classifyItem('锥阀及压力钢管安装（临时生态放水洞闸室段）').key).toBe('metal')
  })

  it('边坡防护与环水保', () => {
    expect(classifyItem('钢筋石笼护脚（左岸1#转存场）').key).toBe('slope')
    expect(classifyItem('被动防护网（承包商二区场地平整）').key).toBe('slope')
    expect(classifyItem('混凝土挡土墙（左岸1#转存场）').key).toBe('concrete')
    expect(classifyItem('表土剥离（榆树沟）').key).toBe('env')
  })

  it('158 个分项工程全部能归到一类，且每类都有工序可推荐', () => {
    const names = templateItemNames()
    expect(names).toHaveLength(158)
    const uncategorized: string[] = []
    names.forEach((name) => {
      const rule = classifyItem(name)
      expect(rule.processes.length).toBeGreaterThan(0)
      if (rule.key === 'other') uncategorized.push(name)
    })
    // 允许落到"通用"，但不允许出现识别不出的空推荐
    expect(ruleOf('other').processes.length).toBeGreaterThan(0)
    expect(uncategorized.length).toBeLessThanOrEqual(2)
  })

  it('洞挖与支护推荐的就是现有的循环工序', () => {
    const exc = recommendProcesses({ itemName: '土石方洞挖（临时生态放水洞主洞）' })
    expect(exc.category).toBe('tunnel-excavation')
    expect(exc.preset).toEqual(EXC_PROCESSES.map((p) => p.name))
    const sup = recommendProcesses({ itemName: '支护工程（进厂交通洞主洞）' })
    expect(sup.category).toBe('support')
    expect(sup.preset).toEqual(SUP_PROCESSES.map((p) => p.name))
  })
})

describe('分项骨架名与记忆', () => {
  it('去掉部位括号，部位里再带括号也不出错', () => {
    expect(itemBaseName('土石方洞挖（导流洞主洞）')).toBe('土石方洞挖')
    expect(itemBaseName('封堵固结灌浆（导流洞1#施工支洞（DZ1#封堵段））')).toBe('封堵固结灌浆')
    expect(itemBaseName('支护工程')).toBe('支护工程')
  })

  it('记住了手工添加的工序，同类分项下次能推荐出来', () => {
    const first = rememberProcess({}, '土石方洞挖（闸室竖井）', '井口安全防护')
    expect(memoryFor(first, '土石方洞挖（闸室竖井）')).toEqual(['井口安全防护'])
    // 同类（同类型 + 同骨架名）的其他部位也吃得到
    expect(memoryFor(first, '土石方洞挖（尾闸运输洞）')).toEqual(['井口安全防护'])
    // 不同骨架名不受影响
    expect(memoryFor(first, '混凝土衬砌（导流洞主洞）')).toEqual([])
    const again = rememberProcess(first, '土石方洞挖（闸室竖井）', '井口安全防护')
    expect(again['tunnel-excavation::土石方洞挖'][0].count).toBe(2)
  })

  it('记忆不写进来源对象，返回的是新的普通对象', () => {
    const src = rememberProcess({}, '路面工程（导流洞1#施工支洞）', '洒水降尘')
    const next = rememberProcess(src, '路面工程（导流洞1#施工支洞）', '边坡修整')
    expect(Object.keys(src)).toHaveLength(1)
    expect(src['paving::路面工程']).toHaveLength(1)
    expect(next['paving::路面工程']).toHaveLength(2)
  })
})

describe('推荐合并', () => {
  it('按 已有 → 记忆 → 内置规则 排列，且互不重复', () => {
    const memory = rememberProcess({}, '混凝土衬砌（导流洞主洞）', '衬砌台车定位')
    const res = recommendProcesses({
      itemName: '混凝土衬砌（尾闸运输洞）',
      existing: ['测量放样', '钢筋制安'],
      memory
    })
    expect(res.category).toBe('concrete')
    expect(res.existing).toEqual(['测量放样', '钢筋制安'])
    expect(res.learned).toEqual(['衬砌台车定位'])
    expect(res.preset).not.toContain('测量放样')
    expect(res.preset).not.toContain('衬砌台车定位')
    expect(res.preset.length).toBeGreaterThan(0)
  })

  it('推荐条数受 limit 限制，已有的工序不占推荐名额', () => {
    const res = recommendProcesses({
      itemName: '土石方洞挖（主变运输洞）',
      existing: ['出渣'],
      limit: 4
    })
    expect(res.learned).toHaveLength(0)
    expect(res.preset).toHaveLength(4)
    expect(res.preset).not.toContain('出渣')
  })

  it('重复的已有工序名会去重', () => {
    const res = recommendProcesses({ itemName: '排水沟（泄洪放空洞出口）', existing: ['沟槽开挖', '沟槽开挖'] })
    expect(res.existing).toEqual(['沟槽开挖'])
    expect(res.preset).not.toContain('沟槽开挖')
  })

  it('每个类别的通用工序都不少于 4 道，且没有重名', () => {
    CATEGORY_RULES.forEach((rule) => {
      expect(rule.processes.length).toBeGreaterThanOrEqual(4)
      expect(new Set(rule.processes).size).toBe(rule.processes.length)
    })
  })
})
