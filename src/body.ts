/**
 * Zero-copy navigator for a document body: the bytes between a heading
 * and EOT, or the inside of a nested level. Indexes files, groups,
 * header rows and records once; everything it returns is a view into
 * the original buffer.
 *
 * Records before the first GS of a file form an unnamed group; records
 * and groups before the first FS form an unnamed file.
 */
import { SOH, STX, ENQ, BEL, DLE, ETB, FS, GS, RS, US, isLayout } from './constants.js'
import { C0Error, C0SyntaxError, KeyError } from './error.js'
import {
  scanLayout, scanText, scanLevel, scanPlain, scanUnit, scanComment, scanRecordEnd,
  trim, value as logicalValue, decodeText,
} from './core.js'
import { EMPTY, bytesEqual, encoder, utf8 } from './bytes.js'

export class Body {
  readonly buf: Uint8Array
  readonly start: number
  readonly stop: number
  readonly files: FileView[] = []

  constructor(buf: Uint8Array, start: number = 0, stop: number = buf.length) {
    this.buf = buf
    this.start = start
    this.stop = stop
    this.index()
  }

  /** All groups of all files, in order. */
  get groups(): Group[] {
    const out: Group[] = []
    for (const f of this.files) out.push(...f.groups)
    return out
  }

  /** Groups of the first file. */
  get groupCount(): number {
    return this.firstFile.groups.length
  }

  group(key: number | string): Group {
    return typeof key === 'number' ? this.firstFile.groups[key] : this.firstFile.group(key)
  }

  eachGroup(cb: (g: Group) => void): void {
    for (const g of this.firstFile.groups) cb(g)
  }

  get groupNames(): Uint8Array[] {
    return this.firstFile.groups.map(g => g.name)
  }

  /** Name of the first file (empty when the body has no FS). */
  get name(): Uint8Array {
    return this.firstFile.name
  }

  /** Records of the body when it is a bare record stream: the unnamed group's records. */
  get records(): Record[] {
    const g = this.firstFile.groups[0]
    return g ? g.records : []
  }

  get recordCount(): number {
    return this.records.length
  }

  record(i: number): Record {
    return this.records[i]
  }

  eachRecord(cb: (r: Record) => void): void {
    for (const r of this.records) cb(r)
  }

  /** Whether the body is just records: one unnamed file, one unnamed group. */
  get bare(): boolean {
    const f = this.files
    return f.length === 1 && f[0].name.length === 0 && f[0].groups.length <= 1 &&
      (f[0].groups.length === 0 || f[0].groups[0].depth === 0)
  }

  private get firstFile(): FileView {
    return this.files[0]
  }

  get raw(): Uint8Array {
    return this.buf.subarray(this.start, this.stop)
  }

  // ------------------------------------------------------------------
  private index(): void {
    const buf = this.buf
    const stop = this.stop
    let pos = scanLayout(buf, this.start, stop)
    // leading unnamed file
    const file = new FileView(buf, 0, 0, [])
    pos = this.indexPart(pos, file)
    const fsNext = pos < stop && (buf[pos] === FS || this.deadFS(pos))
    if (!(file.groups.length === 0 && fsNext)) this.files.push(file)
    let current = file
    while (pos < stop) {
      let b = buf[pos]
      let dead = false
      if (b === BEL && this.deadFS(pos)) {
        dead = true
        pos = scanLayout(buf, pos + 1, stop)
        b = FS
      }
      if (b !== FS) break
      pos = scanLayout(buf, pos + 1, stop)
      const ns = pos
      pos = scanPlain(buf, pos, stop)
      if (dead) {
        // a dead file line: what follows still belongs to the file before
        pos = this.indexPart(pos, current, current.groups[current.groups.length - 1])
      } else {
        const f = new FileView(buf, ns, pos, [])
        pos = this.indexPart(pos, f)
        this.files.push(f)
        current = f
      }
    }
    if (file.groups.length > 0 && !this.files.includes(file)) this.files.unshift(file)
    if (this.files.length === 0) this.files.push(new FileView(buf, 0, 0, []))
  }

  private deadFS(pos: number): boolean {
    const buf = this.buf
    if (!(pos < this.stop && buf[pos] === BEL)) return false
    const p2 = scanLayout(buf, pos + 1, this.stop)
    return p2 < this.stop && buf[p2] === FS
  }

  // Index one part: leading items (the unnamed group, or `into` after a
  // dead file line), then groups. Returns the position of the next FS (or
  // dead FS), or stop.
  private indexPart(pos: number, file: FileView, into?: Group): number {
    const buf = this.buf
    const stop = this.stop
    const g = into ?? new Group(buf, 0, 0, 0, undefined, [])
    pos = this.indexGroupContents(pos, g)
    if (!into && (g.header || g.records.length > 0)) file.groups.push(g)
    let current = g
    while (pos < stop) {
      let b = buf[pos]
      let dead = false
      if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 < stop && buf[p2] === GS) {
          dead = true
          pos = p2
          b = GS
        } else {
          break
        }
      }
      if (b !== GS) break
      let depth = 0
      while (pos < stop && (buf[pos] === GS || isLayout(buf[pos]))) {
        if (buf[pos] === GS) depth++
        pos++
      }
      const ns = pos
      pos = scanPlain(buf, pos, stop)
      if (dead) {
        // a dead group line: what follows still belongs to the group before
        pos = this.indexGroupContents(pos, current)
        if (current === g && !into && !file.groups.includes(g) && (g.header || g.records.length > 0)) file.groups.push(g)
      } else {
        const grp = new Group(buf, depth, ns, pos, undefined, [])
        pos = this.indexGroupContents(pos, grp)
        file.groups.push(grp)
        current = grp
      }
    }
    return pos
  }

  // After a group label (or at the start of a part): notes, header row,
  // items. Returns the position of the next GS/FS/dead GS/FS or stop.
  private indexGroupContents(pos: number, grp: Group): number {
    const buf = this.buf
    const stop = this.stop
    let firstItem = true
    for (;;) {
      pos = scanLayout(buf, pos, stop)
      if (pos >= stop) break
      const b = buf[pos]
      if (b === RS) {
        firstItem = false
        const rs = pos + 1
        pos = scanRecordEnd(buf, rs, stop)
        grp.records.push(new Record(buf, rs, this.trimEnd(rs, pos)))
      } else if (b === SOH) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (!(p2 < stop && buf[p2] === RS)) throw new C0SyntaxError('keyed unit outside a record', pos)
        if (!firstItem) throw new C0SyntaxError('header row not at the start of its group', pos)
        firstItem = false
        const hs = p2 + 1
        pos = scanRecordEnd(buf, hs, stop)
        grp.header = new Record(buf, hs, this.trimEnd(hs, pos))
      } else if (b === ETB) {
        pos = scanPlain(buf, scanLayout(buf, pos + 1, stop), stop)
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, stop)
        if (p2 >= stop || buf[p2] >= 0x20 || buf[p2] === STX) {
          pos = scanComment(buf, pos, stop) // a note
        } else if (buf[p2] === RS || buf[p2] === SOH) {
          pos = scanComment(buf, pos, stop) // dead record / header row / keyed unit
          if (buf[p2] === RS) firstItem = false
        } else {
          break // dead GS or FS: the caller's business
        }
      } else {
        break
      }
    }
    return pos
  }

  private trimEnd(start: number, stop: number): number {
    while (stop > start && isLayout(this.buf[stop - 1])) stop--
    return stop
  }
}

/** A file within a body: its name and groups. */
export class FileView {
  private readonly buf: Uint8Array
  private readonly nameStart: number
  private readonly nameEnd: number
  readonly groups: Group[]

  constructor(buf: Uint8Array, nameStart: number, nameEnd: number, groups: Group[]) {
    this.buf = buf
    this.nameStart = nameStart
    this.nameEnd = nameEnd
    this.groups = groups
  }

  get name(): Uint8Array {
    return trim(this.buf.subarray(this.nameStart, this.nameEnd))
  }

  group(name: string): Group {
    const want = encoder.encode(name)
    for (const g of this.groups) if (bytesEqual(g.name, want)) return g
    throw new KeyError(`No group named '${name}'`)
  }
}

/** A group: its depth (GS count; 0 for the unnamed leading group), name, optional header row and records. */
export class Group {
  private readonly buf: Uint8Array
  readonly depth: number
  private readonly nameStart: number
  private readonly nameEnd: number
  header: Record | undefined
  readonly records: Record[]

  constructor(buf: Uint8Array, depth: number, nameStart: number, nameEnd: number, header: Record | undefined, records: Record[]) {
    this.buf = buf
    this.depth = depth
    this.nameStart = nameStart
    this.nameEnd = nameEnd
    this.header = header
    this.records = records
  }

  get name(): Uint8Array {
    return trim(this.buf.subarray(this.nameStart, this.nameEnd))
  }

  get hasHeader(): boolean {
    return this.header !== undefined
  }

  /** Header names, or an empty array. */
  get headers(): Uint8Array[] {
    return this.header ? this.header.values : []
  }

  get headerCount(): number {
    return this.header ? this.header.fieldCount : 0
  }

  headerName(i: number): Uint8Array {
    return this.headers[i]
  }

  get recordCount(): number {
    return this.records.length
  }

  record(i: number): Record {
    return this.records[i]
  }

  eachRecord(cb: (r: Record) => void): void {
    for (const r of this.records) cb(r)
  }

  /** Index of a header name, or -1. */
  column(name: string): number {
    const want = encoder.encode(name)
    return this.headers.findIndex(h => bytesEqual(h, want))
  }

  /** Compatibility: the group as a Table is itself. */
  get table(): Group {
    return this
  }
}

/** A tabular group. */
export const Table = Group
export type Table = Group

/** A record: positional or keyed. Zero-copy accessors. */
export class Record {
  private readonly buf: Uint8Array
  private readonly start: number
  private readonly end: number

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf
    this.start = start
    this.end = end
  }

  /** Raw bytes of the record (after its RS). */
  get raw(): Uint8Array {
    return this.buf.subarray(this.start, this.end)
  }

  /** Whether the record is keyed (its first unit is an SOH). */
  get keyed(): boolean {
    const buf = this.buf
    const end = this.end
    let p = scanLayout(buf, this.start, end)
    while (p < end && buf[p] === BEL) {
      const p2 = scanLayout(buf, p + 1, end)
      if (p2 < end && buf[p2] === SOH) return true
      if (p2 < end && buf[p2] < 0x20 && buf[p2] !== STX && buf[p2] !== DLE) break
      p = scanLayout(buf, scanComment(buf, p, end), end)
    }
    return p < end && buf[p] === SOH
  }

  // ---- positional -----------------------------------------------------

  /** Raw slice of unit n (layout at its edges included). */
  field(n: number): Uint8Array {
    for (const [i, s, e] of this.unitRanges()) if (i === n) return this.buf.subarray(s, e)
    return EMPTY
  }

  get fieldCount(): number {
    let count = 0
    for (const [i] of this.unitRanges()) count = i + 1
    return count
  }

  get fields(): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const [, s, e] of this.unitRanges()) out.push(this.buf.subarray(s, e))
    return out
  }

  /** Logical value of unit n. */
  value(n: number): Uint8Array {
    return logicalValue(this.field(n))
  }

  get values(): Uint8Array[] {
    return this.fields.map(f => logicalValue(f))
  }

  /** Logical value of unit n as a UTF-8 string. */
  string(n: number): string {
    return utf8(this.value(n))
  }

  get strings(): string[] {
    return this.values.map(utf8)
  }

  /** Unit n as a nested level. */
  level(n: number): Body {
    return levelOf(this.field(n))
  }

  /** Unit n as a flat list: a level holding at most one positional record. */
  list(n: number): Uint8Array[] {
    const body = this.level(n)
    const recs = body.records
    if (recs.length === 0 && body.bare) return []
    if (!(recs.length === 1 && body.bare)) throw new C0Error(`level is not a list (${recs.length} records)`)
    if (recs[0].keyed) throw new C0Error('level is not a list (keyed record)')
    return recs[0].values
  }

  /** Unit n as a reference. */
  ref(n: number): Reference {
    return Reference.parse(this.field(n))
  }

  // ---- keyed ---------------------------------------------------------

  /** Keys in written order. */
  get keys(): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const [k] of this.keyedRanges()) out.push(k)
    return out
  }

  /** Pairs in written order: [key, logical value]. */
  get pairs(): [Uint8Array, Uint8Array][] {
    const out: [Uint8Array, Uint8Array][] = []
    for (const [k, , , vs, ve] of this.keyedRanges()) out.push([k, logicalValue(this.buf.subarray(vs, ve))])
    return out
  }

  /** Raw unit for a key (last wins), or undefined. */
  keyField(key: string): Uint8Array | undefined {
    const want = encoder.encode(key)
    let found: Uint8Array | undefined
    for (const [k, , , vs, ve] of this.keyedRanges()) if (bytesEqual(k, want)) found = this.buf.subarray(vs, ve)
    return found
  }

  /** Logical value for a key (last wins), or undefined. */
  get(key: string): Uint8Array | undefined {
    const f = this.keyField(key)
    return f === undefined ? undefined : logicalValue(f)
  }

  /** Logical value for a key as a UTF-8 string, or undefined. */
  getString(key: string): string | undefined {
    const v = this.get(key)
    return v === undefined ? undefined : utf8(v)
  }

  /** The level under a key, or undefined. */
  keyLevel(key: string): Body | undefined {
    const f = this.keyField(key)
    return f === undefined ? undefined : levelOf(f)
  }

  has(key: string): boolean {
    return this.keyField(key) !== undefined
  }

  // ---- shared ---------------------------------------------------------

  // Yields [index, start, end] for each positional unit.
  private *unitRanges(): Generator<[number, number, number]> {
    const buf = this.buf
    const end = this.end
    let pos = scanLayout(buf, this.start, end)
    if (pos < end && buf[pos] === SOH) return
    let idx = 0
    let unitStart = this.start
    for (;;) {
      pos = scanUnit(buf, pos, end)
      yield [idx, unitStart, pos]
      if (!(pos < end && buf[pos] === US)) break
      idx++
      pos++
      unitStart = pos
    }
  }

  // Yields [key, keyStart, keyEnd, valueStart, valueEnd] per keyed unit.
  private *keyedRanges(): Generator<[Uint8Array, number, number, number, number]> {
    const buf = this.buf
    const end = this.end
    let pos = scanLayout(buf, this.start, end)
    while (pos < end) {
      const b = buf[pos]
      if (b === SOH) {
        const ks = scanLayout(buf, pos + 1, end)
        const ke = scanPlain(buf, ks, end)
        if (!(ke < end && buf[ke] === US)) throw new C0SyntaxError('key without a value (no US)', ke)
        const vs = ke + 1
        const ve = scanUnit(buf, vs, end)
        yield [trim(buf.subarray(ks, ke)), ks, ke, vs, ve]
        pos = ve
      } else if (b === BEL) {
        pos = scanComment(buf, pos, end)
      } else if (isLayout(b)) {
        pos++
      } else {
        return
      }
    }
  }
}

/** The body of a raw level unit (DLE … CAN). */
export function levelOf(raw: Uint8Array): Body {
  const t = trim(raw)
  if (!(t.length > 0 && t[0] === DLE)) throw new C0Error('unit is not a nested level')
  const stop = scanLevel(t, 0)
  return new Body(t, 1, stop - 1)
}

/** A reference: a group name, or a path of two or three segments. */
export class Reference {
  readonly path: Uint8Array[]

  constructor(path: Uint8Array[]) {
    this.path = path
  }

  static parse(raw: Uint8Array): Reference {
    const t = trim(raw)
    if (!(t.length > 0 && t[0] === ENQ)) throw new C0Error('unit is not a reference')
    const p = scanLayout(t, 1)
    if (p < t.length && t[p] === STX) {
      const stop = scanText(t, p)
      const inside = decodeText(t.subarray(p + 1, stop - 1))
      const segs: Uint8Array[] = []
      let s = 0
      for (let i = 0; i < inside.length; i++) {
        if (inside[i] === US) {
          segs.push(inside.subarray(s, i))
          s = i + 1
        }
      }
      segs.push(inside.subarray(s))
      if (segs.length > 3) throw new C0SyntaxError('reference path with more than three segments', p)
      if (segs.some(x => x.length === 0)) throw new C0SyntaxError('reference path with an empty segment', p)
      return new Reference(segs)
    }
    const name = trim(t.subarray(p))
    if (name.length === 0) throw new C0SyntaxError('reference without a name', p)
    return new Reference([name])
  }

  get group(): Uint8Array {
    return this.path[0]
  }

  get record(): Uint8Array | undefined {
    return this.path[1]
  }

  get field(): Uint8Array | undefined {
    return this.path[2]
  }

  get isGroup(): boolean {
    return this.path.length === 1
  }

  /** The path as strings. */
  get segments(): string[] {
    return this.path.map(utf8)
  }
}
