import { SOH, STX, ETX, EOT, ENQ, DLE, ETB, SUB, FS, GS, RS, US } from './constants.js'
import { C0Error } from './error.js'

const encoder = new TextEncoder()

/** A value written byte-transparently: a string (encoded as UTF-8) or raw bytes. */
export type BuilderValue = string | Uint8Array

/**
 * Builds C0DATA documents in compact form.
 *
 * Names (file/group labels, headers, reference targets) are strings and
 * reject control bytes. Values (record fields, list items, blocks, items,
 * ETB payloads) are byte-transparent: pass a string for UTF-8 text or a
 * Uint8Array for raw bytes; control bytes are DLE-escaped automatically.
 *
 * Example:
 *   const buf = build(b => {
 *     b.file('mydb', () => {
 *       b.group('users', ['name', 'amount', 'type'], () => {
 *         b.record('Alice', '1502.30', 'DEPOSIT')
 *         b.record('Bob', '340.00', 'WITHDRAWAL')
 *       })
 *     })
 *   })
 */
export class Builder {
  private parts: (number | Uint8Array)[] = []

  /** Write a file/database scope. */
  file(name: string, fn?: () => void): this {
    this.parts.push(FS)
    this.pushName(name)
    fn?.()
    return this
  }

  /** Write a group/table scope with optional headers. */
  group(name: string, headers?: string[] | null, fn?: () => void): this {
    this.parts.push(GS)
    this.pushName(name)
    if (headers) {
      this.parts.push(SOH)
      for (let i = 0; i < headers.length; i++) {
        if (i > 0) this.parts.push(US)
        this.pushName(headers[i])
      }
    }
    fn?.()
    return this
  }

  /**
   * Write a standalone SOH header (e.g. for stream mode, where the
   * header is appended and committed separately from the group).
   */
  header(names: string[]): this {
    this.parts.push(SOH)
    for (let i = 0; i < names.length; i++) {
      if (i > 0) this.parts.push(US)
      this.pushName(names[i])
    }
    return this
  }

  /** Write a record with positional fields. */
  record(...fields: BuilderValue[]): this {
    this.parts.push(RS)
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) this.parts.push(US)
      this.pushEscaped(fields[i])
    }
    return this
  }

  /** Write a record from an array of fields. */
  recordArray(fields: BuilderValue[]): this {
    this.parts.push(RS)
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) this.parts.push(US)
      this.pushEscaped(fields[i])
    }
    return this
  }

  /** Write an EOT marker. */
  eot(): this {
    this.parts.push(EOT)
    return this
  }

  /**
   * Write an ETB commit marker (stream mode), with an optional
   * integrity payload. The payload may not contain control bytes —
   * it is terminated by the next control code on read.
   */
  etb(payload?: BuilderValue): this {
    this.parts.push(ETB)
    if (payload !== undefined) {
      const bytes = toBytes(payload)
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] < 0x20) {
          throw new C0Error('ETB payload may not contain control bytes')
        }
      }
      this.parts.push(bytes)
    }
    return this
  }

  /** Write a nested sub-structure. */
  nested(fn: () => void): this {
    this.parts.push(STX)
    fn()
    this.parts.push(ETX)
    return this
  }

  /**
   * Write a reference: one segment is ENQ + group name, more is a path
   * (ENQ STX segments-joined-by-US ETX). Reference targets are names, so
   * control bytes are rejected.
   */
  ref(...path: string[]): this {
    this.parts.push(ENQ)
    if (path.length === 1) {
      this.pushName(path[0])
    } else {
      this.parts.push(STX)
      for (let i = 0; i < path.length; i++) {
        if (i > 0) this.parts.push(US)
        this.pushName(path[i])
      }
      this.parts.push(ETX)
    }
    return this
  }

  /**
   * Write a field whose value is a flat list (spec: "arrays are US-separated
   * values inside STX/ETX"): US, STX, the items separated by US, ETX.
   * Read back with `Record#list`.
   */
  listField(items: BuilderValue[]): this {
    this.parts.push(US)
    this.parts.push(STX)
    for (let i = 0; i < items.length; i++) {
      if (i > 0) this.parts.push(US)
      this.pushEscaped(items[i])
    }
    this.parts.push(ETX)
    return this
  }

  /** Write a raw field value (for use within records when building fields individually). */
  field(value: BuilderValue): this {
    this.parts.push(US)
    this.pushEscaped(value)
    return this
  }

  /** Write GS×N for document-mode depth. */
  section(name: string, depth: number = 1, fn?: () => void): this {
    for (let i = 0; i < depth; i++) this.parts.push(GS)
    this.pushName(name)
    fn?.()
    return this
  }

  /** Write a content block (RS + text) for document mode. */
  block(text: BuilderValue): this {
    this.parts.push(RS)
    this.pushEscaped(text)
    return this
  }

  /** Write a list item (US + text) for document mode. */
  item(text: BuilderValue): this {
    this.parts.push(US)
    this.pushEscaped(text)
    return this
  }

  /** Finalize and return the buffer. */
  toUint8Array(): Uint8Array {
    // Calculate total size
    let size = 0
    for (const p of this.parts) {
      size += typeof p === 'number' ? 1 : p.length
    }

    const out = new Uint8Array(size)
    let offset = 0
    for (const p of this.parts) {
      if (typeof p === 'number') {
        out[offset++] = p
      } else {
        out.set(p, offset)
        offset += p.length
      }
    }
    return out
  }

  // Names (labels and headers) are identifiers, not values — control
  // bytes are illegal in them (see DESIGN.md "Canonical Form").
  private pushName(s: string): void {
    const bytes = encoder.encode(s)
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] < 0x20) {
        throw new C0Error(`Names may not contain control bytes (got 0x${bytes[i].toString(16).padStart(2, '0')})`)
      }
    }
    this.parts.push(bytes)
  }

  private pushEscaped(s: BuilderValue): void {
    const bytes = toBytes(s)
    // Check if escaping is needed
    let needsEscape = false
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] < 0x20) { needsEscape = true; break }
    }

    if (!needsEscape) {
      this.parts.push(bytes)
      return
    }

    // Slow path: escape control codes
    const escaped: number[] = []
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] < 0x20) escaped.push(DLE)
      escaped.push(bytes[i])
    }
    this.parts.push(new Uint8Array(escaped))
  }
}

function toBytes(v: BuilderValue): Uint8Array {
  return typeof v === 'string' ? encoder.encode(v) : v
}

/** Build a C0DATA buffer using the builder API. */
export function build(fn: (b: Builder) => void): Uint8Array {
  const b = new Builder()
  fn(b)
  return b.toUint8Array()
}
