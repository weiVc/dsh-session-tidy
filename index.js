/**
 * dsh-session-tidy — Host half.
 *
 * Two capabilities over the official JSONL session store:
 *   POST /plugins/dsh-session-tidy/delete-session  — permanently remove a session
 *   POST /plugins/dsh-session-tidy/delete-turn     — permanently remove one turn
 *
 * The Client half (./client.js) only renders the entries and the confirmation
 * dialog; every destructive decision is validated here again.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  TidyLogError,
  decodeSessionLog,
  encodeSessionLog,
  planTurnDeletion,
  scanZstdFrames,
} from './host/log.js'
import {
  TidyError,
  backupSessionLog,
  collectWorkspaceOwners,
  detachColdSession,
  detachWorkspaceAccounting,
  dropProjectionCache,
  installAgentTracker,
  removeSessionDirectory,
  resolveLogLocation,
  sessionsRoot,
  stopLiveAgent,
  writeFileAtomic,
} from './host/delete-session.js'

export const name = 'session-tidy'
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'agents']

const ROUTE_PREFIX = '/plugins/dsh-session-tidy'
const MAX_BODY_BYTES = 32 * 1024
const SESSION_ID_LIMIT = 512

/** Read one optional service without asserting a late dependency. */
function service(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function failure(response, error) {
  const tidy = error instanceof TidyError ? error : undefined
  sendJson(response, tidy?.status ?? 500, {
    ok: false,
    error: {
      code: tidy?.code ?? 'internal',
      message: tidy?.message ?? `未预期的错误：${error?.message ?? String(error)}`,
      ...(tidy?.stopped === true ? { stopped: true } : {}),
    },
  })
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new TidyError('invalid-request', '请求体过大。', 400))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text.length === 0 ? {} : JSON.parse(text)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new TidyError('invalid-request', '请求体必须是 JSON 对象。', 400)
        }
        resolve(value)
      } catch (error) {
        reject(error instanceof TidyError ? error : new TidyError('invalid-request', '请求体不是有效 JSON。', 400))
      }
    })
    request.on('error', (error) => reject(new TidyError('invalid-request', `读取请求失败：${error.message}`, 400)))
  })
}

/**
 * A destructive route needs the custom header (which a cross-site form cannot
 * add), a same-origin / loopback caller, and the Host's own connection fence
 * when it is available (the desktop app forwards requests without an Origin).
 */
function requestRejection(ctx, request, headerValue) {
  if (request.method !== 'POST') return new TidyError('invalid-request', '只允许使用 POST。', 405)
  if (request.headers['x-dsh-session-tidy'] !== headerValue) {
    return new TidyError('forbidden', '请求缺少本插件的确认头。', 403)
  }
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    return new TidyError('invalid-request', '请求必须使用 JSON。', 415)
  }
  const connection = service(ctx, 'connection')
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    try {
      if (connection.requestRejection(request) === undefined) return undefined
    } catch {
      /* fall through to the origin check */
    }
    return new TidyError('forbidden', '请求未通过宿主的同源校验。', 403)
  }
  const host = request.headers.host
  if (typeof host !== 'string' || host.length === 0) return new TidyError('forbidden', '请求缺少 Host。', 403)
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    if (origin === `http://${host}` || origin === `https://${host}`) return undefined
    return new TidyError('forbidden', '请求来源不是本页面。', 403)
  }
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return undefined
  return new TidyError('forbidden', '请求未通过同源校验。', 403)
}

function requireSessionId(value) {
  if (typeof value !== 'string') throw new TidyError('invalid-request', '缺少 sessionId。', 400)
  const sessionId = value.trim()
  if (sessionId.length === 0 || sessionId.length > SESSION_ID_LIMIT || sessionId.includes('\0') || /[\\/]/.test(sessionId)) {
    throw new TidyError('invalid-request', 'sessionId 无效。', 400)
  }
  return sessionId
}

function requireTurn(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TidyError('invalid-request', 'turn 必须是正整数。', 400)
  return value
}

function mapLogError(error) {
  if (error instanceof TidyError) return error
  if (error instanceof TidyLogError) {
    const status = error.code === 'turn-not-found' ? 404 : error.code === 'turn-open' ? 409 : 409
    return new TidyError(error.code, error.message, status)
  }
  return new TidyError('unsupported-session', `会话日志无法解析，未删除任何内容：${error?.message ?? String(error)}`, 409)
}

/** Validate the rewritten event log through the official Session replay. */
function verifyReplay(ctx, sessionId, events, header) {
  // A synthetic id keeps validation possible while a viewer still holds this
  // session id in the in-memory store; the events, not the id, are validated.
  const verifyId = `${sessionId}#verify-${Date.now().toString(36)}`
  const meta = {
    version: 4,
    id: verifyId,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    isSeeded: false,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
  ctx.sessions.prepare(verifyId, {
    seed: events,
    meta,
    eventState: 'detached',
    inheritedEventCount: 0,
  })
}

async function deleteSession(ctx, tracker, sessionId) {
  const persistence = ctx.sessionPersistence
  const statSafe = async () => {
    try {
      return await persistence.stat(sessionId)
    } catch {
      return undefined
    }
  }
  const snapshot = await statSafe()
  if (snapshot === undefined) {
    throw new TidyError('session-not-found', '会话不存在或已经被删除。', 404)
  }
  // Forked/child sessions carry `parentSession = this id`; deleting the parent
  // first would orphan them in the sidebar and the subagent tree. Check both
  // the persisted list and live in-memory sessions.
  const childIds = new Set()
  try {
    for (const item of await persistence.list()) {
      if (item.header?.parentSession === sessionId) childIds.add(item.header.id)
    }
  } catch (error) {
    throw new TidyError('storage-error', `无法读取会话列表，未删除任何内容：${error?.message ?? String(error)}`, 500)
  }
  for (const session of ctx.sessions.list()) {
    if (session?.header?.parentSession === sessionId && session.header.id !== undefined) {
      childIds.add(session.header.id)
    }
  }
  if (childIds.size > 0) {
    throw new TidyError(
      'has-children',
      `该会话还有 ${childIds.size} 个分叉或子代理会话，请先删除它们再删除本会话。`,
      409,
    )
  }

  // Validate backend, path and stored identity BEFORE any side effect. A blank
  // (not yet materialized) session is the only case allowed to skip the log.
  const root = sessionsRoot(persistence)
  try {
    await resolveLogLocation(ctx, sessionId)
  } catch (error) {
    if (!(error instanceof TidyError) || error.code !== 'session-not-found') throw error
  }

  let stopped = false
  let location
  try {
    stopped = await stopLiveAgent(ctx, tracker, sessionId)
    const coldDetached = await detachColdSession(ctx, sessionId)
    if (!coldDetached && ctx.sessions.get(sessionId) !== undefined) {
      throw new TidyError(
        'live-untracked',
        '该会话在宿主内存中仍被占用且无法安全摘载，未删除任何内容。请重启 DeepSeek Harness 后重试。',
        409,
      )
    }

    // Re-resolve from the state that will actually be deleted.
    try {
      location = await resolveLogLocation(ctx, sessionId)
    } catch (error) {
      if (!(error instanceof TidyError) || error.code !== 'session-not-found') throw error
      location = undefined
    }
    if (location === undefined) {
      if ((await statSafe()) !== undefined) {
        throw new TidyError(
          'storage-error',
          '该会话尚未落盘且无法安全摘载，未删除任何内容。请重启 DeepSeek Harness 后重试。',
          500,
        )
      }
      // A created-but-never-materialized Session that is already gone: only its
      // accounting rows can remain.
      if (root !== undefined) await dropProjectionCache(ctx, sessionId, root)
      await detachWorkspaceAccounting(collectWorkspaceOwners(ctx, sessionId), sessionId)
      return { sessionId, stopped, removedFiles: false }
    }

    // Capture the owning workspace rows before any file disappears, then detach
    // them only after the log removal succeeded.
    const owners = collectWorkspaceOwners(ctx, sessionId)
    await removeSessionDirectory(location.root, location)
    await fsp.rm(location.dir, { recursive: true, force: true }).catch(() => undefined)
    if (fs.existsSync(location.file)) {
      throw new TidyError('storage-error', '会话日志仍然存在，删除未完成。', 500)
    }
    if ((await statSafe()) !== undefined) {
      throw new TidyError('storage-error', '会话在删除后仍可从存储中读到，删除未完成。', 500)
    }
    await detachWorkspaceAccounting(owners, sessionId)
    await dropProjectionCache(ctx, sessionId, location.root)
  } catch (error) {
    const failure = error instanceof TidyError
      ? error
      : new TidyError('storage-error', `删除会话失败：${error?.message ?? String(error)}`, 500)
    failure.stopped = stopped
    throw failure
  }
  return { sessionId, stopped, removedFiles: true }
}

/**
 * Build the rewritten artifact for one turn from the bytes currently on disk.
 * Every failure here happens before the session is stopped, so a refusal never
 * disturbs a running conversation.
 */
async function buildTurnRewrite(ctx, sessionId, file, turn) {
  let original
  let decoded
  try {
    original = await fsp.readFile(file)
    decoded = decodeSessionLog(original)
    if (scanZstdFrames(original).tornStart !== undefined) {
      throw new TidyError('unsupported-session', '会话日志尾部存在未提交的残帧，未删除任何内容。请先重启 DSH 让会话完成恢复。', 409)
    }
  } catch (error) {
    throw mapLogError(error)
  }
  if (decoded.header?.isSeeded === true) {
    throw new TidyError('unsupported-session', '分叉会话暂不支持删除单轮，未删除任何内容。', 409)
  }

  let plan
  try {
    plan = planTurnDeletion(decoded.events, turn)
  } catch (error) {
    throw mapLogError(error)
  }
  if (plan.events.length !== decoded.events.length - plan.removedEvents) {
    throw new TidyError('rewrite-failed', '删除计划的事件数量不一致，未删除任何内容。', 500)
  }
  // Later turns keep their content but slide down one turn number, so the
  // conversation reads as if the removed turn had never existed.
  for (const event of plan.events) {
    const data = event?.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    if (Number.isSafeInteger(data.turn) && data.turn > turn) data.turn -= 1
  }

  try {
    verifyReplay(ctx, sessionId, plan.events, decoded.header)
  } catch (error) {
    throw new TidyError('verify-failed', `删除后重放校验失败，未删除任何内容：${error?.message ?? String(error)}`, 409)
  }

  let next
  try {
    next = encodeSessionLog(decoded.headerLine, plan.events)
  } catch (error) {
    throw mapLogError(error)
  }
  return { original, decoded, plan, next }
}

async function deleteTurn(ctx, tracker, sessionId, turn) {
  const snapshot = await ctx.sessionPersistence.stat(sessionId).catch(() => undefined)
  if (snapshot === undefined) throw new TidyError('session-not-found', '会话不存在或已经被删除。', 404)
  const location = await resolveLogLocation(ctx, sessionId)

  // Plan and replay-validate while the conversation is still untouched.
  let attempt = await buildTurnRewrite(ctx, sessionId, location.file, turn)

  const stopped = await stopLiveAgent(ctx, tracker, sessionId)
  const coldDetached = await detachColdSession(ctx, sessionId)
  if (!coldDetached && ctx.sessions.get(sessionId) !== undefined) {
    const failure = new TidyError(
      'live-untracked',
      '该会话在宿主内存中仍被占用且无法安全摘载，未删除任何内容。请重启 DeepSeek Harness 后重试。',
      409,
    )
    failure.stopped = stopped
    throw failure
  }
  let written = false
  try {
    // Stopping a live agent may append its closing events; replan from the
    // exact bytes that will be replaced.
    let current = await fsp.readFile(location.file)
    for (let round = 0; round < 2 && !current.equals(attempt.original); round += 1) {
      attempt = await buildTurnRewrite(ctx, sessionId, location.file, turn)
      current = await fsp.readFile(location.file)
    }
    if (!current.equals(attempt.original)) {
      throw new TidyError('rewrite-failed', '会话在停止过程中持续变化，未删除任何内容。', 409)
    }
    await backupSessionLog(location.root, sessionId, `turn-${turn}`, attempt.original)
    await writeFileAtomic(location.file, attempt.next)
    written = true
    const reread = decodeSessionLog(await fsp.readFile(location.file))
    if (
      reread.events.length !== attempt.plan.events.length ||
      reread.headerLine !== attempt.decoded.headerLine
    ) {
      throw new Error('rewritten log does not read back as planned')
    }
    verifyReplay(ctx, sessionId, reread.events, reread.header)
  } catch (error) {
    if (written) {
      try {
        await writeFileAtomic(location.file, attempt.original)
      } catch {
        /* the backup under the plugin work area remains restorable */
      }
    }
    const failure = error instanceof TidyError
      ? error
      : new TidyError('rewrite-failed', `改写会话日志失败，已回滚：${error?.message ?? String(error)}`, 500)
    failure.stopped = stopped
    throw failure
  }

  await dropProjectionCache(ctx, sessionId, location.root)
  return {
    sessionId,
    turn,
    stopped,
    removedEvents: attempt.plan.removedEvents,
    remainingEvents: attempt.plan.events.length,
  }
}

export function apply(ctx) {
  const tracker = installAgentTracker(ctx.agents)
  ctx.effect(() => () => tracker.release(), 'session-tidy: agent handle tracker')

  const busy = new Set()
  const withLock = async (sessionId, operation) => {
    if (busy.has(sessionId)) {
      throw new TidyError('busy', '该会话正在执行另一个删除操作，请稍后重试。', 409)
    }
    busy.add(sessionId)
    try {
      return await operation()
    } finally {
      busy.delete(sessionId)
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/ping`,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            sendJson(response, 405, { ok: false, error: { code: 'invalid-request', message: '只允许 GET。' } })
            return
          }
          sendJson(response, 200, { ok: true, plugin: name, version: '1.0.0' })
        },
      }),
    'session-tidy: ping route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/delete-session`,
        handler: async (request, response) => {
          try {
            const rejected = requestRejection(ctx, request, 'delete-session')
            if (rejected !== undefined) throw rejected
            const body = await readJsonBody(request)
            const sessionId = requireSessionId(body.sessionId)
            const value = await withLock(sessionId, () => deleteSession(ctx, tracker, sessionId))
            sendJson(response, 200, { ok: true, value })
          } catch (error) {
            failure(response, error)
          }
        },
      }),
    'session-tidy: delete session route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/delete-turn`,
        handler: async (request, response) => {
          try {
            const rejected = requestRejection(ctx, request, 'delete-turn')
            if (rejected !== undefined) throw rejected
            const body = await readJsonBody(request)
            const sessionId = requireSessionId(body.sessionId)
            const turn = requireTurn(body.turn)
            const value = await withLock(sessionId, () => deleteTurn(ctx, tracker, sessionId, turn))
            sendJson(response, 200, { ok: true, value })
          } catch (error) {
            failure(response, error)
          }
        },
      }),
    'session-tidy: delete turn route',
  )
}
