const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomChunk(len: number): string {
  let out = ''
  const buf = new Uint8Array(len)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < len; i += 1) buf[i] = Math.floor(Math.random() * 256)
  }
  for (let i = 0; i < len; i += 1) out += ALPHABET[buf[i] % ALPHABET.length]
  return out
}

/** 全局唯一 id：时间戳前缀 + 随机后缀，两台设备不会撞号 */
export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${randomChunk(6)}`
}

export function deviceId(): string {
  return `dev-${randomChunk(8)}`
}
