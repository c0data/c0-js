/**
 * Scanning primitives and value codecs. All scanners take a buffer and a
 * position and return the position after the construct; they throw on
 * malformed input.
 */
import {
  STX, ETX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, FS, GS, RS, US, SOH,
  isLayout, isTextEscaped,
} from './constants.js'
import { C0Error, C0SyntaxError, UnexpectedEndError } from './error.js'
import { ByteWriter, EMPTY, toBytes, type ByteSource } from './bytes.js'

/** Skip layout bytes. */
export function scanLayout(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  while (pos < stop && isLayout(buf[pos])) pos++
  return pos
}

/**
 * Skip a text (STX … ETX) starting at the STX at `pos`. Returns the
 * position after the ETX. Throws on an unclosed text, a bad escape, a
 * nested STX, or framing inside the text.
 */
export function scanText(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  const start = pos
  pos++ // STX
  while (pos < stop) {
    const b = buf[pos]
    if (b === DLE) {
      pos++
      if (pos >= stop) throw new UnexpectedEndError('DLE at end of text', pos)
      if (!isTextEscaped(buf[pos])) throw new C0SyntaxError('DLE before a byte that is not one of the seven', pos)
      pos++
    } else if (b === ETX) {
      return pos + 1
    } else if (b === STX) {
      throw new C0SyntaxError('STX inside text (text does not nest)', pos)
    } else if (b === ETB || b === EOT || b === SYN || b === EM) {
      throw new C0SyntaxError('framing inside open text', pos)
    } else {
      pos++
    }
  }
  throw new UnexpectedEndError(`text opened at ${start} is not closed`, pos)
}

/** Skip a nested level starting at the DLE at `pos`. Returns the position after the matching CAN. */
export function scanLevel(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  const start = pos
  pos++ // DLE
  let depth = 1
  while (pos < stop) {
    const b = buf[pos]
    if (b >= 0x20) {
      pos++
    } else if (b === STX) {
      pos = scanText(buf, pos, stop)
    } else if (b === DLE) {
      depth++
      pos++
    } else if (b === CAN) {
      depth--
      pos++
      if (depth === 0) return pos
    } else if (b === ETB || b === EOT || b === SYN || b === EM) {
      throw new C0SyntaxError('framing inside open level', pos)
    } else {
      pos++
    }
  }
  throw new UnexpectedEndError(`level opened at ${start} is not closed`, pos)
}

/** Skip a plain run of bytes >= 0x20. Returns the position of the next control code or `stop`. */
export function scanPlain(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  while (pos < stop && buf[pos] >= 0x20) pos++
  return pos
}

/**
 * From `pos` (just after a US, RS or a key's US), find the end of one
 * unit's value: the next control code at this depth other than the ones
 * that belong to the value (STX…ETX, DLE…CAN, ENQ, BEL note). Layout at
 * the edges is included in the returned range.
 */
export function scanUnit(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  while (pos < stop) {
    const b = buf[pos]
    if (b >= 0x20 || isLayout(b)) {
      pos++
    } else if (b === STX) {
      pos = scanText(buf, pos, stop)
    } else if (b === DLE) {
      pos = scanLevel(buf, pos, stop)
    } else if (b === ENQ) {
      pos++
    } else if (b === BEL) {
      // a note or a dead level stays inside the unit; a dead
      // record-level element (BEL RS / SOH / GS / FS) ends it
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 < stop && buf[p2] < 0x20 && buf[p2] !== STX && buf[p2] !== DLE) return pos
      pos = scanComment(buf, pos, stop)
    } else {
      return pos
    }
  }
  return pos
}

/**
 * Skip a comment starting at the BEL at `pos`: a note (text or plain to
 * the next code) or a dead element (the next code's whole element).
 * Returns the position after it.
 */
export function scanComment(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  pos++ // BEL
  pos = scanLayout(buf, pos, stop)
  if (pos >= stop) throw new UnexpectedEndError('BEL at end of input', pos)
  const b = buf[pos]
  if (b >= 0x20) return scanPlain(buf, pos, stop)
  if (b === STX) return scanText(buf, pos, stop)
  if (b === DLE) return scanLevel(buf, pos, stop)
  if (b === RS) return scanRecordEnd(buf, pos + 1, stop)
  if (b === SOH) {
    // header row or keyed unit
    const p2 = scanLayout(buf, pos + 1, stop)
    if (p2 < stop && buf[p2] === RS) return scanRecordEnd(buf, p2 + 1, stop)
    return scanKeyedUnitEnd(buf, pos + 1, stop)
  }
  if (b === GS) {
    let p2 = pos
    while (p2 < stop && (buf[p2] === GS || isLayout(buf[p2]))) p2++
    return scanPlain(buf, p2, stop)
  }
  if (b === FS) return scanPlain(buf, pos + 1, stop)
  throw new C0SyntaxError('BEL before a code that is not an element', pos)
}

/** From just after an RS, find the end of the record: the next record-level code at this depth. */
export function scanRecordEnd(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  while (pos < stop) {
    const b = buf[pos]
    if (b >= 0x20 || isLayout(b)) {
      pos++
    } else if (b === US) {
      pos++
    } else if (b === SOH) {
      // a header row (SOH RS) ends the record; a keyed unit is inside it
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 < stop && buf[p2] === RS) return pos
      pos++
    } else if (b === STX) {
      pos = scanText(buf, pos, stop)
    } else if (b === DLE) {
      pos = scanLevel(buf, pos, stop)
    } else if (b === ENQ) {
      pos++
    } else if (b === BEL) {
      // a note inside the record, or a dead element; a dead record-level
      // element (BEL RS / BEL GS …) ends this record first.
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 < stop && (buf[p2] === RS || buf[p2] === GS || buf[p2] === FS)) return pos
      if (p2 < stop && buf[p2] === SOH) {
        const p3 = scanLayout(buf, p2 + 1, stop)
        if (p3 < stop && buf[p3] === RS) return pos
      }
      pos = scanComment(buf, pos, stop)
    } else {
      return pos
    }
  }
  return pos
}

/** From just after an SOH (not a header row), skip the key, US and value of one keyed unit. */
export function scanKeyedUnitEnd(buf: Uint8Array, pos: number, stop: number = buf.length): number {
  pos = scanLayout(buf, pos, stop)
  pos = scanPlain(buf, pos, stop)
  if (!(pos < stop && buf[pos] === US)) throw new C0SyntaxError('key without a value (no US)', pos)
  return scanUnit(buf, pos + 1, stop)
}

/** The scanning primitives as one namespace. */
export const Scan = {
  layout: scanLayout,
  text: scanText,
  level: scanLevel,
  plain: scanPlain,
  unit: scanUnit,
  comment: scanComment,
  recordEnd: scanRecordEnd,
  keyedUnitEnd: scanKeyedUnitEnd,
}

// ---------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------

/** Trim layout from both ends of a raw slice. */
export function trim(raw: Uint8Array): Uint8Array {
  let s = 0
  let e = raw.length
  while (s < e && isLayout(raw[s])) s++
  while (e > s && isLayout(raw[e - 1])) e--
  return s === 0 && e === raw.length ? raw : raw.subarray(s, e)
}

/** Whether the raw unit (layout included) is a text value. */
export function isText(raw: Uint8Array): boolean {
  const t = trim(raw)
  return t.length > 0 && t[0] === STX
}

/** Whether the raw unit is a nested level. */
export function isLevel(raw: Uint8Array): boolean {
  const t = trim(raw)
  return t.length > 0 && t[0] === DLE
}

/** Whether the raw unit is a reference. */
export function isReference(raw: Uint8Array): boolean {
  const t = trim(raw)
  return t.length > 0 && t[0] === ENQ
}

/**
 * The logical value of a raw unit slice: for text, the inside with its
 * escapes decoded (zero-copy when there are none); for a plain value,
 * the slice with edge layout removed. A note in the unit yields the
 * empty value. Throws on malformed input.
 */
export function value(raw: Uint8Array): Uint8Array {
  const t = trim(raw)
  if (t.length === 0) return t
  const first = t[0]
  if (first === STX) {
    const stop = scanText(t, 0)
    onlyNotesAfter(t, stop, 'text cannot be part of a plain value')
    return decodeText(t.subarray(1, stop - 1))
  } else if (first === BEL) {
    // a note, or a dead level: the unit is empty
    onlyNotesAfter(t, 0, 'value after a comment in the same unit')
    return EMPTY
  } else if (first === DLE) {
    throw new C0SyntaxError('a nested level is not a scalar value', 0)
  } else if (first === ENQ) {
    throw new C0SyntaxError('a reference is not a scalar value', 0)
  }
  for (let i = 0; i < t.length; i++) {
    const b = t[i]
    if (b === BEL) {
      // notes after the value: skipped
      onlyNotesAfter(t, i, 'value after a note in the same unit')
      return trim(t.subarray(0, i))
    } else if (b < 0x20) {
      throw new C0SyntaxError(isLayout(b) ? 'layout code inside a plain value' : 'control code inside a plain value', i)
    }
  }
  return t
}

// From pos to the end of the unit only notes (and layout) may follow.
function onlyNotesAfter(t: Uint8Array, pos: number, what: string): void {
  pos = scanLayout(t, pos)
  while (pos < t.length) {
    if (t[pos] !== BEL) throw new C0SyntaxError(what, pos)
    pos = scanLayout(t, scanComment(t, pos))
  }
}

/** Decode the inside of a text: DLE escapes removed. Zero-copy when there are none. */
export function decodeText(inside: Uint8Array): Uint8Array {
  let i = 0
  for (; i < inside.length; i++) if (inside[i] === DLE) break
  if (i === inside.length) return inside
  const out = new Uint8Array(inside.length)
  out.set(inside.subarray(0, i))
  let n = i
  while (i < inside.length) {
    let b = inside[i]
    if (b === DLE) {
      i++
      if (i >= inside.length) throw new UnexpectedEndError('DLE at end of text', i)
      b = inside[i]
    }
    out[n++] = b
    i++
  }
  return out.subarray(0, n)
}

/** Whether a value can be written plain: no byte below 0x20, no edge whitespace. */
export function isPlain(value: Uint8Array): boolean {
  if (value.length === 0) return true
  if (isLayout(value[0]) || isLayout(value[value.length - 1])) return false
  for (let i = 0; i < value.length; i++) if (value[i] < 0x20) return false
  return true
}

/**
 * Write a value in its one canonical spelling: plain when it can be,
 * text otherwise, with only the seven codes escaped.
 */
export function writeValue(w: ByteWriter, v: ByteSource): void {
  const bytes = toBytes(v)
  if (isPlain(bytes)) {
    w.write(bytes)
    return
  }
  w.push(STX)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (isTextEscaped(b)) w.push(DLE)
    w.push(b)
  }
  w.push(ETX)
}

/** Encode a value on its own, in canonical spelling. */
export function encodeValue(v: ByteSource): Uint8Array {
  const w = new ByteWriter()
  writeValue(w, v)
  return w.toUint8Array()
}

/** Whether bytes are a legal name (label, key, header name). */
export function isName(v: Uint8Array): boolean {
  return isPlain(v)
}

/** Write a name; throws if it is not one. */
export function writeName(w: ByteWriter, name: ByteSource): void {
  const bytes = toBytes(name)
  if (!isName(bytes)) throw new C0Error(`not a legal name: ${JSON.stringify(typeof name === 'string' ? name : Array.from(bytes))}`)
  w.write(bytes)
}
