import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  SOH, STX, ETX, EOT, ENQ, DLE, SUB, FS, GS, RS, US,
  tokenize, tokenizeEach, TokenType,
  Builder, build,
  Table, Record as C0Record,
  Document,
  glyph, format, parse, align,
  fromCSV, toCSV,
  toJSON, fromJSON, toObject, fromObject,
  parseDiff, applyDiff, buildDiff,
  C0Error, UnassignedCodeError, UnexpectedEndError,
} from './index.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Helper to build byte buffers from control codes and strings. */
function buf(...parts: (number | string)[]): Uint8Array {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'number') out.push(p)
    else for (const b of enc.encode(p)) out.push(b)
  }
  return new Uint8Array(out)
}

// ============================================================
// Tokenizer
// ============================================================
describe('Tokenizer', () => {
  it('emits a single data token for plain text', () => {
    const tokens = tokenize(enc.encode('hello'))
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0].type, TokenType.Data)
    assert.equal(dec.decode(enc.encode('hello').subarray(tokens[0].start, tokens[0].end)), 'hello')
  })

  it('handles empty input', () => {
    assert.deepEqual(tokenize(new Uint8Array(0)), [])
  })

  it('emits control code tokens', () => {
    const tests: [number, TokenType][] = [
      [FS, TokenType.FS], [GS, TokenType.GS], [RS, TokenType.RS], [US, TokenType.US],
      [SOH, TokenType.SOH], [STX, TokenType.STX], [ETX, TokenType.ETX],
      [EOT, TokenType.EOT], [ENQ, TokenType.ENQ], [SUB, TokenType.SUB],
    ]
    for (const [byte, expected] of tests) {
      const tokens = tokenize(new Uint8Array([byte]))
      assert.equal(tokens.length, 1, `byte 0x${byte.toString(16)}`)
      assert.equal(tokens[0].type, expected, `byte 0x${byte.toString(16)}`)
    }
  })

  it('tokenizes a simple table', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30')
    const tokens = tokenize(data)
    const types = tokens.map(t => t.type)
    assert.deepEqual(types, [
      TokenType.GS, TokenType.Data, TokenType.SOH,
      TokenType.Data, TokenType.US, TokenType.Data,
      TokenType.RS, TokenType.Data, TokenType.US, TokenType.Data,
    ])
  })

  it('escapes a control code as data via DLE', () => {
    const data = buf(DLE, RS) // DLE + RS → data token for RS byte
    const tokens = tokenize(data)
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0].type, TokenType.Data)
    assert.equal(data[tokens[0].start], RS)
  })

  it('raises UnexpectedEndError on trailing DLE', () => {
    assert.throws(() => tokenize(new Uint8Array([DLE])), UnexpectedEndError)
  })

  it('rejects unassigned control codes', () => {
    assert.throws(() => tokenize(new Uint8Array([0x07])), UnassignedCodeError) // BEL
    assert.throws(() => tokenize(new Uint8Array([0x00])), UnassignedCodeError) // NUL
  })

  it('allows DEL (0x7F) as data', () => {
    const tokens = tokenize(new Uint8Array([0x7f]))
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0].type, TokenType.Data)
  })

  it('handles consecutive delimiters (empty fields)', () => {
    const data = buf(RS, US, US) // record with two empty fields + third empty
    const tokens = tokenize(data)
    assert.deepEqual(tokens.map(t => t.type), [TokenType.RS, TokenType.US, TokenType.US])
  })

  it('handles UTF-8 data', () => {
    const data = buf(RS, '日本語', US, '🎉')
    const tokens = tokenize(data)
    assert.equal(tokens.length, 4)
    assert.equal(tokens[0].type, TokenType.RS)
    assert.equal(dec.decode(data.subarray(tokens[1].start, tokens[1].end)), '日本語')
    assert.equal(tokens[2].type, TokenType.US)
    assert.equal(dec.decode(data.subarray(tokens[3].start, tokens[3].end)), '🎉')
  })

  it('handles multiple GS for depth', () => {
    const data = buf(GS, GS, 'section')
    const tokens = tokenize(data)
    assert.deepEqual(tokens.map(t => t.type), [TokenType.GS, TokenType.GS, TokenType.Data])
  })
})

// ============================================================
// Builder
// ============================================================
describe('Builder', () => {
  it('builds a simple table', () => {
    const data = build(b => {
      b.group('users', ['name', 'age'], () => {
        b.record('Alice', '30')
        b.record('Bob', '25')
      })
    })
    const table = new Table(data)
    assert.equal(dec.decode(table.name), 'users')
    assert.equal(table.headerCount, 2)
    assert.equal(dec.decode(table.header(0)), 'name')
    assert.equal(dec.decode(table.header(1)), 'age')
    assert.equal(table.recordCount, 2)
    assert.equal(dec.decode(table.record(0).field(0)), 'Alice')
    assert.equal(dec.decode(table.record(0).field(1)), '30')
  })

  it('builds a full database with multiple tables', () => {
    const data = build(b => {
      b.file('mydb', () => {
        b.group('users', ['name', 'age'], () => {
          b.record('Alice', '30')
        })
        b.group('config')
      })
    })
    const tokens = tokenize(data)
    assert.equal(tokens[0].type, TokenType.FS)
  })

  it('escapes control codes in field values', () => {
    const data = build(b => {
      b.group('test', null, () => {
        b.record('line1\x1eline2') // contains RS
      })
    })
    const table = new Table(data)
    assert.equal(table.recordCount, 1)
    // The escaped field should survive round-trip
  })

  it('builds document-mode sections', () => {
    const data = build(b => {
      b.section('chapter', 1, () => {
        b.section('subsection', 2, () => {
          b.block('content here')
        })
      })
    })
    const tokens = tokenize(data)
    // First token should be GS (depth 1)
    assert.equal(tokens[0].type, TokenType.GS)
  })

  it('builds key-value config', () => {
    const data = build(b => {
      b.group('config', null, () => {
        b.record('host', 'localhost')
        b.record('port', '8080')
      })
    })
    const table = new Table(data)
    assert.equal(table.recordCount, 2)
    assert.equal(dec.decode(table.record(0).field(0)), 'host')
    assert.equal(dec.decode(table.record(0).field(1)), 'localhost')
  })

  it('builds references', () => {
    const data = build(b => {
      b.ref('users')
    })
    const tokens = tokenize(data)
    assert.equal(tokens[0].type, TokenType.ENQ)
    assert.equal(tokens[1].type, TokenType.Data)
  })

  it('builds path references', () => {
    const data = build(b => {
      b.ref('users', 'alice', 'name')
    })
    const tokens = tokenize(data)
    assert.equal(tokens[0].type, TokenType.ENQ)
    assert.equal(tokens[1].type, TokenType.STX)
  })
})

// ============================================================
// Table
// ============================================================
describe('Table', () => {
  it('reads group name', () => {
    const data = buf(GS, 'users', SOH, 'name', RS, 'Alice')
    const table = new Table(data)
    assert.equal(dec.decode(table.name), 'users')
  })

  it('reads SOH headers', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30')
    const table = new Table(data)
    assert.equal(table.headerCount, 2)
    assert.equal(dec.decode(table.header(0)), 'name')
    assert.equal(dec.decode(table.header(1)), 'age')
  })

  it('reads records and fields', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30', RS, 'Bob', US, '25')
    const table = new Table(data)
    assert.equal(table.recordCount, 2)
    assert.equal(dec.decode(table.record(0).field(0)), 'Alice')
    assert.equal(dec.decode(table.record(0).field(1)), '30')
    assert.equal(dec.decode(table.record(1).field(0)), 'Bob')
  })

  it('handles table without SOH header', () => {
    const data = buf(GS, 'config', RS, 'host', US, 'localhost')
    const table = new Table(data)
    assert.equal(table.headerCount, 0)
    assert.equal(table.recordCount, 1)
  })

  it('stops at next GS boundary', () => {
    const data = buf(GS, 'a', RS, '1', GS, 'b', RS, '2')
    const table = new Table(data)
    assert.equal(dec.decode(table.name), 'a')
    assert.equal(table.recordCount, 1)
  })

  it('stops at EOT', () => {
    const data = buf(GS, 'a', RS, '1', EOT)
    const table = new Table(data)
    assert.equal(table.recordCount, 1)
  })

  it('handles empty fields', () => {
    const data = buf(GS, 'test', RS, US, US, 'x')
    const table = new Table(data)
    const rec = table.record(0)
    assert.equal(rec.fieldCount, 3)
    assert.equal(dec.decode(rec.field(0)), '')
    assert.equal(dec.decode(rec.field(1)), '')
    assert.equal(dec.decode(rec.field(2)), 'x')
  })

  it('handles DLE-escaped bytes', () => {
    const data = buf(GS, 'test', RS, 'a', DLE, RS, 'b')
    const table = new Table(data)
    const rec = table.record(0)
    // The field contains 'a' + literal RS + 'b' in raw bytes
    assert.equal(rec.fieldCount, 1)
  })

  it('iterates records', () => {
    const data = buf(GS, 'test', RS, 'a', RS, 'b', RS, 'c')
    const table = new Table(data)
    const values: string[] = []
    table.eachRecord(rec => values.push(dec.decode(rec.field(0))))
    assert.deepEqual(values, ['a', 'b', 'c'])
  })
})

// ============================================================
// Document
// ============================================================
describe('Document', () => {
  it('reads file name', () => {
    const data = buf(FS, 'mydb', GS, 'users', RS, 'Alice')
    const doc = new Document(data)
    assert.equal(dec.decode(doc.name), 'mydb')
  })

  it('finds all top-level groups', () => {
    const data = buf(FS, 'db', GS, 'users', RS, 'Alice', GS, 'config', RS, 'k', US, 'v')
    const doc = new Document(data)
    assert.equal(doc.groupCount, 2)
  })

  it('accesses groups by name', () => {
    const data = buf(FS, 'db', GS, 'users', SOH, 'name', RS, 'Alice', GS, 'config', RS, 'k', US, 'v')
    const doc = new Document(data)
    const group = doc.group('users')
    assert.equal(dec.decode(group.name), 'users')
  })

  it('accesses groups by index', () => {
    const data = buf(FS, 'db', GS, 'users', RS, 'Alice', GS, 'config', RS, 'k')
    const doc = new Document(data)
    assert.equal(dec.decode(doc.group(0).name), 'users')
    assert.equal(dec.decode(doc.group(1).name), 'config')
  })

  it('raises on unknown group name', () => {
    const data = buf(FS, 'db', GS, 'users', RS, 'Alice')
    const doc = new Document(data)
    assert.throws(() => doc.group('nope'), /No group named/)
  })

  it('handles document without FS', () => {
    const data = buf(GS, 'users', RS, 'Alice')
    const doc = new Document(data)
    assert.equal(dec.decode(doc.name), '')
    assert.equal(doc.groupCount, 1)
  })

  it('handles document with EOT', () => {
    const data = buf(FS, 'db', GS, 'users', RS, 'Alice', EOT)
    const doc = new Document(data)
    assert.equal(doc.groupCount, 1)
  })

  it('ignores deeper GS×N sections', () => {
    const data = buf(GS, 'doc', RS, 'intro', GS, GS, 'chapter1', RS, 'content', GS, 'other')
    const doc = new Document(data)
    // Should find 'doc' and 'other' as top-level, skip GS×2 'chapter1'
    assert.equal(doc.groupCount, 2)
    assert.equal(dec.decode(doc.group(0).name), 'doc')
    assert.equal(dec.decode(doc.group(1).name), 'other')
  })

  it('iterates groups', () => {
    const data = buf(FS, 'db', GS, 'a', RS, '1', GS, 'b', RS, '2')
    const doc = new Document(data)
    const names: string[] = []
    doc.eachGroup(g => names.push(dec.decode(g.name)))
    assert.deepEqual(names, ['a', 'b'])
  })
})

// ============================================================
// Pretty
// ============================================================
describe('Pretty', () => {
  it('maps control codes to correct glyphs', () => {
    assert.equal(glyph(SOH), '␁')
    assert.equal(glyph(STX), '␂')
    assert.equal(glyph(ETX), '␃')
    assert.equal(glyph(EOT), '␄')
    assert.equal(glyph(ENQ), '␅')
    assert.equal(glyph(DLE), '␐')
    assert.equal(glyph(SUB), '␚')
    assert.equal(glyph(FS), '␜')
    assert.equal(glyph(GS), '␝')
    assert.equal(glyph(RS), '␞')
    assert.equal(glyph(US), '␟')
  })

  it('formats a simple table', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30')
    const pretty = format(data)
    assert.ok(pretty.includes('␝users'))
    assert.ok(pretty.includes('␁name␟age'))
    assert.ok(pretty.includes('␞Alice␟30'))
  })

  it('round-trips through format and parse', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30')
    const pretty = format(data)
    const compact = parse(pretty)
    assert.deepEqual(compact, data)
  })

  it('preserves whitespace inside STX/ETX', () => {
    const data = buf(GS, 'test', RS, STX, ' hello  world ', ETX)
    const pretty = format(data)
    const compact = parse(pretty)
    assert.deepEqual(compact, data)
  })

  it('preserves spaces between words', () => {
    const data = buf(GS, 'test', RS, 'hello world')
    const pretty = format(data)
    const compact = parse(pretty)
    assert.deepEqual(compact, data)
  })

  it('formats with spaced mode — columns aligned with spaces', () => {
    const data = buf(
      GS, 'users', SOH, 'name', US, 'age',
      RS, 'Alice', US, '30',
      RS, 'Bob', US, '25',
    )
    const pretty = format(data, { mode: 'spaced' })
    // Spaced: prefix + space, fields padded, space around ␟
    assert.ok(pretty.includes('␁ name  ␟ age'))
    assert.ok(pretty.includes('␞ Alice ␟ 30'))
    assert.ok(pretty.includes('␞ Bob   ␟ 25'))
  })

  it('formats with aligned mode — columns aligned without extra spaces', () => {
    const data = buf(
      GS, 'users', SOH, 'name', US, 'age',
      RS, 'Alice', US, '30',
      RS, 'Bob', US, '25',
    )
    const pretty = format(data, { mode: 'aligned' })
    // Aligned: no space after prefix, no space around ␟
    assert.ok(pretty.includes('␁name ␟age'))
    assert.ok(pretty.includes('␞Alice␟30'))
    assert.ok(pretty.includes('␞Bob  ␟25'))
  })

  it('formats with compact mode — no padding', () => {
    const data = buf(
      GS, 'users', SOH, 'name', US, 'age',
      RS, 'Alice', US, '30',
    )
    const pretty = format(data, { mode: 'compact' })
    assert.ok(pretty.includes('␁name␟age'))
    assert.ok(pretty.includes('␞Alice␟30'))
  })

  it('align round-trips through parse', () => {
    const data = buf(
      GS, 'users', SOH, 'name', US, 'age',
      RS, 'Alice', US, '30',
      RS, 'Bob', US, '25',
    )
    const spaced = format(data, { mode: 'spaced' })
    const compact = parse(spaced)
    assert.deepEqual(compact, data)
  })

  it('align handles mixed table and non-table lines', () => {
    const data = buf(
      FS, 'mydb',
      GS, 'users', SOH, 'name', US, 'age',
      RS, 'Alice', US, '30',
      GS, 'config', RS, 'host', US, 'localhost',
    )
    const spaced = format(data, { mode: 'spaced' })
    // FS line should have space after glyph
    assert.ok(spaced.includes('␜ mydb'))
    // GS line should have space after glyph
    assert.ok(spaced.includes('␝ users'))
    // Table should be aligned
    assert.ok(spaced.includes('␞ Alice ␟ 30'))
  })

  it('align standalone function works on pretty strings', () => {
    const pretty = '␝users\n  ␁name␟age\n  ␞Alice␟30\n  ␞Bob␟25\n'
    const spaced = align(pretty, 'spaced')
    assert.ok(spaced.includes('␁ name  ␟ age'))
    assert.ok(spaced.includes('␞ Alice ␟ 30'))
    assert.ok(spaced.includes('␞ Bob   ␟ 25'))
  })
})

// ============================================================
// CSV
// ============================================================
describe('CSV', () => {
  it('converts CSV to C0DATA', () => {
    const csv = 'name,age\nAlice,30\nBob,25\n'
    const data = fromCSV(csv, 'users')
    const table = new Table(data)
    assert.equal(dec.decode(table.name), 'users')
    assert.equal(table.headerCount, 2)
    assert.equal(table.recordCount, 2)
    assert.equal(dec.decode(table.record(0).field(0)), 'Alice')
  })

  it('converts C0DATA to CSV', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30', RS, 'Bob', US, '25')
    const csv = toCSV(data)
    assert.ok(csv.includes('name,age'))
    assert.ok(csv.includes('Alice,30'))
    assert.ok(csv.includes('Bob,25'))
  })

  it('handles empty CSV', () => {
    const data = fromCSV('')
    assert.equal(data.length, 0)
  })

  it('handles quoted CSV fields', () => {
    const csv = 'name,note\nAlice,"has, comma"\n'
    const data = fromCSV(csv)
    const table = new Table(data)
    assert.equal(dec.decode(table.record(0).field(1)), 'has, comma')
  })

  it('round-trips CSV', () => {
    const csv = 'name,age\nAlice,30\nBob,25\n'
    const data = fromCSV(csv)
    const result = toCSV(data)
    assert.equal(result, csv)
  })
})

// ============================================================
// JSON
// ============================================================
describe('JSON', () => {
  it('exports tabular group as array of objects', () => {
    const data = buf(GS, 'users', SOH, 'name', US, 'age', RS, 'Alice', US, '30')
    const obj = toObject(data) as { [key: string]: unknown }
    const users = (obj as any).users as any[]
    assert.equal(users.length, 1)
    assert.equal(users[0].name, 'Alice')
    assert.equal(users[0].age, '30')
  })

  it('exports key-value group as flat object', () => {
    const data = buf(GS, 'config', RS, 'host', US, 'localhost', RS, 'port', US, '8080')
    const obj = toObject(data) as any
    assert.equal(obj.config.host, 'localhost')
    assert.equal(obj.config.port, '8080')
  })

  it('imports flat key-value from JSON', () => {
    const json = '{"host":"localhost","port":"8080"}'
    const data = fromJSON(json, 'config')
    const table = new Table(data)
    assert.equal(dec.decode(table.name), 'config')
    assert.equal(table.recordCount, 2)
  })

  it('imports array of objects from JSON', () => {
    const json = '[{"name":"Alice","age":"30"},{"name":"Bob","age":"25"}]'
    const data = fromJSON(json, 'users')
    const table = new Table(data)
    assert.equal(table.headerCount, 2)
    assert.equal(table.recordCount, 2)
  })

  it('imports nested objects with STX/ETX', () => {
    const json = '{"user":{"name":"Alice","address":{"city":"NYC"}}}'
    const data = fromJSON(json)
    // Verify it has nested structure
    const tokens = tokenize(data)
    const hasSTX = tokens.some(t => t.type === TokenType.STX)
    assert.ok(hasSTX)
  })

  it('round-trips JSON for flat tables', () => {
    const json = '[{"name":"Alice","age":"30"},{"name":"Bob","age":"25"}]'
    const data = fromJSON(json, 'users')
    const result = toObject(data) as any
    assert.deepEqual(result.users, JSON.parse(json))
  })

  it('round-trips JSON for key-value', () => {
    const json = '{"host":"localhost","port":"8080"}'
    const data = fromJSON(json, 'config')
    const result = toObject(data) as any
    assert.deepEqual(result.config, JSON.parse(json))
  })
})

// ============================================================
// Diff
// ============================================================
describe('Diff', () => {
  it('parses a simple diff', () => {
    const diffBuf = buildDiff(b => {
      b.file('test.txt', () => {
        b.replace('before ', 'old', 'new', ' after')
      })
    })
    const edits = parseDiff(diffBuf)
    assert.equal(edits.length, 1)
    assert.equal(dec.decode(edits[0].path), 'test.txt')
    assert.equal(edits[0].sections.length, 1)
  })

  it('applies a simple substitution', () => {
    const diffBuf = buildDiff(b => {
      b.file('test.txt', () => {
        b.replace('', 'hello', 'world')
      })
    })
    const result = applyDiff(diffBuf, { 'test.txt': 'say hello here' })
    assert.equal(result.get('test.txt'), 'say world here')
  })

  it('applies multi-file edits', () => {
    const diffBuf = buildDiff(b => {
      b.file('a.txt', () => {
        b.replace('', 'foo', 'bar')
      })
      b.file('b.txt', () => {
        b.replace('', 'baz', 'qux')
      })
    })
    const result = applyDiff(diffBuf, { 'a.txt': 'foo', 'b.txt': 'baz' })
    assert.equal(result.get('a.txt'), 'bar')
    assert.equal(result.get('b.txt'), 'qux')
  })

  it('preserves unmodified files', () => {
    const diffBuf = buildDiff(b => {
      b.file('a.txt', () => {
        b.replace('', 'old', 'new')
      })
    })
    const result = applyDiff(diffBuf, { 'a.txt': 'old', 'b.txt': 'unchanged' })
    assert.equal(result.get('b.txt'), 'unchanged')
  })

  it('raises on missing file', () => {
    const diffBuf = buildDiff(b => {
      b.file('missing.txt', () => {
        b.replace('', 'x', 'y')
      })
    })
    assert.throws(() => applyDiff(diffBuf, {}), /File not found/)
  })

  it('raises on missing pattern', () => {
    const diffBuf = buildDiff(b => {
      b.file('test.txt', () => {
        b.replace('', 'nothere', 'something')
      })
    })
    assert.throws(() => applyDiff(diffBuf, { 'test.txt': 'hello' }), /Pattern not found/)
  })

  it('raises on ambiguous pattern', () => {
    const diffBuf = buildDiff(b => {
      b.file('test.txt', () => {
        b.replace('', 'aa', 'bb')
      })
    })
    assert.throws(() => applyDiff(diffBuf, { 'test.txt': 'aa aa' }), /found 2 times/)
  })

  it('uses section builder with anchors', () => {
    const diffBuf = buildDiff(b => {
      b.file('test.txt', () => {
        b.section(sb => {
          sb.anchor('function ')
          sb.sub('oldName', 'newName')
          sb.anchor('()')
        })
      })
    })
    const result = applyDiff(diffBuf, { 'test.txt': 'function oldName() {}' })
    assert.equal(result.get('test.txt'), 'function newName() {}')
  })
})

// ============================================================
// List fields (Builder#listField / Record#list)
// ============================================================

describe('List fields', () => {
  it('listField writes a US-separated list inside STX/ETX as one field', () => {
    const out = build(b => {
      b.group('users', null, () => {
        b.record('Alice')
        b.listField(['Admin', 'Editor', 'User'])
        b.field('1502.30')
      })
    })
    assert.deepEqual(out, buf(
      GS, 'users',
      RS, 'Alice',
      US, STX, 'Admin', US, 'Editor', US, 'User', ETX,
      US, '1502.30',
    ))
    const rec = new Table(out).record(0)
    assert.equal(rec.fieldCount, 3)
    assert.equal(dec.decode(rec.value(0)), 'Alice')
    assert.deepEqual(rec.list(1).map(i => dec.decode(i)), ['Admin', 'Editor', 'User'])
    assert.equal(dec.decode(rec.value(2)), '1502.30')
  })

  it('round-trips escaped items and empty lists through Record#list', () => {
    const items = ['a\u001Fb', '', 'c\u0002d', 'plain']
    const out = build(b => {
      b.group('t', null, () => {
        b.record('x')
        b.listField(items)
        b.listField([])
      })
    })
    const rec = new Table(out).record(0)
    assert.equal(rec.fieldCount, 3)
    assert.deepEqual(rec.list(1).map(i => dec.decode(i)), items)
    assert.deepEqual(rec.list(2), [])
  })

  it('Record#list unescapes items and keeps nested scopes intact', () => {
    const b = buf(
      GS, 't',
      RS, STX, 'Ed', DLE, US, 'itor', US, STX, 'x', US, 'y', ETX, US, 'b', ETX,
    )
    const items = new Table(b).record(0).list(0)
    assert.equal(items.length, 3)
    assert.equal(dec.decode(items[0]), 'Ed\u001Fitor')
    assert.equal(items[1][0], STX)
    assert.equal(dec.decode(items[2]), 'b')
  })

  it('Record#list returns a plain field as a single item and an empty scope as empty', () => {
    const b = buf(GS, 't', RS, 'plain', US, STX, ETX)
    const rec = new Table(b).record(0)
    assert.deepEqual(rec.list(0).map(i => dec.decode(i)), ['plain'])
    assert.deepEqual(rec.list(1), [])
  })
})

describe('Reference name guard', () => {
  it('rejects control bytes in reference names and path segments', () => {
    assert.throws(() => new Builder().ref('bad\u001Fname'), /control bytes/)
    assert.throws(() => new Builder().ref('users', '01\u001E', 'name'), /control bytes/)
    const out = build(b => { b.ref('users'); b.ref('users', '01', 'name') })
    assert.deepEqual(out, buf(ENQ, 'users', ENQ, STX, 'users', US, '01', US, 'name', ETX))
  })
})
