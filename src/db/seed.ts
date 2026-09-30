/**
 * 本标段项目划分模板
 * 来源：《关于呈报项目划分的申报表（DL-BS（2025）010号）》
 *      滚哈导流洞和和静抽蓄通风兼安全洞及进厂交通洞工程（合同编号 BZFD-GC-02-2025）
 *
 * 层级对应：项目划分的「单位工程 / 分部工程 / 单元（分项）工程 + 部位」
 *          → App 的「单位工程 / 分部工程 / 分项工程」，工序 = 循环作业的每道工序。
 *
 * 参考用时来自 scripts/parse_loop_logs.py 对三份循环作业记录的实测统计（中位数）。
 */
import historyData from '@/db/data/loop-history.json'

export interface TemplateProcess {
  /** 工序编码（同一分项工程内唯一） */
  key: string
  name: string
  unit?: string
  /** 本标段暂不预设标准用时，由现场确认后填写 */
  standardHours?: number
}

export interface TemplateItem {
  key: string
  name: string
  note?: string
  unit?: string
  designQty?: number
  processes: TemplateProcess[]
}

export interface TemplateDivision {
  key: string
  name: string
  items: TemplateItem[]
}

export interface TemplateUnit {
  key: string
  name: string
  divisions: TemplateDivision[]
}

/** 实测参考用时 */
export interface RefHours {
  hours: number
  samples: number
  min: number
  max: number
}

interface StatRow {
  face: string
  key: string
  count: number
  median: number
  min: number
  max: number
  enough: boolean
}

const STATS = (historyData.stats ?? []) as StatRow[]

/** 取某工作面某工序的参考用时（样本不足 5 次的返回 undefined） */
export function refHoursOf(face: string, processKey: string): RefHours | undefined {
  const row = STATS.find((s) => s.face === face && s.key === processKey && s.enough)
  if (!row) return undefined
  return { hours: row.median, samples: row.count, min: row.min, max: row.max }
}

/** 三份历史记录所属的工作面 → 模板里对应的开挖 / 支护分项工程 */
export const HISTORY_FACES = {
  zd1: { label: '1#施工支洞', excItem: 'dld-1zd-exc', supItem: 'dld-1zd-sup' },
  tf: { label: '通风兼安全洞', excItem: 'tf-zd-exc', supItem: 'tf-zd-sup' },
  zs: { label: '闸室交通洞', excItem: 'dld-zst-exc', supItem: 'dld-zst-sup' }
} as const

export type FaceKey = keyof typeof HISTORY_FACES

/** 本标段项目名称（一键建立项目时使用） */
export const BENCH_PROJECT_NAME = '滚哈导流洞和和静抽蓄通风兼安全洞及进厂交通洞工程'

/** 由分项工程 key 反查它属于哪个工作面（历史记录导入用） */
export function faceOfItem(itemKey: string): FaceKey | null {
  const entries = Object.entries(HISTORY_FACES) as Array<[FaceKey, (typeof HISTORY_FACES)[FaceKey]]>
  for (const [face, cfg] of entries) {
    if (cfg.excItem === itemKey || cfg.supItem === itemKey) return face
  }
  return null
}

/** 开挖循环工序 */
export const EXC_PROCESSES: TemplateProcess[] = [
  { key: 'm-survey', name: '测量放样（爆破孔）' },
  { key: 'm-drill', name: '钻孔（爆破孔）' },
  { key: 'm-check', name: '爆破孔验收' },
  { key: 'm-blast', name: '装药爆破' },
  { key: 'm-vent', name: '通风散烟' },
  { key: 'm-muck', name: '出渣' },
  { key: 'm-scale', name: '扒渣排险' },
  { key: 'm-geo', name: '超前地质预报' },
  { key: 'm-other', name: '洞内辅助作业（排水 / 清理）' }
]

/** 支护循环工序 */
export const SUP_PROCESSES: TemplateProcess[] = [
  { key: 's-survey', name: '测量放样（锚杆孔）' },
  { key: 's-drill', name: '锚杆孔钻孔' },
  { key: 's-blow', name: '吹孔' },
  { key: 's-check', name: '锚杆孔验收' },
  { key: 's-rod', name: '锚杆插杆' },
  { key: 's-grout', name: '锚杆注浆' },
  { key: 's-mesh', name: '挂钢筋网' },
  { key: 's-meshcheck', name: '网片验收' },
  { key: 's-shot', name: '喷护' },
  { key: 's-clean', name: '清理回弹料' }
]

/** 分项工程 = 项目划分表里的一行（单元工程 + 部位） */
function it(
  key: string,
  name: string,
  part: string,
  rule = '',
  processes: TemplateProcess[] = [],
  range = ''
): TemplateItem {
  const note = [range, rule].filter(Boolean).join(' · ')
  return {
    key,
    name: part ? `${name}（${part}）` : name,
    note: note || undefined,
    processes
  }
}

export const BENCH_TEMPLATE: TemplateUnit[] = [
  // ---------------------------------------------------------------- 导流洞
  {
    key: 'u-dld',
    name: '导流洞',
    divisions: [
      {
        key: 'dld-kd',
        name: '洞口段',
        items: [
          it('dld-kd-jk-tfkw', '土石方开挖', '导流洞进口', '3m/层一个单元', [], '导0-057.5~0+000'),
          it('dld-kd-jk-bpfh', '边坡防护工程', '导流洞进口', '3m/层一个单元'),
          it('dld-kd-jk-db', '明渠底板混凝土', '导流洞进口', '每个结构缝一单元'),
          it('dld-kd-jk-zb', '明渠左岸贴坡混凝土', '导流洞进口', '每个结构缝一单元'),
          it('dld-kd-jk-yb', '明渠右岸贴坡混凝土', '导流洞进口', '每个结构缝一单元'),
          it('dld-kd-jk-mt', '明洞混凝土', '导流洞进口', '每仓一个单元', [], '导0-004.5~0+000'),
          it('dld-kd-jk-mtht', '明洞混凝土回填', '导流洞进口', '1 个单元'),
          it('dld-kd-ck-tfkw', '土石方开挖', '导流洞出口', '3m/层一个单元', [], '导0+866.3~0+875.79'),
          it('dld-kd-ck-bpfh', '边坡防护工程', '导流洞出口', '3m/层一个单元'),
          it('dld-kd-ck-db', '底板混凝土', '导流洞出口', '1 个单元'),
          it('dld-kd-ck-zdq', '左岸挡土墙', '导流洞出口', '结构缝 / 仓 / 单元'),
          it('dld-kd-ck-ydq', '右岸挡土墙', '导流洞出口', '结构缝 / 仓 / 单元'),
          it('dld-kd-ck-wy', '围堰土石方填筑', '导流洞出口', '每层一个单元'),
          it('dld-kd-2zd-dlkw', '洞脸开挖', '导流洞2#支洞', '3m/层一个单元'),
          it('dld-kd-2zd-dlzh', '洞脸支护', '导流洞2#支洞', '3m/层一个单元'),
          it('dld-kd-2zd-mt', '明洞混凝土', '导流洞2#支洞', '1 个单元')
        ]
      },
      {
        key: 'dld-ss',
        name: '洞身段',
        items: [
          it('dld-zd-exc', '土石方洞挖', '导流洞主洞', '12m/单元', [], '导0+000~0+866.3'),
          it('dld-zd-sup', '支护工程', '导流洞主洞', '12m/单元'),
          it('dld-zd-cl', '混凝土衬砌', '导流洞主洞', '12m/仓/单元', [], '导0+000~0+423、导0+468~0+866.3'),
          it('dld-zd-jb', '渐变段及闸室混凝土', '导流洞主洞', '结构缝 / 仓 / 单元', [], '导0+423~0+468'),
          it('dld-zsjs-exc', '土石方洞挖', '闸室竖井', '1 个单元'),
          it('dld-zsjs-sup', '支护工程', '闸室竖井', '1 个单元'),
          it('dld-1zd-exc', '土石方洞挖', '导流洞1#施工支洞', '12m/单元', EXC_PROCESSES),
          it('dld-1zd-sup', '支护工程', '导流洞1#施工支洞', '12m/单元', SUP_PROCESSES),
          it('dld-1zd-fd', '封堵混凝土', '导流洞1#施工支洞（DZ1#封堵段）', '仓 / 单元'),
          it('dld-2zd-exc', '土石方洞挖', '导流洞2#施工支洞', '12m/单元'),
          it('dld-2zd-sup', '支护工程', '导流洞2#施工支洞', '12m/单元'),
          it('dld-2zd-fd', '封堵混凝土', '导流洞2#施工支洞（DZ2#封堵段）', '仓 / 单元'),
          it('dld-zst-exc', '土石方洞挖', '导流洞闸室交通洞', '12m/单元', EXC_PROCESSES),
          it('dld-zst-sup', '支护工程', '导流洞闸室交通洞', '12m/单元', SUP_PROCESSES)
        ]
      },
      {
        key: 'dld-gj',
        name: '灌浆工程',
        items: [
          it('dld-gj-jk', '导流洞进口预留岩坎灌浆', '导流洞进口', '50 个喷射孔/单元'),
          it('dld-gj-ck', '导流洞出口围堰灌浆', '导流洞出口', '50 个喷射孔/单元'),
          it('dld-gj-ht', '回填灌浆', '导流洞主洞', '50m/单元', [], '导0+000~0+866.3'),
          it('dld-gj-gg', '固结灌浆', '导流洞主洞', '50m/单元'),
          it('dld-gj-jc', '接触灌浆', '导流洞闸室', '每孔/单元'),
          it('dld-gj-1zd-gg', '封堵固结灌浆', '导流洞1#施工支洞（DZ1#封堵段）', '1 个单元'),
          it('dld-gj-1zd-ht', '封堵回填灌浆', '导流洞1#施工支洞（DZ1#封堵段）', '1 个单元'),
          it('dld-gj-2zd-gg', '封堵固结灌浆', '导流洞2#施工支洞（DZ2#封堵段）', '1 个单元'),
          it('dld-gj-2zd-ht', '封堵回填灌浆', '导流洞2#施工支洞（DZ2#封堵段）', '1 个单元')
        ]
      },
      {
        key: 'dld-lm',
        name: '路面工程',
        items: [
          it('dld-lm-1zd', '路面工程', '导流洞1#施工支洞', '每仓一个单元'),
          it('dld-lm-2zd', '路面工程', '导流洞2#施工支洞', '每仓一个单元'),
          it('dld-lm-zst', '路面工程', '导流洞闸室交通洞', '每仓一个单元')
        ]
      },
      {
        key: 'dld-jd',
        name: '机电及金属结构安装',
        items: [
          it('dld-jd-mj', '闸门埋件安装', '导流洞闸室段', '每孔/单元'),
          it('dld-jd-mt', '闸门门体安装', '导流洞闸室段', '每孔/单元'),
          it('dld-jd-qbj', '启闭机设备安装', '导流洞闸室段', '每类别/单元'),
          it('dld-jd-eq', '闸门埋件二期混凝土', '导流洞闸室段', '1 个单元')
        ]
      }
    ]
  },

  // -------------------------------------------------- 临时生态放水洞
  {
    key: 'u-lssl',
    name: '临时生态放水洞',
    divisions: [
      {
        key: 'lssl-ss',
        name: '洞身段',
        items: [
          it('lssl-zst-exc', '土石方洞挖', '临时生态放水洞闸室交通洞', '12m/单元'),
          it('lssl-zst-sup', '支护工程', '临时生态放水洞闸室交通洞', '12m/单元'),
          it('lssl-zd-exc', '土石方洞挖', '临时生态放水洞主洞', '12m/单元', [], '临0+000~临0+202.85'),
          it('lssl-zd-sup', '支护工程', '临时生态放水洞主洞', '12m/单元'),
          it('lssl-zd-yl', '混凝土衬砌', '临时生态放水洞有压段', '12m/单元', [], '临0+000~0+084.21'),
          it('lssl-zd-zs', '混凝土衬砌', '临时生态放水洞闸室段', '结构缝 / 仓 / 单元', [], '临0+084.21~0+141.71'),
          it('lssl-zd-wy', '混凝土衬砌', '临时生态放水洞无压段', '12m/单元', [], '临0+141.71~0+202.85'),
          it('lssl-sj-exc', '土石方洞挖', '锥阀操作室竖井', '1 个单元'),
          it('lssl-sj-sup', '支护工程', '锥阀操作室竖井', '1 个单元')
        ]
      },
      {
        key: 'lssl-lm',
        name: '路面工程',
        items: [it('lssl-lm-zst', '路面工程', '临时生态放水洞闸室交通洞', '每仓一个单元')]
      },
      {
        key: 'lssl-gj',
        name: '灌浆工程',
        items: [
          it('lssl-gj-yl-ht', '回填灌浆', '临时生态放水洞主洞', '50m/单元', [], '临0+000~0+084.21'),
          it('lssl-gj-yl-gg', '固结灌浆', '临时生态放水洞主洞', '50m/单元', [], '临0+000~0+084.21'),
          it('lssl-gj-zs-ht', '回填灌浆', '临时生态放水洞闸室段', '1 个单元', [], '临0+084.21~0+141.71'),
          it('lssl-gj-zs-gg', '固结灌浆', '临时生态放水洞闸室段', '1 个单元', [], '临0+084.21~0+141.71'),
          it('lssl-gj-wy-ht', '回填灌浆', '临时生态放水洞无压段', '50m/单元', [], '临0+141.71~0+202.85'),
          it('lssl-gj-wy-gg', '固结灌浆', '临时生态放水洞无压段', '50m/单元', [], '临0+141.71~0+202.85')
        ]
      },
      {
        key: 'lssl-jg',
        name: '金属结构安装',
        items: [
          it('lssl-jg-zf', '闸阀底座混凝土', '临时生态放水洞闸室段', '1 个单元'),
          it('lssl-jg-ylg', '压力钢管安装', '临时生态放水洞闸室段', '1 个单元'),
          it('lssl-jg-zfylg', '锥阀及压力钢管安装', '临时生态放水洞闸室段', '1 个单元'),
          it('lssl-jg-tc', '压力钢管填充混凝土', '临时生态放水洞闸室段', '1 个单元')
        ]
      }
    ]
  },

  // ------------------------------------------------------ 泄洪放空洞
  {
    key: 'u-xhf',
    name: '泄洪放空洞',
    divisions: [
      {
        key: 'xhf-kd',
        name: '洞口段',
        items: [
          it('xhf-ck-kw', '土石方开挖', '泄洪放空洞出口', '3m/层一个单元', [], '泄0+557.09~0+579.46'),
          it('xhf-ck-zh', '支护工程', '泄洪放空洞出口', '3m/层一个单元'),
          it('xhf-ck-psg', '排水沟', '泄洪放空洞出口', '每条排水沟/单元'),
          it('xhf-ck-jsg', '截水沟', '泄洪放空洞出口', '1 个单元'),
          it('xhf-ck-ht', '护坦混凝土', '泄洪放空洞出口', '结构缝 / 仓 / 单元')
        ]
      }
    ]
  },

  // -------------------------------------------------- 左岸消能防护区
  {
    key: 'u-xn',
    name: '左岸消能防护区',
    divisions: [
      {
        key: 'xn-kw',
        name: '开挖',
        items: [it('xn-kw-tf', '土石方开挖', '左岸消能防护区', '3m/层一个单元')]
      },
      {
        key: 'xn-fh',
        name: '防护工程',
        items: [
          it('xn-fh-gjs', '钢筋石笼护脚', '左岸消能防护区', '每结构缝/单元'),
          it('xn-fh-ks', '块石护脚', '左岸消能防护区', '每结构缝/单元'),
          it('xn-fh-hnt', '混凝土防护', '左岸消能防护区', '结构缝 / 仓 / 单元'),
          it('xn-fh-gwph', '挂网喷护', '左岸消能防护区', '2 个单元'),
          it('xn-fh-zxpsg', '纵向排水沟', '左岸消能防护区', '1 个单元'),
          it('xn-fh-hntmd', '混凝土马道', '左岸消能防护区', '每条马道/单元'),
          it('xn-fh-wgl', '网格梁生态护坡砖', '左岸消能防护区', '每个区/单元')
        ]
      }
    ]
  },

  // -------------------------------------------------------- 场地平整
  {
    key: 'u-cd',
    name: '场地平整',
    divisions: [
      {
        key: 'cd-wl',
        name: '乌拉斯台沟',
        items: [
          it('cd-wl-kw', '挡墙基础开挖', '乌拉斯台沟场地平整', '1 个单元'),
          it('cd-wl-tz', '挡墙基础石渣填筑', '乌拉斯台沟场地平整', '1 个单元'),
          it('cd-wl-jqs', '浆砌石挡土墙', '乌拉斯台沟场地平整', '1 个单元'),
          it('cd-wl-gjs', '钢筋石笼', '乌拉斯台沟场地平整', '1 个单元'),
          it('cd-wl-jqh', '浆砌石护坡', '乌拉斯台沟场地平整', '1 个单元'),
          it('cd-wl-sztz', '场平区石渣填筑', '乌拉斯台沟场地平整', '每层/单元')
        ]
      },
      {
        key: 'cd-ys',
        name: '榆树沟',
        items: [
          it('cd-ys-kw', '挡墙基础开挖', '榆树沟场地平整', '每结构/单元'),
          it('cd-ys-tf', '土石方开挖', '榆树沟场地平整', '1 个单元'),
          it('cd-ys-hnt', '混凝土挡墙', '榆树沟场地平整', '结构缝 / 仓 / 单元'),
          it('cd-ys-gqh', '干砌石护坡', '榆树沟场地平整', '1 个单元'),
          it('cd-ys-jqh', '浆砌石护坡', '榆树沟场地平整', '每结构/单元'),
          it('cd-ys-kstz', '挡墙基础块石填筑', '榆树沟场地平整', '每结构/单元'),
          it('cd-ys-sztz', '石渣填筑', '榆树沟场地平整', '每层/单元')
        ]
      },
      {
        key: 'cd-lj',
        name: '左右岸连接路',
        items: [it('cd-lj-lm', '路面工程', '左右岸连接路', '每仓/单元')]
      },
      {
        key: 'cd-cb',
        name: '承包商二区',
        items: [
          it('cd-cb-kw', '挡墙基础开挖', '承包商二区场地平整', '每结构/单元'),
          it('cd-cb-jqs', '浆砌石挡土墙', '承包商二区场地平整', '每结构/单元'),
          it('cd-cb-jqh', '浆砌石护坡', '承包商二区场地平整', '每结构/单元'),
          it('cd-cb-psg', '浆砌石排水沟', '承包商二区场地平整', '1 个单元'),
          it('cd-cb-bdfh', '被动防护网', '承包商二区场地平整', '1 个单元'),
          it('cd-cb-sztz', '石渣填筑', '承包商二区场地平整', '每层/单元')
        ]
      }
    ]
  },

  // ------------------------------------------ 左岸1#转存场环水保工程
  {
    key: 'u-zc1',
    name: '左岸1#转存场环水保工程',
    divisions: [
      {
        key: 'zc1-ts',
        name: '土石方工程',
        items: [
          it('zc1-ts-kw', '土石方开挖', '左岸1#转存料场'),
          it('zc1-ts-ht', '土石方回填', '左岸1#转存料场')
        ]
      },
      {
        key: 'zc1-fh',
        name: '防护工程',
        items: [
          it('zc1-fh-kw', '挡墙基础开挖', '左岸1#转存场'),
          it('zc1-fh-gjs', '钢筋石笼护脚', '左岸1#转存场', '50m/单元'),
          it('zc1-fh-hnt', '混凝土挡土墙', '左岸1#转存场', '结构缝 / 仓 / 单元'),
          it('zc1-fh-gjsdq', '钢筋石笼挡土墙', '左岸1#转存场', '100m/单元')
        ]
      },
      {
        key: 'zc1-ps',
        name: '排水工程',
        items: [
          it('zc1-ps-jqs', '浆砌石排水沟', '左岸1#转存场', '50m/单元'),
          it('zc1-ps-jqh', '浆砌石护坡', '左岸1#转存场'),
          it('zc1-ps-lskw', '临时排水沟开挖', '左岸1#转存场', '50m/单元'),
          it('zc1-ps-lshnt', '临时排水沟混凝土', '左岸1#转存场', '50m/单元'),
          it('zc1-ps-lsht', '临时排水沟回填', '左岸1#转存料场')
        ]
      }
    ]
  },

  // ------------------------------------------ 左岸3#转存场环水保工程
  {
    key: 'u-zc3',
    name: '左岸3#转存场环水保工程',
    divisions: [
      {
        key: 'zc3-fh',
        name: '防护工程',
        items: [
          it('zc3-fh-gjsdq', '钢筋石笼挡墙', '左岸3#转存料场', '100m/单元'),
          it('zc3-fh-hnt', '混凝土挡土墙', '左岸3#转存料场', '结构缝 / 仓 / 单元'),
          it('zc3-fh-dzt', '袋装土挡土墙', '左岸3#转存料场', '50m/单元')
        ]
      },
      {
        key: 'zc3-ps',
        name: '排水工程',
        items: [
          it('zc3-ps-lskw', '临时排水沟开挖', '左岸3#转存料场', '50m/单元'),
          it('zc3-ps-lshnt', '临时排水沟混凝土', '左岸3#转存料场', '50m/单元'),
          it('zc3-ps-lsht', '临时排水沟回填', '左岸3#转存料场')
        ]
      }
    ]
  },

  // ------------------------------------------------ 场平区环水保工程
  {
    key: 'u-cphb',
    name: '场平区环水保工程',
    divisions: [
      {
        key: 'cphb-tb',
        name: '表土剥离',
        items: [it('cphb-tb-ys', '表土剥离', '榆树沟')]
      }
    ]
  },

  // ------------------------------------------------ 通风兼安全洞B段
  {
    key: 'u-tf',
    name: '通风兼安全洞B段',
    divisions: [
      {
        key: 'tf-ss',
        name: '洞身段',
        items: [
          it('tf-zd-exc', '土石方洞挖', '通风兼安全洞主洞', '12m/单元', EXC_PROCESSES, '通风0+413~1+227.43'),
          it('tf-zd-sup', '支护工程', '通风兼安全洞主洞', '12m/单元', SUP_PROCESSES),
          it('tf-zd-cl', '混凝土衬砌', '通风兼安全洞主洞', '12m/单元'),
          it('tf-zb-exc', '土石方洞挖', '主变通风兼安全洞', '12m/单元', [], '主变通风0+000~0+302.58'),
          it('tf-zb-sup', '支护工程', '主变通风兼安全洞', '12m/单元'),
          it('tf-zb-cl', '混凝土衬砌', '主变通风兼安全洞', '12m/单元'),
          it('tf-wz-exc', '土石方洞挖', '尾闸通风兼安全洞', '12m/单元', [], '尾闸通风0+000~0+265.06'),
          it('tf-wz-sup', '支护工程', '尾闸通风兼安全洞', '12m/单元'),
          it('tf-wz-cl', '混凝土衬砌', '尾闸通风兼安全洞', '12m/单元')
        ]
      },
      {
        key: 'tf-gj',
        name: '灌浆工程',
        items: [
          it('tf-gj-zd', '回填灌浆', '通风兼安全洞主洞', '50m/单元', [], '通风0+413~1+227.43'),
          it('tf-gj-zb', '回填灌浆', '主变通风兼安全洞', '50m/单元', [], '主变通风0+000~0+302.58'),
          it('tf-gj-wz', '回填灌浆', '尾闸通风兼安全洞', '50m/单元', [], '尾闸通风0+000~0+265.06')
        ]
      },
      {
        key: 'tf-lm',
        name: '路面工程',
        items: [
          it('tf-lm-zd-dc', '垫层混凝土', '通风兼安全洞主洞', '一次浇筑长度/单元'),
          it('tf-lm-zd-yq', '一期路面', '通风兼安全洞主洞', '一次浇筑长度/单元'),
          it('tf-lm-zb-dc', '垫层混凝土', '主变通风兼安全洞', '一次浇筑长度/单元'),
          it('tf-lm-zb-yq', '一期路面', '主变通风兼安全洞', '一次浇筑长度/单元'),
          it('tf-lm-wz-dc', '垫层混凝土', '尾闸通风兼安全洞', '一次浇筑长度/单元'),
          it('tf-lm-wz-yq', '一期路面', '尾闸通风兼安全洞', '一次浇筑长度/单元')
        ]
      }
    ]
  },

  // ---------------------------------------------------- 进厂交通洞
  {
    key: 'u-jc',
    name: '进厂交通洞',
    divisions: [
      {
        key: 'jc-kd',
        name: '洞口段',
        items: [
          it('jc-kd-kw', '洞脸开挖', '洞口（洞脸边坡）', '3m/层一个单元'),
          it('jc-kd-fh', '边坡防护', '洞脸边坡', '3m/层一个单元')
        ]
      },
      {
        key: 'jc-ss',
        name: '洞身段',
        items: [
          it('jc-zd-exc', '土石方洞挖', '进厂交通洞主洞', '12m/单元', [], '进厂0+000~0+930.7'),
          it('jc-zd-sup', '支护工程', '进厂交通洞主洞', '12m/单元'),
          it('jc-zd-cl', '混凝土衬砌', '进厂交通洞主洞', '12m/单元'),
          it('jc-zb-exc', '土石方洞挖', '主变运输洞', '12m/单元', [], '主变0+000~0+114.08'),
          it('jc-zb-sup', '支护工程', '主变运输洞', '12m/单元'),
          it('jc-zb-cl', '混凝土衬砌', '主变运输洞', '12m/单元'),
          it('jc-wz-exc', '土石方洞挖', '尾闸运输洞', '12m/单元', [], '尾闸0+000~0+201.28'),
          it('jc-wz-sup', '支护工程', '尾闸运输洞', '12m/单元'),
          it('jc-wz-cl', '混凝土衬砌', '尾闸运输洞', '12m/单元')
        ]
      },
      {
        key: 'jc-gj',
        name: '灌浆工程',
        items: [
          it('jc-gj-zd-ht', '回填灌浆', '进厂交通洞主洞', '50m/单元', [], '进厂0+000~0+930.7'),
          it('jc-gj-zd-gg', '固结灌浆', '进厂交通洞主洞', '50m/单元'),
          it('jc-gj-zb-ht', '回填灌浆', '主变运输洞', '50m/单元', [], '主变0+000~0+114.08'),
          it('jc-gj-zb-gg', '固结灌浆', '主变运输洞', '50m/单元'),
          it('jc-gj-wz-ht', '回填灌浆', '尾闸运输洞', '50m/单元', [], '尾闸0+000~0+201.28'),
          it('jc-gj-wz-gg', '固结灌浆', '尾闸运输洞', '50m/单元')
        ]
      },
      {
        key: 'jc-lm',
        name: '路面工程',
        items: [
          it('jc-lm-zd-dc', '混凝土垫层', '进厂交通洞主洞', '一次浇筑长度/单元'),
          it('jc-lm-zd-yq', '一期路面', '进厂交通洞主洞', '一次浇筑长度/单元'),
          it('jc-lm-zb-dc', '混凝土垫层', '主变运输洞', '一次浇筑长度/单元'),
          it('jc-lm-zb-yq', '一期路面', '主变运输洞', '一次浇筑长度/单元'),
          it('jc-lm-wz-dc', '混凝土垫层', '尾闸运输洞', '一次浇筑长度/单元'),
          it('jc-lm-wz-yq', '一期路面', '尾闸运输洞', '一次浇筑长度/单元')
        ]
      }
    ]
  }
]
