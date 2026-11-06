/**
 * Writes C0DATA in canonical compact form.
 *
 *   const buf = build(b => {
 *     b.syn({ shape: 'tabular' })
 *     b.group('users', ['name', 'amount'], () => {
 *       b.record('Alice', '1502.30')
 *       b.record('Bob', '340.00')
 *     })
 *     b.eot()
 *   })
 *
 * Two layers. The primitives are one method per code (`fs`, `gs`, `rs`,
 * `us`, `soh`, `dle`, `can`, `bel`, `enq`, `syn`, `eot`, `etb`, `em`); each
 * writes its code and, when given, what grammatically follows it, so a chain
 * reads like the bytes:
 *
 *   b.rs('Alice').us('1502.30')                        // ␞Alice␟1502.30
 *   b.rs().soh('host').us('localhost').soh('port').us('5432')
 *   b.bel().gs('old')                                  // a dead group
 *
 * The composed methods (`file`, `group`, `header`, `record`, `field`, `map`,
 * `key`, `level`, `list`, `ref`, `note`) are built on the primitives and
 * cannot write ill-formed output. The primitives write what you spell;
 * well-formedness is then yours to keep. Both layers share the record state,
 * so they mix.
 *
 * Values are written in their one spelling: plain when they can be, text
 * otherwise. Keyed records keep the order given. Nested levels open with DLE
 * and close with CAN.
 */
import { SOH, STX, ETX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, FS, GS, RS, US } from './constants.js'
import { C0Error } from './error.js'
import { writeValue, writeName, isName } from './core.js'
import { ByteWriter, toBytes, utf8, type ByteSource } from './bytes.js'

export type BuilderValue = ByteSource

/** Keyed pairs: an object (insertion order), a Map, or an array of [key, value]. */
export type Pairs = { [key: string]: BuilderValue } | Map<string, BuilderValue> | [string, BuilderValue][]

export function pairEntries(pairs: Pairs): [string, BuilderValue][] {
  if (pairs instanceof Map) return Array.from(pairs.entries())
  if (Array.isArray(pairs)) return pairs
  return Object.entries(pairs)
}

const EMPTY_NOTE = 'a note needs content: bare BEL marks the next element dead'

export class Builder {
  private readonly io = new ByteWriter()
  private inRecord = false
  private units = 0
  private readonly stack: [boolean, number][] = []

  static build(fn: (b: Builder) => void): Uint8Array {
    const b = new Builder()
    fn(b)
    return b.toUint8Array()
  }

  toUint8Array(): Uint8Array {
    return this.io.toUint8Array()
  }

  toString(): string {
    return utf8(this.toUint8Array())
  }

  // ---- primitives: one method per code ---------------------------------

  /** FS and a file name. */
  fs(name: string): this {
    this.endRecord()
    this.io.push(FS)
    writeName(this.io, name)
    return this
  }

  /** GS and, when given, a group name. `gs().gs('sub')` is a group at depth 2. */
  gs(name?: string): this {
    this.endRecord()
    this.io.push(GS)
    if (name !== undefined) writeName(this.io, name)
    return this
  }

  /** RS and, when given, the record's first value. */
  rs(value?: BuilderValue): this {
    this.io.push(RS)
    this.inRecord = true
    this.units = 0
    if (value !== undefined) this.firstValue(value)
    return this
  }

  /** US and, when given, the value that follows it. */
  us(value?: BuilderValue): this {
    this.io.push(US)
    if (value !== undefined) writeValue(this.io, value)
    this.units++
    return this
  }

  /** SOH and, when given, a key. Bare before `rs` it opens a header row. */
  soh(name?: string): this {
    this.io.push(SOH)
    if (name !== undefined) writeName(this.io, name)
    return this
  }

  /** DLE: open a nested level. Inside, the builder is at the top of a fresh body. */
  dle(): this {
    this.stack.push([this.inRecord, this.units])
    this.inRecord = false
    this.units = 0
    this.io.push(DLE)
    return this
  }

  /** CAN: close the innermost level. */
  can(): this {
    const st = this.stack.pop()
    if (st === undefined) throw new C0Error('CAN with no open level')
    this.io.push(CAN)
    this.inRecord = st[0]
    this.units = st[1]
    return this
  }

  /** BEL and, when given, a note. Bare, it marks the element that follows dead. */
  bel(text?: BuilderValue): this {
    if (text !== undefined) {
      const bytes = toBytes(text)
      if (bytes.length === 0) throw new C0Error(EMPTY_NOTE)
      this.io.push(BEL)
      writeValue(this.io, bytes)
    } else {
      this.io.push(BEL)
    }
    return this
  }

  /** ENQ and a reference: a group name, or a path of two or three names. */
  enq(...path: string[]): this {
    if (path.length === 0 || path.length > 3) throw new C0Error('a reference has one to three segments')
    this.io.push(ENQ)
    if (path.length === 1) {
      writeName(this.io, path[0])
      return this
    }
    this.io.push(STX)
    path.forEach((seg, i) => {
      if (i > 0) this.io.push(US)
      const bytes = toBytes(seg)
      if (!isName(bytes) || bytes.length === 0) throw new C0Error('reference segment is not a name')
      this.io.write(bytes)
    })
    this.io.push(ETX)
    return this
  }

  /**
   * SYN: start a document. Bare, heading pairs follow as `soh(key).us(value)`;
   * given pairs, they are written in the order given.
   */
  syn(pairs?: Pairs): this {
    this.endRecord()
    this.io.push(SYN)
    if (pairs !== undefined) for (const [k, v] of pairEntries(pairs)) this.soh(k).us(v)
    return this
  }

  /** EOT: end a document. */
  eot(): this {
    this.endRecord()
    this.io.push(EOT)
    return this
  }

  /** ETB and, when given, a commit payload. */
  etb(payload?: BuilderValue): this {
    this.endRecord()
    this.io.push(ETB)
    if (payload !== undefined) writeName(this.io, payload)
    return this
  }

  /** EM and the raw tail. Nothing may follow. */
  em(tail: Uint8Array): this {
    this.endRecord()
    this.io.push(EM)
    this.io.write(tail)
    return this
  }

  // ---- documents -------------------------------------------------------

  /** A heading key whose value is a nested level (e.g. the blob table). */
  headingLevel(key: string, fn: () => void): this {
    this.endRecord()
    this.soh(key).us()
    this.openLevel(fn)
    return this
  }

  // ---- structure -------------------------------------------------------

  file(name: string, fn?: () => void): this {
    this.fs(name)
    if (fn) fn()
    return this
  }

  group(name: string, headers?: string[] | null, fn?: () => void, depth: number = 1): this {
    for (let i = 1; i < depth; i++) this.gs()
    this.gs(name)
    if (headers) this.header(headers)
    if (fn) fn()
    return this
  }

  /** A header row: SOH RS names. */
  header(names: string[]): this
  header(...names: string[]): this
  header(...args: (string | string[])[]): this {
    const names = args.length === 1 && Array.isArray(args[0]) ? args[0] : (args as string[])
    for (const n of names) writeName(new ByteWriter(), n)
    this.endRecord()
    this.soh().rs()
    names.forEach((n, i) => {
      if (i === 0) this.firstValue(n)
      else this.us(n)
    })
    this.endRecord()
    return this
  }

  /** Document mode: a section at depth. */
  section(name: string, depth: number = 1, fn?: () => void): this {
    return this.group(name, null, fn, depth)
  }

  // ---- records -----------------------------------------------------------

  /** A positional record; with no fields, begins a record left open for `field` / `level` / `list` / `key`. */
  record(...fields: BuilderValue[]): this {
    this.rs()
    for (const f of fields) this.field(f)
    return this
  }

  recordArray(fields: BuilderValue[]): this {
    return this.record(...fields)
  }

  /** Document mode: a paragraph. */
  block(text: BuilderValue): this {
    return this.record(text)
  }

  /** Document mode: a list item (a unit of the open block). */
  item(text: BuilderValue): this {
    return this.field(text)
  }

  /** Append a unit to the open record (opens one if none is open). */
  field(value: BuilderValue): this {
    if (!this.inRecord) return this.rs(value)
    if (this.units === 0) {
      this.firstValue(value)
      return this
    }
    return this.us(value)
  }

  /** A keyed record: a map, entries in the order given. */
  map(pairs: Pairs): this {
    this.rs()
    for (const [k, v] of pairEntries(pairs)) this.soh(k).us(v)
    return this
  }

  /** One keyed unit on the open record (order is the caller's); a function value writes a nested level. */
  key(name: string, value: BuilderValue | (() => void)): this {
    if (!this.inRecord) this.rs()
    if (typeof value === 'function') {
      this.soh(name).us()
      this.openLevel(value)
      return this
    }
    return this.soh(name).us(value)
  }

  // ---- values that are not plain -------------------------------------

  /** A nested level as the next unit. Inside the function the builder is at the top of a fresh body. */
  level(fn: () => void): this {
    this.nextUnit()
    this.openLevel(fn)
    return this
  }

  /** A flat list as the next unit: a level holding one record. */
  list(items: BuilderValue[]): this {
    this.nextUnit()
    this.dle()
    if (items.length > 0) {
      this.rs()
      for (const it of items) this.field(it)
    }
    return this.can()
  }

  /** A reference as the next unit: a group name, or a path of two or three names. */
  ref(...path: string[]): this {
    if (path.length === 0 || path.length > 3) throw new C0Error('a reference has one to three segments')
    this.nextUnit()
    return this.enq(...path)
  }

  // ---- comments ----------------------------------------------------------

  /**
   * A note at the current position. Content is required: a bare BEL is a
   * dead marker, written with `bel()`.
   */
  note(text: BuilderValue): this {
    if (toBytes(text).length === 0) throw new C0Error(EMPTY_NOTE)
    return this.bel(text)
  }

  // ---- internals ---------------------------------------------------------

  private endRecord(): void {
    this.inRecord = false
    this.units = 0
  }

  /**
   * Position for the next unit of the open record (opening one if needed):
   * US between units, nothing before the first.
   */
  private nextUnit(): void {
    if (!this.inRecord) this.rs()
    else if (this.units > 0) this.io.push(US)
    this.units++
  }

  /** The first value of a record, straight after RS. */
  private firstValue(value: BuilderValue): void {
    writeValue(this.io, value)
    this.units = 1
  }

  private openLevel(fn: () => void): void {
    this.dle()
    fn()
    this.can()
  }
}

/** Build a buffer with a Builder. */
export function build(fn: (b: Builder) => void): Uint8Array {
  return Builder.build(fn)
}
