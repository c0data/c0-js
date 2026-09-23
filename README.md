# c0

A TypeScript implementation of [C0DATA](https://github.com/c0data) — structured
data built on ASCII C0 control codes. Values are plain UTF-8 text; structure is
expressed through single-byte control codes (FS/GS/RS/US separators, SOH
headers, STX/ETX nesting, DLE escape, ETB stream commits).

The reader is **zero-copy**: accessors return `Uint8Array` views into the input
buffer and decode escapes only on demand. The library has **no runtime
dependencies**. It targets modern JavaScript (ES modules); the file-backed
stream log uses Node's `fs` via a dynamic import, so everything else runs in
any runtime.

API docs: https://c0data.github.io/c0-js/

## Status

Port of the Crystal reference (`c0-cr`):

- tokenizer, table/record and document/group navigation, builder
- canonical-form helpers, ETB stream mode (`StreamReader`, `StreamWriter`,
  file logs with torn-tail repair)
- pretty form: compact, aligned, and spaced layouts + round-tripping parse
- CSV ⇄ C0DATA and JSON ⇄ C0DATA conversion
- C0DIFF: parse, build, and atomic multi-file apply

It passes the shared language-agnostic conformance vectors from
[c0-spec](https://github.com/c0data/c0-spec), included here as a git submodule
at `c0-spec/`. After cloning:

```sh
git submodule update --init
```

## Install

Not yet published to npm. From a checkout:

```sh
npm install
npm run build    # compiles src/ to dist/
```

Then import from `dist/index.js`, or `npm link` it into a project.

## Usage

```ts
import { build, Table, canonical } from 'c0'

// Build compact bytes
const buf = build(b => {
  b.group('users', ['name', 'amount'], () => {
    b.record('Alice', '1502.30')
    b.record('Bob', '340.00')
  })
})

// Read them back, zero-copy
const t = new Table(buf)
t.record(0).field(0)   // Uint8Array view: "Alice"
t.record(0).value(1)   // Uint8Array, DLE-escapes decoded

// Compact form is canonical — hashable for content addressing
canonical(buf)         // => true
```

Value writers (`record`, `field`, `listField`, `block`, `item`, and the ETB
payload) accept a `string` or a `Uint8Array`, so raw bytes round-trip.

### List fields

A field whose value is a flat list is written as US-separated items inside
STX/ETX (`␂Admin␟Editor␃`). `listField` writes one; `Record#list` reads it
back as unescaped items.

```ts
const buf = build(b => {
  b.group('users', null, () => {
    b.record('Alice')
    b.listField(['Admin', 'Editor'])   // one field: ␂Admin␟Editor␃
  })
})
new Table(buf).record(0).list(1)       // [Uint8Array "Admin", Uint8Array "Editor"]
```

### Documents

```ts
import { Document } from 'c0'

const doc = new Document(buf)
doc.name                     // Uint8Array
doc.group('users').table     // a Table over that group
doc.eachGroup(g => { /* g.name, g.table, g.recordCount */ })
```

### Stream logs (ETB commits)

```ts
import { openLog, readLog } from 'c0'

const log = await openLog('claims.c0')   // repairs a torn tail first
log.record('create', 'a1b2', '1718208000')
log.batch(b => {                          // atomic multi-record commit
  b.record('name', 'draft')
  b.record('tag', 'alpha')
})
log.close()

const r = await readLog('claims.c0')
r.torn                                    // false: any torn append was skipped
r.eachRecord(rec => { /* ... */ })
```

`StreamReader` also works on any `Uint8Array` (`committedEnd`, `committed`,
`tail`, `blockCount`, `block(i)`), and `StreamWriter` on any sink.

### Pretty form and converters

```ts
import { format, parse, fromCSV, toCSV, toJSON, fromJSON } from 'c0'

format(buf)                // Unicode Control Pictures, one glyph per code
parse(format(buf))         // back to compact bytes
fromCSV(csvText, 'users')  // CSV → C0DATA
toJSON(buf)                // C0DATA → JSON text
fromJSON(jsonText, 'data') // JSON → C0DATA
```

## Development

```sh
npm test       # compiles, then runs unit tests and the conformance vectors
npm run docs   # TypeDoc → docs/
```

## License

MIT
