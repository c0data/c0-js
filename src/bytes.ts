/** Byte helpers shared by the library: UTF-8 codecs, equality, hex, a growable writer. */

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

/** A value given as a string (UTF-8) or raw bytes. */
export type ByteSource = string | Uint8Array

export const EMPTY: Uint8Array = new Uint8Array(0)

export function toBytes(v: ByteSource): Uint8Array {
  return typeof v === 'string' ? encoder.encode(v) : v
}

/** Decode bytes as UTF-8 (lossy on invalid sequences). */
export function utf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** One JS string per distinct byte sequence (for map keys). */
export function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function toHex(buf: Uint8Array): string {
  let out = ''
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}

/** A growable byte buffer. */
export class ByteWriter {
  private buf: Uint8Array
  length = 0

  constructor(capacity: number = 256) {
    this.buf = new Uint8Array(capacity)
  }

  push(b: number): void {
    if (this.length === this.buf.length) this.grow(1)
    this.buf[this.length++] = b
  }

  write(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.buf.length) this.grow(bytes.length)
    this.buf.set(bytes, this.length)
    this.length += bytes.length
  }

  writeString(s: string): void {
    this.write(encoder.encode(s))
  }

  clear(): void {
    this.length = 0
  }

  /** A copy of the bytes written so far. */
  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.length)
  }

  private grow(extra: number): void {
    let cap = this.buf.length * 2
    while (cap < this.length + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
}
