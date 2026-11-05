/**
 * C0-DIFF: atomic multi-file edits with anchored patterns (DIFF.md).
 *
 *   const diff = buildDiff(d => {
 *     d.file('greeting.txt', () => {
 *       d.section(s => { s.anchor('Hello '); s.sub('world', 'universe'); s.anchor('!') })
 *     })
 *     d.file('tally.rb', () => {
 *       d.section(s => { s.anchor('def tally(items)') })
 *       d.replaceAll('count', 'total')
 *       d.section(s => { s.anchor('end') })
 *     })
 *   })
 *   applyDiff(diff, { 'greeting.txt': 'Hello world!' })
 */
import { SOH, STX, EOT, BEL, SYN, ETB, EM, SUB, FS, GS, RS, US } from './constants.js'
import { C0Error, C0SyntaxError } from './error.js'
import { scanLayout, scanText, scanPlain, scanComment, trim, decodeText, writeValue, writeName } from './core.js'
import { parseHeading } from './document.js'
import { ByteWriter, EMPTY, concat, encoder, utf8 } from './bytes.js'

export class DiffError extends C0Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffError'
  }
}

/** One unit of a pattern: an anchor (`new` is null) or a substitution. */
export class Unit {
  readonly old: Uint8Array
  readonly new: Uint8Array | null

  constructor(old: Uint8Array, new_: Uint8Array | null) {
    this.old = old
    this.new = new_
  }

  get isAnchor(): boolean {
    return this.new === null
  }
}

/** A section: one anchored pattern, plus the replace-alls that follow it. */
export class Section {
  readonly units: Unit[]
  readonly replaces: [Uint8Array, Uint8Array][]

  constructor(units: Unit[], replaces: [Uint8Array, Uint8Array][] = []) {
    this.units = units
    this.replaces = replaces
  }

  get search(): Uint8Array {
    return concat(this.units.map(u => u.old))
  }

  get replacement(): Uint8Array {
    return concat(this.units.map(u => u.new ?? u.old))
  }
}

/** A file's edits: replace-alls before any section apply to the whole file (up to the first match). */
export interface FileEdit {
  readonly path: string
  readonly leadingReplaces: [Uint8Array, Uint8Array][]
  readonly sections: Section[]
}

/** Parse a diff document (with or without its SYN heading). */
export function parseDiff(buf: Uint8Array): FileEdit[] {
  const len = buf.length
  let pos = scanLayout(buf, 0, len)
  if (pos < len && buf[pos] === SYN) {
    const [heading, p] = parseHeading(buf, pos + 1, len)
    pos = p
    const shape = heading.shape
    if (shape !== undefined && shape !== 'diff') throw new DiffError(`heading declares shape '${shape}', not diff`)
  }
  const files: FileEdit[] = []
  let path: string | null = null
  let leading: [Uint8Array, Uint8Array][] = []
  let sections: Section[] = []
  const flush = (): void => {
    if (path !== null) files.push({ path, leadingReplaces: leading, sections })
    leading = []
    sections = []
  }
  while (pos < len) {
    pos = scanLayout(buf, pos, len)
    if (pos >= len) break
    let b = buf[pos]
    let dead = false
    if (b === BEL) {
      const p2 = scanLayout(buf, pos + 1, len)
      if (p2 < len && (buf[p2] === FS || buf[p2] === GS || buf[p2] === RS)) {
        dead = true
        pos = p2
        b = buf[pos]
      } else {
        pos = scanComment(buf, pos, len) // a note
        continue
      }
    }
    switch (b) {
      case FS: {
        const [name, p] = readName(buf, pos + 1, len)
        pos = p
        if (!dead) {
          flush()
          if (files.some(f => f.path === name)) throw new DiffError(`the same path twice: ${name}`)
          path = name
        }
        break
      }
      case GS: {
        if (path === null) throw new DiffError('section before any file')
        const [units, p] = parsePattern(buf, pos + 1, len)
        pos = p
        if (!dead) sections.push(new Section(units))
        break
      }
      case RS: {
        if (path === null) throw new DiffError('replace-all before any file')
        const [old, p1] = readDValue(buf, pos + 1, len)
        pos = p1
        if (old.length === 0) throw new DiffError('replace-all with an empty old part')
        if (!(pos < len && buf[pos] === SUB)) throw new DiffError('replace-all without SUB')
        const [nw, p2] = readDValue(buf, pos + 1, len)
        pos = p2
        if (!dead) {
          if (sections.length === 0) leading.push([old, nw])
          else sections[sections.length - 1].replaces.push([old, nw])
        }
        break
      }
      case ETB:
        pos = scanPlain(buf, scanLayout(buf, pos + 1, len), len)
        break
      case EOT:
        pos = scanLayout(buf, pos + 1, len)
        if (pos < len && buf[pos] !== SYN && buf[pos] !== EM) throw new C0SyntaxError('unexpected byte after EOT', pos)
        flush()
        return files
      default:
        throw new C0SyntaxError('unexpected byte in a diff body', pos)
    }
  }
  flush()
  return files
}

/**
 * Apply a diff to in-memory files (UTF-8 strings). Validates everything
 * first; throws without touching the input on any error. Returns the
 * edited files (unmodified ones included).
 */
export function applyDiff(diff: Uint8Array, files: Map<string, string> | { [path: string]: string }): Map<string, string> {
  const input = files instanceof Map ? files : new Map(Object.entries(files))
  const bytes = new Map<string, Uint8Array>()
  for (const [k, v] of input) bytes.set(k, encoder.encode(v))
  const out = new Map<string, string>()
  for (const [k, v] of applyDiffBytes(diff, bytes)) out.set(k, utf8(v))
  return out
}

/** Apply a diff to in-memory files given as bytes. */
export function applyDiffBytes(diff: Uint8Array, files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const edits = parseDiff(diff)
  const results = new Map<string, Uint8Array>()
  for (const e of edits) {
    const content = files.get(e.path)
    if (content === undefined) throw new DiffError(`no such file: ${e.path}`)
    results.set(e.path, applyFileEdit(content, e))
  }
  const out = new Map(files)
  for (const [k, v] of results) out.set(k, v)
  return out
}

/**
 * Apply a diff to files on disk under `baseDir` (Node only), atomically:
 * every file is validated before any is written, and each is written via
 * a temporary file and rename.
 */
export async function applyDiffFiles(diff: Uint8Array, baseDir: string = '.'): Promise<void> {
  const fs = await import('node:fs')
  const nodePath = await import('node:path')
  const edits = parseDiff(diff)
  const base = nodePath.resolve(baseDir)
  const planned: [string, Uint8Array][] = []
  for (const e of edits) {
    const target = nodePath.resolve(base, e.path)
    if (!(target === base || target.startsWith(base + nodePath.sep))) throw new DiffError(`path escapes the target directory: ${e.path}`)
    if (!fs.existsSync(target)) throw new DiffError(`no such file: ${e.path}`)
    planned.push([target, applyFileEdit(fs.readFileSync(target), e)])
  }
  for (const [target, bytes] of planned) {
    const tmp = target + '.c0diff.tmp'
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, target)
  }
}

/** Apply one file's edits (DIFF.md "Sections", "Replace-all"). */
export function applyFileEdit(data: Uint8Array, edit: FileEdit): Uint8Array {
  let cursor = 0
  const matches: [number, number, Uint8Array][] = []
  for (const sec of edit.sections) {
    const search = sec.search
    if (search.length === 0) throw new DiffError(`empty search text in ${edit.path}`)
    const first = find(data, search, cursor)
    if (first < 0) throw new DiffError(`pattern not found in ${edit.path}: ${JSON.stringify(utf8(search))}`)
    if (find(data, search, first + 1) >= 0) throw new DiffError(`pattern matched more than once in ${edit.path}: ${JSON.stringify(utf8(search))}`)
    matches.push([first, first + search.length, sec.replacement])
    cursor = first + search.length
  }
  // scopes: before the first match, and after each match to the next
  const io = new ByteWriter()
  const firstStart = matches.length === 0 ? data.length : matches[0][0]
  io.write(replaceAll(data.subarray(0, firstStart), edit.leadingReplaces, edit.path))
  matches.forEach(([, e, repl], i) => {
    io.write(repl)
    const nxt = i + 1 < matches.length ? matches[i + 1][0] : data.length
    io.write(replaceAll(data.subarray(e, nxt), edit.sections[i].replaces, edit.path))
  })
  return io.toUint8Array()
}

function replaceAll(segment: Uint8Array, replaces: [Uint8Array, Uint8Array][], path: string): Uint8Array {
  for (const [old, nw] of replaces) {
    let count = 0
    const io = new ByteWriter()
    let pos = 0
    let i: number
    while ((i = find(segment, old, pos)) >= 0) {
      io.write(segment.subarray(pos, i))
      io.write(nw)
      pos = i + old.length
      count++
    }
    if (count === 0) throw new DiffError(`replace-all found nothing in ${path}: ${JSON.stringify(utf8(old))}`)
    io.write(segment.subarray(pos))
    segment = io.toUint8Array()
  }
  return segment
}

function find(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return -1
  const last = hay.length - needle.length
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== needle[0]) continue
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function readName(buf: Uint8Array, pos: number, len: number): [string, number] {
  pos = scanLayout(buf, pos, len)
  if (pos < len && buf[pos] === STX) throw new C0SyntaxError('a path cannot be text', pos)
  const stop = scanPlain(buf, pos, len)
  return [utf8(trim(buf.subarray(pos, stop))), stop]
}

function readDValue(buf: Uint8Array, pos: number, len: number): [Uint8Array, number] {
  pos = scanLayout(buf, pos, len)
  if (pos >= len) return [EMPTY, pos]
  if (buf[pos] === STX) {
    const stop = scanText(buf, pos, len)
    return [decodeText(buf.subarray(pos + 1, stop - 1)), scanLayout(buf, stop, len)]
  }
  if (buf[pos] >= 0x20) {
    const stop = scanPlain(buf, pos, len)
    return [trim(buf.subarray(pos, stop)), stop]
  }
  return [EMPTY, pos]
}

function parsePattern(buf: Uint8Array, pos: number, len: number): [Unit[], number] {
  const units: Unit[] = []
  for (;;) {
    const [old, p1] = readDValue(buf, pos, len)
    pos = p1
    if (pos < len && buf[pos] === SUB) {
      const [nw, p2] = readDValue(buf, pos + 1, len)
      pos = p2
      units.push(new Unit(old, nw))
    } else {
      units.push(new Unit(old, null))
    }
    // notes after a unit
    while (pos < len && buf[pos] === BEL) {
      const p2 = scanLayout(buf, pos + 1, len)
      if (!(p2 < len && (buf[p2] >= 0x20 || buf[p2] === STX))) break
      pos = scanLayout(buf, scanComment(buf, pos, len), len)
    }
    if (!(pos < len && buf[pos] === US)) break
    pos++
  }
  return [units, pos]
}

/** Build a diff document. */
export function buildDiff(fn: (d: DiffBuilder) => void): Uint8Array {
  const b = new DiffBuilder()
  fn(b)
  return b.toUint8Array()
}

export class DiffBuilder {
  private readonly io = new ByteWriter()

  constructor(heading: boolean = true) {
    if (heading) {
      this.io.push(SYN)
      this.io.push(SOH)
      this.io.writeString('shape')
      this.io.push(US)
      this.io.writeString('diff')
    }
  }

  file(path: string, fn?: () => void): this {
    this.io.push(FS)
    writeName(this.io, path)
    if (fn) fn()
    return this
  }

  section(fn: (s: SectionBuilder) => void): this {
    this.io.push(GS)
    fn(new SectionBuilder(this.io))
    return this
  }

  /** anchor, old → new, anchor in one call. */
  replace(contextBefore: string, oldText: string, newText: string, contextAfter: string = ''): this {
    return this.section(s => {
      if (contextBefore !== '') s.anchor(contextBefore)
      s.sub(oldText, newText)
      if (contextAfter !== '') s.anchor(contextAfter)
    })
  }

  /** RS old SUB new: every occurrence within the current section's scope. */
  replaceAll(oldText: string, newText: string): this {
    if (oldText === '') throw new DiffError('replace-all needs a non-empty old part')
    this.io.push(RS)
    writeValue(this.io, oldText)
    this.io.push(SUB)
    writeValue(this.io, newText)
    return this
  }

  note(text: string): this {
    this.io.push(BEL)
    writeValue(this.io, text)
    return this
  }

  eot(): this {
    this.io.push(EOT)
    return this
  }

  toUint8Array(): Uint8Array {
    return this.io.toUint8Array()
  }
}

export class SectionBuilder {
  private readonly io: ByteWriter
  private first = true

  constructor(io: ByteWriter) {
    this.io = io
  }

  anchor(text: string): this {
    this.sep()
    writeValue(this.io, text)
    return this
  }

  sub(oldText: string, newText: string): this {
    this.sep()
    writeValue(this.io, oldText)
    this.io.push(SUB)
    writeValue(this.io, newText)
    return this
  }

  private sep(): void {
    if (!this.first) this.io.push(US)
    this.first = false
  }
}

