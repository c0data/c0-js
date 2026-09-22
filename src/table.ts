import { SOH, STX, ETX, EOT, DLE, ETB, FS, GS, RS, US } from './constants.js'
import { unescape } from './canonical.js'

/**
 * Zero-copy accessor for a single record within a table.
 * Fields are accessed by index, returning slices into the original buffer.
 */
export class Record {
  readonly buf: Uint8Array
  readonly start: number
  readonly end: number

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf
    this.start = start
    this.end = end
  }

  /** Access field by index. Respects STX/ETX nesting. */
  field(n: number): Uint8Array {
    let pos = this.start
    let fieldIdx = 0
    let fieldStart = pos

    while (pos < this.end) {
      const byte = this.buf[pos]
      if (byte === US) {
        if (fieldIdx === n) return this.buf.subarray(fieldStart, pos)
        fieldIdx++
        pos++
        fieldStart = pos
      } else if (byte === DLE) {
        pos += 2
      } else if (byte === STX) {
        pos = skipNested(this.buf, pos, this.end)
      } else {
        pos++
      }
    }

    // Last field (no trailing US)
    if (fieldIdx === n) return this.buf.subarray(fieldStart, pos)
    return new Uint8Array(0)
  }

  /** Number of fields in this record. Respects STX/ETX nesting. */
  get fieldCount(): number {
    let count = 1
    let pos = this.start

    while (pos < this.end) {
      const byte = this.buf[pos]
      if (byte === US) {
        count++
        pos++
      } else if (byte === DLE) {
        pos += 2
      } else if (byte === STX) {
        pos = skipNested(this.buf, pos, this.end)
      } else {
        pos++
      }
    }
    return count
  }

  /** All fields as slices. */
  get fields(): Uint8Array[] {
    const result: Uint8Array[] = []
    for (let i = 0; i < this.fieldCount; i++) {
      result.push(this.field(i))
    }
    return result
  }

  /**
   * Logical bytes of field n: the raw slice with DLE escapes decoded.
   * Zero-copy when the field contains no escapes.
   */
  value(n: number): Uint8Array {
    return unescape(this.field(n))
  }

  /** All logical field values. */
  get values(): Uint8Array[] {
    const result: Uint8Array[] = []
    for (let i = 0; i < this.fieldCount; i++) {
      result.push(this.value(i))
    }
    return result
  }

  /**
   * Field n as a flat list: the items of its STX/ETX scope split on
   * top-level US, each DLE-unescaped (mirrors `value`). Inverse of
   * `Builder#listField`. A field that is not an STX/ETX scope is returned
   * as a single-item list holding its value; an empty scope is an empty list.
   */
  list(n: number): Uint8Array[] {
    const raw = this.field(n)
    if (!(raw.length > 0 && raw[0] === STX)) return [unescape(raw)]
    let stop = raw.length
    if (stop > 1 && raw[stop - 1] === ETX) stop--
    const items: Uint8Array[] = []
    if (stop <= 1) return items
    let pos = 1
    let itemStart = pos
    while (pos < stop) {
      const byte = raw[pos]
      if (byte === US) {
        items.push(unescape(raw.subarray(itemStart, pos)))
        pos++
        itemStart = pos
      } else if (byte === DLE) {
        pos += 2
      } else if (byte === STX) {
        pos = skipNested(raw, pos, stop)
      } else {
        pos++
      }
    }
    items.push(unescape(raw.subarray(itemStart, stop)))
    return items
  }

  /** Raw bytes of the entire record. */
  get raw(): Uint8Array {
    return this.buf.subarray(this.start, this.end)
  }
}

/**
 * Zero-copy accessor for a tabular C0DATA group.
 *
 * Scans the buffer once to index record positions, then provides
 * O(1) access to records and fields as slices into the original buffer.
 */
export class Table {
  readonly buf: Uint8Array
  private _nameStart = 0
  private _nameEnd = 0
  private _headers: number[] = []      // pairs of [start, end]
  private _records: number[] = []      // start offset of each record
  private _recordEnds: number[] = []   // end offset of each record

  constructor(buf: Uint8Array, offset: number = 0) {
    this.buf = buf
    this.index(offset)
  }

  /** Group/table name as a slice into the buffer. */
  get name(): Uint8Array {
    return this.buf.subarray(this._nameStart, this._nameEnd)
  }

  /** Number of header fields. */
  get headerCount(): number {
    return this._headers.length >> 1
  }

  /** Header field name by index. */
  header(i: number): Uint8Array {
    return this.buf.subarray(this._headers[i * 2], this._headers[i * 2 + 1])
  }

  /** All header names. */
  get headers(): Uint8Array[] {
    const result: Uint8Array[] = []
    for (let i = 0; i < this.headerCount; i++) {
      result.push(this.header(i))
    }
    return result
  }

  /** Number of records. */
  get recordCount(): number {
    return this._records.length
  }

  /** Access a record by index. */
  record(i: number): Record {
    return new Record(this.buf, this._records[i], this._recordEnds[i])
  }

  /** Iterate all records. */
  eachRecord(cb: (rec: Record) => void): void {
    for (let i = 0; i < this._records.length; i++) {
      cb(this.record(i))
    }
  }

  private index(offset: number): void {
    let pos = offset
    const len = this.buf.length

    // Expect GS to start the group
    if (pos >= len) return
    if (this.buf[pos] === GS) {
      pos++
      this._nameStart = pos
      while (pos < len && this.buf[pos] >= 0x20) pos++
      this._nameEnd = pos
    }

    // Skip ETB commit markers and their payloads (stream mode framing)
    while (pos < len && this.buf[pos] === ETB) {
      pos++
      while (pos < len && this.buf[pos] >= 0x20) pos++
    }

    // Read SOH header if present
    if (pos < len && this.buf[pos] === SOH) {
      pos++
      let fieldStart = pos
      while (pos < len) {
        const byte = this.buf[pos]
        if (byte === US) {
          this._headers.push(fieldStart, pos)
          pos++
          fieldStart = pos
        } else if (byte < 0x20) {
          this._headers.push(fieldStart, pos)
          break
        } else {
          pos++
        }
      }
      if (pos >= len && fieldStart <= len) {
        this._headers.push(fieldStart, pos)
      }
    }

    // Read records
    while (pos < len) {
      const byte = this.buf[pos]
      if (byte === GS || byte === FS || byte === EOT || byte === ETX) break

      if (byte === RS) {
        pos++
        const recStart = pos
        while (pos < len) {
          const b = this.buf[pos]
          if (b === RS || b === GS || b === FS || b === EOT || b === ETX || b === ETB) break
          if (b === DLE) {
            pos += 2
          } else if (b === STX) {
            pos++
            let depth = 1
            while (pos < len && depth > 0) {
              if (this.buf[pos] === STX) depth++
              else if (this.buf[pos] === ETX) depth--
              else if (this.buf[pos] === DLE) pos++
              pos++
            }
          } else {
            pos++
          }
        }
        this._records.push(recStart)
        this._recordEnds.push(pos)
      } else {
        pos++
      }
    }
  }
}

/** Skip over a STX/ETX nested scope, returning position after ETX. */
function skipNested(buf: Uint8Array, pos: number, stop: number): number {
  pos++ // skip STX
  let depth = 1
  while (pos < stop && depth > 0) {
    const byte = buf[pos]
    if (byte === STX) depth++
    else if (byte === ETX) depth--
    else if (byte === DLE) pos++
    pos++
  }
  return pos
}
