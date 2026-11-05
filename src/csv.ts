/** CSV ⇄ C0DATA. */
import { C0Error } from './error.js'
import { isLevel, isReference, value as logicalValue } from './core.js'
import { Group, Reference } from './body.js'
import { Document } from './document.js'
import { build } from './builder.js'
import { utf8 } from './bytes.js'

/** CSV text → one group with a header row and positional records. */
export function fromCSV(input: string, groupName: string = 'data'): Uint8Array {
  const rows = parseCSV(input)
  if (rows.length === 0) return new Uint8Array(0)
  return build(b => {
    b.group(groupName, rows[0])
    for (let i = 1; i < rows.length; i++) b.record(...rows[i])
  })
}

/**
 * A group → CSV text (header row first if present): the first group of
 * the buffer, or the named one. A reference is written as its path
 * (`tags/001`); a nested level has no CSV form and is an error.
 */
export function toCSV(buf: Uint8Array, groupName?: string): string {
  const g = findGroup(buf, groupName)
  const rows: string[][] = []
  if (g.hasHeader) rows.push(g.headers.map(utf8))
  for (const rec of g.records) {
    const row: string[] = []
    rec.fields.forEach((f, i) => {
      if (isLevel(f)) throw new C0Error(`CSV cannot carry a nested level (group '${utf8(g.name)}', field ${i + 1})`)
      if (isReference(f)) row.push(Reference.parse(f).segments.join('/'))
      else row.push(utf8(logicalValue(f)))
    })
    rows.push(row)
  }
  return rows.map(row => row.map(quote).join(',')).join('\n') + '\n'
}

function findGroup(buf: Uint8Array, name?: string): Group {
  const body = new Document(buf).body
  if (name !== undefined) {
    const g = body.groups.find(x => utf8(x.name) === name)
    if (!g) throw new C0Error(`no group named '${name}'`)
    return g
  }
  const g = body.groups[0]
  if (!g) throw new C0Error('no group in buffer')
  return g
}

function quote(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
    return '"' + field.replace(/"/g, '""') + '"'
  }
  return field
}

/** RFC 4180 CSV: comma-separated, double-quoted fields, LF or CRLF rows. */
export function parseCSV(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  let fieldStarted = false
  const endRow = (): void => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
    fieldStarted = false
  }
  while (i < input.length) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      quoted = true
      fieldStarted = true
      i++
    } else if (ch === ',') {
      row.push(field)
      field = ''
      fieldStarted = false
      i++
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      i++
      endRow()
    } else {
      field += ch
      fieldStarted = true
      i++
    }
  }
  if (row.length > 0 || fieldStarted || field.length > 0) endRow()
  return rows
}
