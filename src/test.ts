import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SOH, STX, ETX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, SUB, FS, GS, RS, US,
  C0Error, C0SyntaxError, KeyError,
  value, isPlain, encodeValue, decodeText,
  validate, canonical,
  Body, Record as C0Record, Document, Container,
  build, Builder,
  glyph, format, parse, align, GlyphInDataError,
  tokenize, TokenType,
  fromCSV, toCSV, parseCSV,
  toJSON, toObject, fromJSON, fromObject,
  parseDiff, applyDiff, buildDiff,
  utf8, toHex, ByteWriter,
} from './index.js'

const enc = new TextEncoder()

function concat(parts: Uint8Array[]): Uint8Array {
  const w = new ByteWriter()
  for (const p of parts) w.write(p)
  return w.toUint8Array()
}

/** Build a byte buffer from control codes and strings. */
function buf(...parts: (number | string)[]): Uint8Array {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'number') out.push(p)
    else out.push(...enc.encode(p))
  }
  return new Uint8Array(out)
}

/** Compact bytes from a pretty-form string. */
function g(pretty: string): Uint8Array {
  return parse(pretty)
}

// ============================================================
// Values
// ============================================================

describe('values', () => {
  it('plain iff no byte below 0x20 and no edge whitespace', () => {
    assert.equal(isPlain(enc.encode('Alice Smith')), true)
    assert.equal(isPlain(enc.encode('')), true)
    assert.equal(isPlain(enc.encode(' Alice')), false)
    assert.equal(isPlain(enc.encode('a\tb')), false)
    assert.equal(isPlain(buf('a', US, 'b')), false)
  })

  it('writes one spelling per value, escaping only the seven codes', () => {
    assert.deepEqual(encodeValue('only'), enc.encode('only'))
    assert.deepEqual(encodeValue(' x '), buf(STX, ' x ', ETX))
    assert.deepEqual(encodeValue(buf('a', US, 'b')), buf(STX, 'a', US, 'b', ETX))
    assert.deepEqual(encodeValue(buf('a', ETB, STX, ETX, DLE, EOT, SYN, EM)),
      buf(STX, 'a', DLE, ETB, DLE, STX, DLE, ETX, DLE, DLE, DLE, EOT, DLE, SYN, DLE, EM, ETX))
  })

  it('reads a plain value with its edge layout trimmed and a text decoded', () => {
    assert.equal(utf8(value(enc.encode(' Alice '))), 'Alice')
    assert.deepEqual(value(buf(STX, 'a', DLE, ETB, 'b', ETX)), buf('a', ETB, 'b'))
    assert.deepEqual(value(buf(STX, ETX)), new Uint8Array(0))
  })

  it('a note in a unit is skipped; a note alone is the empty value', () => {
    assert.equal(utf8(value(buf('x', BEL, 'old'))), 'x')
    assert.equal(value(buf(BEL, 'old')).length, 0)
  })

  it('rejects layout inside a plain value and text glued to plain', () => {
    assert.throws(() => value(buf('a\tb')), C0SyntaxError)
    assert.throws(() => value(buf('abc', STX, ' x ', ETX, 'def')), C0SyntaxError)
  })

  it('decodeText is zero-copy without escapes', () => {
    const inside = enc.encode('hello')
    assert.equal(decodeText(inside), inside)
  })
})

// ============================================================
// Builder
// ============================================================

describe('Builder', () => {
  it('builds the full database example', () => {
    const bytes = build(b => {
      b.syn()
      b.file('mydb')
      b.group('users', ['name', 'amount', 'type'], () => {
        b.record('Alice', '1502.30', 'DEPOSIT')
        b.record('Bob', '340.00', 'WITHDRAWAL')
      })
      b.group('products', ['id', 'product', 'qty'])
      b.record('01', 'Widget', '100')
      b.eot()
    })
    assert.deepEqual(bytes, g('␖␜mydb␝users␁␞name␟amount␟type␞Alice␟1502.30␟DEPOSIT␞Bob␟340.00␟WITHDRAWAL␝products␁␞id␟product␟qty␞01␟Widget␟100␄'))
  })

  it('writes a SYN heading with keys in the order given', () => {
    assert.deepEqual(build(b => b.syn({ shape: 'stream', version: '1' })), g('␖␁shape␟stream␁version␟1'))
    assert.deepEqual(build(b => b.syn([['version', '1'], ['shape', 'stream']])), g('␖␁version␟1␁shape␟stream'))
  })

  it('writes keyed records in order and keeps values byte-transparent', () => {
    const bytes = build(b => {
      b.group('database')
      b.map({ host: 'localhost', port: '5432' })
      b.record().key('a', ' x ').key('b', buf(0x00, 0xff))
    })
    assert.deepEqual(bytes, buf(GS, 'database', RS, SOH, 'host', US, 'localhost', SOH, 'port', US, '5432',
      RS, SOH, 'a', US, STX, ' x ', ETX, SOH, 'b', US, STX, 0x00, 0xff, ETX))
  })

  it('nests levels, lists and maps', () => {
    const bytes = build(b => {
      b.record('Alice')
      b.list(['Admin', 'Editor'])
      b.list([])
      b.level(() => {
        b.header('street', 'city')
        b.record('123 Main', 'Springfield')
      })
      b.key('ignored-not-mixed-here', 'x') // keyed unit on a new record below
    })
    // the last key continued the open positional record: the caller's business; check the prefix
    const want = g('␞Alice␟␐␞Admin␟Editor␘␟␐␘␟␐␁␞street␟city␞123 Main␟Springfield␘')
    assert.deepEqual(bytes.subarray(0, want.length), want)
  })

  it('writes references as a name or a text path', () => {
    assert.deepEqual(build(b => b.record('My Post').ref('tags').ref('tags', '001')),
      buf(RS, 'My Post', US, ENQ, 'tags', US, ENQ, STX, 'tags', US, '001', ETX))
    assert.throws(() => build(b => b.ref('tags', ' x')), C0Error)
    assert.throws(() => build(b => b.ref('a', 'b', 'c', 'd')), C0Error)
  })

  it('refuses names that are not identifiers', () => {
    assert.throws(() => build(b => b.group(' users')), C0Error)
    assert.throws(() => build(b => b.header(['a\tb'])), C0Error)
    assert.throws(() => build(b => b.key('k ', 'v')), C0Error)
  })

  it('writes notes, commits and the EM tail', () => {
    assert.deepEqual(build(b => b.note('see the runbook').record('a').etb('sha256:00').em(buf('raw'))),
      buf(BEL, 'see the runbook', RS, 'a', ETB, 'sha256:00', EM, 'raw'))
    assert.deepEqual(build(b => b.note(' spaced ')), buf(BEL, STX, ' spaced ', ETX))
  })

  it('output is canonical', () => {
    const bytes = build(b => {
      b.group('g', ['a', 'b'])
      b.record('1', ' 2 ')
      b.map({ k: 'v' })
    })
    assert.equal(canonical(bytes), true)
  })

  it('refuses an empty note', () => {
    assert.throws(() => build(b => b.record('a').note('')), C0Error)
    assert.throws(() => build(b => b.record('a').bel('')), C0Error)
    assert.throws(() => build(b => b.record('a').bel(new Uint8Array(0))), C0Error)
  })

  it('spells primitives as the bytes read', () => {
    assert.deepEqual(build(b => b.fs('inv').gs('users').soh().rs('name').us('amount')), g('␜inv␝users␁␞name␟amount'))
    assert.deepEqual(build(b => b.rs('Alice').us('1502.30')), g('␞Alice␟1502.30'))
    assert.deepEqual(build(b => b.rs().soh('host').us('localhost').soh('port').us('5432')), g('␞␁host␟localhost␁port␟5432'))
    assert.deepEqual(build(b => b.rs('cfg').us().dle().rs().soh('b').us('2').can()), g('␞cfg␟␐␞␁b␟2␘'))
    assert.deepEqual(build(b => b.bel('checked').rs('x')), g('␇checked␞x'))
    assert.deepEqual(build(b => b.bel().gs('old').rs('1').gs('new').rs('2')), g('␇␝old␞1␝new␞2'))
    assert.deepEqual(build(b => b.gs().gs('sub').rs().enq('users').us().enq('users', '1')), g('␝␝sub␞␅users␟␅␂users␟1␃'))
    assert.deepEqual(build(b => b.syn().soh('version').us('1').rs('a').eot()), g('␖␁version␟1␞a␄'))
    assert.deepEqual(build(b => b.fs('f').rs('old').sub('new').gs('x').us('10').sub('20')), g('␜f␞old␚new␝x␟10␚20'))
    assert.deepEqual(build(b => b.rs('old').sub(' new ').sub()), buf(RS, 'old', SUB, STX, ' new ', ETX, SUB))
    assert.deepEqual(build(b => b.rs(' a ').us(' b ').bel(' n ').etb('c1')), buf(RS, STX, ' a ', ETX, US, STX, ' b ', ETX, BEL, STX, ' n ', ETX, ETB, 'c1'))
  })

  it('validates names in the primitives', () => {
    assert.throws(() => build(b => b.fs(' f')), C0Error)
    assert.throws(() => build(b => b.gs('a\tb')), C0Error)
    assert.throws(() => build(b => b.soh('k ')), C0Error)
    assert.throws(() => build(b => b.enq(' x')), C0Error)
    assert.throws(() => build(b => b.enq('a', 'b', 'c', 'd')), C0Error)
    assert.throws(() => build(b => b.etb(' p')), C0Error)
  })

  it('mixes primitives with composed methods', () => {
    const bytes = build(b => {
      b.rs('a')
      b.field('b')
      b.record()
      b.us('c')
      b.gs('g')
      b.key('k', 'v')
      b.group('h', ['h'])
      b.field('x')
    })
    assert.deepEqual(bytes, g('␞a␟b␞␟c␝g␞␁k␟v␝h␁␞h␞x'))
    assert.throws(() => build(b => b.can()), C0Error)
    assert.throws(() => build(b => b.dle().can().can()), C0Error)
  })

  it('writes the same bytes through either layer', () => {
    const hi = build(b => {
      b.syn({ shape: 'tabular' })
      b.group('users', ['name', 'amount'], () => {
        b.record('Alice', '1502.30')
        b.record('Bob', '3 40')
      })
      b.group('cfg')
      b.map({ host: 'localhost', port: '5432' })
      b.record('r').level(() => { b.record('n') }).list(['i', 'j']).ref('users', '1')
      b.record().key('k', () => { b.record('v') })
      b.eot()
    })
    const lo = build(b => {
      b.syn().soh('shape').us('tabular')
      b.gs('users').soh().rs('name').us('amount').rs('Alice').us('1502.30').rs('Bob').us('3 40')
      b.gs('cfg').rs().soh('host').us('localhost').soh('port').us('5432')
      b.rs('r').us().dle().rs('n').can().us().dle().rs('i').us('j').can().us().enq('users', '1')
      b.rs().soh('k').us().dle().rs('v').can()
      b.eot()
    })
    assert.deepEqual(lo, hi)
    assert.equal(canonical(new Document(lo).body.raw), true)
  })
})

// ============================================================
// Body / Record
// ============================================================

describe('Body', () => {
  it('indexes files, groups, header rows and records', () => {
    const body = new Body(g('␜mydb␝users␁␞name␟amount␞Alice␟1502.30␞Bob␟340.00␝products␞01␟Widget'))
    assert.equal(utf8(body.name), 'mydb')
    assert.equal(body.groupCount, 2)
    assert.deepEqual(body.groupNames.map(utf8), ['users', 'products'])
    const users = body.group('users')
    assert.deepEqual(users.headers.map(utf8), ['name', 'amount'])
    assert.equal(users.recordCount, 2)
    assert.deepEqual(users.record(1).strings, ['Bob', '340.00'])
    assert.equal(users.column('amount'), 1)
    assert.equal(users.column('nope'), -1)
    assert.equal(body.group(1).hasHeader, false)
    assert.throws(() => body.group('nope'), KeyError)
  })

  it('a bare record stream is one unnamed file and group', () => {
    const body = new Body(g('␞a␟b␞c'))
    assert.equal(body.bare, true)
    assert.equal(body.recordCount, 2)
    assert.deepEqual(body.record(0).strings, ['a', 'b'])
  })

  it('counts units by separators and reads an empty record as one empty field', () => {
    assert.equal(new Body(g('␞Alice␟')).record(0).fieldCount, 2)
    assert.equal(new Body(g('␞')).record(0).fieldCount, 1)
    assert.equal(new Body(g('␞Alice␟␇old␟100')).record(0).fieldCount, 3)
    assert.equal(new Body(g('␞a␇n␟b')).record(0).fieldCount, 2)
  })

  it('whitespace touching a code is layout', () => {
    const body = new Body(g('  ␝ users \n  ␁␞ name ␟ amount \n  ␞ Alice Smith ␟ 100 \n'))
    const grp = body.group('users')
    assert.deepEqual(grp.headers.map(utf8), ['name', 'amount'])
    assert.deepEqual(grp.record(0).strings, ['Alice Smith', '100'])
  })

  it('reads keyed records in order, last wins on duplicates', () => {
    const rec = new Body(g('␞␁host␟localhost␁port␟5432␁host␟db')).record(0)
    assert.equal(rec.keyed, true)
    assert.deepEqual(rec.keys.map(utf8), ['host', 'port', 'host'])
    assert.equal(rec.getString('host'), 'db')
    assert.equal(rec.getString('port'), '5432')
    assert.equal(rec.has('nope'), false)
    assert.equal(rec.fieldCount, 0)
  })

  it('reads levels, lists and references', () => {
    const rec = new Body(g('␞Alice␟␐␞Admin␟Editor␘␟␐␘␟␐␁␞street␟city␞1 Main␟Springfield␘␟␅tags␟␅␂tags␟001␟label␃')).record(0)
    assert.deepEqual(rec.list(1).map(utf8), ['Admin', 'Editor'])
    assert.deepEqual(rec.list(2), [])
    const lvl = rec.level(3)
    assert.deepEqual(lvl.group(0).headers.map(utf8), ['street', 'city'])
    assert.deepEqual(lvl.group(0).record(0).strings, ['1 Main', 'Springfield'])
    assert.throws(() => new Body(g('␞␐␞1␟2␞3␟4␘')).record(0).list(0), C0Error)
    assert.deepEqual(rec.ref(4).segments, ['tags'])
    assert.equal(rec.ref(4).isGroup, true)
    assert.deepEqual(rec.ref(5).segments, ['tags', '001', 'label'])
    assert.throws(() => rec.value(3), C0SyntaxError)
  })

  it('a map under a key', () => {
    const rec = new Body(g('␞␁server␟␐␞␁host␟0.0.0.0␁port␟8080␘')).record(0)
    const inner = rec.keyLevel('server')!.record(0)
    assert.equal(inner.getString('port'), '8080')
  })

  it('skips notes and dead elements, keeping scanning properties', () => {
    const body = new Body(g('␇ see the runbook␇␞port␟5432␝server␇␁␞name␟amount␞Alice␟␇␐␞Admin␘␟100␇␝gone␞Bob'))
    assert.equal(body.groupCount, 1)
    const grp = body.group('server')
    assert.equal(grp.hasHeader, false)
    assert.equal(grp.recordCount, 2)
    assert.deepEqual(grp.record(0).strings, ['Alice', '', '100'])
    assert.deepEqual(grp.record(1).strings, ['Bob'])
  })

  it('GS repetition is depth', () => {
    const groups = new Body(g('␝Chapter 1␞p1␝␝Section 1.1␞p2␝␝␝Sub␞p3␝Chapter 2')).groups
    assert.deepEqual(groups.map(x => x.depth), [1, 2, 3, 1])
    assert.deepEqual(groups.map(x => utf8(x.name)), ['Chapter 1', 'Section 1.1', 'Sub', 'Chapter 2'])
  })

  it('a dead file line keeps its contents in the previous file', () => {
    const body = new Body(g('␜a␝x␞1␇␜b␞2␝y'))
    assert.equal(body.files.length, 1)
    assert.deepEqual(body.files[0].groups.map(x => utf8(x.name)), ['x', 'y'])
    assert.deepEqual(body.files[0].groups[0].records.map(r => r.string(0)), ['1', '2'])
    const lead = new Body(g('␇␜b␝y'))
    assert.equal(lead.files.length, 1)
    assert.deepEqual(lead.files[0].groups.map(x => utf8(x.name)), ['y'])
  })
})

// ============================================================
// Document / Container
// ============================================================

describe('Document', () => {
  it('reads the heading and warns on missing markers', () => {
    const doc = new Document(g('␖␁shape␟tabular␁version␟1␁x␟y␜db␝g␞a␄'))
    assert.equal(doc.hasSyn, true)
    assert.equal(doc.hasEot, true)
    assert.equal(doc.shape, 'tabular')
    assert.equal(doc.heading.version, 1)
    assert.deepEqual(doc.warnings, ["unknown heading key 'x'"])
    assert.equal(utf8(doc.name), 'db')
    assert.equal(doc.group('g').recordCount, 1)

    const slice = new Document(g('␝g␞a'))
    assert.deepEqual(slice.warnings, ['no SYN at the start of the document', 'no EOT at the end of the document'])
    assert.equal(new Document(g('␖␁shape␟stream␞a␗')).warnings.length, 0)
  })

  it('a heading value may be a level, never a reference', () => {
    const doc = new Document(g('␖␁blob␟␐␁␞name␟offset␟length␞lamp␟0␟3␘␄'))
    assert.deepEqual(doc.heading.blob!.group(0).headers.map(utf8), ['name', 'offset', 'length'])
    assert.throws(() => new Document(g('␖␁k␟␅g␄')), C0SyntaxError)
  })

  it('a container holds several documents and the EM tail', () => {
    const cont = new Container(concat([g('␖␁blob␟␐␁␞name␟offset␟length␞lamp␟0␟3␞desk␟3␟4␘␄␖␜catalogue␝items␁␞name␟photo␞Lamp␟lamp␄'), buf(EM, 'abcdefg')]))
    assert.equal(cont.documents.length, 2)
    assert.equal(cont.hasEm, true)
    assert.equal(utf8(cont.tail), 'abcdefg')
    assert.equal(utf8(cont.blob('lamp')!), 'abc')
    assert.equal(utf8(cont.blob('desk')!), 'defg')
    assert.equal(cont.blob('nope'), undefined)
    assert.equal(utf8(cont.documents[1].name), 'catalogue')
  })

  it('a second document needs SYN; bytes after EOT are an error', () => {
    assert.throws(() => new Container(g('␞a␄␞b')), C0SyntaxError)
    assert.throws(() => new Container(g('␞a␄x')), C0SyntaxError)
    assert.equal(new Container(g('␞a␄␖␞b␄')).documents.length, 2)
  })
})

// ============================================================
// Validator
// ============================================================

describe('validate / canonical', () => {
  it('accepts the spec examples', () => {
    for (const s of [
      '␖␜mydb␝users␁␞name␟amount␞Alice␟100␞Bob␟200␄',
      '␖␁shape␟stream␞alice␟100␗␞bob␟200␗',
      '␖␁shape␟diff␜foo.txt␝␂Hello ␃␟world␚universe␄',
      '␝database␞␁host␟localhost␁port␟5432␝server␞␁host␟0.0.0.0␁allowed_origins␟␐␞localhost␟example.com␘',
      '␇ note␇␞dead␇␝g␇␁␞h␞Alice␟␇␐␞Admin␘␟100',
    ]) validate(g(s))
  })

  it('rejects malformed input', () => {
    for (const bytes of [
      buf(RS, 0x0e),                         // unassigned code
      buf(RS, STX, 'a'),                     // unclosed text
      buf(RS, STX, DLE, 'a', ETX),           // DLE before a non-escapable byte
      buf(RS, 'a\nb'),                       // LF inside a plain value
      buf(RS, SOH, 'a', US, '1', US, '2'),   // mixed record
      buf(RS, SOH, 'a'),                     // key without a value
      buf(GS, STX, 'name', ETX),             // a name as text
      buf(RS, 'a', SUB, 'b'),                // SUB outside a diff
      buf(RS, 'a', EOT, 'b'),                // bytes after EOT
      buf(RS, 'a', BEL, US, 'b'),            // BEL before a non-element
      buf(RS, DLE, 'x', CAN),                // DLE before plain
      buf(RS, DLE, RS, 'x'),                 // level not closed
      buf(RS, 'x', CAN),                     // unmatched CAN
      buf(RS, 'a', RS, 'b', SOH, RS, 'h'),   // header row not first
      buf(SYN, 'x'),                         // plain directly after SYN
    ]) assert.throws(() => validate(bytes), C0Error, toHex(bytes))
  })

  it('classifies canonical form', () => {
    assert.equal(canonical(g('␝g␞a␟b')), true)
    assert.equal(canonical(buf(GS, 'g', RS, 'a', US, ' b')), false) // layout
    assert.equal(canonical(g('␝g␞␂a␃')), false)         // gratuitous text
    assert.equal(canonical(g('␝g␞␂␃')), false)           // empty text
    assert.equal(canonical(g('␖␝g␞a␄')), false)         // framing
    assert.equal(canonical(g('␝g␇n␞a')), false)          // comment
    assert.equal(canonical(g('␞␁a␟1␁a␟2')), false)       // duplicate key
    assert.equal(canonical(g('␞␁a␟1␁b␟2␁a␟3')), false)   // duplicate key, not adjacent
    assert.equal(canonical(g('␞␁b␟1␁a␟2')), true)        // key order is data
    assert.equal(canonical(g('␞␅␂g␃')), false)           // group reference as text
    assert.equal(canonical(buf(RS, 0x0e)), false)        // not even well-formed
  })
})

// ============================================================
// Pretty
// ============================================================

describe('Pretty', () => {
  it('maps codes to Control Pictures', () => {
    assert.equal(glyph(RS), '␞')
    assert.equal(glyph(DLE), '␐')
    assert.equal(glyph(CAN), '␘')
    assert.equal(glyph(SYN), '␖')
  })

  it('formats a document one element per line', () => {
    const out = format(g('␖␜mydb␝users␁␞name␟amount␞Alice Smith␟1502.30␞Bob␟340.00␄'))
    assert.equal(out, '␖\n␜mydb\n␝users\n  ␁␞name␟amount\n  ␞Alice Smith␟1502.30\n  ␞Bob␟340.00\n␄\n')
  })

  it('shows the heading on the SYN line and text exactly', () => {
    const out = format(g('␖␁shape␟stream␁blob␟␐␁␞name␟offset␘␞note␟␂line one\nline two␃␗'))
    assert.equal(out, '␖␁shape␟stream␁blob␟␐␁␞name␟offset␘\n␞note␟␂line one\nline two␃␗\n')
  })

  it('breaks the line at a level and resumes after CAN', () => {
    const out = format(g('␝users␁␞name␟address␞Alice␟␐␁␞street␟city␞123 Main␟Springfield␘␞Bob␟␐␘'))
    assert.equal(out, [
      '␝users',
      '  ␁␞name␟address',
      '  ␞Alice␟␐',
      '    ␁␞street␟city',
      '    ␞123 Main␟Springfield',
      '  ␘',
      '  ␞Bob␟␐',
      '  ␘',
      '',
    ].join('\n'))
  })

  it('round-trips through format and parse', () => {
    for (const s of [
      '␖␜mydb␝users␁␞name␟amount␞Alice Smith␟1502.30␞Bob␟340.00␄',
      '␝k␞␁host␟localhost␁port␟5432␞␁list␟␐␞a␟b␘',
      '␞a␟␂ spaced \ttab ␐␗␃␟␅␂g␟r␃␗payload',
      '␇ a note␇␞dead␟x␞live',
      '␖␁shape␟diff␜foo.txt␝␂Hello ␃␟world␚universe␟!␞count␚total␄',
      '␖␁blob␟␐␁␞name␟offset␘␄␙raw bytes',
    ]) {
      const bytes = g(s)
      assert.deepEqual(parse(format(bytes)), bytes, s)
    }
  })

  it('parse drops layout touching a glyph and keeps interior spaces', () => {
    assert.deepEqual(parse('  ␝ users \n  ␞ Alice Smith ␟ 100 \n'), g('␝users␞Alice Smith␟100'))
    assert.deepEqual(parse('␞␂ kept \n␃'), buf(RS, STX, ' kept \n', ETX))
  })

  it('refuses a value holding a Control Picture', () => {
    assert.throws(() => format(buf(RS, '␞')), GlyphInDataError)
  })

  it('aligns table columns and keyed records', () => {
    const bytes = g('␝users␁␞name␟amount␞Alice Smith␟1502.30␞Bob␟340.00')
    assert.equal(format(bytes, { mode: 'aligned' }),
      '␝users\n  ␁␞name       ␟amount\n  ␞Alice Smith␟1502.30\n  ␞Bob        ␟340.00\n')
    assert.equal(format(bytes, { mode: 'spaced' }),
      '␝ users\n  ␁␞ name        ␟ amount\n  ␞ Alice Smith ␟ 1502.30\n  ␞ Bob         ␟ 340.00\n')
    const keyed = format(g('␝db␞␁host␟localhost␁port␟5432␞␁hostname␟x␁p␟1'), { mode: 'aligned' })
    assert.equal(keyed, '␝db\n  ␞␁host    ␟localhost ␁port␟5432\n  ␞␁hostname␟x         ␁p   ␟1\n')
    assert.deepEqual(parse(keyed), g('␝db␞␁host␟localhost␁port␟5432␞␁hostname␟x␁p␟1'))
    assert.deepEqual(parse(align(format(bytes), 'spaced')), bytes)
  })
})

// ============================================================
// Tokenizer
// ============================================================

describe('Tokenizer', () => {
  it('emits one token per code, whole texts, and plain/layout runs', () => {
    const tokens = tokenize(buf(RS, 'Alice ', US, STX, 'a', DLE, ETX, ETX, '\n', SYN, EM, 'raw'))
    assert.deepEqual(tokens.map(t => t.type), [
      TokenType.RS, TokenType.Data, TokenType.Layout, TokenType.US, TokenType.Text, TokenType.Layout, TokenType.SYN, TokenType.EM,
    ])
    assert.deepEqual(tokens[1], { type: TokenType.Data, start: 1, end: 6 })
  })

  it('rejects unassigned codes', () => {
    assert.throws(() => tokenize(buf(RS, 0x0e)), C0Error)
  })
})

// ============================================================
// CSV
// ============================================================

describe('CSV', () => {
  it('parses quoted fields and CRLF', () => {
    assert.deepEqual(parseCSV('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']])
    assert.deepEqual(parseCSV(''), [])
  })

  it('converts both ways with a header row', () => {
    const bytes = fromCSV('name,amount\nAlice Smith,1502.30\nBob,340.00\n', 'users')
    assert.deepEqual(bytes, g('␝users␁␞name␟amount␞Alice Smith␟1502.30␞Bob␟340.00'))
    assert.equal(toCSV(bytes), 'name,amount\nAlice Smith,1502.30\nBob,340.00\n')
  })

  it('writes references as paths and refuses levels', () => {
    assert.equal(toCSV(g('␝g␞a␟␅␂tags␟001␃')), 'a,tags/001\n')
    assert.throws(() => toCSV(g('␝g␞a␟␐␞x␘')), C0Error)
    assert.equal(toCSV(g('␝a␞1␝b␞2'), 'b'), '2\n')
  })
})

// ============================================================
// JSON
// ============================================================

describe('JSON', () => {
  it('exports a table with a header row as objects, a map as an object', () => {
    assert.deepEqual(toObject(g('␝users␁␞name␟amount␞Alice␟100␝db␞␁host␟x␁port␟1')), {
      users: [{ name: 'Alice', amount: '100' }],
      db: { host: 'x', port: '1' },
    })
    assert.deepEqual(toObject(g('␞a␟␐␞1␟2␘␟␅␂g␟r␃')), [['a', ['1', '2'], { $ref: 'g/r' }]])
    assert.deepEqual(toObject(g('␜db␝g␞a')), { db: { g: [['a']] } })
  })

  it('imports objects of groups, arrays of objects, and nested values', () => {
    assert.deepEqual(fromObject({ users: [{ name: 'Alice', tags: ['a', 'b'] }], db: { host: 'x', n: 1, z: null } }),
      g('␝users␁␞name␟tags␞Alice␟␐␞a␟b␘␝db␞␁host␟x␁n␟1␁z␟'))
    assert.deepEqual(fromObject({ mydb: { users: [['a', 'b']] } }), g('␜mydb␝users␞a␟b'))
    assert.deepEqual(fromObject({ a: 'x' }), g('␝data␞␁a␟x'))
    assert.deepEqual(fromObject(['x', 'y'], 'items'), g('␝items␞x␞y'))
    assert.deepEqual(fromJSON('{"k":{"a":"1"}}'), g('␝k␞␁a␟1'))
  })

  it('round-trips tables and maps', () => {
    const table = g('␝users␁␞name␟amount␞Alice␟100␞Bob␟200')
    assert.deepEqual(fromJSON(toJSON(table), 'x'), table)
    const map = g('␝db␞␁host␟x␁port␟1')
    assert.deepEqual(fromJSON(toJSON(map)), map)
  })
})

// ============================================================
// Diff
// ============================================================

describe('Diff', () => {
  it('builds a diff document', () => {
    const diff = buildDiff(d => {
      d.file('greeting.txt', () => d.section(s => s.anchor('Hello ').sub('world', 'universe').anchor('!')))
      d.file('tally.rb', () => {
        d.section(s => s.anchor('def tally(items)'))
        d.replaceAll('count', 'total')
        d.section(s => s.anchor('end'))
      })
      d.eot()
    })
    assert.deepEqual(diff, g('␖␁shape␟diff␜greeting.txt␝␂Hello ␃␟world␚universe␟!␜tally.rb␝def tally(items)␞count␚total␝end␄'))
    const edits = parseDiff(diff)
    assert.equal(edits.length, 2)
    assert.equal(utf8(edits[0].sections[0].search), 'Hello world!')
    assert.equal(utf8(edits[0].sections[0].replacement), 'Hello universe!')
    assert.equal(edits[1].sections[0].replaces.length, 1)
  })

  it('applies atomically and leaves other files alone', () => {
    const diff = buildDiff(d => {
      d.file('a.txt').replace('Hello ', 'world', 'universe', '!')
      d.file('b.txt').section(s => s.sub('x', 'y'))
    })
    const out = applyDiff(diff, { 'a.txt': 'Hello world!', 'b.txt': 'axb', 'c.txt': 'untouched' })
    assert.deepEqual(Object.fromEntries(out), { 'a.txt': 'Hello universe!', 'b.txt': 'ayb', 'c.txt': 'untouched' })
    assert.throws(() => applyDiff(diff, { 'a.txt': 'Hello world!' }), C0Error) // b.txt missing
    assert.throws(() => applyDiff(diff, { 'a.txt': 'Hello world! Hello world!', 'b.txt': 'axb' }), C0Error)
  })

  it('refuses a contradicting shape', () => {
    assert.throws(() => parseDiff(g('␖␁shape␟stream␜a␝x')), C0Error)
    assert.equal(parseDiff(g('␜a␝x')).length, 1)
  })
})

// keep the Record import used for typing
void (null as unknown as C0Record)
void Builder
