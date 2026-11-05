// Runs the shared conformance vectors from the c0-spec submodule
// (https://github.com/c0data/c0-spec), the source of truth. Schema v2:
// see c0-spec/vectors/README.md.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Body, Record, Group } from './body.js'
import { Container, Heading } from './document.js'
import { Builder, build } from './builder.js'
import { validate, canonical } from './validator.js'
import { StreamReader } from './stream.js'
import { applyDiff } from './diff.js'
import { scanLevel } from './core.js'
import { C0Error } from './error.js'
import { encoder, utf8, toHex, fromHex } from './bytes.js'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Case { name: string, desc: string, [key: string]: Any }

function cases(file: string): Case[] {
  const url = new URL(`../c0-spec/vectors/${file}`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf-8')).cases
}

// A scalar expected value: a JSON string or {"hex": ...}.
function isScalar(f: Any): boolean {
  return typeof f === 'string' || (f !== null && typeof f === 'object' && 'hex' in f)
}

function scalarBytes(f: Any): Uint8Array {
  return typeof f === 'string' ? encoder.encode(f) : fromHex(f.hex)
}

function strings(xs: Uint8Array[]): string[] {
  return xs.map(utf8)
}

// Flatten a group list with "sections" into [depth, group] pairs.
function flatGroups(groups: Any[], depth: number = 1): [number, Any][] {
  const out: [number, Any][] = []
  for (const g of groups) {
    out.push([depth, g])
    if (g.sections) out.push(...flatGroups(g.sections, depth + 1))
  }
  return out
}

function checkValue(rec: Record, i: number, f: Any): void {
  if (isScalar(f)) {
    assert.deepEqual(rec.value(i), scalarBytes(f))
  } else if (f.level) {
    checkBody(rec.level(i), f.level)
  } else if (f.ref !== undefined) {
    const r = rec.ref(i)
    assert.deepEqual(r.segments, typeof f.ref === 'string' ? [f.ref] : f.ref)
  } else {
    throw new Error(`unknown value form ${JSON.stringify(f)}`)
  }
}

function checkRecord(rec: Record, r: Any): void {
  if (Array.isArray(r)) {
    assert.equal(rec.keyed, false)
    assert.equal(rec.fieldCount, r.length)
    r.forEach((f: Any, j: number) => checkValue(rec, j, f))
  } else {
    assert.equal(rec.keyed, true)
    const pairs: [string, Any][] = r.keys
    assert.deepEqual(strings(rec.keys), pairs.map(p => p[0]))
    const got = rec.pairs
    pairs.forEach((p, j) => assert.deepEqual(got[j][1], scalarBytes(p[1])))
  }
}

function checkGroup(g: Group, e: Any): void {
  assert.equal(utf8(g.name), e.name)
  if (Array.isArray(e.headers)) {
    assert.deepEqual(strings(g.headers), e.headers)
  } else {
    assert.equal(g.hasHeader, false)
  }
  assert.equal(g.recordCount, e.records.length)
  e.records.forEach((r: Any, i: number) => checkRecord(g.record(i), r))
}

function checkGroups(groups: Group[], expected: Any[]): void {
  const flat = flatGroups(expected)
  assert.equal(groups.length, flat.length)
  flat.forEach(([depth, e], i) => {
    const g = groups[i]
    checkGroup(g, e)
    // the unnamed leading group has depth 0 in the reader
    if (!(e.name === '' && i === 0)) assert.equal(g.depth, depth)
  })
}

function checkBody(body: Body, e: Any): void {
  if (e.files) {
    checkFiles(body, e.files)
  } else if (e.records) {
    // a level described as a single table
    assert.equal(body.files.length, 1)
    const gs = body.files[0].groups
    if (e.records.length === 0 && !Array.isArray(e.headers)) {
      assert.equal(gs.length, 0)
    } else {
      assert.equal(gs.length, 1)
      checkGroup(gs[0], { name: '', headers: e.headers ?? null, records: e.records })
    }
  } else {
    checkGroups(body.groups, e.groups)
  }
}

function checkFiles(body: Body, files: Any[]): void {
  assert.equal(body.files.length, files.length)
  files.forEach((f, i) => {
    assert.equal(utf8(body.files[i].name), f.name)
    checkGroups(body.files[i].groups, f.groups)
  })
}

function checkHeading(h: Heading, e: [string, Any][]): void {
  assert.deepEqual(strings(h.keys), e.map(p => p[0]))
  e.forEach((p, i) => {
    const v = p[1]
    if (isScalar(v)) {
      assert.deepEqual(h.pairs[i][1], scalarBytes(v))
    } else if (v.level) {
      const raw = h.pairs[i][1]
      checkBody(new Body(raw, 1, scanLevel(raw, 0) - 1), v.level)
    }
  })
}

// ---------------------------------------------------------------- building

function buildValue(b: Builder, f: Any): void {
  if (isScalar(f)) {
    b.field(scalarBytes(f))
  } else if (f.level) {
    b.level(() => buildBody(b, f.level))
  } else if (f.ref !== undefined) {
    const segs: string[] = typeof f.ref === 'string' ? [f.ref] : f.ref
    b.ref(...segs)
  } else if (f.map) {
    b.level(() => buildRecord(b, { keys: f.map }))
  } else {
    throw new Error(`unknown value form ${JSON.stringify(f)}`)
  }
}

function buildRecord(b: Builder, r: Any): void {
  b.record()
  if (Array.isArray(r)) {
    for (const f of r) buildValue(b, f)
  } else {
    for (const p of r.keys as [string, Any][]) {
      const v = p[1]
      if (isScalar(v)) b.key(p[0], scalarBytes(v))
      else if (v.map) b.key(p[0], () => buildRecord(b, { keys: v.map }))
      else if (v.level) b.key(p[0], () => buildBody(b, v.level))
    }
  }
}

function buildGroups(b: Builder, groups: Any[]): void {
  groups.forEach((g, i) => {
    const headers: string[] | null = Array.isArray(g.headers) ? g.headers : null
    if (g.name === '' && i === 0) {
      if (headers) b.header(headers) // the unnamed leading group: no GS
    } else {
      b.group(g.name, headers)
    }
    for (const r of g.records) buildRecord(b, r)
  })
}

function buildBody(b: Builder, e: Any): void {
  if (e.records) {
    if (Array.isArray(e.headers)) b.header(e.headers)
    for (const r of e.records) buildRecord(b, r)
  } else if (e.groups) {
    buildGroups(b, e.groups)
  }
}

// ================================================================== specs

describe('conformance: decode.json', () => {
  for (const c of cases('decode.json')) {
    it(c.name, () => {
      const bytes = fromHex(c.bytes)
      const cont = new Container(bytes)
      if (c.documents) {
        assert.equal(cont.documents.length, c.documents.length)
        c.documents.forEach((d: Any, i: number) => {
          const doc = cont.documents[i]
          if (d.heading) checkHeading(doc.heading, d.heading)
          assert.equal(utf8(doc.name), d.file ?? '')
          checkGroups(doc.groups, d.groups)
        })
      } else {
        const doc = cont.first
        if (c.heading) {
          assert.equal(doc.hasSyn, true)
          checkHeading(doc.heading, c.heading)
        }
        if (c.files) {
          checkFiles(doc.body, c.files)
        } else {
          assert.equal(utf8(doc.name), c.file ?? '')
          checkGroups(doc.groups, c.groups)
        }
        if (c.tail !== undefined) {
          assert.equal(cont.hasEm, true)
          assert.equal(toHex(cont.tail), c.tail)
        }
      }
    })
  }
})

describe('conformance: encode.json', () => {
  for (const c of cases('encode.json')) {
    it(c.name, () => {
      const spec = c.build
      const emit = (b: Builder): void => {
        if (typeof spec.file === 'string') b.file(spec.file)
        buildGroups(b, spec.groups)
      }
      const canon = build(emit)
      assert.equal(toHex(canon), c.canonical)
      assert.equal(canonical(canon), true)
      if (spec.heading) {
        const whole = build(b => {
          b.syn(spec.heading as [string, string][])
          emit(b)
          b.eot()
        })
        assert.equal(toHex(whole), c.bytes)
      }
    })
  }
})

describe('conformance: canonical.json', () => {
  for (const c of cases('canonical.json')) {
    it(c.name, () => {
      const bytes = fromHex(c.bytes)
      let wellformed = true
      try {
        validate(bytes)
      } catch (e) {
        if (!(e instanceof C0Error)) throw e
        wellformed = false
      }
      assert.equal(wellformed, c.wellformed)
      assert.equal(canonical(bytes), c.canonical)
    })
  }
})

describe('conformance: invalid.json', () => {
  for (const c of cases('invalid.json')) {
    it(c.name, () => {
      assert.throws(() => validate(fromHex(c.bytes)), C0Error)
    })
  }
})

describe('conformance: nested.json', () => {
  for (const c of cases('nested.json')) {
    it(c.name, () => {
      const bytes = fromHex(c.bytes)
      const expected: Any[] = c.record
      const rec = new Body(bytes).record(0)
      assert.equal(rec.fieldCount, expected.length)
      expected.forEach((f, i) => {
        if (isScalar(f)) {
          assert.deepEqual(rec.value(i), scalarBytes(f))
        } else if (f.list) {
          const items: Any[] = f.list
          if (items.every(isScalar)) {
            assert.deepEqual(rec.list(i), items.map(scalarBytes))
          } else {
            const inner = rec.level(i).record(0)
            assert.equal(inner.fieldCount, items.length)
            items.forEach((x, j) => {
              if (isScalar(x)) assert.deepEqual(inner.value(j), scalarBytes(x))
              else assert.deepEqual(inner.list(j), (x.list as Any[]).map(scalarBytes))
            })
          }
        } else if (f.level) {
          checkBody(rec.level(i), f.level)
        }
      })
      if (c.canonical) {
        const buf = build(b => {
          b.record()
          for (const f of expected) {
            if (!isScalar(f) && f.list && (f.list as Any[]).every(isScalar)) {
              b.list((f.list as Any[]).map(scalarBytes))
            } else if (!isScalar(f) && f.list) {
              b.level(() => {
                b.record()
                for (const x of f.list as Any[]) {
                  if (isScalar(x)) b.field(scalarBytes(x))
                  else b.list((x.list as Any[]).map(scalarBytes))
                }
              })
            } else {
              buildValue(b, f)
            }
          }
        })
        assert.equal(toHex(buf), c.bytes)
        assert.equal(canonical(buf), true)
      }
    })
  }
})

describe('conformance: diff.json', () => {
  for (const c of cases('diff.json')) {
    it(c.name, () => {
      const diff = fromHex(c.diff)
      const files: { [path: string]: string } = c.files
      if (c.error) {
        assert.throws(() => applyDiff(diff, files), C0Error)
      } else {
        const got = applyDiff(diff, files)
        assert.deepEqual(Object.fromEntries(got), c.result)
      }
    })
  }
})

describe('conformance: stream.json', () => {
  for (const c of cases('stream.json')) {
    it(c.name, () => {
      const reader = new StreamReader(fromHex(c.bytes))
      assert.equal(reader.committedEnd, c.committed_end)
      assert.equal(reader.torn, c.torn)
      const blocks: string[] = c.blocks
      assert.equal(reader.blockCount, blocks.length)
      blocks.forEach((hex, i) => assert.equal(toHex(reader.block(i)), hex))
      assert.deepEqual(reader.damaged, c.damaged ?? [])
      if (c.records) {
        const got = reader.records
        assert.equal(got.length, c.records.length)
        ;(c.records as string[][]).forEach((r, i) => assert.deepEqual(got[i].strings, r))
      }
    })
  }
})
