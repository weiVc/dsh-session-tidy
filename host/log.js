/**
 * Pure primitives over a DSH v4 JSONL session log (zstd frame container).
 *
 * A session artifact is a concatenation of independently decodable, checksummed
 * Zstandard frames:
 *  - the first frame holds exactly one `header` JSON line,
 *  - every following frame holds one or more event JSON lines (one event per line).
 *
 * Nothing here touches the filesystem or any `@deepseek-ai/*` package: on-disk
 * bytes in, on-disk bytes out, plus the plan for deleting one closed turn.
 *
 * Inputs are never mutated; every returned object graph is newly allocated.
 *
 * @module dsh-session-tidy/log
 */
import { Buffer } from 'node:buffer'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Little-endian magic number of one Zstandard frame (`0xFD2FB528`). */
export const ZSTD_MAGIC = 4247762216

const ZSTD_DESCRIPTOR_RESERVED_BITS = 0b11000
const CHECKSUM_FLAG = constants.ZSTD_c_checksumFlag
const CHECKSUM_OPTIONS =
  typeof CHECKSUM_FLAG === 'number' ? { params: { [CHECKSUM_FLAG]: 1 } } : {}
const CONSERVATIVE_EVENT_TYPES = new Set([
  'image/offload',
  'feedback/message-delete',
  'feedback/message-put',
])
const COMPACTION_PREFIX = 'compaction/'
/**
 * Payload fields that carry event-sequence references in the shipped
 * vocabulary. `throughSeq` and `messageSeqs` come from the DeepSeek session-log
 * delivery watermark and the title projection; the rest are surface metadata.
 */
const SEQ_REFERENCE_FIELDS = new Set([
  'throughSeq',
  'messageSeqs',
  'headerSeq',
  'sourceEventSeqs',
  'surfaceOp',
])
/** Subtrees whose numbers are business data, never log positions. */
const OPAQUE_SUBTREES = new Set(['meta', 'arguments', 'header'])

/**
 * One actionable failure with a stable code the Host can map onto an HTTP response.
 */
export class TidyLogError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable Chinese reason
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'TidyLogError'
    this.code = code
  }
}

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * Invalid complete structure throws; a truncated final frame is not corruption
 * (an interrupted append leaves it behind) and is reported as `tornStart` so
 * the caller can decide whether to recover or refuse.
 *
 * @param {Buffer | Uint8Array} buffer complete bytes currently present on disk
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
  const bytes = asBuffer(buffer, 'scanZstdFrames')
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const start = offset
    if (bytes.length - offset < 4) return { frames, tornStart: start }
    if (bytes.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new TidyLogError(
        'unsupported-session',
        `会话日志在字节 ${offset} 处不是合法的 zstd 帧（magic 不匹配）。`,
      )
    }
    offset += 4
    if (offset === bytes.length) return { frames, tornStart: start }
    const descriptor = bytes.readUInt8(offset)
    offset += 1
    if ((descriptor & ZSTD_DESCRIPTOR_RESERVED_BITS) !== 0) {
      throw new TidyLogError(
        'unsupported-session',
        `会话日志在字节 ${offset - 1} 处使用了保留的 zstd 帧头标志位。`,
      )
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (bytes.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (bytes.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = bytes.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new TidyLogError(
          'unsupported-session',
          `会话日志在字节 ${offset - 3} 处使用了保留的 zstd 块类型。`,
        )
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (bytes.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (bytes.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode a session log into its header line, parsed header and event rows.
 *
 * A torn final frame is ignored (its events were never committed); complete
 * frames must decompress and every complete line must be a JSON object.
 *
 * @param {Buffer | Uint8Array} buffer complete log bytes as read from disk
 * @returns {{headerLine: string, header: Record<string, any>, events: Array<Record<string, any>>}}
 */
export function decodeSessionLog(buffer) {
  const bytes = asBuffer(buffer, 'decodeSessionLog')
  const { frames } = scanZstdFrames(bytes)
  if (frames.length === 0) {
    throw new TidyLogError(
      'unsupported-session',
      '会话日志为空、缺少 header 帧，或第一个 zstd 帧不完整。',
    )
  }
  const chunks = []
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    try {
      chunks.push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)))
    } catch (error) {
      throw new TidyLogError(
        'unsupported-session',
        `会话日志的第 ${index + 1} 个 zstd 帧无法解压（校验失败或内容已损坏）。`,
        { cause: error },
      )
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) {
    throw new TidyLogError('unsupported-session', '会话日志为空或缺少 header 行。')
  }
  const headerLine = lines[0]
  let header
  try {
    header = JSON.parse(headerLine)
  } catch (error) {
    throw new TidyLogError('unsupported-session', '会话日志的 header 行不是合法 JSON。', {
      cause: error,
    })
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new TidyLogError('unsupported-session', '会话日志的 header 行不是 JSON 对象。')
  }
  if (header.type !== 'session') {
    throw new TidyLogError('unsupported-session', '会话日志的 header 行缺少 type="session" 标记。')
  }
  if (header.version !== 4) {
    throw new TidyLogError(
      'unsupported-session',
      `不支持的会话格式版本：${String(header.version)}（本插件只处理 v4 会话日志）。`,
    )
  }
  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new TidyLogError(
        'unsupported-session',
        `会话日志第 ${index + 1} 行不是合法 JSON（文件可能已损坏）。`,
        { cause: error },
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TidyLogError(
        'unsupported-session',
        `会话日志第 ${index + 1} 行不是 JSON 对象（文件可能已损坏）。`,
      )
    }
    events.push(parsed)
  }
  return { headerLine, header, events }
}

/**
 * Read and validate just the header frame of a session log. Used for identity
 * checks before a delete, without decoding every event.
 *
 * @param {Buffer | Uint8Array} buffer complete log bytes (or at least its first frame)
 * @returns {{headerLine: string, header: Record<string, any>}}
 */
export function readSessionHeader(buffer) {
  const bytes = asBuffer(buffer, 'readSessionHeader')
  const { frames } = scanZstdFrames(bytes, 1)
  const frame = frames[0]
  if (frame === undefined) {
    throw new TidyLogError('unsupported-session', '会话日志缺少可用的 header 帧。')
  }
  let text
  try {
    text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
  } catch (error) {
    throw new TidyLogError('unsupported-session', '会话日志的 header 帧无法解压。', { cause: error })
  }
  const newline = text.indexOf('\n')
  const headerLine = newline === -1 ? text : text.slice(0, newline)
  let header
  try {
    header = JSON.parse(headerLine)
  } catch (error) {
    throw new TidyLogError('unsupported-session', '会话日志的 header 行不是合法 JSON。', {
      cause: error,
    })
  }
  if (
    typeof header !== 'object'
    || header === null
    || Array.isArray(header)
    || header.type !== 'session'
    || header.version !== 4
    || typeof header.id !== 'string'
  ) {
    throw new TidyLogError('unsupported-session', '会话日志的 header 行不是有效的 v4 会话头。')
  }
  return { headerLine, header }
}

/**
 * Encode a header line and its events into a fresh concatenated-frame artifact.
 *
 * The header frame always exists; the event frame exists only when there is at
 * least one event. Frames carry a checksum, matching the persistence backend.
 *
 * @param {string} headerLine exact header JSON (a trailing newline is tolerated)
 * @param {Array<Record<string, any>>} events physical event rows in log order
 * @returns {Buffer}
 */
export function encodeSessionLog(headerLine, events) {
  const line = normalizeHeaderLine(headerLine)
  if (!Array.isArray(events)) {
    throw new TidyLogError('invalid-request', 'events 必须是事件数组。')
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new TidyLogError('invalid-request', `第 ${index} 个事件不是 JSON 对象。`)
    }
  }
  const headerFrame = compressFrame(`${line}\n`)
  if (events.length === 0) return headerFrame
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  return Buffer.concat([headerFrame, compressFrame(body)])
}

/**
 * Plan the deletion of one closed turn from an event list.
 *
 * The closed interval `[startSeq, endSeq]` (a `turn/start` row through its
 * matching `turn/end` row) is dropped; every surviving sequence number and every
 * sequence reference above `endSeq` is shifted down by the number of removed
 * events. Anything that cannot be remapped safely refuses the whole plan with
 * `blocked-by-later-records` instead of producing a damaged session.
 *
 * @param {Array<Record<string, any> | {seq: number, type?: string, data?: any, surfaceOp?: any, sourceEventSeqs?: number[]}>} events
 * @param {number} turn turn number as recorded in `data.turn`
 * @returns {{startSeq: number, endSeq: number, removedEvents: number, events: Array<Record<string, any>>, shifted: number}}
 */
export function planTurnDeletion(events, turn) {
  if (!Array.isArray(events)) {
    throw new TidyLogError('invalid-request', 'events 必须是事件数组。')
  }
  if (!Number.isSafeInteger(turn) || turn < 0) {
    throw new TidyLogError('invalid-request', `turn 必须是非负整数（收到 ${String(turn)}）。`)
  }
  let cloned
  try {
    cloned = structuredClone(events)
  } catch (error) {
    throw new TidyLogError('invalid-request', 'events 含有无法克隆的值（事件必须是纯 JSON 数据）。', {
      cause: error,
    })
  }
  assertRowSeqs(cloned)

  const starts = []
  for (let index = 0; index < cloned.length; index += 1) {
    const row = cloned[index]
    if (row.type === 'turn/start' && dataTurn(row) === turn) starts.push(index)
  }
  if (starts.length === 0) {
    throw new TidyLogError('turn-not-found', `第 ${turn} 轮不在该会话日志中。`)
  }
  if (starts.length > 1) {
    throw new TidyLogError(
      'unsupported-session',
      `第 ${turn} 轮有多个 turn/start 记录，无法安全判断删除范围。`,
    )
  }
  const startIndex = starts[0]
  const startSeq = cloned[startIndex].seq
  let endIndex = -1
  for (let index = startIndex + 1; index < cloned.length; index += 1) {
    const row = cloned[index]
    if (row.type === 'turn/end' && dataTurn(row) === turn) {
      endIndex = index
      break
    }
  }
  if (endIndex === -1) {
    throw new TidyLogError('turn-open', `第 ${turn} 轮尚未结束（缺少 turn/end 记录），无法删除。`)
  }
  const endSeq = cloned[endIndex].seq
  for (let index = startIndex; index <= endIndex; index += 1) {
    const row = cloned[index]
    if (row.seq !== startSeq + (index - startIndex)) {
      throw new TidyLogError(
        'unsupported-session',
        `第 ${turn} 轮的事件区间 seq 不连续，无法安全重映射。`,
      )
    }
    if (index !== startIndex && row.type === 'turn/start') {
      throw new TidyLogError(
        'unsupported-session',
        `第 ${turn} 轮的删除区间内还有另一轮 turn/start 记录，无法安全删除。`,
      )
    }
  }

  // The closed turn range, plus every queued prompt/steering message the turn
  // actually consumed. Their add events land just before `turn/start` while the
  // matching removals land inside the turn, so deleting only the turn would
  // leave those prompts forever "queued".
  const removed = new Set()
  for (let seq = startSeq; seq <= endSeq; seq += 1) removed.add(seq)
  const consumedOrigins = new Map()
  for (const entry of inboxConsumedByTurn(cloned, startIndex, endIndex)) {
    const bucket = consumedOrigins.get(entry.originSeq)
    if (bucket === undefined) consumedOrigins.set(entry.originSeq, { entry, consumed: 1 })
    else bucket.consumed += 1
  }
  for (const [originSeq, bucket] of consumedOrigins) {
    if (removed.has(originSeq)) continue
    if (!Number.isSafeInteger(originSeq)) {
      throw new TidyLogError('unsupported-session', '排队消息的来源事件缺少合法 seq，无法安全删除。')
    }
    if (bucket.entry.insertStart !== 0 || bucket.consumed !== bucket.entry.originInsertedCount) {
      throw blocked('该轮的排队消息不是整批被本轮消费的，无法安全移除')
    }
    removed.add(originSeq)
  }

  const removedSeqs = [...removed].sort((left, right) => left - right)
  const shiftOf = (ref) => {
    let low = 0
    let high = removedSeqs.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (removedSeqs[middle] <= ref) low = middle + 1
      else high = middle
    }
    return low
  }
  const clampSurvivingBelow = (value) => {
    let candidate = value
    while (candidate >= 0 && removed.has(candidate)) candidate -= 1
    return candidate
  }

  const survivors = cloned.filter((row) => !removed.has(row.seq))
  for (const row of survivors) {
    if (Array.isArray(row.sourceEventSeqs)) {
      for (const ref of row.sourceEventSeqs) {
        if (!Number.isSafeInteger(ref)) {
          throw new TidyLogError(
            'unsupported-session',
            `事件 #${String(row.seq)} 的 sourceEventSeqs 含非整数引用，无法安全重映射。`,
          )
        }
        if (removed.has(ref)) {
          throw blocked(`事件 #${row.seq} 引用了将被删除的事件 #${ref}`)
        }
      }
    }
    if (isPlainObject(row.surfaceOp)) {
      for (const key of ['startSeq', 'endSeq']) {
        const value = row.surfaceOp[key]
        if (value === undefined) continue
        if (!Number.isSafeInteger(value)) {
          throw new TidyLogError(
            'unsupported-session',
            `事件 #${String(row.seq)} 的 surfaceOp.${key} 不是整数，无法安全重映射。`,
          )
        }
        if (removed.has(value)) {
          throw blocked(`事件 #${row.seq} 的 surfaceOp.${key} 指向将被删除的事件 #${value}`)
        }
      }
    }
    const data = isPlainObject(row.data) ? row.data : undefined
    if (data?.headerSeq !== undefined) {
      if (!Number.isSafeInteger(data.headerSeq)) {
        throw new TidyLogError(
          'unsupported-session',
          `事件 #${String(row.seq)} 的 data.headerSeq 不是整数，无法安全重映射。`,
        )
      }
      if (removed.has(data.headerSeq)) {
        throw blocked(`事件 #${row.seq} 的 data.headerSeq 指向将被删除的事件 #${data.headerSeq}`)
      }
    }
    if (data?.throughSeq !== undefined && !Number.isSafeInteger(data.throughSeq)) {
      throw new TidyLogError(
        'unsupported-session',
        `事件 #${String(row.seq)} 的 data.throughSeq 不是整数，无法安全重映射。`,
      )
    }
    if (Array.isArray(data?.messageSeqs)) {
      for (const ref of data.messageSeqs) {
        if (!Number.isSafeInteger(ref)) {
          throw new TidyLogError(
            'unsupported-session',
            `事件 #${String(row.seq)} 的 data.messageSeqs 含非整数引用，无法安全重映射。`,
          )
        }
      }
    }
    for (const field of unknownSeqFields(row)) {
      throw new TidyLogError(
        'unsupported-session',
        `事件 #${row.seq} 携带本插件不认识的序列引用字段「${field}」，为避免损坏会话，本次未删除任何内容。`,
      )
    }
    if (typeof row.type === 'string' && row.seq > endSeq) {
      if (row.type.startsWith(COMPACTION_PREFIX) || CONSERVATIVE_EVENT_TYPES.has(row.type)) {
        throw blocked(`幸存事件 #${row.seq}（${row.type}）无法在删除轮次后被安全保留`)
      }
    }
  }

  const shiftedEvents = survivors.map((row) => {
    row.seq -= shiftOf(row.seq)
    if (Array.isArray(row.sourceEventSeqs)) {
      row.sourceEventSeqs = row.sourceEventSeqs.map((ref) => ref - shiftOf(ref))
    }
    if (isPlainObject(row.surfaceOp)) {
      for (const key of ['startSeq', 'endSeq']) {
        const value = row.surfaceOp[key]
        if (Number.isSafeInteger(value)) row.surfaceOp[key] = value - shiftOf(value)
      }
    }
    const data = isPlainObject(row.data) ? row.data : undefined
    if (data !== undefined) {
      if (Number.isSafeInteger(data.headerSeq)) data.headerSeq -= shiftOf(data.headerSeq)
      if (Number.isSafeInteger(data.throughSeq)) {
        if (removed.has(data.throughSeq)) {
          // A cumulative delivery watermark: everything before the removed range
          // is still delivered, so clamp it to the last surviving position.
          const candidate = clampSurvivingBelow(data.throughSeq)
          if (candidate < 0) throw blocked(`事件 #${row.seq} 的投递水位无法重映射`)
          data.throughSeq = candidate
        }
        data.throughSeq -= shiftOf(data.throughSeq)
        if (data.throughSeq < 0 || data.throughSeq >= row.seq) {
          throw blocked(`事件 #${row.seq} 的投递水位落在将被删除的区间内，无法安全重映射`)
        }
      }
      if (Array.isArray(data.messageSeqs)) {
        data.messageSeqs = data.messageSeqs
          .filter((ref) => !removed.has(ref))
          .map((ref) => ref - shiftOf(ref))
      }
    }
    return row
  })

  for (let index = 0; index < shiftedEvents.length; index += 1) {
    const row = shiftedEvents[index]
    if (row.seq !== index) {
      throw new TidyLogError('unsupported-session', '重映射后的事件 seq 不连续，已取消删除。')
    }
    for (const value of [
      ...(Array.isArray(row.sourceEventSeqs) ? row.sourceEventSeqs : []),
      ...(isPlainObject(row.surfaceOp)
        ? [row.surfaceOp.startSeq, row.surfaceOp.endSeq].filter(
            (candidate) => candidate !== undefined,
          )
        : []),
      isPlainObject(row.data) ? row.data.headerSeq : undefined,
      isPlainObject(row.data) ? row.data.throughSeq : undefined,
      ...(Array.isArray(row.data?.messageSeqs) ? row.data.messageSeqs : []),
    ]) {
      if (Number.isSafeInteger(value) && value < 0) {
        throw new TidyLogError(
          'unsupported-session',
          `事件 #${String(row.seq)} 的序列引用在重映射后变成负值，已取消删除。`,
        )
      }
    }
  }

  assertInboxHistory(shiftedEvents)
  return { startSeq, endSeq, removedEvents: removed.size, events: shiftedEvents, shifted: removed.size }
}

/** Replay one inbox-splice event into the pending queues (shared by the guards below). */
function applyInboxSplice(queues, event) {
  const splice = event.data
  if (!isPlainObject(splice)) throw new Error('inbox splice payload is not an object')
  const queue = queues[splice.target]
  if (queue === undefined) throw new Error(`unknown inbox target "${String(splice.target)}"`)
  const start = splice.start
  const removedCount = splice.removedCount ?? 0
  if (!Number.isSafeInteger(start) || start < 0 || start > queue.length) {
    throw new Error('inbox splice start is out of range')
  }
  if (!Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > queue.length) {
    throw new Error('inbox splice removedCount is out of range')
  }
  if (!Array.isArray(splice.inserted)) throw new Error('inbox splice inserted is not an array')
  const entries = splice.inserted.map((message) => ({
    message,
    originSeq: event.seq,
    insertStart: start,
    originInsertedCount: splice.inserted.length,
  }))
  queue.splice(start, removedCount, ...entries)
  const ids = new Set()
  for (const item of [...queues['next-turn'], ...queues['next-step']]) {
    const id = item?.message?.id
    if (id === undefined) continue
    if (ids.has(id)) throw new Error(`inbox message "${id}" is pending twice`)
    ids.add(id)
  }
}

/** Pending inbox entries one turn actually consumes (from either queue). */
function inboxConsumedByTurn(events, startIndex, endIndex) {
  const queues = { 'next-turn': [], 'next-step': [] }
  try {
    for (let index = 0; index < startIndex; index += 1) {
      if (events[index].type === 'agent/inbox/spliced') applyInboxSplice(queues, events[index])
    }
    const pending = {
      'next-turn': [...queues['next-turn']],
      'next-step': [...queues['next-step']],
    }
    for (let index = startIndex; index <= endIndex; index += 1) {
      if (events[index].type === 'agent/inbox/spliced') applyInboxSplice(queues, events[index])
    }
    const remaining = new Set()
    for (const item of [...queues['next-turn'], ...queues['next-step']]) {
      if (item?.message?.id !== undefined) remaining.add(item.message.id)
    }
    const consumed = []
    for (const target of ['next-turn', 'next-step']) {
      for (const entry of pending[target]) {
        const id = entry?.message?.id
        if (id === undefined) continue
        if (!remaining.has(id)) consumed.push(entry)
      }
    }
    return consumed
  } catch (error) {
    throw new TidyLogError('unsupported-session', '会话的排队消息记录无法重放，无法安全删除。', {
      cause: error,
    })
  }
}

/** Reject a surviving inbox history the projection could not replay. */
function assertInboxHistory(events) {
  const queues = { 'next-turn': [], 'next-step': [] }
  try {
    for (const event of events) {
      if (event.type === 'agent/inbox/spliced') applyInboxSplice(queues, event)
    }
  } catch (error) {
    throw new TidyLogError(
      'blocked-by-later-records',
      `删除后排队消息记录将无法重放（${error.message}），为避免损坏会话，本次未删除任何内容。`,
      { cause: error },
    )
  }
}


/** Reject a row list whose sequence numbers are not strictly increasing non-negative integers. */
function assertRowSeqs(rows) {
  let previous
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new TidyLogError('unsupported-session', `第 ${index} 个事件不是 JSON 对象。`)
    }
    if (!Number.isSafeInteger(row.seq) || row.seq < 0) {
      throw new TidyLogError('unsupported-session', `第 ${index} 个事件缺少合法的 seq。`)
    }
    if (previous !== undefined && row.seq <= previous) {
      throw new TidyLogError('unsupported-session', '会话日志的事件 seq 不是严格递增的，无法安全删除。')
    }
    previous = row.seq
  }
}

/** The turn number recorded on a row, if any. */
function dataTurn(row) {
  return isPlainObject(row.data) ? row.data.turn : undefined
}

/**
 * Find `*seq` fields in a payload this build cannot remap (an extension added
 * after this plugin). Detecting one turns a would-be corrupt session into a
 * refusal instead. Business subtrees (`meta`, `arguments`, request headers) are
 * never scanned; the shipped reference fields are handled explicitly.
 */
function unknownSeqFields(row) {
  if (!isPlainObject(row.data)) return []
  if (row.type === 'request/header') return []
  const found = []
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (OPAQUE_SUBTREES.has(key)) continue
      const here = path === '' ? key : `${path}.${key}`
      if (/seq/i.test(key)) {
        if (!SEQ_REFERENCE_FIELDS.has(key)) {
          found.push(here)
          continue
        }
      }
      walk(child, here)
    }
  }
  walk(row.data, '')
  return found
}

/** Whether a value is a non-array, non-null object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build the refusal used whenever a surviving row pins a deleted sequence. */
function blocked(detail) {
  return new TidyLogError(
    'blocked-by-later-records',
    `后续会话记录仍引用将被删除的内容（${detail}），为避免损坏会话，本次未删除任何内容。`,
  )
}

/** Normalize and validate a header line before compression. */
function normalizeHeaderLine(value) {
  if (typeof value !== 'string') {
    throw new TidyLogError('invalid-request', 'headerLine 必须是字符串。')
  }
  let line = value
  while (line.endsWith('\n') || line.endsWith('\r')) line = line.slice(0, -1)
  if (line.trim().length === 0) {
    throw new TidyLogError('invalid-request', 'headerLine 不能为空。')
  }
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new TidyLogError('invalid-request', 'headerLine 必须是合法的 JSON 对象。', {
      cause: error,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TidyLogError('invalid-request', 'headerLine 必须是 JSON 对象。')
  }
  return line
}

/** Compress one independently decodable, checksummed frame. */
function compressFrame(text) {
  try {
    return zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM_OPTIONS)
  } catch (error) {
    throw new TidyLogError('rewrite-failed', '压缩会话日志帧失败，未写入任何内容。', {
      cause: error,
    })
  }
}

/** Accept Buffer or any Uint8Array view of log bytes. */
function asBuffer(value, operation) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError(`${operation}() expects a Buffer or Uint8Array`)
}
