/**
 * Zero-copy tokenizer. Scans a byte buffer and emits tokens as offsets
 * into it: plain runs, layout runs, whole texts, and one token per code.
 * It does not check structure (see `validate`); it stops at EM and throws
 * on unassigned codes and malformed text.
 *
 * The hot loop is a single comparison: `byte < 0x20`.
 */
import { SOH, STX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, SUB, FS, GS, RS, US, HT, LF, CR, SP } from './constants.js'
import { UnassignedCodeError } from './error.js'
import { scanLayout, scanText } from './core.js'
import { TokenType, type Token } from './token.js'

const CODE_TYPES = new Map<number, TokenType>([
  [SOH, TokenType.SOH], [EOT, TokenType.EOT], [ENQ, TokenType.ENQ], [BEL, TokenType.BEL],
  [DLE, TokenType.DLE], [SYN, TokenType.SYN], [ETB, TokenType.ETB], [CAN, TokenType.CAN],
  [SUB, TokenType.SUB], [FS, TokenType.FS], [GS, TokenType.GS], [RS, TokenType.RS], [US, TokenType.US],
])

export class Tokenizer {
  private readonly buf: Uint8Array
  private pos = 0
  private readonly len: number
  /** Position of the first byte after EM, or the buffer size; -1 before scanning. */
  tailStart = -1

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.len = buf.length
  }

  each(cb: (t: Token) => void): void {
    const buf = this.buf
    while (this.pos < this.len) {
      const byte = buf[this.pos]
      if (byte < 0x20) {
        if (byte === STX) {
          const stop = scanText(buf, this.pos)
          cb({ type: TokenType.Text, start: this.pos, end: stop })
          this.pos = stop
        } else if (byte === HT || byte === LF || byte === CR) {
          cb(this.scanLayoutToken())
        } else if (byte === EM) {
          cb({ type: TokenType.EM, start: this.pos, end: this.pos + 1 })
          this.pos++
          this.tailStart = this.pos
          return
        } else {
          const type = CODE_TYPES.get(byte)
          if (type === undefined) throw new UnassignedCodeError(byte, this.pos)
          cb({ type, start: this.pos, end: this.pos + 1 })
          this.pos++
        }
      } else if (byte === SP) {
        cb(this.scanLayoutToken())
      } else {
        cb(this.scanData())
      }
    }
    this.tailStart = this.len
  }

  toArray(): Token[] {
    const tokens: Token[] = []
    this.each(t => tokens.push(t))
    return tokens
  }

  // A plain run: bytes >= 0x20, ending before trailing spaces so that
  // layout next to a code is its own token.
  private scanData(): Token {
    const buf = this.buf
    const start = this.pos
    this.pos++
    while (this.pos < this.len && buf[this.pos] >= 0x20) this.pos++
    let stop = this.pos
    while (stop > start + 1 && buf[stop - 1] === SP) stop--
    this.pos = stop
    return { type: TokenType.Data, start, end: stop }
  }

  private scanLayoutToken(): Token {
    const start = this.pos
    this.pos = scanLayout(this.buf, this.pos)
    return { type: TokenType.Layout, start, end: this.pos }
  }
}

/** Tokenize a whole buffer. */
export function tokenize(buf: Uint8Array): Token[] {
  return new Tokenizer(buf).toArray()
}

/** Tokenize a buffer, calling back per token. */
export function tokenizeEach(buf: Uint8Array, cb: (t: Token) => void): void {
  new Tokenizer(buf).each(cb)
}
