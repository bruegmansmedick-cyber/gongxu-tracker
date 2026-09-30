import { describe, expect, it } from 'vitest'
import { buildXlsx } from '@/utils/xlsx'

describe('XLSX 生成', () => {
  it('生成的文件是合法的 zip 容器（PK 头）', async () => {
    const blob = buildXlsx([
      {
        name: '记录明细',
        freezeHeader: true,
        rows: [
          ['日期', '工序', '用时(h)'],
          ['2026-09-30', '钻孔', 4],
          ['2026-09-30', '注浆 & 封孔', 3.5]
        ]
      }
    ])
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const buf = new Uint8Array(await blob.arrayBuffer())
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    expect(buf.length).toBeGreaterThan(300)
  })
})
