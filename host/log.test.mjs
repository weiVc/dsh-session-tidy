/**
 * Tests for the pure session-log primitives in ./log.js.
 *
 * Run from this directory with:  node --test log.test.mjs
 * (or from the plugin root with: node --test host/log.test.mjs)
 *
 * The real fixture lives at ../../../.refs/test-data/sample.jsonl.zstd relative
 * to this file. It is read-only: no test writes to it or to any real session
 * directory.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'

import {
  TidyLogError,
  ZSTD_MAGIC,
  decodeSessionLog,
  encodeSessionLog,
  planTurnDeletion,
  readSessionHeader,
  scanZstdFrames,
} from './log.js'

// Optional development fixture: a real v4 session log copied out of a local
// sessions root. It never ships with the plugin (it is private user data), so
// the real-data cases skip when it is absent; all synthetic cases always run.
const SAMPLE_URL = new URL(process.env.DSH_TIDY_FIXTURE ?? '../../../.refs/test-data/sample.jsonl.zstd', import.meta.url)
const sampleBytes = existsSync(SAMPLE_URL) ? readFileSync(SAMPLE_URL) : undefined
const sampleSkip = sampleBytes === undefined ? 'private sample fixture is not present' : false

/** One synthetic physical event row. */
function row(seq, type, data = {}, extra = {}) {
  return { type, seq, time: 1000 + seq, data, ...extra }
}

/** A small three-turn log: leading record, then turns 1..3, no trailing records. */
function baseEvents() {
  return [
    row(0, 'session/title', {}, { surfaceOp: 'append' }),
    row(1, 'turn/start', { turn: 1 }),
    row(2, 'user/message', { turn: 1, text: 'hello' }),
    row(3, 'step/start', { turn: 1, step: 1 }),
    row(4, 'assistant/message', { turn: 1, text: 'hi' }),
    row(5, 'step/end', { turn: 1, step: 1 }),
    row(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    row(7, 'turn/start', { turn: 2 }),
    row(8, 'step/start', { turn: 2, step: 1 }),
    row(9, 'user/message', { turn: 2, text: 'again' }),
    row(10, 'tool/call', { turn: 2, step: 1 }),
    row(11, 'tool/result', { turn: 2, step: 1 }, { sourceEventSeqs: [10] }),
    row(12, 'assistant/message', { turn: 2, text: 'done' }),
    row(13, 'step/end', { turn: 2, step: 1 }),
    row(14, 'turn/end', { turn: 2 }),
    row(15, 'turn/start', { turn: 3 }),
    row(16, 'user/message', { turn: 3, text: 'last' }),
    row(17, 'turn/end', { turn: 3 }),
  ]
}

/** Find one synthetic row by seq. */
function at(events, seq) {
  const found = events.find((event) => event.seq === seq)
  assert.ok(found !== undefined, `synthetic event #${seq} must exist`)
  return found
}

/** Assert an operation fails with one stable TidyLogError code. */
function fails(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TidyLogError, `expected TidyLogError, got ${error?.name}`)
    assert.equal(error.code, code)
    return true
  })
}

function headerLineFor(overrides = {}) {
  return JSON.stringify({
    type: 'session',
    version: 4,
    id: 'session-00000000-0000-4000-8000-000000000000',
    createdAt: 1792572637778,
    isSeeded: false,
    delegationDepth: 0,
    ...overrides,
  })
}

test('scanZstdFrames locates every frame of the real sample log', { skip: sampleSkip }, () => {
  const result = scanZstdFrames(sampleBytes)
  assert.equal(result.tornStart, undefined)
  assert.ok(result.frames.length > 100)
  assert.equal(result.frames[0].start, 0)
  assert.equal(result.frames.at(-1).end, sampleBytes.length)
  for (let index = 1; index < result.frames.length; index += 1) {
    assert.equal(result.frames[index].start, result.frames[index - 1].end)
  }
  assert.equal(sampleBytes.readUInt32LE(0), ZSTD_MAGIC)
  assert.equal(ZSTD_MAGIC, 4247762216)
})

test('decodeSessionLog reads the header frame and every event line of the sample', { skip: sampleSkip }, () => {
  const { frames } = scanZstdFrames(sampleBytes)
  const decoded = decodeSessionLog(sampleBytes)
  assert.equal(typeof decoded.headerLine, 'string')
  assert.equal(decoded.headerLine.includes('\n'), false)
  assert.deepEqual(decoded.header, JSON.parse(decoded.headerLine))
  assert.equal(decoded.header.type, 'session')
  assert.equal(decoded.header.version, 4)
  assert.equal(typeof decoded.header.id, 'string')
  const headerPlaintext = zstdDecompressSync(
    sampleBytes.subarray(frames[0].start, frames[0].end),
  ).toString('utf8')
  assert.equal(headerPlaintext, `${decoded.headerLine}\n`)
  assert.ok(decoded.events.length > 500)
  assert.ok(decoded.events.every((event, index) => event.seq === index))
  const turns = decoded.events.filter((event) => event.type === 'turn/start')
  assert.equal(turns.length, 6)
  for (let turn = 1; turn <= 6; turn += 1) {
    assert.ok(
      decoded.events.some((event) => event.type === 'turn/end' && event.data.turn === turn),
      `sample must contain a closed turn ${turn}`,
    )
  }
})

test('encodeSessionLog round-trips the real sample without changing header or events', { skip: sampleSkip }, () => {
  const first = decodeSessionLog(sampleBytes)
  const encoded = encodeSessionLog(first.headerLine, first.events)
  const scanned = scanZstdFrames(encoded)
  assert.equal(scanned.tornStart, undefined)
  assert.equal(scanned.frames.length, 2)
  assert.notEqual(encoded.readUInt8(4) & 4, 0, 'encoded frames must carry a checksum')

  const headerPlaintext = zstdDecompressSync(
    encoded.subarray(scanned.frames[0].start, scanned.frames[0].end),
  ).toString('utf8')
  assert.equal(headerPlaintext, `${first.headerLine}\n`)

  const second = decodeSessionLog(encoded)
  assert.equal(second.headerLine, first.headerLine)
  assert.deepEqual(second.header, first.header)
  assert.deepEqual(second.events, first.events)
})

test('planTurnDeletion deletes a middle turn of the real sample and keeps seqs contiguous', { skip: sampleSkip }, () => {
  const decoded = decodeSessionLog(sampleBytes)
  const before = JSON.stringify(decoded.events)
  const startIndex = decoded.events.findIndex(
    (event) => event.type === 'turn/start' && event.data.turn === 3,
  )
  const endIndex = decoded.events.findIndex(
    (event) => event.type === 'turn/end' && event.data.turn === 3,
  )
  assert.ok(startIndex >= 0 && endIndex > startIndex)

  const plan = planTurnDeletion(decoded.events, 3)
  assert.equal(plan.startSeq, decoded.events[startIndex].seq)
  assert.equal(plan.endSeq, decoded.events[endIndex].seq)
  // The turn range plus the queued prompt that fed it, so no phantom queue
  // entry survives the deletion.
  const origin = decoded.events
    .slice(0, startIndex)
    .filter(
      (event) =>
        event.type === 'agent/inbox/spliced'
        && event.data.target === 'next-turn'
        && (event.data.inserted?.length ?? 0) > 0,
    )
    .at(-1)
  assert.ok(origin !== undefined)
  assert.equal(plan.removedEvents, endIndex - startIndex + 2)
  assert.equal(plan.shifted, plan.removedEvents)
  assert.equal(plan.events.length, decoded.events.length - plan.removedEvents)
  assert.ok(plan.events.every((event, index) => event.seq === index))
  assert.equal(plan.events.at(-1).type, 'session/end-seed')
  assert.equal(
    plan.events.some(
      (event) =>
        event.type === 'agent/inbox/spliced'
        && event.data.inserted?.[0]?.id === origin.data.inserted[0].id,
    ),
    false,
    'the queued prompt of the removed turn must not stay pending',
  )
  const deleted = new Set(plan.events.map((event) => event.seq))
  assert.equal(deleted.size, plan.events.length)
  assert.equal(JSON.stringify(decoded.events), before, 'input events must not be mutated')

  const shiftedRefs = plan.events.flatMap((event) =>
    Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [],
  )
  for (const ref of shiftedRefs) {
    assert.ok(Number.isSafeInteger(ref) && ref >= 0)
    assert.ok(ref < plan.events.length)
  }
})

test('planTurnDeletion deletes the last closed turn of the real sample', { skip: sampleSkip }, () => {
  const decoded = decodeSessionLog(sampleBytes)
  const plan = planTurnDeletion(decoded.events, 6)
  const startIndex = decoded.events.findIndex(
    (event) => event.type === 'turn/start' && event.data.turn === 6,
  )
  const startSeq = decoded.events[startIndex].seq
  assert.equal(plan.startSeq, startSeq)
  assert.ok(plan.endSeq > plan.startSeq)
  assert.equal(plan.events.length, decoded.events.length - plan.removedEvents)
  assert.ok(plan.events.every((event, index) => event.seq === index))
  // Records that live after the closed turn survive and shift down.
  assert.equal(plan.events.at(-1).type, 'session/end-seed')
  assert.ok(plan.events.length > plan.endSeq - plan.shifted)
})

test('planTurnDeletion removes a middle turn and remaps seq plus every reference', () => {
  const events = baseEvents()
  events.push(
    row(
      18,
      'session/title',
      { headerSeq: 10 },
      {
        sourceEventSeqs: [11],
        surfaceOp: { op: 'replace', startSeq: 12, endSeq: 13 },
      },
    ),
    // A replacement range that starts before the deleted block and ends after it.
    row(19, 'deliverables/presented', {}, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 12 } }),
  )
  const before = JSON.stringify(events)
  const plan = planTurnDeletion(events, 1)

  assert.equal(plan.startSeq, 1)
  assert.equal(plan.endSeq, 6)
  assert.equal(plan.removedEvents, 6)
  assert.equal(plan.shifted, 6)
  assert.equal(plan.events.length, 14)
  assert.ok(plan.events.every((event, index) => event.seq === index))

  const title = plan.events[0]
  assert.equal(title.seq, 0)
  assert.equal(title.surfaceOp, 'append', 'a string surfaceOp must not be rewritten')

  const toolResult = plan.events.find((event) => event.type === 'tool/result')
  assert.equal(toolResult.seq, 5)
  assert.deepEqual(toolResult.sourceEventSeqs, [4])

  assert.deepEqual(plan.events.find((event) => event.seq === 12), {
    type: 'session/title',
    seq: 12,
    time: 1018,
    data: { headerSeq: 4 },
    sourceEventSeqs: [5],
    surfaceOp: { op: 'replace', startSeq: 6, endSeq: 7 },
  })
  // Only the endpoint after the deleted block shifts; the range still covers
  // exactly the surviving surface events.
  assert.deepEqual(plan.events.at(-1).surfaceOp, {
    op: 'replace',
    startSeq: 0,
    endSeq: 6,
  })
  assert.equal(plan.events.some((event) => event.type === 'turn/start' && event.data.turn === 1), false)
  assert.equal(JSON.stringify(events), before, 'input events must not be mutated')
})

test('planTurnDeletion deleting the last turn only shifts records after it', () => {
  const events = baseEvents()
  const plan = planTurnDeletion(events, 3)
  assert.equal(plan.startSeq, 15)
  assert.equal(plan.endSeq, 17)
  assert.equal(plan.removedEvents, 3)
  assert.equal(plan.shifted, 3)
  assert.equal(plan.events.length, 15)
  assert.deepEqual(
    plan.events.map((event) => event.seq),
    Array.from({ length: 15 }, (unused, index) => index),
  )
  assert.equal(plan.events.at(-1).type, 'turn/end')
  assert.equal(plan.events.at(-1).data.turn, 2)
})

test('planTurnDeletion refuses an open turn with turn-open', () => {
  const events = baseEvents().filter((event) => event.seq !== 17)
  fails(() => planTurnDeletion(events, 3), 'turn-open')
  // An event list whose last turn has no turn/end row at all.
  fails(() => planTurnDeletion(baseEvents().slice(0, 16), 3), 'turn-open')
})

test('planTurnDeletion refuses an unknown turn with turn-not-found', () => {
  fails(() => planTurnDeletion(baseEvents(), 9), 'turn-not-found')
  fails(() => planTurnDeletion([], 1), 'turn-not-found')
  fails(() => planTurnDeletion(baseEvents(), 0.5), 'invalid-request')
  fails(() => planTurnDeletion(baseEvents(), -1), 'invalid-request')
  fails(() => planTurnDeletion('not an array', 1), 'invalid-request')
})

test('planTurnDeletion refuses a turn with several turn/start rows', () => {
  const events = baseEvents()
  events.push(row(18, 'turn/start', { turn: 1 }))
  fails(() => planTurnDeletion(events, 1), 'unsupported-session')
})

test('planTurnDeletion blocks when a survivor pins a deleted sequence', () => {
  const mutations = [
    // sourceEventSeqs points into the deleted range.
    (events) => {
      at(events, 12).sourceEventSeqs = [2]
    },
    // surfaceOp object points into the deleted range.
    (events) => {
      at(events, 15).surfaceOp = { op: 'replace', startSeq: 3, endSeq: 3 }
    },
    // data.headerSeq points into the deleted range.
    (events) => {
      at(events, 16).data.headerSeq = 4
    },
    // Conservatively refused record kinds.
    (events) => {
      at(events, 12).type = 'compaction/start'
    },
    (events) => {
      at(events, 13).type = 'image/offload'
    },
    (events) => {
      at(events, 13).type = 'feedback/message-delete'
    },
    (events) => {
      at(events, 13).type = 'feedback/message-put'
    },
  ]
  for (const mutate of mutations) {
    const events = baseEvents()
    mutate(events)
    fails(() => planTurnDeletion(events, 1), 'blocked-by-later-records')
  }
})

test('planTurnDeletion remaps extension sequence references (throughSeq, messageSeqs)', () => {
  const events = baseEvents()
  events.push(
    row(
      18,
      'session-log-deepseek/delivery-accepted',
      { sessionId: 's', sessionFormatVersion: 4, throughSeq: 12 },
    ),
    row(
      19,
      'session-log-deepseek/delivery-accepted',
      { sessionId: 's', sessionFormatVersion: 4, throughSeq: 3 },
    ),
    row(20, 'session/title', { title: 't', messageSeqs: [0, 3, 12] }),
  )
  const plan = planTurnDeletion(events, 1)
  const high = plan.events.find((event) => event.seq === 12)
  assert.equal(high.data.throughSeq, 6, 'a watermark after the removed range shifts down')
  const clamped = plan.events.find((event) => event.seq === 13)
  assert.equal(clamped.data.throughSeq, 0, 'a watermark inside the removed range clamps to its edge')
  const title = plan.events.find((event) => event.seq === 14)
  assert.deepEqual(title.data.messageSeqs, [0, 6], 'message references drop the deleted row and shift')
})

test('planTurnDeletion refuses a partially consumed multi-message inbox insert', () => {
  const events = [
    row(0, 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'a', content: [] }, { id: 'b', content: [] }],
    }),
    row(1, 'turn/start', { turn: 1 }),
    row(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    row(3, 'user/message', { turn: 1, id: 'a', content: [] }),
    row(4, 'turn/end', { turn: 1 }),
  ]
  fails(() => planTurnDeletion(events, 1), 'blocked-by-later-records')
})

test('planTurnDeletion removes a fully consumed multi-message inbox insert', () => {
  const events = [
    row(0, 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'a', content: [] }, { id: 'b', content: [] }],
    }),
    row(1, 'turn/start', { turn: 1 }),
    row(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 2, inserted: [] }),
    row(3, 'user/message', { turn: 1, id: 'a', content: [] }),
    row(4, 'user/message', { turn: 1, id: 'b', content: [] }),
    row(5, 'turn/end', { turn: 1 }),
  ]
  const plan = planTurnDeletion(events, 1)
  assert.equal(plan.startSeq, 1)
  assert.equal(plan.endSeq, 5)
  assert.equal(plan.removedEvents, 6, 'the whole origin insert plus the closed turn')
  assert.deepEqual(plan.events, [])
})

test('planTurnDeletion refuses an unknown sequence-reference field', () => {
  const events = baseEvents()
  events.push(row(18, 'session/some-extension', { targetSeq: 3 }))
  fails(() => planTurnDeletion(events, 1), 'unsupported-session')
})

test('readSessionHeader decodes only the header frame of the real sample', { skip: sampleSkip }, () => {
  const { headerLine, header } = readSessionHeader(sampleBytes)
  assert.equal(header.type, 'session')
  assert.equal(header.version, 4)
  assert.equal(typeof header.id, 'string')
  assert.equal(header.id, decodeSessionLog(sampleBytes).header.id)
  assert.deepEqual(JSON.parse(headerLine), header)
})

test('readSessionHeader refuses bytes that are not a session log', () => {
  assert.throws(
    () => readSessionHeader(Buffer.from('definitely not zstd')),
    (error) => error instanceof TidyLogError && error.code === 'unsupported-session',
  )
})

test('encodeSessionLog writes only a header frame for an event-less log', () => {
  const headerLine = headerLineFor()
  const encoded = encodeSessionLog(headerLine, [])
  const scanned = scanZstdFrames(encoded)
  assert.equal(scanned.tornStart, undefined)
  assert.equal(scanned.frames.length, 1)
  assert.notEqual(encoded.readUInt8(4) & 4, 0, 'header frame must carry a checksum')
  const decoded = decodeSessionLog(encoded)
  assert.equal(decoded.headerLine, headerLine)
  assert.deepEqual(decoded.header, JSON.parse(headerLine))
  assert.deepEqual(decoded.events, [])
})

test('encodeSessionLog accepts a header line with a trailing newline', () => {
  const headerLine = headerLineFor()
  const decoded = decodeSessionLog(encodeSessionLog(`${headerLine}\n`, []))
  assert.equal(decoded.headerLine, headerLine)
})

test('scanZstdFrames reports a torn tail instead of throwing', () => {
  const headerLine = headerLineFor()
  const encoded = encodeSessionLog(headerLine, [
    row(0, 'turn/start', { turn: 1 }),
    row(1, 'user/message', { turn: 1 }),
    row(2, 'turn/end', { turn: 1 }),
  ])
  const { frames } = scanZstdFrames(encoded)
  assert.equal(frames.length, 2)

  const truncated = encoded.subarray(0, encoded.length - 3)
  const tail = scanZstdFrames(truncated)
  assert.equal(tail.frames.length, 1)
  assert.equal(tail.tornStart, frames[0].end)
  const decoded = decodeSessionLog(truncated)
  assert.equal(decoded.headerLine, headerLine)
  assert.deepEqual(decoded.events, [], 'events of a torn frame are never committed')

  // A header frame that is itself torn yields no complete frame.
  const tornHeader = scanZstdFrames(encoded.subarray(0, 10))
  assert.equal(tornHeader.frames.length, 0)
  assert.equal(tornHeader.tornStart, 0)
  fails(() => decodeSessionLog(encoded.subarray(0, 10)), 'unsupported-session')

  // Fewer than four trailing bytes are a torn frame start, not corruption.
  const trailing = Buffer.concat([encoded, Buffer.from([0x28, 0xb5])])
  const appended = scanZstdFrames(trailing)
  assert.equal(appended.frames.length, 2)
  assert.equal(appended.tornStart, encoded.length)

  assert.deepEqual(scanZstdFrames(Buffer.alloc(0)), { frames: [] })
})

test('scanZstdFrames and decodeSessionLog refuse corrupt or non-session bytes', () => {
  fails(() => scanZstdFrames(Buffer.from('not a zstd session log at all')), 'unsupported-session')
  fails(() => decodeSessionLog(Buffer.from('not a zstd session log at all')), 'unsupported-session')
  fails(() => decodeSessionLog(Buffer.alloc(0)), 'unsupported-session')
  fails(() => decodeSessionLog(encodeSessionLog(headerLineFor({ version: 5 }), [])), 'unsupported-session')
  fails(() => decodeSessionLog(encodeSessionLog(headerLineFor({ type: 'other' }), [])), 'unsupported-session')
  assert.throws(() => scanZstdFrames('not a buffer'), TypeError)
})

test('encodeSessionLog refuses malformed arguments with invalid-request', () => {
  const headerLine = headerLineFor()
  fails(() => encodeSessionLog(undefined, []), 'invalid-request')
  fails(() => encodeSessionLog('', []), 'invalid-request')
  fails(() => encodeSessionLog('{not json', []), 'invalid-request')
  fails(() => encodeSessionLog('[]', []), 'invalid-request')
  fails(() => encodeSessionLog(headerLine, 'not an array'), 'invalid-request')
  fails(() => encodeSessionLog(headerLine, [null]), 'invalid-request')
  fails(() => encodeSessionLog(headerLine, [[1, 2]]), 'invalid-request')
})
