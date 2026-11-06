# c0

A TypeScript implementation of [C0DATA](https://github.com/c0data) — structured
data built on ASCII C0 control codes. Values are plain UTF-8 text; structure is
expressed through single-byte control codes: FS/GS/RS/US separators, `␁` keys
and header rows, `␂…␃` text, `␐…␘` nesting, `␅` references, `␇` comments, a
`␖` heading, `␗` stream commits and `␙` trailing blobs.

The reader is **zero-copy**: accessors return `Uint8Array` views into the input
buffer and decode text escapes only on demand. The library has **no runtime
dependencies**. It targets modern JavaScript (ES modules); the file-backed
stream log and on-disk diff apply use Node's `fs` via a dynamic import, so
everything else runs in any runtime.

API docs: https://c0data.github.io/c0-js/

## Status

Port of the Crystal reference (`c0-cr`) to the 1.0 redesign of the spec:

- scanning primitives, values, a recursive-descent validator with canonical
  classification, tokenizer
- `Body` / `Document` / `Container` navigation (files, groups, header rows,
  positional and keyed records, levels, lists, references, blob tables)
- `Builder` writing canonical bytes; ETB stream mode (`StreamReader`,
  `StreamWriter`, file logs with torn-tail repair)
- pretty form: compact, aligned, and spaced layouts + round-tripping parse
- CSV ⇄ C0DATA and JSON ⇄ C0DATA conversion
- C0-DIFF: parse, build, and atomic multi-file apply

It passes every case of the language-agnostic conformance vectors from
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
import { build, Document, canonical } from 'c0'

// Build a document: SYN heading, a file, a group with a header row, EOT
const buf = build(b => {
  b.syn()
  b.file('mydb')
  b.group('users', ['name', 'amount'], () => {   // ␝users␁␞name␟amount
    b.record('Alice Smith', '1502.30')            // ␞Alice Smith␟1502.30
    b.record('Bob', '340.00')
  })
  b.eot()
})

// Read it back, zero-copy
const doc = new Document(buf)
const users = doc.group('users')
users.headers                 // [Uint8Array "name", Uint8Array "amount"]
users.record(0).value(0)      // Uint8Array "Alice Smith"
users.record(0).string(1)     // "1502.30"

// The body is canonical — hashable for content addressing
canonical(doc.body.raw)       // => true
```

Value writers (`record`, `field`, `list`, `key`, `map`, `note`) accept a
`string` or a `Uint8Array`, so raw bytes round-trip. A value is written plain
when it can be and as text (`␂…␃`) when it must be: edge whitespace, a tab or
line break, or any control byte. Names (file and group labels, keys, header
names) must be identifiers.

Underneath, the builder has one method per code: `fs`, `gs`, `rs`, `us`,
`soh`, `dle`, `can`, `bel`, `enq`, `syn`, `eot`, `etb`, `em`. Each writes
its code and, when given, what follows it, so a chain reads like the
bytes, and anything the grammar allows can be written:

```ts
b.rs('Alice').us('1502.30')                                  // ␞Alice␟1502.30
b.rs().soh('host').us('localhost').soh('port').us('5432')    // ␞␁host␟localhost␁port␟5432
b.gs('users').soh().rs('name').us('amount')                  // header row
b.rs('cfg').us().dle().rs().soh('b').us('2').can()           // ␞cfg␟␐␞␁b␟2␘
b.bel().gs('old')                                            // a dead group
b.gs().gs('sub').rs().enq('users').us().enq('users', '1')    // ␝␝sub␞␅users␟␅␂users␟1␃
```

The composed methods above are built on these and cannot write ill-formed
output; with the primitives, well-formedness is yours. The two layers
share state and mix freely: `b.rs('a').field('b')` writes `␞a␟b`.

### Keyed records, levels and lists

```ts
const buf = build(b => {
  b.group('server')
  b.map({ host: '0.0.0.0', port: '8080' })        // ␞␁host␟0.0.0.0␁port␟8080
  b.record('Alice')
  b.list(['Admin', 'Editor'])                     // ␐␞Admin␟Editor␘
  b.level(() => {                                 // ␐␁␞street␟city␞1 Main␟Springfield␘
    b.header('street', 'city')
    b.record('1 Main', 'Springfield')
  })
  b.ref('tags', '001')                            // ␅␂tags␟001␃
})

const [config, alice] = new Document(buf).group('server').records
config.keyed                 // true; keys stay in written order, last wins
config.getString('port')     // "8080"
alice.list(1)                // [Uint8Array "Admin", Uint8Array "Editor"]
alice.level(2).group(0)      // a Group with headers street, city
alice.ref(3).segments        // ["tags", "001"]
```

### Documents and containers

```ts
import { Container, validate } from 'c0'

const cont = new Container(bytes)   // several ␖…␄ documents and an optional ␙ tail
cont.documents[0].heading.shape     // "tabular" | "stream" | "diff" | undefined
cont.documents[0].warnings          // e.g. ["no SYN at the start of the document"]
cont.blob('lamp')                   // bytes from the tail, by the heading's blob table
validate(bytes)                     // throws C0SyntaxError on malformed input
```

### Stream logs (ETB commits)

```ts
import { openLog, readLog } from 'c0'

const log = await openLog('claims.c0')    // repairs a torn tail first
log.start()                               // ␖␁shape␟stream␗ on a new log
log.header('op', 'id', 'at')
log.record('create', 'a1b2', '1718208000')
log.batch(b => {                          // atomic multi-record commit
  b.record('name', 'draft')
  b.record('tag', 'alpha')
})
log.close()

const r = await readLog('claims.c0')
r.torn                                    // false: any torn append was skipped
r.damaged                                 // blocks cut by an ETB inside open text or a level
r.eachRecord(rec => { /* ... */ })
```

`StreamReader` also works on any `Uint8Array` (`committedEnd`, `committed`,
`tail`, `blockCount`, `block(i)`), and `StreamWriter` on any sink.

### Pretty form and converters

```ts
import { format, parse, fromCSV, toCSV, toJSON, fromJSON, buildDiff, applyDiff } from 'c0'

format(buf)                // Unicode Control Pictures, one element per line
format(buf, { mode: 'aligned' })
parse(format(buf))         // back to compact bytes
fromCSV(csvText, 'users')  // CSV → C0DATA
toJSON(buf)                // C0DATA → JSON text
fromJSON(jsonText, 'data') // JSON → C0DATA

const diff = buildDiff(d => d.file('greeting.txt').replace('Hello ', 'world', 'universe', '!'))
applyDiff(diff, { 'greeting.txt': 'Hello world!' })   // Map { 'greeting.txt' => 'Hello universe!' }
```

## Development

```sh
npm test       # compiles, then runs unit tests and the conformance vectors
npm run docs   # TypeDoc → docs/
```

## License

MIT
