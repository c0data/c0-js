/** Documents: SYN heading, body, EOT; and containers of several documents with an EM tail. */
import { SOH, STX, EOT, ENQ, BEL, DLE, SYN, EM, CAN, RS, US } from './constants.js'
import { C0SyntaxError } from './error.js'
import { scanLayout, scanText, scanLevel, scanPlain, scanUnit, scanComment, trim, value as logicalValue } from './core.js'
import { Body, Group, Record, FileView } from './body.js'
import { EMPTY, bytesEqual, encoder, utf8 } from './bytes.js'

const KNOWN_KEYS = new Set(['shape', 'version', 'blob'])

/** The heading of a document: keyed units after SYN. Last wins for duplicate keys. */
export class Heading {
  /** [key, logical value] in written order; a level's value is its raw bytes (DLE … CAN). */
  readonly pairs: [Uint8Array, Uint8Array][]
  readonly raw: Uint8Array
  private readonly rawPairs: [Uint8Array, Uint8Array][]

  constructor(raw: Uint8Array, pairs: [Uint8Array, Uint8Array][], rawPairs: [Uint8Array, Uint8Array][] = pairs) {
    this.raw = raw
    this.pairs = pairs
    this.rawPairs = rawPairs
  }

  static empty(): Heading {
    return new Heading(EMPTY, [], [])
  }

  /** Logical value for a key (last wins), or undefined. */
  get(key: string): Uint8Array | undefined {
    const want = encoder.encode(key)
    let found: Uint8Array | undefined
    for (const [k, v] of this.pairs) if (bytesEqual(k, want)) found = v
    return found
  }

  getString(key: string): string | undefined {
    const v = this.get(key)
    return v === undefined ? undefined : utf8(v)
  }

  get keys(): Uint8Array[] {
    return this.pairs.map(p => p[0])
  }

  get shape(): string | undefined {
    return this.getString('shape')
  }

  get version(): number {
    const v = this.getString('version')
    if (v === undefined) return 1
    const n = parseInt(v, 10)
    return Number.isNaN(n) ? 1 : n
  }

  /** The blob table as a Body, when declared. */
  get blob(): Body | undefined {
    const r = this.rawBlob
    return r === undefined ? undefined : new Body(r, 1, scanLevel(r, 0) - 1)
  }

  /** Raw unit of the blob key (a level), or undefined. */
  get rawBlob(): Uint8Array | undefined {
    const want = encoder.encode('blob')
    let found: Uint8Array | undefined
    for (const [k, v] of this.rawPairs) if (bytesEqual(k, want)) found = v
    return found
  }

  get isEmpty(): boolean {
    return this.pairs.length === 0
  }
}

/**
 * One C0DATA document: an optional SYN heading, a body, an optional EOT.
 * `new Document(buf)` reads the first document in the buffer. Use
 * `Container` for a buffer holding several documents or an EM tail.
 */
export class Document {
  readonly buf: Uint8Array
  readonly heading: Heading
  readonly body: Body
  readonly start: number
  /** Position after EOT (or the end of the document). */
  readonly stop: number
  readonly hasSyn: boolean
  readonly hasEot: boolean
  readonly warnings: string[] = []

  constructor(buf: Uint8Array, start: number = 0) {
    this.buf = buf
    this.start = start
    const len = buf.length
    let pos = scanLayout(buf, start, len)
    this.hasSyn = pos < len && buf[pos] === SYN
    if (this.hasSyn) {
      pos++
      const [h, p] = parseHeading(buf, pos, len)
      this.heading = h
      pos = p
    } else {
      this.warnings.push('no SYN at the start of the document')
      this.heading = Heading.empty()
    }
    const bodyStart = pos
    const bodyEnd = findBodyEnd(buf, pos, len)
    this.body = new Body(buf, bodyStart, bodyEnd)
    pos = scanLayout(buf, bodyEnd, len)
    this.hasEot = pos < len && buf[pos] === EOT
    if (this.hasEot) {
      pos++
    } else if (this.heading.shape !== 'stream') {
      this.warnings.push('no EOT at the end of the document')
    }
    this.stop = pos
    for (const k of this.heading.keys) {
      const s = utf8(k)
      if (!KNOWN_KEYS.has(s)) this.warnings.push(`unknown heading key '${s}'`)
    }
  }

  // Convenience accessors over the body.
  get name(): Uint8Array { return this.body.name }
  get files(): FileView[] { return this.body.files }
  get groupCount(): number { return this.body.groupCount }
  group(key: number | string): Group { return this.body.group(key) }
  eachGroup(cb: (g: Group) => void): void { this.body.eachGroup(cb) }
  get groups(): Group[] { return this.body.groups }
  get groupNames(): Uint8Array[] { return this.body.groupNames }
  get records(): Record[] { return this.body.records }
  get shape(): string | undefined { return this.heading.shape }

  get raw(): Uint8Array {
    return this.buf.subarray(this.start, this.stop)
  }
}

/** Parse keyed units after SYN. Returns [heading, position of the first body code]. */
export function parseHeading(buf: Uint8Array, pos: number, len: number = buf.length): [Heading, number] {
  const hs = pos
  const pairs: [Uint8Array, Uint8Array][] = []
  const rawPairs: [Uint8Array, Uint8Array][] = []
  for (;;) {
    pos = scanLayout(buf, pos, len)
    if (pos >= len) break
    const b = buf[pos]
    if (b === SOH) {
      const p2 = scanLayout(buf, pos + 1, len)
      if (p2 < len && buf[p2] === RS) break
      const ks = p2
      const ke = scanPlain(buf, ks, len)
      if (!(ke < len && buf[ke] === US)) throw new C0SyntaxError('key without a value (no US)', ke)
      const vs = ke + 1
      const ve = scanUnit(buf, vs, len)
      const key = trim(buf.subarray(ks, ke))
      const rawv = trim(buf.subarray(vs, ve))
      if (rawv.length > 0 && rawv[0] === ENQ) throw new C0SyntaxError('reference in a heading', vs)
      rawPairs.push([key, rawv])
      pairs.push([key, rawv.length > 0 && rawv[0] === DLE ? rawv : logicalValue(rawv)])
      pos = ve
    } else if (b === BEL) {
      pos = scanComment(buf, pos, len)
    } else if (b >= 0x20) {
      throw new C0SyntaxError('plain text directly after SYN', pos)
    } else {
      break
    }
  }
  return [new Heading(buf.subarray(hs, pos), pairs, rawPairs), pos]
}

// Scan from the start of a body to its end: EOT, SYN, EM or end of input
// at depth zero, skipping text and levels.
function findBodyEnd(buf: Uint8Array, pos: number, len: number): number {
  while (pos < len) {
    const b = buf[pos]
    if (b >= 0x20) pos++
    else if (b === STX) pos = scanText(buf, pos, len)
    else if (b === DLE) pos = scanLevel(buf, pos, len)
    else if (b === EOT || b === SYN || b === EM) return pos
    else if (b === CAN) throw new C0SyntaxError('CAN with no open level', pos)
    else pos++
  }
  return pos
}

/** A file or message: one or more documents and an optional raw tail after EM. */
export class Container {
  readonly documents: Document[] = []
  readonly tail: Uint8Array = EMPTY
  readonly hasEm: boolean = false

  constructor(buf: Uint8Array) {
    const len = buf.length
    let pos = scanLayout(buf, 0, len)
    while (pos < len) {
      if (buf[pos] === EM) {
        this.hasEm = true
        this.tail = buf.subarray(pos + 1)
        break
      }
      const doc = new Document(buf, pos)
      this.documents.push(doc)
      pos = scanLayout(buf, doc.stop, len)
      if (pos < len && buf[pos] !== SYN && buf[pos] !== EM) throw new C0SyntaxError('unexpected byte after EOT', pos)
    }
  }

  get first(): Document {
    return this.documents[0]
  }

  /** The blob table from the first document's heading. */
  get blobTable(): Body | undefined {
    return this.documents[0]?.heading.blob
  }

  /** Bytes of a named blob from the tail, or undefined. */
  blob(name: string): Uint8Array | undefined {
    const table = this.blobTable
    if (!table) return undefined
    const g = table.groups[0]
    if (!g) return undefined
    const col = (n: string, dflt: number): number => { const i = g.column(n); return i < 0 ? dflt : i }
    const ni = col('name', 0)
    const oi = col('offset', 1)
    const li = col('length', 2)
    const want = encoder.encode(name)
    let found: Uint8Array | undefined
    for (const r of g.records) {
      if (!bytesEqual(r.value(ni), want)) continue
      const off = parseInt(r.string(oi), 10)
      const length = parseInt(r.string(li), 10)
      found = this.tail.subarray(off, off + length)
    }
    return found
  }
}
