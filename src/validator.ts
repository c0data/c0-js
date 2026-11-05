/**
 * Recursive-descent check of a buffer against GRAMMAR.md. `validate`
 * throws the first error; `canonical` additionally applies the canonical
 * constraints and answers false instead of throwing.
 */
import {
  SOH, STX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, SUB, FS, GS, RS, US, isLayout,
} from './constants.js'
import { C0Error, C0SyntaxError, UnexpectedEndError } from './error.js'
import {
  scanLayout, scanText, scanPlain, scanComment, trim, decodeText, isPlain,
} from './core.js'
import { bytesEqual, latin1, encoder } from './bytes.js'

const SHAPE = encoder.encode('shape')
const DIFF = encoder.encode('diff')

export class Validator {
  readonly warnings: string[] = []
  private readonly buf: Uint8Array
  private readonly len: number
  private readonly canonical: boolean
  private ok = true
  private diff = false

  constructor(buf: Uint8Array, canonical: boolean = false) {
    this.buf = buf
    this.len = buf.length
    this.canonical = canonical
  }

  /** Throw on the first structural error. */
  static validate(buf: Uint8Array): void {
    new Validator(buf).run()
  }

  /** Well-formed and canonical: no layout, one spelling per value, unique keys, no framing, no comments. */
  static isCanonical(buf: Uint8Array): boolean {
    const v = new Validator(buf, true)
    try {
      v.run()
    } catch (e) {
      if (e instanceof C0Error) return false
      throw e
    }
    return v.isOk
  }

  get isOk(): boolean {
    return this.ok
  }

  private notCanonical(why: string): void {
    this.ok = false
    this.warnings.push(why)
  }

  run(): void {
    const buf = this.buf
    let pos = this.layout(0)
    let first = true
    while (pos < this.len) {
      const b = buf[pos]
      if (b === SYN) {
        this.notCanonical('SYN in a canonical unit')
        pos = this.heading(pos + 1)
        first = true // the body that follows belongs to this document
      } else if (b === EM) {
        this.notCanonical('EM in a canonical unit')
        return // raw region follows
      } else {
        if (!first) throw new C0SyntaxError('a document after the first must begin with SYN', pos)
        pos = this.body(pos, this.len, true)
        // after a body only EOT, SYN, EM or end
        pos = this.layout(pos)
        first = false
        if (pos < this.len) {
          const b2 = buf[pos]
          if (b2 === EOT) {
            this.notCanonical('EOT in a canonical unit')
            pos = this.layout(pos + 1)
            if (pos < this.len && buf[pos] !== SYN && buf[pos] !== EM) {
              throw new C0SyntaxError('unexpected byte after EOT', pos)
            }
          } else if (b2 === SYN || b2 === EM) {
            continue
          } else {
            throw new C0SyntaxError('unexpected byte after document', pos)
          }
        }
      }
    }
  }

  private layout(pos: number, stop: number = this.len): number {
    const p2 = scanLayout(this.buf, pos, stop)
    if (p2 !== pos) this.notCanonical('layout bytes')
    return p2
  }

  // Heading: keyed units and notes after SYN. Returns the position of the
  // first body code. Also decides diff vs data body.
  private heading(pos: number): number {
    const buf = this.buf
    const keys: Uint8Array[] = []
    pos = this.layout(pos)
    while (pos < this.len) {
      const b = buf[pos]
      if (b === SOH) {
        const p2 = this.layout(pos + 1)
        if (p2 < this.len && buf[p2] === RS) break // header row ends the heading
        const [k, v, p] = this.keyedUnit(pos + 1, this.len, true)
        keys.push(k)
        pos = p
        if (bytesEqual(k, SHAPE) && bytesEqual(v, DIFF)) this.diff = true
      } else if (b === BEL) {
        pos = this.comment(pos, this.len)
      } else if (b >= 0x20) {
        throw new C0SyntaxError('plain text directly after SYN', pos)
      } else {
        break
      }
      pos = this.layout(pos)
    }
    this.checkKeys(keys)
    return pos
  }

  private checkKeys(keys: Uint8Array[]): void {
    const seen = new Set<string>()
    for (const k of keys) {
      const s = latin1(k)
      if (seen.has(s)) this.notCanonical('duplicate key')
      seen.add(s)
    }
  }

  // A body (data or diff) from pos to stop. depth0 allows commits.
  private body(pos: number, stop: number, depth0: boolean): number {
    if (this.diff && depth0) return this.diffBody(pos, stop)
    const buf = this.buf
    pos = this.layout(pos, stop)
    pos = this.part(pos, stop, depth0)
    while (pos < stop) {
      const b = buf[pos]
      if (b === FS) {
        pos = this.plainName(pos + 1, stop)
        pos = this.part(pos, stop, depth0)
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 < stop && buf[p2] === FS) {
          this.notCanonical('dead element')
          pos = this.plainName(p2 + 1, stop)
          pos = this.part(pos, stop, depth0)
        } else {
          break
        }
      } else {
        break
      }
    }
    return pos
  }

  // part = *pre [header-row] *item *group
  private part(pos: number, stop: number, depth0: boolean): number {
    const buf = this.buf
    pos = this.pre(pos, stop, depth0)
    pos = this.headerRow(pos, stop)
    pos = this.items(pos, stop, depth0)
    while (pos < stop) {
      const b = buf[pos]
      if (b === GS) {
        pos = this.group(pos, stop, depth0)
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 < stop && buf[p2] === GS) {
          this.notCanonical('dead element')
          pos = this.group(p2, stop, depth0)
        } else {
          break
        }
      } else {
        break
      }
    }
    return pos
  }

  private group(pos: number, stop: number, depth0: boolean): number {
    const buf = this.buf
    while (pos < stop && buf[pos] === GS) pos = this.layout(pos + 1, stop)
    pos = this.plainName(pos, stop)
    pos = this.pre(pos, stop, depth0)
    pos = this.headerRow(pos, stop)
    return this.items(pos, stop, depth0)
  }

  // Before a header row: notes, commits (at depth zero), dead records and
  // dead header rows.
  private pre(pos: number, stop: number, depth0: boolean): number {
    const buf = this.buf
    for (;;) {
      pos = this.layout(pos, stop)
      if (pos >= stop) break
      const b = buf[pos]
      if (b === ETB) {
        if (!depth0) throw new C0SyntaxError('commit inside a nested level', pos)
        this.notCanonical('commit')
        pos = scanPlain(buf, this.layout(pos + 1, stop), stop)
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 >= stop) throw new UnexpectedEndError('BEL at end of input', p2)
        if (buf[p2] >= 0x20 || buf[p2] === STX) {
          pos = this.notes(pos, stop)
        } else if (buf[p2] === RS) {
          this.notCanonical('dead element')
          pos = this.record(p2 + 1, stop)
        } else if (buf[p2] === SOH) {
          const p3 = scanLayout(buf, p2 + 1, stop)
          if (p3 < stop && buf[p3] === RS) {
            this.notCanonical('dead element')
            pos = this.headerNames(p3 + 1, stop)
          } else {
            throw new C0SyntaxError('keyed unit outside a record', p2)
          }
        } else {
          break
        }
      } else {
        break
      }
    }
    return pos
  }

  private headerNames(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    for (;;) {
      pos = this.plainName(pos, stop)
      if (!(pos < stop && buf[pos] === US)) break
      pos = this.layout(pos + 1, stop)
    }
    return pos
  }

  // Notes only (BEL followed by plain/text); dead elements are handled by
  // their element rules.
  private notes(pos: number, stop: number): number {
    const buf = this.buf
    for (;;) {
      pos = this.layout(pos, stop)
      if (!(pos < stop && buf[pos] === BEL)) break
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 >= stop) throw new UnexpectedEndError('BEL at end of input', p2)
      if (buf[p2] < 0x20 && buf[p2] !== STX) break // a dead element, not a note
      this.notCanonical('comment')
      pos = buf[p2] === STX ? scanText(buf, p2, stop) : scanPlain(buf, p2, stop)
    }
    return pos
  }

  private headerRow(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    if (!(pos < stop && buf[pos] === SOH)) return pos
    const p2 = this.layout(pos + 1, stop)
    if (!(p2 < stop && buf[p2] === RS)) return pos
    return this.headerNames(p2 + 1, stop)
  }

  private items(pos: number, stop: number, depth0: boolean): number {
    const buf = this.buf
    for (;;) {
      pos = this.layout(pos, stop)
      if (pos >= stop) break
      const b = buf[pos]
      if (b === RS) {
        pos = this.record(pos + 1, stop)
      } else if (b === ETB) {
        if (!depth0) throw new C0SyntaxError('commit inside a nested level', pos)
        this.notCanonical('commit')
        pos = scanPlain(buf, this.layout(pos + 1, stop), stop)
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 >= stop || buf[p2] >= 0x20 || buf[p2] === STX) {
          pos = this.notes(pos, stop)
        } else if (buf[p2] === RS) {
          this.notCanonical('dead element')
          pos = this.record(p2 + 1, stop)
        } else if (buf[p2] === SOH) {
          const p3 = scanLayout(buf, p2 + 1, stop)
          if (p3 < stop && buf[p3] === RS) {
            this.notCanonical('dead element')
            pos = this.headerNames(p3 + 1, stop)
          } else {
            throw new C0SyntaxError('keyed unit outside a record', p2)
          }
        } else if (buf[p2] === DLE) {
          throw new C0SyntaxError('a nested level is not an item', p2)
        } else {
          break // dead GS/FS handled by the caller; others are errors there
        }
      } else if (b === SOH) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 < stop && buf[p2] === RS) throw new C0SyntaxError('header row not at the start of its group', pos)
        throw new C0SyntaxError('keyed unit outside a record', pos)
      } else {
        break
      }
    }
    return pos
  }

  // After RS. Returns the position after the record.
  private record(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    if (this.keyedStart(pos, stop)) {
      const keys: Uint8Array[] = []
      for (;;) {
        pos = this.layout(pos, stop)
        if (pos >= stop) break
        const b = buf[pos]
        if (b === SOH) {
          const p2 = scanLayout(buf, pos + 1, stop)
          if (p2 < stop && buf[p2] === RS) break
          const [k, , p] = this.keyedUnit(pos + 1, stop, false)
          keys.push(k)
          pos = p
        } else if (b === BEL) {
          const p2 = scanLayout(buf, pos + 1, stop)
          if (p2 >= stop) throw new UnexpectedEndError('BEL at end of input', p2)
          if (buf[p2] === SOH) {
            const p3 = scanLayout(buf, p2 + 1, stop)
            if (p3 < stop && buf[p3] === RS) break
            this.notCanonical('dead element')
            pos = this.keyedUnit(p2 + 1, stop, false)[2]
          } else if (buf[p2] >= 0x20 || buf[p2] === STX) {
            pos = this.notes(pos, stop)
          } else {
            break
          }
        } else {
          break
        }
      }
      this.checkKeys(keys)
      if (pos < stop && buf[pos] === US) throw new C0SyntaxError('US after a keyed value (mixed record)', pos)
      return pos
    }
    // positional
    for (;;) {
      pos = this.value(pos, stop)
      pos = this.layout(pos, stop)
      if (pos >= stop) break
      const b = buf[pos]
      if (b === US) {
        pos++
      } else if (b === SOH) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 < stop && buf[p2] === RS) break
        throw new C0SyntaxError('keyed unit in a positional record (mixed record)', pos)
      } else {
        break
      }
    }
    return pos
  }

  // Does a record starting here begin with a (live or dead) keyed unit?
  private keyedStart(pos: number, stop: number): boolean {
    const buf = this.buf
    while (pos < stop) {
      const b = buf[pos]
      if (b === SOH) return true
      if (b !== BEL) return false
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 >= stop) return false
      if (buf[p2] === SOH) return true
      if (buf[p2] < 0x20 && buf[p2] !== STX) return false
      pos = scanLayout(buf, scanComment(buf, pos, stop), stop)
    }
    return false
  }

  // After SOH. Returns [key, value-or-empty, pos].
  private keyedUnit(pos: number, stop: number, heading: boolean): [Uint8Array, Uint8Array, number] {
    const buf = this.buf
    pos = this.layout(pos, stop)
    const ks = pos
    pos = scanPlain(buf, pos, stop)
    const key = trim(buf.subarray(ks, pos))
    if (!(pos < stop && buf[pos] === US)) throw new C0SyntaxError('key without a value (no US)', pos)
    const vs = pos + 1
    pos = this.value(vs, stop, heading)
    return [key, trim(buf.subarray(vs, pos)), pos]
  }

  // One value (possibly empty) starting at pos. Returns the position after
  // it (before the next code at this depth).
  private value(pos: number, stop: number, heading: boolean = false): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    if (pos >= stop) return pos
    const b = buf[pos]
    const twoValues = (after: number): boolean =>
      after < stop && (buf[after] >= 0x20 || buf[after] === STX || buf[after] === DLE || buf[after] === ENQ)
    if (b >= 0x20) {
      const start = pos
      pos = scanPlain(buf, pos, stop)
      for (let i = start; i < pos; i++) {
        if (buf[i] < 0x20) throw new C0SyntaxError('layout code inside a plain value', i)
      }
      if (isLayout(buf[pos - 1])) this.notCanonical('layout bytes')
      const after = this.trailingNotes(this.layout(pos, stop), stop)
      if (twoValues(after)) throw new C0SyntaxError('two values in one unit', after)
      return after
    } else if (b === STX) {
      const start = pos
      pos = scanText(buf, pos, stop)
      const inside = buf.subarray(start + 1, pos - 1)
      if (this.canonical) {
        if (inside.length === 0) this.notCanonical('empty text')
        if (inside.length > 0 && isPlain(decodeText(inside))) this.notCanonical('gratuitous text')
      }
      const after = this.trailingNotes(this.layout(pos, stop), stop)
      if (twoValues(after)) throw new C0SyntaxError('two values in one unit', after)
      return after
    } else if (b === DLE) {
      pos = this.level(pos, stop)
      const after = this.trailingNotes(this.layout(pos, stop), stop)
      if (twoValues(after)) throw new C0SyntaxError('two values in one unit', after)
      return after
    } else if (b === ENQ) {
      if (heading) throw new C0SyntaxError('reference in a heading', pos)
      pos = this.layout(pos + 1, stop)
      if (pos >= stop || (buf[pos] < 0x20 && buf[pos] !== STX)) throw new C0SyntaxError('reference without a name', pos)
      if (buf[pos] === STX) {
        const start = pos
        pos = scanText(buf, pos, stop)
        const inside = decodeText(buf.subarray(start + 1, pos - 1))
        const segs = inside.length === 0 ? [] : splitUS(inside)
        if (segs.some(s => s.length === 0)) throw new C0SyntaxError('reference path with an empty segment', start)
        if (segs.length > 3) throw new C0SyntaxError('reference path with more than three segments', start)
        if (segs.length === 1) this.notCanonical('group reference written as text')
      } else {
        pos = scanPlain(buf, pos, stop)
      }
      return this.trailingNotes(this.layout(pos, stop), stop)
    } else if (b === BEL) {
      // a note or dead level in unit position: the unit is empty
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 >= stop) throw new UnexpectedEndError('BEL at end of input', p2)
      if (buf[p2] === DLE) {
        this.notCanonical('dead element')
        pos = this.level(p2, stop)
      } else if (buf[p2] < 0x20 && buf[p2] !== STX) {
        return pos // a dead record-level element: handled by the caller
      } else {
        this.notCanonical('comment')
        pos = buf[p2] === STX ? scanText(buf, p2, stop) : scanPlain(buf, p2, stop)
      }
      return this.layout(pos, stop)
    }
    return pos
  }

  // Notes (BEL + content) after a value inside a unit; a BEL before a code
  // is left for the caller.
  private trailingNotes(pos: number, stop: number): number {
    const buf = this.buf
    while (pos < stop && buf[pos] === BEL) {
      const p2 = scanLayout(buf, pos + 1, stop)
      if (p2 >= stop) throw new UnexpectedEndError('BEL at end of input', p2)
      if (!(buf[p2] >= 0x20 || buf[p2] === STX)) break
      this.notCanonical('comment')
      pos = buf[p2] === STX ? scanText(buf, p2, stop) : scanPlain(buf, p2, stop)
      pos = this.layout(pos, stop)
    }
    return pos
  }

  // DLE at pos: a nested level. Returns the position after CAN.
  private level(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos + 1, stop)
    if (pos >= stop) throw new UnexpectedEndError('level not closed', pos)
    const b = buf[pos]
    if (b === CAN) return pos + 1
    if (!(b === FS || b === GS || b === RS || b === SOH || b === BEL)) {
      throw new C0SyntaxError('DLE must be followed by a structural code', pos)
    }
    pos = this.body(pos, stop, false)
    pos = this.layout(pos, stop)
    if (pos >= stop) throw new UnexpectedEndError('level not closed', pos)
    if (buf[pos] !== CAN) throw new C0SyntaxError('unexpected byte inside level', pos)
    return pos + 1
  }

  private plainName(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    if (pos < stop && buf[pos] === STX) throw new C0SyntaxError('a name cannot be text', pos)
    const start = pos
    pos = scanPlain(buf, pos, stop)
    if (pos > start && isLayout(buf[pos - 1])) this.notCanonical('layout bytes')
    return pos
  }

  private comment(pos: number, stop: number): number {
    this.notCanonical('comment')
    return scanComment(this.buf, pos, stop)
  }

  // ---- diff body -----------------------------------------------------

  private diffBody(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    while (pos < stop) {
      const b = buf[pos]
      if (b === FS) {
        pos = this.plainName(pos + 1, stop)
      } else if (b === GS) {
        pos = this.pattern(pos + 1, stop)
      } else if (b === RS) {
        pos = this.replace(pos + 1, stop)
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 < stop && buf[p2] === FS) pos = this.plainName(p2 + 1, stop)
        else if (p2 < stop && buf[p2] === GS) pos = this.pattern(p2 + 1, stop)
        else if (p2 < stop && buf[p2] === RS) pos = this.replace(p2 + 1, stop)
        else pos = this.notes(pos, stop)
      } else if (b === ETB) {
        this.notCanonical('commit')
        pos = scanPlain(buf, this.layout(pos + 1, stop), stop)
      } else if (b === EOT || b === SYN || b === EM) {
        break
      } else {
        throw new C0SyntaxError('unexpected byte in a diff body', pos)
      }
      pos = this.layout(pos, stop)
    }
    return pos
  }

  private dvalue(pos: number, stop: number): number {
    const buf = this.buf
    pos = this.layout(pos, stop)
    if (pos >= stop) return pos
    if (buf[pos] === STX) pos = scanText(buf, pos, stop)
    else if (buf[pos] >= 0x20) pos = scanPlain(buf, pos, stop)
    return this.layout(pos, stop)
  }

  private pattern(pos: number, stop: number): number {
    const buf = this.buf
    for (;;) {
      pos = this.dvalue(pos, stop)
      if (pos < stop && buf[pos] === SUB) pos = this.dvalue(pos + 1, stop)
      pos = this.trailingNotes(pos, stop)
      if (!(pos < stop && buf[pos] === US)) break
      pos++
    }
    return pos
  }

  private replace(pos: number, stop: number): number {
    const buf = this.buf
    const start = scanLayout(buf, pos, stop)
    pos = this.dvalue(pos, stop)
    if (trim(buf.subarray(start, pos)).length === 0) throw new C0SyntaxError('replace-all with an empty old part', start)
    if (!(pos < stop && buf[pos] === SUB)) throw new C0SyntaxError('replace-all without SUB', pos)
    return this.dvalue(pos + 1, stop)
  }
}

function splitUS(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let s = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === US) {
      out.push(bytes.subarray(s, i))
      s = i + 1
    }
  }
  out.push(bytes.subarray(s))
  return out
}

/** Throw a C0Error unless the buffer is well-formed. */
export function validate(buf: Uint8Array): void {
  Validator.validate(buf)
}

/** Whether bytes are a canonical unit (DESIGN.md "Canonical Form"). */
export function canonical(buf: Uint8Array): boolean {
  return Validator.isCanonical(buf)
}
