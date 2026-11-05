import { decodeText } from './core.js'

export enum TokenType {
  Data,   // a plain run of bytes >= 0x20 (may include interior spaces)
  Layout, // a run of layout bytes (SP HT LF CR) outside text
  Text,   // a whole text, STX through ETX

  SOH, // key or header-row introducer
  EOT, // end of document
  ENQ, // reference
  BEL, // comment introducer
  DLE, // open a nested level
  SYN, // start of document
  ETB, // commit marker
  CAN, // close a nested level
  EM,  // end of medium
  SUB, // substitution
  FS,  // file separator
  GS,  // group separator
  RS,  // record separator
  US,  // unit separator
}

/** A token: a type and a byte range into the buffer. */
export interface Token {
  readonly type: TokenType
  readonly start: number
  readonly end: number
}

export function tokenSize(t: Token): number {
  return t.end - t.start
}

/** Raw bytes of the token as a view into the buffer. Zero-copy. */
export function tokenRaw(t: Token, buf: Uint8Array): Uint8Array {
  return buf.subarray(t.start, t.end)
}

/** For a Text token: the inside, escapes decoded. */
export function tokenText(t: Token, buf: Uint8Array): Uint8Array {
  return decodeText(buf.subarray(t.start + 1, t.end - 1))
}
