// Runs the shared conformance vectors from the c0-spec submodule
// (https://github.com/trans/c0-spec), the source of truth.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { tokenize } from './tokenizer.js'
import { Table } from './table.js'
import { Document } from './document.js'
import { Builder, build } from './builder.js'
import { canonical } from './canonical.js'
import { StreamReader } from './stream.js'
import { C0Error } from './error.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface Case { name: string, [key: string]: unknown }

function cases(file: string): Case[] {
  const url = new URL(`../c0-spec/vectors/${file}`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf-8')).cases
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

// A field is a JSON string (UTF-8 bytes) or {hex: "..."} (raw bytes).
function fieldBytes(f: unknown): Uint8Array {
  if (typeof f === 'string') return encoder.encode(f)
  return hexBytes((f as { hex: string }).hex)
}

interface GroupSpec {
  name: string
  headers: string[] | null
  records: unknown[][]
}

function checkTable(t: Table, g: GroupSpec): void {
  assert.equal(decoder.decode(t.name), g.name)
  if (g.headers) {
    assert.deepEqual(t.headers.map(h => decoder.decode(h)), g.headers)
  } else {
    assert.equal(t.headerCount, 0)
  }
  assert.equal(t.recordCount, g.records.length)
  g.records.forEach((expected, i) => {
    const rec = t.record(i)
    assert.equal(rec.fieldCount, expected.length)
    expected.forEach((f, j) => {
      assert.deepEqual(rec.value(j), fieldBytes(f))
    })
  })
}

describe('conformance: decode.json', () => {
  for (const c of cases('decode.json')) {
    it(c.name, () => {
      const bytes = hexBytes(c.bytes as string)
      const fileName = c.file as string | null
      const groups = c.groups as unknown as GroupSpec[]

      if (fileName === null && groups.length === 1 && groups[0].name === '') {
        checkTable(new Table(bytes), groups[0])
      } else {
        const doc = new Document(bytes)
        assert.equal(decoder.decode(doc.name), fileName ?? '')
        assert.equal(doc.groupCount, groups.length)
        groups.forEach((g, i) => {
          checkTable(doc.group(i).table, g)
        })
      }
    })
  }
})

describe('conformance: encode.json', () => {
  for (const c of cases('encode.json')) {
    it(c.name, () => {
      const spec = c.build as { file: string | null, groups: GroupSpec[] }

      const emitGroups = (b: Builder) => {
        for (const g of spec.groups) {
          b.group(g.name, g.headers)
          for (const r of g.records) {
            b.recordArray(r.map(f => decoder.decode(fieldBytes(f))))
          }
        }
      }

      const buf = build(b => {
        if (spec.file !== null) b.file(spec.file, () => emitGroups(b))
        else emitGroups(b)
      })

      assert.equal(toHex(buf), c.canonical as string)
      assert.equal(canonical(buf), true)
    })
  }
})

describe('conformance: canonical.json', () => {
  for (const c of cases('canonical.json')) {
    it(c.name, () => {
      const bytes = hexBytes(c.bytes as string)

      let wellformed = true
      try {
        tokenize(bytes)
      } catch (e) {
        if (!(e instanceof C0Error)) throw e
        wellformed = false
      }
      assert.equal(wellformed, c.wellformed as boolean)

      assert.equal(canonical(bytes), c.canonical as boolean)
    })
  }
})

describe('conformance: invalid.json', () => {
  for (const c of cases('invalid.json')) {
    it(c.name, () => {
      const bytes = hexBytes(c.bytes as string)
      assert.throws(() => tokenize(bytes), C0Error)
    })
  }
})

describe('conformance: stream.json', () => {
  for (const c of cases('stream.json')) {
    it(c.name, () => {
      const bytes = hexBytes(c.bytes as string)
      const reader = new StreamReader(bytes)

      assert.equal(reader.committedEnd, c.committed_end as number)
      assert.equal(reader.torn, c.torn as boolean)

      const blocks = c.blocks as string[]
      assert.equal(reader.blockCount, blocks.length)
      blocks.forEach((hex, i) => {
        assert.equal(toHex(reader.block(i)), hex)
      })

      if (c.records) {
        const t = reader.table
        const expected = c.records as string[][]
        assert.equal(t.recordCount, expected.length)
        expected.forEach((r, i) => {
          assert.deepEqual(t.record(i).values.map(v => decoder.decode(v)), r)
        })
      }
    })
  }
})
