/** 公共类型定义。所有实体都带 updatedAt 与软删除标记，用于多设备合并。 */

/** YYYY-MM-DD */
export type ISODate = string
/** HH:mm */
export type HHMM = string

export interface Syncable {
  id: string
  updatedAt: number
  deletedAt?: number
}

/** 项目（标段 / 工区） */
export interface Project extends Syncable {
  name: string
  code?: string
  archived: 0 | 1
  createdAt: number
}

export type WbsLevel = 1 | 2 | 3

/** 单位工程(1) / 分部工程(2) / 分项工程(3) */
export interface WbsNode extends Syncable {
  projectId: string
  parentId: string | null
  level: WbsLevel
  name: string
  sort: number
  unit?: string
  designQty?: number
  /** 部位（桩号）与单元工程划分原则等说明 */
  note?: string
}

/** 工序，挂在分项工程下 */
export interface Process extends Syncable {
  projectId: string
  itemId: string
  name: string
  sort: number
  unit?: string
  /** 设计工程量 */
  designQty?: number
  /** 标准用时（小时） */
  standardHours?: number
  /** 实测参考用时（小时，历史记录中位数），只作参考，不参与效率计算 */
  refHours?: number
  /** 参考用时的样本次数 */
  refSamples?: number
  refMin?: number
  refMax?: number
  enabled: 0 | 1
}

/** 一条工序用时记录 */
export interface ProcessRecord extends Syncable {
  projectId: string
  processId: string
  /** 施工日期，按自然日归属 */
  date: ISODate
  startTime: HHMM
  endTime: HHMM
  /** 由 date+startTime 推出的时间戳 */
  startAt: number
  /** 跨零点时自动 +1 天 */
  endAt: number
  /** 净用时（小时），由起止时刻算出 */
  hours: number
  quantity?: number
  /** 本工序开工前等待的原因标签 key */
  gapReason?: string
  /** 部位 / 桩号，填写后衔接空隙按部位分别计算 */
  location?: string
  note?: string
  operatorId: string
  operatorName: string
  deviceId: string
  createdAt: number
}

export interface Operator extends Syncable {
  name: string
  shift: string
}

export interface KvRow {
  key: string
  value: unknown
}

/** 云端 catalog.json 的结构 */
export interface CatalogPayload {
  updatedAt: number
  projects: Project[]
  wbs: WbsNode[]
  processes: Process[]
  operators: Operator[]
}

/** 云端 records-YYYY-MM.json 的结构 */
export interface RecordsPayload {
  month: string
  updatedAt: number
  records: ProcessRecord[]
}

export interface MetaPayload {
  schemaVersion: number
  updatedAt: number
  deviceId?: string
}
