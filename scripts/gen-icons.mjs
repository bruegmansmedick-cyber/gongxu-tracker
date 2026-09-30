/**
 * 生成 PWA 图标（纯 Node，无第三方依赖）。
 * 图案：深蓝圆角方块 + 白色表盘 + 指针，代表"工序用时"。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public')
mkdirSync(outDir, { recursive: true })

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

function png(width, height, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 距离圆角矩形边界的有符号距离（负数表示在内部） */
function roundedRectDistance(x, y, size, radius, inset) {
  const half = size / 2 - inset
  const dx = Math.abs(x - size / 2) - (half - radius)
  const dy = Math.abs(y - size / 2) - (half - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius
}

function render(size, opts = {}) {
  const { maskable = false } = opts
  const px = Buffer.alloc(size * size * 4)
  const radius = maskable ? 0 : size * 0.22
  const inset = maskable ? size * 0.1 : 0
  const cx = size / 2
  const cy = size / 2
  const ringR = size * (maskable ? 0.26 : 0.31)
  const ringW = size * 0.055

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const d = roundedRectDistance(x + 0.5, y + 0.5, size, radius, inset)
      const inside = d <= 0
      const edge = Math.min(1, Math.max(0, -d))
      const t = y / size
      const r = Math.round(31 + 20 * t)
      const g = Math.round(111 - 20 * t)
      const b = Math.round(235 - 20 * t)
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = Math.round(255 * edge * (inside ? 1 : 0))

      if (!inside) continue

      // 表盘外圈
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const onRing = Math.abs(dist - ringR) <= ringW / 2

      // 指针：用"点到线段距离"画两根细针
      const handWidth = size * 0.028
      const hand = (angle, len) => {
        const tx = cx + Math.cos(angle) * len
        const ty = cy + Math.sin(angle) * len
        const vx = tx - cx
        const vy = ty - cy
        const wx = x + 0.5 - cx
        const wy = y + 0.5 - cy
        const proj = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
        const dx = wx - vx * proj
        const dy = wy - vy * proj
        return Math.hypot(dx, dy) <= handWidth / 2
      }
      const onHand = hand(-Math.PI / 2, ringR * 0.62) || hand(Math.PI / 6, ringR * 0.82)

      if (onRing || onHand) {
        px[i] = 255
        px[i + 1] = 255
        px[i + 2] = 255
        px[i + 3] = 255
      }
      // 中心点
      if (dist < size * 0.035) {
        px[i] = 255
        px[i + 1] = 255
        px[i + 2] = 255
        px[i + 3] = 255
      }
    }
  }
  return png(size, size, px)
}

writeFileSync(resolve(outDir, 'icon-192.png'), render(192))
writeFileSync(resolve(outDir, 'icon-512.png'), render(512))
writeFileSync(resolve(outDir, 'icon-512-maskable.png'), render(512, { maskable: true }))
writeFileSync(resolve(outDir, 'apple-touch-icon.png'), render(180))
console.log('icons generated in public/')
