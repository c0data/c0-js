/**
 * Stream mode: ETB-committed append logs (DESIGN.md "Stream Mode").
 *
 *   const log = await openLog('events.c0')
 *   log.start()                               // SYN ␁shape␟stream ␗ on a new log
 *   log.record('create', 'a1b2', '1718208000')
 *   log.close()
 *   const r = await readLog('events.c0')
 *   r.torn                                    // false
 *   r.eachRecord(rec => { ... })
 */
import { STX, ETX, EOT, BEL, DLE, SYN, ETB, CAN, EM, SP } from './constants.js'
import { scanLayout, scanComment } from './core.js'
import { C0Error } from './error.js'
import { Body, Group, Record } from './body.js'
import { Document } from './document.js'
import { Builder, type BuilderValue, type Pairs } from './builder.js'
import { ByteWriter, EMPTY } from './bytes.js'

/**
 * Scans a buffer for commits. An unescaped ETB is always a commit, even
 * inside open text or a level; such a block is damaged and yields
 * nothing. The tail after the last commit is torn unless it holds only
 * layout, notes or EOT.
 */
export class StreamReader {
  readonly buf: Uint8Array
  /** [start, end) of each committed block (ETB excluded). */
  readonly blocks: [number, number][] = []
  /** Indexes of damaged blocks. */
  readonly damaged: number[] = []
  readonly torn: boolean
  private _committedEnd = 0

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.scan()
    this.torn = this.tornTail()
  }

  /** Offset just past the last ETB and its payload. */
  get committedEnd(): number {
    return this._committedEnd
  }

  get committed(): Uint8Array {
    return this.buf.subarray(0, this._committedEnd)
  }

  get tail(): Uint8Array {
    return this.buf.subarray(this._committedEnd)
  }

  get blockCount(): number {
    return this.blocks.length
  }

  block(i: number): Uint8Array {
    const [s, e] = this.blocks[i]
    return this.buf.subarray(s, e)
  }

  isDamaged(i: number): boolean {
    return this.damaged.includes(i)
  }

  eachBlock(cb: (block: Uint8Array, i: number) => void): void {
    for (let i = 0; i < this.blocks.length; i++) cb(this.block(i), i)
  }

  /** The committed region as a document (heading skipped), undamaged blocks only. */
  get document(): Document {
    return new Document(this.undamagedBytes())
  }

  get body(): Body {
    return this.document.body
  }

  /** Compatibility: the committed records as a group (the first one). */
  get table(): Group {
    const b = this.body
    return b.groups[0] ?? new Group(EMPTY, 0, 0, 0, undefined, [])
  }

  eachRecord(cb: (r: Record) => void): void {
    for (const g of this.body.groups) for (const r of g.records) cb(r)
  }

  get records(): Record[] {
    const out: Record[] = []
    this.eachRecord(r => out.push(r))
    return out
  }

  // Committed bytes with damaged blocks and payloads removed.
  private undamagedBytes(): Uint8Array {
    const io = new ByteWriter()
    this.blocks.forEach(([s, e], i) => {
      if (!this.damaged.includes(i)) io.write(this.buf.subarray(s, e))
    })
    return io.toUint8Array()
  }

  private scan(): void {
    const buf = this.buf
    const len = buf.length
    let pos = 0
    let blockStart = 0
    let inText = false
    let depth = 0
    while (pos < len) {
      const b = buf[pos]
      if (inText) {
        if (b === DLE) {
          pos += 2
          continue
        } else if (b === ETX) {
          inText = false
        } else if (b === ETB) {
          this.commit(blockStart, pos, true)
          pos = this.payloadEnd(pos + 1)
          blockStart = pos
          inText = false
          depth = 0
          continue
        } else if (b === SYN || b === EOT || b === EM) {
          // framing cuts the text; the block is torn/damaged at the next commit
          inText = false
          depth = 0
          if (b === SYN) blockStart = pos
        }
        pos++
      } else {
        if (b === STX) {
          inText = true
        } else if (b === DLE) {
          depth++
        } else if (b === CAN) {
          if (depth > 0) depth--
        } else if (b === ETB) {
          this.commit(blockStart, pos, depth > 0)
          pos = this.payloadEnd(pos + 1)
          blockStart = pos
          depth = 0
          continue
        } else if (b === SYN && pos > 0) {
          // tears the uncommitted bytes before it; a new document begins
          blockStart = pos
          depth = 0
        }
        pos++
      }
    }
  }

  private commit(start: number, stop: number, damaged: boolean): void {
    this.blocks.push([start, stop])
    if (damaged) this.damaged.push(this.blocks.length - 1)
  }

  // After an ETB: skip its payload and return committedEnd (which excludes
  // layout after the payload).
  private payloadEnd(pos: number): number {
    const buf = this.buf
    const len = buf.length
    let p = scanLayout(buf, pos, len)
    if (p < len && buf[p] >= 0x20) {
      while (p < len && buf[p] >= 0x20) p++
      // trailing spaces of the payload are layout
      while (p > pos && buf[p - 1] === SP) p--
    } else {
      p = pos // no payload: layout after ETB belongs to the next block
    }
    this._committedEnd = p
    return p
  }

  // Is the tail more than layout, notes and EOT?
  private tornTail(): boolean {
    const buf = this.buf
    const len = buf.length
    let pos = this._committedEnd
    for (;;) {
      pos = scanLayout(buf, pos, len)
      if (pos >= len) return false
      const b = buf[pos]
      if (b === EOT) {
        pos++
      } else if (b === BEL) {
        const p2 = scanLayout(buf, pos + 1, len)
        if (p2 < len && buf[p2] < 0x20 && buf[p2] !== STX) return true // a dead element is data
        try {
          pos = scanComment(buf, pos, len)
        } catch (e) {
          if (e instanceof C0Error) return true
          throw e
        }
      } else {
        return true
      }
    }
  }
}

/** Where a StreamWriter appends its blocks. */
export interface StreamSink {
  write(bytes: Uint8Array): void
  sync?(): void
  close?(): void
}

/**
 * Appends committed blocks to a sink. Each `record`, `header`, `group`,
 * `map` or `batch` is one block, written with its ETB in a single append.
 */
export class StreamWriter {
  private readonly sink: StreamSink

  constructor(sink: StreamSink) {
    this.sink = sink
  }

  /** A new log: SYN and heading, committed. */
  start(pairs: Pairs = { shape: 'stream' }): void {
    this.commit(b => { b.syn(pairs) })
  }

  record(...fields: BuilderValue[]): void {
    this.commit(b => { b.record(...fields) })
  }

  recordArray(fields: BuilderValue[]): void {
    this.record(...fields)
  }

  map(pairs: Pairs): void {
    this.commit(b => { b.map(pairs) })
  }

  header(...names: string[]): void {
    this.commit(b => { b.header(names) })
  }

  group(name: string, headers?: string[] | null): void {
    this.commit(b => { b.group(name, headers) })
  }

  /** Several writes under one ETB: atomic as a batch. */
  batch(fn: (b: Builder) => void): void {
    this.commit(fn)
  }

  flush(): void {
    this.sink.sync?.()
  }

  close(): void {
    this.flush()
    this.sink.close?.()
  }

  private commit(fn: (b: Builder) => void): void {
    const b = new Builder()
    fn(b)
    b.etb()
    this.sink.write(b.toUint8Array())
    this.flush()
  }
}

/** A StreamWriter over a log file. Close when done. */
export type FileLog = StreamWriter

/** Truncate an uncommitted tail so the file ends at a commit (Node only). */
export async function repairLog(path: string): Promise<void> {
  const fs = await import('node:fs')
  const reader = new StreamReader(fs.readFileSync(path))
  if (reader.torn) fs.truncateSync(path, reader.committedEnd)
}

/**
 * Open an append-only log file (Node only), repairing any torn tail
 * first. With `sync: true` (the default) every commit is fsync'd.
 */
export async function openLog(path: string, opts?: { sync?: boolean }): Promise<FileLog> {
  const fs = await import('node:fs')
  if (fs.existsSync(path)) await repairLog(path)
  const fd = fs.openSync(path, 'a')
  const wantSync = opts?.sync ?? true
  return new StreamWriter({
    write: bytes => { fs.writeSync(fd, bytes) },
    sync: wantSync ? () => { fs.fsyncSync(fd) } : undefined,
    close: () => { fs.closeSync(fd) },
  })
}

/** Read a log file (Node only) into a StreamReader. */
export async function readLog(path: string): Promise<StreamReader> {
  const fs = await import('node:fs')
  return new StreamReader(fs.readFileSync(path))
}

/**
 * Position just past the last commit, found by scanning backward (a
 * shortcut for well-formed input; the forward scan is authoritative).
 */
export function lastCommitEnd(buf: Uint8Array): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] !== ETB) continue
    // count the DLE run before it: odd means escaped
    let dles = 0
    for (let j = i - 1; j >= 0 && buf[j] === DLE; j--) dles++
    if (dles % 2 === 0) {
      let p = i + 1
      while (p < buf.length && buf[p] >= 0x20) p++
      return p
    }
  }
  return 0
}
