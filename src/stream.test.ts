import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RS, US, DLE, ETB, STX, SOH, SYN, EOT } from './constants.js'
import { StreamReader, StreamWriter, openLog, readLog, lastCommitEnd } from './stream.js'
import { Document } from './document.js'
import { format, parse } from './pretty.js'
import { utf8 } from './bytes.js'

const encoder = new TextEncoder()

function buf(...parts: (number | string)[]): Uint8Array {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'number') out.push(p)
    else out.push(...encoder.encode(p))
  }
  return new Uint8Array(out)
}

describe('Stream', () => {
  describe('document tolerance', () => {
    it('reads an ETB-committed log like an uncommitted one', () => {
      const bytes = buf(SYN, SOH, 'shape', US, 'stream', ETB, SOH, RS, 'op', US, 'arg', ETB,
        RS, 'create', US, 'a1b2', ETB, RS, 'name', US, 'draft', ETB)
      const doc = new Document(bytes)
      assert.equal(doc.shape, 'stream')
      const g = doc.group(0)
      assert.deepEqual(g.headers.map(utf8), ['op', 'arg'])
      assert.equal(g.recordCount, 2)
      assert.deepEqual(g.record(0).strings, ['create', 'a1b2'])
    })
  })

  describe('pretty form', () => {
    it('renders ␗ at the end of the record line and round-trips', () => {
      const bytes = buf(RS, 'create', US, 'a1b2', ETB, RS, 'name', US, 'draft', ETB, 'sha256:00')
      const pretty = format(bytes)
      assert.equal(pretty, '␞create␟a1b2␗\n␞name␟draft␗sha256:00\n')
      assert.deepEqual(parse(pretty), bytes)
    })
  })

  describe('StreamReader', () => {
    it('reads committed records and skips a torn tail', () => {
      const bytes = buf(RS, 'create', US, 'a1b2', ETB, RS, 'name', US, 'dra')
      const reader = new StreamReader(bytes)
      assert.equal(reader.torn, true)
      assert.equal(reader.blockCount, 1)
      assert.equal(utf8(reader.tail), '\x1ename\x1fdra')
      assert.equal(reader.records.length, 1)
      assert.equal(lastCommitEnd(bytes), reader.committedEnd)
    })

    it('commits a multi-record batch as one block', () => {
      const reader = new StreamReader(buf(RS, 'a', RS, 'b', ETB))
      assert.equal(reader.blockCount, 1)
      assert.equal(reader.table.recordCount, 2)
    })

    it('an ETB inside open text is a commit that damages the block', () => {
      const reader = new StreamReader(buf(RS, STX, 'open', ETB, RS, 'ok', ETB))
      assert.deepEqual(reader.damaged, [0])
      assert.equal(reader.isDamaged(0), true)
      assert.deepEqual(reader.records.map(r => r.strings), [['ok']])
    })

    it('a tail of layout, notes or EOT is not torn', () => {
      assert.equal(new StreamReader(buf(RS, 'a', ETB, '\n', EOT)).torn, false)
      assert.equal(new StreamReader(buf(RS, 'a', ETB, 0x07, 'note')).torn, false)
      assert.equal(new StreamReader(buf(RS, 'a', ETB, 0x07, RS, 'dead')).torn, true)
    })
  })

  describe('StreamWriter', () => {
    it('writes each call as one committed block', () => {
      const chunks: Uint8Array[] = []
      const w = new StreamWriter({ write: b => chunks.push(b) })
      w.start()
      w.header('op', 'arg')
      w.record('create', 'a1b2')
      w.map({ k: 'v' })
      w.batch(b => { b.record('x'); b.record('y') })
      assert.equal(chunks.length, 5)
      assert.deepEqual(chunks[0], buf(SYN, SOH, 'shape', US, 'stream', ETB))
      const all = new Uint8Array(chunks.flatMap(c => Array.from(c)))
      const r = new StreamReader(all)
      assert.equal(r.blockCount, 5)
      assert.equal(r.torn, false)
      assert.equal(r.records.length, 4)
    })
  })

  describe('openLog', () => {
    it('appends committed records and repairs a torn tail', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'c0stream-'))
      const path = join(dir, 'claims.c0')
      try {
        let log = await openLog(path)
        log.start()
        log.header('op', 'arg')
        log.record('create', 'a1b2')
        log.close()

        // Simulate a crash mid-append (the tear ends in a lone DLE)
        appendFileSync(path, Buffer.from([RS, 0x78, DLE]))
        assert.equal(new StreamReader(readFileSync(path)).torn, true)

        log = await openLog(path)
        log.record('tag', 'alpha')
        log.close()

        const reader = await readLog(path)
        assert.equal(reader.torn, false)
        assert.equal(reader.blockCount, 4)
        const t = reader.table
        assert.deepEqual(t.headers.map(utf8), ['op', 'arg'])
        assert.equal(t.recordCount, 2)
        assert.equal(t.record(1).string(0), 'tag')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
