/**
 * JSON ⇄ C0DATA. Export never guesses: a positional record is an array, a
 * keyed record an object, a group with a header row an array of objects,
 * a reference `{"$ref": "group/record/field"}`.
 */
import { isLevel, isReference, value as logicalValue } from './core.js'
import { Body, Group, Record, Reference, levelOf } from './body.js'
import { Document } from './document.js'
import { Builder, build } from './builder.js'
import { utf8 } from './bytes.js'

export type Value = string | Value[] | { [key: string]: Value }

// --- Export: C0DATA → JSON ---

export function toJSON(buf: Uint8Array): string {
  return JSON.stringify(toObject(buf), null, 2)
}

export function toObject(buf: Uint8Array): Value {
  return exportBody(new Document(buf).body)
}

/** A body: {file: groups} per named file, or the groups directly; a bare body exports as its group. */
export function exportBody(body: Body, level: boolean = false): Value {
  const files = body.files
  if (files.length === 1) {
    const f = files[0]
    if (f.name.length === 0) return exportGroups(f.groups, level)
    return { [utf8(f.name)]: exportGroups(f.groups, level) }
  }
  const out: { [key: string]: Value } = {}
  for (const f of files) out[utf8(f.name)] = exportGroups(f.groups, level)
  return out
}

function exportGroups(groups: Group[], level: boolean = false): Value {
  if (groups.length === 0) return []
  if (groups.length === 1 && groups[0].name.length === 0 && groups[0].depth === 0) return exportGroup(groups[0], level)
  const out: { [key: string]: Value } = {}
  for (const g of groups) out[utf8(g.name)] = exportGroup(g)
  return out
}

/** A group: with a header row, an array of objects; a single keyed record is an object; otherwise an array of records. */
export function exportGroup(g: Group, level: boolean = false): Value {
  if (g.hasHeader) {
    const headers = g.headers.map(utf8)
    const rows: Value[] = []
    for (const rec of g.records) {
      if (rec.keyed) {
        rows.push(exportRecord(rec))
      } else {
        const row: { [key: string]: Value } = {}
        const n = rec.fieldCount
        headers.forEach((h, i) => { row[h] = i < n ? exportRaw(rec.field(i)) : '' })
        rows.push(row)
      }
    }
    return rows
  }
  const recs = g.records
  if (recs.length === 1 && (recs[0].keyed || level)) return exportRecord(recs[0])
  return recs.map(exportRecord)
}

export function exportRecord(rec: Record): Value {
  if (rec.keyed) {
    const obj: { [key: string]: Value } = {}
    for (const [k] of rec.pairs) {
      const key = utf8(k)
      obj[key] = exportRaw(rec.keyField(key)!)
    }
    return obj
  }
  const arr: Value[] = []
  for (let i = 0; i < rec.fieldCount; i++) arr.push(exportRaw(rec.field(i)))
  return arr
}

function exportRaw(raw: Uint8Array): Value {
  if (isLevel(raw)) return exportBody(levelOf(raw), true)
  if (isReference(raw)) return { $ref: Reference.parse(raw).segments.join('/') }
  return utf8(logicalValue(raw))
}

// --- Import: JSON → C0DATA ---

export function fromJSON(input: string, groupName: string = 'data'): Uint8Array {
  return fromObject(JSON.parse(input), groupName)
}

/** Any JSON-like value: objects, arrays, strings; numbers and booleans are stringified, null is empty. */
export function fromObject(value: unknown, groupName: string = 'data'): Uint8Array {
  return emitRoot(normalize(value), groupName)
}

function normalize(v: unknown): Value {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'object') {
    const out: { [key: string]: Value } = {}
    for (const [k, x] of Object.entries(v as object)) out[k] = normalize(x)
    return out
  }
  return String(v)
}

function isObject(v: Value): v is { [key: string]: Value } {
  return typeof v === 'object' && !Array.isArray(v)
}

// Top-level layout: an object of groups (one key wrapping an object of
// groups becomes a file); an array becomes one group; an object of
// scalars becomes one group holding one map; a scalar one record.
function emitRoot(value: Value, groupName: string): Uint8Array {
  return build(b => {
    if (isObject(value)) {
      const entries = Object.entries(value)
      const inner = entries.length === 1 ? entries[0][1] : undefined
      if (inner !== undefined && isObject(inner) && allGroupable(inner)) {
        b.file(entries[0][0])
        emitGroups(b, inner)
      } else if (allGroupable(value)) {
        emitGroups(b, value)
      } else {
        b.group(groupName)
        emitMap(b, value)
      }
    } else if (Array.isArray(value)) {
      emitArrayAsGroup(b, value, groupName)
    } else {
      b.group(groupName)
      b.record(value)
    }
  })
}

function emitGroups(b: Builder, obj: { [key: string]: Value }): void {
  for (const [name, value] of Object.entries(obj)) {
    if (isObject(value)) {
      b.group(name)
      emitMap(b, value)
    } else if (Array.isArray(value)) {
      emitArrayAsGroup(b, value, name)
    } else {
      b.group(name)
      b.record(value)
    }
  }
}

// An object → one keyed record, entries in object order.
function emitMap(b: Builder, obj: { [key: string]: Value }): void {
  b.record()
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') b.key(k, v)
    else b.key(k, () => emitLevelBody(b, v))
  }
}

function emitArrayAsGroup(b: Builder, arr: Value[], name: string): void {
  if (tabular(arr)) {
    const headers = Object.keys(arr[0] as { [key: string]: Value })
    b.group(name, headers)
    for (const row of arr) {
      const h = row as { [key: string]: Value }
      b.record()
      for (const k of headers) emitUnit(b, k in h ? h[k] : '')
    }
  } else {
    b.group(name)
    for (const item of arr) emitItemAsRecord(b, item)
  }
}

function emitItemAsRecord(b: Builder, item: Value): void {
  if (typeof item === 'string') {
    b.record(item)
  } else if (Array.isArray(item)) {
    b.record()
    for (const v of item) emitUnit(b, v)
  } else {
    emitMap(b, item)
  }
}

// A value in unit position: scalar, or a level.
function emitUnit(b: Builder, value: Value): void {
  if (typeof value === 'string') b.field(value)
  else b.level(() => emitLevelBody(b, value))
}

// Inside a level: an array of scalars is one record (a list); an array of
// uniform objects a table with a header row; an array of arrays a table;
// a mixed array one record per item; an object a map.
function emitLevelBody(b: Builder, value: Value): void {
  if (isObject(value)) {
    emitMap(b, value)
  } else if (Array.isArray(value)) {
    if (value.every(v => typeof v === 'string')) {
      b.record()
      for (const v of value) b.field(v as string)
    } else if (tabular(value)) {
      const headers = Object.keys(value[0] as { [key: string]: Value })
      b.header(headers)
      for (const row of value) {
        const h = row as { [key: string]: Value }
        b.record()
        for (const k of headers) emitUnit(b, k in h ? h[k] : '')
      }
    } else if (value.every(v => Array.isArray(v))) {
      for (const row of value) {
        b.record()
        for (const v of row as Value[]) emitUnit(b, v)
      }
    } else {
      for (const item of value) emitItemAsRecord(b, item)
    }
  } else {
    b.record(value)
  }
}

function allGroupable(obj: { [key: string]: Value }): boolean {
  const values = Object.values(obj)
  return values.length > 0 && values.every(v => typeof v === 'object')
}

function tabular(arr: Value[]): boolean {
  if (arr.length === 0) return false
  if (!arr.every(isObject)) return false
  const keys = Object.keys(arr[0] as object).join('\u001f')
  return arr.every(item => Object.keys(item as object).join('\u001f') === keys)
}
