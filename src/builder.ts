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
 * Values are written in their one spelling: plain when they can be, text
 * otherwise. Keyed records (`map`) keep the order given. Nested levels
 * (`level`, `list`, `key` with a function) open with DLE and close with CAN.
 */
import { SOH, STX, ETX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, FS, GS, RS, US } from './constants.js'
import { C0Error } from './error.js'
import { writeValue, writeName, isName, isPlain } from './core.js'
import { ByteWriter, toBytes, utf8, type ByteSource } from './bytes.js'

export type BuilderValue = ByteSource

/** Keyed pairs: an object (insertion order), a Map, or an array of [key, value]. */
export type Pairs = { [key: string]: BuilderValue } | Map<string, BuilderValue> | [string, BuilderValue][]

export function pairEntries(pairs: Pairs): [string, BuilderValue][] {
  if (pairs instanceof Map) return Array.from(pairs.entries())
  if (Array.isArray(pairs)) return pairs
  return Object.entries(pairs)
}

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

  // ---- documents -------------------------------------------------------

  /** SYN and a heading. Keys in the order given; values written as values. */
  syn(pairs: Pairs = {}): this {
    this.endRecord()
    this.io.push(SYN)
    for (const [k, v] of pairEntries(pairs)) {
      this.io.push(SOH)
      writeName(this.io, k)
      this.io.push(US)
      writeValue(this.io, v)
    }
    return this
  }

  /** A heading key whose value is a nested level (e.g. the blob table). */
  headingLevel(key: string, fn: () => void): this {
    this.endRecord()
    this.io.push(SOH)
    writeName(this.io, key)
    this.io.push(US)
    this.openLevel(fn)
    return this
  }

  eot(): this {
    this.endRecord()
    this.io.push(EOT)
    return this
  }

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

  // ---- structure -------------------------------------------------------

  file(name: string, fn?: () => void): this {
    this.endRecord()
    this.io.push(FS)
    writeName(this.io, name)
    if (fn) fn()
    return this
  }

  group(name: string, headers?: string[] | null, fn?: () => void, depth: number = 1): this {
    this.endRecord()
    for (let i = 0; i < depth; i++) this.io.push(GS)
    writeName(this.io, name)
    if (headers) this.header(headers)
    if (fn) fn()
    return this
  }

  /** A header row: SOH RS names. */
  header(names: string[]): this
  header(...names: string[]): this
  header(...args: (string | string[])[]): this {
    const names = args.length === 1 && Array.isArray(args[0]) ? args[0] : (args as string[])
    this.endRecord()
    this.io.push(SOH)
    this.io.push(RS)
    names.forEach((n, i) => {
      if (i > 0) this.io.push(US)
      writeName(this.io, n)
    })
    return this
  }

  /** Document mode: a section at depth. */
  section(name: string, depth: number = 1, fn?: () => void): this {
    return this.group(name, null, fn, depth)
  }

  // ---- records -----------------------------------------------------------

  /** A positional record; with no fields, begins a record left open for `field` / `level` / `list` / `key`. */
  record(...fields: BuilderValue[]): this {
    this.startRecord()
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
    this.nextUnit()
    writeValue(this.io, value)
    return this
  }

  /** A keyed record: a map, entries in the order given. */
  map(pairs: Pairs): this {
    this.startRecord()
    for (const [k, v] of pairEntries(pairs)) this.key(k, v)
    return this
  }

  /** One keyed unit on the open record (order is the caller's); a function value writes a nested level. */
  key(name: string, value: BuilderValue | (() => void)): this {
    if (!this.inRecord) this.startRecord()
    this.io.push(SOH)
    writeName(this.io, name)
    this.io.push(US)
    this.units++
    if (typeof value === 'function') this.openLevel(value)
    else writeValue(this.io, value)
    return this
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
    this.io.push(DLE)
    if (items.length > 0) {
      this.io.push(RS)
      items.forEach((it, i) => {
        if (i > 0) this.io.push(US)
        writeValue(this.io, it)
      })
    }
    this.io.push(CAN)
    return this
  }

  /** A reference as the next unit: a group name, or a path of two or three names. */
  ref(...path: string[]): this {
    if (path.length === 0 || path.length > 3) throw new C0Error('a reference has one to three segments')
    this.nextUnit()
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

  // ---- comments ----------------------------------------------------------

  /** A note at the current position (record level, or as an empty unit). */
  note(text: BuilderValue): this {
    this.io.push(BEL)
    const bytes = toBytes(text)
    if (isPlain(bytes) && bytes.length > 0) this.io.write(bytes)
    else writeValue(this.io, bytes)
    return this
  }

  // ---- internals ---------------------------------------------------------

  private startRecord(): void {
    this.io.push(RS)
    this.inRecord = true
    this.units = 0
  }

  private endRecord(): void {
    this.inRecord = false
    this.units = 0
  }

  private nextUnit(): void {
    if (!this.inRecord) this.startRecord()
    if (this.units > 0) this.io.push(US)
    this.units++
  }

  private openLevel(fn: () => void): void {
    this.stack.push([this.inRecord, this.units])
    this.inRecord = false
    this.units = 0
    this.io.push(DLE)
    fn()
    this.io.push(CAN)
    const st = this.stack.pop()!
    this.inRecord = st[0]
    this.units = st[1]
  }
}

/** Build a buffer with a Builder. */
export function build(fn: (b: Builder) => void): Uint8Array {
  return Builder.build(fn)
}
