/**
 * Pretty form: Unicode Control Pictures (U+2400 block) for the codes,
 * line breaks and indentation as layout. `format` and `parse` are
 * inverses on well-formed input.
 */
import {
  SOH, STX, ETX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, SUB, FS, GS, RS, US, HT, LF, CR, isLayout,
} from './constants.js'
import { C0Error, UnassignedCodeError } from './error.js'
import { scanLayout, scanText, scanLevel, scanPlain, trim } from './core.js'
import { ByteWriter, encoder, utf8 } from './bytes.js'

export type FormatMode = 'compact' | 'aligned' | 'spaced'

export interface FormatOptions {
  indent?: string
  mode?: FormatMode
}

export class GlyphInDataError extends C0Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlyphInDataError'
  }
}

/** Convert a C0 control byte to its Unicode Control Picture character. */
export function glyph(byte: number): string {
  return String.fromCodePoint(0x2400 + byte)
}

const GLYPH_BYTES: Uint8Array[] = []
for (let b = 0; b < 0x20; b++) GLYPH_BYTES.push(encoder.encode(glyph(b)))

/**
 * Format a compact buffer as pretty form.
 *
 * Modes: `'compact'` (one element per line, no padding; the default),
 * `'aligned'` (column-aligned units within table groups), `'spaced'`
 * (aligned, plus a space after the prefix and around ␟).
 */
export function format(buf: Uint8Array, options?: string | FormatOptions): string {
  let indent = '  '
  let mode: FormatMode = 'compact'
  if (typeof options === 'string') {
    indent = options
  } else if (options) {
    indent = options.indent ?? '  '
    mode = options.mode ?? 'compact'
  }
  const compact = new Formatter(buf, indent).run()
  return mode === 'compact' ? compact : align(compact, mode)
}

// ---- formatting ----------------------------------------------------

class Formatter {
  private readonly buf: Uint8Array
  private readonly len: number
  private readonly indent: string
  private readonly io = new ByteWriter()
  private depth = 0      // nesting depth (levels)
  private gdepth = 0     // group depth within the current level
  private lineStart = true
  private readonly stack: number[] = []

  constructor(buf: Uint8Array, indent: string) {
    this.buf = buf
    this.len = buf.length
    this.indent = indent
  }

  run(): string {
    const buf = this.buf
    const len = this.len
    const io = this.io
    let pos = 0
    while (pos < len) {
      const byte = buf[pos]
      if (byte >= 0x20 || isLayout(byte)) {
        // stray plain or layout at element level: layout is dropped
        if (isLayout(byte)) {
          pos++
        } else {
          const start = pos
          pos = scanPlain(buf, pos, len)
          this.writeData(buf.subarray(start, pos))
          this.lineStart = false
        }
        continue
      }
      switch (byte) {
        case SYN:
          this.newline()
          this.g(SYN)
          pos = this.writeHeading(pos + 1)
          this.nl()
          this.gdepth = 0
          break
        case FS:
          this.newline()
          this.writeIndent(this.depth)
          this.g(FS)
          pos = this.writePlain(pos + 1)
          this.nl()
          this.gdepth = 1
          break
        case GS: {
          let run = 0
          while (pos < len && buf[pos] === GS) { run++; pos++ }
          this.newline()
          this.writeIndent(this.depth)
          for (let i = 0; i < run; i++) this.g(GS)
          pos = this.writePlain(pos)
          this.nl()
          this.gdepth = 1
          break
        }
        case SOH: case RS: case BEL: case ETB:
          this.newline()
          this.writeIndent(this.depth + this.gdepth)
          pos = this.writeElement(pos)
          break
        case CAN:
          if (this.depth > 0) this.depth--
          this.gdepth = this.stack.pop() ?? 0
          this.newline()
          this.writeIndent(this.depth + this.gdepth)
          this.g(CAN)
          pos++
          this.lineStart = false
          // the rest of the enclosing record continues on this line
          pos = this.writeUnits(pos)
          if (!this.lineStart) this.nl()
          break
        case EOT:
          this.newline()
          this.g(EOT)
          this.nl()
          pos++
          break
        case EM: {
          this.newline()
          this.g(EM)
          const tail = len - pos - 1
          if (tail > 0) io.writeString(` ${tail} bytes`)
          this.nl()
          return this.finish()
        }
        case STX: case DLE: case ENQ: case US: case SUB:
          // a unit-level code at element level (e.g. a diff pattern): write inline
          pos = this.writeUnits(pos)
          this.nl()
          break
        default:
          throw new UnassignedCodeError(byte, pos)
      }
    }
    if (!this.lineStart) this.nl()
    return this.finish()
  }

  private finish(): string {
    return utf8(this.io.toUint8Array())
  }

  private g(code: number): void {
    this.io.write(GLYPH_BYTES[code])
  }

  private nl(): void {
    this.io.push(LF)
    this.lineStart = true
  }

  private newline(): void {
    if (!this.lineStart) this.io.push(LF)
  }

  // SOH / RS / BEL / ETB at element level: the element and its units on
  // one line (a level opener breaks the line).
  private writeElement(pos: number): number {
    const buf = this.buf
    const len = this.len
    const byte = buf[pos]
    this.lineStart = false
    switch (byte) {
      case BEL: {
        this.g(BEL)
        pos = scanLayout(buf, pos + 1, len)
        if (pos < len && (buf[pos] >= 0x20 || buf[pos] === STX)) {
          pos = this.writeUnits(pos)
          this.nl()
          return pos
        }
        // dead element: render it on this line
        if (pos >= len) return pos
        return this.writeElement(pos)
      }
      case SOH:
        this.g(SOH)
        pos = scanLayout(buf, pos + 1, len)
        if (pos < len && buf[pos] === RS) {
          this.g(RS)
          pos++
        }
        pos = this.writeUnits(pos)
        break
      case RS:
        this.g(RS)
        pos = this.writeUnits(pos + 1)
        break
      case ETB:
        this.g(ETB)
        pos = this.writePlain(pos + 1)
        break
    }
    if (!this.lineStart) this.nl()
    return pos
  }

  // Units of a record/header/heading on the current line. Stops at a
  // record-level code. A level opener writes ␐, breaks the line and
  // increments the depth; the caller resumes at the matching CAN.
  private writeUnits(pos: number): number {
    const buf = this.buf
    const len = this.len
    while (pos < len) {
      const b = buf[pos]
      if (b >= 0x20) {
        const start = pos
        pos = scanPlain(buf, pos, len)
        this.writeData(trim(buf.subarray(start, pos)))
      } else if (isLayout(b)) {
        pos++
      } else if (b === US || b === ENQ || b === SUB) {
        this.g(b)
        pos++
      } else if (b === SOH) {
        const p2 = scanLayout(buf, pos + 1, len)
        if (p2 < len && buf[p2] === RS) break
        this.g(SOH)
        pos++
      } else if (b === STX) {
        const stop = scanText(buf, pos, len)
        this.writeText(buf.subarray(pos, stop))
        pos = stop
      } else if (b === DLE) {
        this.g(DLE)
        this.io.push(LF)
        this.stack.push(this.gdepth)
        this.depth++
        this.lineStart = true
        return pos + 1
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, len)
        if (p2 < len && (buf[p2] >= 0x20 || buf[p2] === STX || buf[p2] === DLE)) {
          this.g(BEL)
          pos = p2
        } else {
          break
        }
      } else if (b === ETB) {
        this.g(ETB)
        pos = this.writePlain(pos + 1)
      } else {
        break
      }
    }
    this.lineStart = false
    return pos
  }

  private writeHeading(pos: number): number {
    const buf = this.buf
    const len = this.len
    while (pos < len) {
      const b = buf[pos]
      if (b === SOH) {
        const p2 = scanLayout(buf, pos + 1, len)
        if (p2 < len && buf[p2] === RS) break
        this.g(SOH)
        pos = this.writePlain(p2)
        if (pos < len && buf[pos] === US) {
          this.g(US)
          pos = scanLayout(buf, pos + 1, len)
          if (pos < len && buf[pos] === STX) {
            const stop = scanText(buf, pos, len)
            this.writeText(buf.subarray(pos, stop))
            pos = stop
          } else if (pos < len && buf[pos] === DLE) {
            const stop = scanLevel(buf, pos, len)
            // a nested heading value is written inline
            this.writeInlineLevel(buf.subarray(pos, stop))
            pos = stop
          } else {
            pos = this.writePlain(pos)
          }
        }
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, len)
        if (p2 < len && (buf[p2] >= 0x20 || buf[p2] === STX)) {
          this.g(BEL)
          pos = p2
          if (buf[pos] === STX) {
            const stop = scanText(buf, pos, len)
            this.writeText(buf.subarray(pos, stop))
            pos = stop
          } else {
            pos = this.writePlain(pos)
          }
        } else if (p2 < len && buf[p2] === SOH) {
          this.g(BEL)
          pos = p2
        } else {
          break
        }
      } else if (isLayout(b)) {
        pos++
      } else {
        break
      }
    }
    return pos
  }

  // A level written on one line (used for heading values).
  private writeInlineLevel(raw: Uint8Array): void {
    let i = 0
    while (i < raw.length) {
      const b = raw[i]
      if (b === STX) {
        const stop = scanText(raw, i)
        this.writeText(raw.subarray(i, stop))
        i = stop
      } else if (b >= 0x20) {
        const start = i
        i = scanPlain(raw, i)
        this.writeData(trim(raw.subarray(start, i)))
      } else if (isLayout(b)) {
        i++
      } else {
        this.g(b)
        i++
      }
    }
  }

  private writePlain(pos: number): number {
    const buf = this.buf
    pos = scanLayout(buf, pos, this.len)
    const start = pos
    pos = scanPlain(buf, pos, this.len)
    this.writeData(trim(buf.subarray(start, pos)))
    return pos
  }

  // A whole text (STX … ETX): glyphs for the brackets and for any control
  // byte inside; everything else as is.
  private writeText(text: Uint8Array): void {
    checkGlyphs(text)
    this.g(STX)
    const stop = text.length - 1
    for (let i = 1; i < stop; i++) {
      const b = text[i]
      if (b < 0x20 && b !== LF && b !== CR && b !== HT) this.g(b)
      else this.io.push(b)
    }
    this.g(ETX)
  }

  private writeData(data: Uint8Array): void {
    checkGlyphs(data)
    this.io.write(data)
  }

  private writeIndent(depth: number): void {
    for (let i = 0; i < depth; i++) this.io.writeString(this.indent)
  }
}

// Pretty form cannot show a value that contains a Control Picture
// character (U+2400–U+241F, UTF-8 E2 90 80–9F).
function checkGlyphs(data: Uint8Array): void {
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0xE2 && data[i + 1] === 0x90 && data[i + 2] >= 0x80 && data[i + 2] <= 0x9F) {
      throw new GlyphInDataError('value contains a Control Picture character and cannot be shown in pretty form')
    }
  }
}

// ---- parsing ---------------------------------------------------------

function glyphCode(ch: string): number {
  const cp = ch.codePointAt(0)!
  return cp >= 0x2400 && cp <= 0x241F ? cp - 0x2400 : -1
}

/**
 * Pretty form → compact bytes. Glyphs become codes; outside text, layout
 * touching a code is dropped and interior spaces are kept; inside text
 * everything is kept.
 */
export function parse(str: string): Uint8Array {
  const io = new ByteWriter()
  const chars = Array.from(str)
  let i = 0
  let pending = '' // whitespace between data characters
  let afterCode = true
  while (i < chars.length) {
    const ch = chars[i]
    const code = glyphCode(ch)
    if (code >= 0) {
      pending = ''
      io.push(code)
      i++
      if (code === STX) {
        i = parseText(chars, i, io)
      } else if (code === EM) {
        // the rest of the line is a summary, not data
        while (i < chars.length && chars[i] !== '\n') i++
      }
      afterCode = true
    } else if (ch === '\n' || ch === '\r') {
      pending = ''
      afterCode = true
      i++
    } else if (ch === ' ' || ch === '\t') {
      if (!afterCode) pending += ch
      i++
    } else {
      if (pending.length > 0) {
        io.writeString(pending)
        pending = ''
      }
      afterCode = false
      io.writeString(ch)
      i++
    }
  }
  return io.toUint8Array()
}

// Inside text: everything verbatim until the ETX glyph; a DLE glyph takes
// the next glyph with it.
function parseText(chars: string[], i: number, io: ByteWriter): number {
  while (i < chars.length) {
    const code = glyphCode(chars[i])
    if (code >= 0) {
      io.push(code)
      i++
      if (code === DLE && i < chars.length) {
        const nx = glyphCode(chars[i])
        if (nx >= 0) {
          io.push(nx)
          i++
        }
      } else if (code === ETX) {
        return i
      }
    } else {
      io.writeString(chars[i])
      i++
    }
  }
  return i
}

// ---- alignment -------------------------------------------------------

const G_FS = glyph(FS)
const G_GS = glyph(GS)
const G_RS = glyph(RS)
const G_SOH = glyph(SOH)
const G_US = glyph(US)
const G_EOT = glyph(EOT)
const G_STX = glyph(STX)
const G_ETX = glyph(ETX)
const G_DLE = glyph(DLE)
const G_CAN = glyph(CAN)
const G_SYN = glyph(SYN)
const G_BEL = glyph(BEL)

const PREFIXES = new Set([G_FS, G_GS, G_RS, G_SOH, G_US, G_SYN, G_BEL])

interface TableLine {
  lineIndex: number
  prefix: string
  fields: string[]
  /** seps[i] is what stood between fields[i] and fields[i+1]: G_US, or '' when the next field begins with its own SOH mark. */
  seps: string[]
}

function width(s: string): number {
  return Array.from(s).length
}

/**
 * Reformat a pretty-form string with column alignment. Keyed records
 * (SOH units) are aligned on their US like two-column tables.
 */
export function align(pretty: string, mode: FormatMode = 'spaced'): string {
  const lines = pretty.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const groups = findTableGroups(lines)
  const spaced = mode === 'spaced'
  const sp = spaced ? ' ' : ''

  const tableLineIndices = new Set<number>()
  for (const g of groups) for (const l of g) tableLineIndices.add(l.lineIndex)

  for (const group of groups) {
    if (group.length === 0) continue
    const colCount = Math.max(...group.map(l => l.fields.length))
    const maxWidths = new Array<number>(colCount).fill(0)
    for (const line of group) {
      line.fields.forEach((f, c) => { maxWidths[c] = Math.max(maxWidths[c], width(f)) })
    }
    for (const line of group) {
      let text = line.prefix + sp
      line.fields.forEach((field, col) => {
        if (col < line.fields.length - 1) {
          text += field + ' '.repeat(maxWidths[col] - width(field))
          text += line.seps[col] === G_US ? sp + G_US + sp : ' '
        } else {
          text += field
        }
      })
      lines[line.lineIndex] = text
    }
  }

  lines.forEach((text, i) => {
    if (tableLineIndices.has(i)) return
    if (text.trim() === '') return
    const chars = Array.from(text)
    let wsEnd = 0
    while (wsEnd < chars.length && (chars[wsEnd] === ' ' || chars[wsEnd] === '\t')) wsEnd++
    let glyphEnd = wsEnd
    while (glyphEnd < chars.length && PREFIXES.has(chars[glyphEnd])) glyphEnd++
    if (glyphEnd === wsEnd) return
    if (glyphEnd >= chars.length) return
    const indentStr = chars.slice(0, wsEnd).join('')
    const glyphs = chars.slice(wsEnd, glyphEnd).join('')
    const rest = chars.slice(glyphEnd).join('').replace(/^\s+/, '')
    lines[i] = spaced ? `${indentStr}${glyphs} ${rest}` : `${indentStr}${glyphs}${rest}`
  })

  return lines.join('\n') + '\n'
}

function findTableGroups(lines: string[]): TableLine[][] {
  const groups: TableLine[][] = []
  let current: TableLine[] | null = null
  const flush = (): void => {
    if (current && current.length > 0) groups.push(current)
    current = null
  }
  lines.forEach((text, i) => {
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.startsWith(G_GS) || trimmed.startsWith(G_FS) || trimmed.startsWith(G_EOT) ||
        trimmed.startsWith(G_SYN) || trimmed.startsWith(G_CAN)) {
      flush()
      return
    }
    if (trimmed.startsWith(G_SOH) || trimmed.startsWith(G_RS)) {
      const parsed = parseTableLine(i, text)
      if (parsed === null || parsed.fields.length < 2) {
        flush()
        return
      }
      if (current === null) current = []
      current.push(parsed)
    } else {
      flush()
    }
  })
  flush()
  return groups
}

// Split a ␞ or ␁␞ line into its units on ␟ (text is not split; a keyed
// record splits on its ␁ marks too, so key and value align).
function parseTableLine(lineIndex: number, text: string): TableLine | null {
  const chars = Array.from(text)
  let i = 0
  while (i < chars.length && (chars[i] === ' ' || chars[i] === '\t')) i++
  if (i >= chars.length) return null
  if (chars[i] === G_SOH) {
    i++
    if (!(i < chars.length && chars[i] === G_RS)) return null
    i++
  } else if (chars[i] === G_RS) {
    i++
  } else {
    return null
  }
  const prefix = chars.slice(0, i).join('')
  const prefixLen = i
  const fields: string[] = []
  const seps: string[] = []
  let field = ''
  let inText = false
  const keyed = i < chars.length && chars[i] === G_SOH
  while (i < chars.length) {
    const ch = chars[i]
    if (inText) {
      field += ch
      if (ch === G_ETX) inText = false
      if (ch === G_DLE && i + 1 < chars.length) {
        field += chars[i + 1]
        i++
      }
    } else if (ch === G_STX) {
      inText = true
      field += ch
    } else if (ch === G_DLE || ch === G_CAN) {
      return null // nested levels are not aligned
    } else if (ch === G_US) {
      fields.push(field.trim())
      seps.push(G_US)
      field = ''
    } else if (keyed && ch === G_SOH && i > prefixLen) {
      fields.push(field.trim())
      seps.push('')
      field = ch
    } else {
      field += ch
    }
    i++
  }
  if (inText) return null // text continues on the next line
  fields.push(field.trim())
  if (fields.length < 2) return null
  return { lineIndex, prefix, fields, seps }
}
