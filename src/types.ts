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
  /** 所属工作面；分项工程（level=3）才有，缺省时按名称自动推导 */
  workfaceId?: string
}

/**
 * 工作面：同一个洞室 / 部位（如"1#支洞"）下的开挖、支护等分项工程归到一起。
 * 记录不直接挂在工作上，仍通过分项工程间接归属，历史数据不需要批量改写。
 */
export interface Workface extends Syncable {
  projectId: string
  /** 所属单位工程（WbsNode level=1） */
  unitId: string
  /** 工作面短名，如 "1#支洞" */
  name: string
  sort: number
  /** 自动初始化时的来源说明（分项名称解析口径），便于排查 */
  source?: string
  /** 被合并到哪个工作面；软删除后仍可用于把旧绑定迁过去 */
  mergedInto?: string
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
  /** 本工序开工前等待的实际起止时刻；与 gapEndTime 成对填写 */
  gapStartTime?: HHMM
  gapEndTime?: HHMM
  /** 人工填写的等待时长（小时）；用于避免只靠前后工序时差推算 */
  gapHours?: number
  /** 桩号；新记录独立填写，缺省时兼容读取 location 中可解析的旧桩号 */
  chainage?: string
  /** 部位补充说明（历史数据里也可能存放桩号） */
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
  /** 工作面；旧版云端目录没有这个字段，读取后由本地按名称幂等补建 */
  workfaces?: Workface[]
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
