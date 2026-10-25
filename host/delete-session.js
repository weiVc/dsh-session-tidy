/**
 * Host-side support for dsh-session-tidy.
 *
 * Everything here is process-local orchestration around the official services:
 *  - locate the JSONL session log of one session,
 *  - capture AgentHandles so a live session can be stopped and detached in the
 *    host's own supported order (cancel/drain → unregister → close handle),
 *  - remove a session directory through a quarantine rename outside the
 *    sessions root, so a partial delete can never leave a readable half-state,
 *  - drop the projection-cache row and the workspace accounting,
 *  - write a session log atomically (temp file + rename) with backups.
 *
 * No file here rewrites a log; the turn-deletion plan lives in ./log.js and the
 * HTTP flow that combines these primitives lives in ../index.js.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { readSessionHeader } from './log.js'

/** One actionable failure with a stable code and an HTTP status. */
export class TidyError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'TidyError'
    this.code = code
    this.status = status
  }
}

/** Session ids appear in two spellings across older stores. */
export function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else variants.add(`session-${sessionId}`)
  return [...variants]
}

/** The configured session-persistence root, or undefined for other backends. */
export function sessionsRoot(persistence) {
  const root = persistence?.root ?? persistence?.config?.root
  return typeof root === 'string' && root.length > 0 ? path.resolve(root) : undefined
}

/** Plugin-owned scratch area, a sibling of the sessions root (never scanned as sessions). */
export function workArea(root, name) {
  return path.join(path.dirname(root), name)
}

/** Whether `child` is strictly inside `parent`. */
export function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Poll one synchronous predicate until it holds or the budget expires. */
export async function waitUntil(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** Find the canonical log file name inside one session directory. */
async function canonicalLogInside(dir) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(entry.name)
    if (match === null) continue
    candidates.push({ name: entry.name, version: match[1] === undefined ? 0 : Number(match[1]) })
  }
  candidates.sort((left, right) => right.version - left.version)
  return candidates[0]?.name
}

/** Scan the sessions root for one session's canonical log when the backend has no locator. */
async function scanForLog(root, sessionId) {
  let projects
  try {
    projects = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(root, project.name, sessionId)
    const name = await canonicalLogInside(dir)
    if (name !== undefined) return path.join(dir, name)
  }
  return undefined
}

/**
 * Resolve and validate the on-disk log of one stored session.
 * @returns {Promise<{root: string, dir: string, file: string, name: string}>}
 */
export async function resolveLogLocation(ctx, sessionId) {
  const persistence = ctx.sessionPersistence
  const root = sessionsRoot(persistence)
  if (root === undefined) {
    throw new TidyError('unsupported-session', '当前配置的会话存储不是可删除的 JSONL 后端，未删除任何内容。', 409)
  }
  let candidate
  try {
    if (typeof persistence.resolveCurrentLog === 'function') {
      candidate = await persistence.resolveCurrentLog(sessionId)
    }
  } catch (error) {
    if (error?.name === 'SessionPersistenceNotFoundError') candidate = undefined
    else throw error
  }
  if (typeof candidate !== 'string' || candidate.length === 0) {
    candidate = await scanForLog(root, sessionId)
  }
  if (candidate === undefined) {
    throw new TidyError('session-not-found', '找不到该会话的日志文件（可能已经被删除）。', 404)
  }
  const file = path.resolve(candidate)
  if (!isInside(root, file)) {
    throw new TidyError('unsafe-path', '会话日志位置未通过安全校验，未删除任何内容。', 500)
  }
  const parts = path.relative(root, file).split(path.sep)
  if (parts.length !== 3 || parts[1] !== sessionId) {
    throw new TidyError('unsafe-path', '会话日志目录结构与预期不符，未删除任何内容。', 500)
  }
  if (!/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(parts[2])) {
    throw new TidyError('unsafe-path', '会话日志文件名与预期不符，未删除任何内容。', 500)
  }
  const stat = await fsp.stat(file).catch(() => undefined)
  if (stat === undefined || !stat.isFile()) {
    throw new TidyError('session-not-found', '找不到该会话的日志文件（可能已经被删除）。', 404)
  }

  // Canonical identity: no directory junction/symlink inside the root may point
  // deletion at another session, and the log must identify this exact session.
  let canonicalRoot
  let canonicalDir
  let canonicalFile
  try {
    canonicalRoot = await fsp.realpath(root)
    canonicalDir = await fsp.realpath(path.dirname(file))
    canonicalFile = await fsp.realpath(file)
  } catch (error) {
    throw new TidyError('storage-error', `无法解析会话目录：${error.message}`, 500)
  }
  if (
    !isInside(canonicalRoot, canonicalDir)
    || path.dirname(canonicalFile) !== canonicalDir
    || path.basename(canonicalDir).toLowerCase() !== sessionId.toLowerCase()
  ) {
    throw new TidyError('unsafe-path', '会话目录不是本会话的真实目录（疑似链接），未删除任何内容。', 500)
  }
  let header
  try {
    header = readSessionHeader(await fsp.readFile(canonicalFile)).header
  } catch (error) {
    if (error instanceof TidyError) throw error
    throw new TidyError('unsupported-session', `无法验证会话身份：${error?.message ?? String(error)}`, 409)
  }
  if (header.id !== sessionId) {
    throw new TidyError('unsafe-path', '会话日志的身份与目标会话不一致，未删除任何内容。', 500)
  }
  return { root: canonicalRoot, dir: canonicalDir, file: canonicalFile, name: parts[2] }
}

/**
 * Drop a cold (Agent-less) session instance from the in-memory store so the
 * rewritten log is read fresh and its read handle is released before the file
 * is replaced. A live Agent is handled by {@link stopLiveAgent} before this.
 */
export async function detachColdSession(ctx, sessionId) {
  if (ctx.agents?.get?.(sessionId) !== undefined) return false
  const sessions = ctx.sessions
  const entry = sessions?.store?.get?.(sessionId)
  if (entry === undefined) return false
  if (typeof sessions.detachEntered !== 'function') return false
  try {
    sessions.detachEntered(entry)
  } catch {
    return false
  }
  await waitUntil(() => ctx.sessions.get(sessionId) === undefined, 5000)
  return ctx.sessions.get(sessionId) === undefined
}

/**
 * Capture the AgentHandle every Web Agent is created with, so a permanent
 * delete can tear exactly that agent down instead of guessing at internals.
 * The session controller drops the handle after creation; this tracker keeps
 * it without changing any other behavior.
 * @returns {{take(id: string, agent?: object): object | undefined, release(): void}}
 */
export function installAgentTracker(agents) {
  const originalKey = Symbol.for('cordis.original')
  const mark = Symbol.for('dsh-session-tidy.tracker')
  const service = agents?.[originalKey] ?? agents
  const handles = new Map()
  const maxTracked = 128
  const restorations = []
  if (service === undefined || service === null) {
    return { take: () => undefined, release() {} }
  }
  for (const method of ['create', 'resume']) {
    const original = service[method]
    if (typeof original !== 'function' || original[mark] === true) continue
    const wrapped = async function (...args) {
      const handle = await Reflect.apply(original, this, args)
      try {
        const id = handle?.agent?.id
        if (typeof id === 'string' && typeof handle.dispose === 'function') {
          handles.set(id, handle)
          // Bounded retention: an Agent disposed elsewhere never invalidates its
          // handle, so keep only the most recent window (older ones fall back to
          // the live-object teardown in stopLiveAgent).
          while (handles.size > maxTracked) {
            const oldest = handles.keys().next().value
            if (oldest === undefined) break
            handles.delete(oldest)
          }
        }
      } catch {
        /* tracking is best-effort; the original result is returned unchanged */
      }
      return handle
    }
    Object.defineProperty(wrapped, mark, { value: true })
    service[method] = wrapped
    restorations.push([method, original])
  }
  return {
    take(sessionId, agent) {
      const handle = handles.get(sessionId)
      if (handle === undefined) return undefined
      if (agent !== undefined && handle.agent !== agent) return undefined
      handles.delete(sessionId)
      return handle
    },
    release() {
      handles.clear()
      for (const [method, original] of restorations) {
        if (service[method]?.[mark] === true) service[method] = original
      }
      restorations.length = 0
    },
  }
}

/**
 * Stop and fully detach a live Agent before its files are touched.
 * Refuses (without side effects) when no lifecycle handle was captured.
 * @returns {Promise<boolean>} whether anything was running
 */
export async function stopLiveAgent(ctx, tracker, sessionId) {
  const agents = ctx.agents
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (agent === undefined) return false
  const handle = tracker.take(sessionId, agent)
  if (handle === undefined) {
    await settleUntrackedAgent(ctx, agent, sessionId)
    return true
  }
  let disposalError
  const disposal = Promise.resolve()
    .then(() => handle.dispose())
    .catch((error) => {
      disposalError = error
    })
  const timeout = new Promise((resolve) => setTimeout(resolve, 30000, 'timeout'))
  const outcome = await Promise.race([disposal.then(() => 'disposed'), timeout])
  if (disposalError !== undefined) {
    throw new TidyError('storage-error', `停止该会话时失败，未删除任何内容：${disposalError.message ?? disposalError}`, 500)
  }
  if (outcome === 'timeout') {
    throw new TidyError('live-untracked', '该会话仍在执行中，未能在 30 秒内安全停止，未删除任何内容。请停止该轮任务后重试。', 409)
  }
  const detached = await waitUntil(
    () => ctx.agents.get(sessionId) === undefined && ctx.sessions.get(sessionId) === undefined,
    8000,
  )
  if (!detached) {
    throw new TidyError('live-untracked', '宿主未能完整摘载该会话，未删除任何内容。', 409)
  }
  return true
}

/**
 * Last-resort teardown for an Agent the plugin did not create (installed after
 * the Agent existed). Mirrors the documented handle order with the live
 * objects: cancel → settle → unwind the Agent scope → detach the Session (which
 * emits `session/disposed`, closing the persistence write handle) → unregister
 * the Agent. Every step is verified before any file is touched, and an
 * unsupported internal shape refuses instead of guessing.
 */
async function settleUntrackedAgent(ctx, agent, sessionId) {
  const unsupported = () =>
    new TidyError(
      'live-untracked',
      '该会话由宿主直接持有、无法安全停止，未删除任何内容。请先重启 DeepSeek Harness 再试。',
      409,
    )
  try {
    agent.cancel?.({ kind: 'user' })
  } catch {
    /* an already-settling agent is fine */
  }
  try {
    await Promise.race([
      Promise.resolve(agent.whenIdle?.()),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ])
  } catch {
    /* proceed to the detachment verification below */
  }
  if (typeof agent.scope?.dispose === 'function') {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => agent.scope.dispose())
        .then(() => 'disposed')
        .catch(() => 'failed'),
      new Promise((resolve) => setTimeout(resolve, 15000, 'timeout')),
    ])
    if (outcome !== 'disposed') throw unsupported()
  } else {
    throw unsupported()
  }
  const sessionEntry = ctx.sessions?.store?.get?.(sessionId)
  if (sessionEntry !== undefined) {
    if (typeof ctx.sessions.detachEntered !== 'function') throw unsupported()
    try {
      ctx.sessions.detachEntered(sessionEntry)
    } catch {
      throw unsupported()
    }
  }
  const agentEntry = ctx.agents?.store?.get?.(sessionId)
  if (agentEntry !== undefined) {
    if (typeof ctx.agents.detachEntered !== 'function') throw unsupported()
    try {
      ctx.agents.detachEntered(agentEntry)
    } catch {
      /* the session detached first; the registry entry is best effort */
    }
  }
  const detached = await waitUntil(
    () => ctx.agents.get(sessionId) === undefined && ctx.sessions.get(sessionId) === undefined,
    10000,
  )
  if (!detached) throw unsupported()
}

/** Drop the projection-cache row so titles/stats/blank state are recomputed. */
export async function dropProjectionCache(ctx, sessionId, root) {
  const variants = sessionIdVariants(sessionId)
  const storage = ctx.get?.('storageDomain')
  const domain = storage?.get?.('session_projcache')
  const table = domain?.table?.('sessions')
  if (table !== undefined && typeof table.delete === 'function') {
    for (const variant of variants) {
      try {
        const current = typeof table.get === 'function' ? table.get(variant) : undefined
        if (current !== undefined || typeof table.get !== 'function') await table.delete(variant)
      } catch {
        /* the row may already be absent */
      }
    }
    return true
  }
  const dir = path.join(path.dirname(root), 'storages', 'session_projcache', 'sessions')
  for (const variant of variants) {
    await fsp.rm(path.join(dir, `${variant}.json`), { force: true }).catch(() => undefined)
  }
  return false
}

/**
 * Snapshot which workspace rows account for one session before its files move.
 * Captured first because the `sessionIds` getter stops matching an id once the
 * log is gone.
 * @returns {{registry: object | undefined, workspaces: object[]}}
 */
export function collectWorkspaceOwners(ctx, sessionId) {
  const registry = ctx.get?.('workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.list !== 'function') {
    return { registry: undefined, workspaces: [] }
  }
  const workspaces = []
  for (const workspace of registry.list()) {
    if (typeof workspace?.detachSession !== 'function') continue
    try {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) workspaces.push(workspace)
    } catch {
      /* a workspace whose projection is temporarily unavailable is skipped */
    }
  }
  return { registry, workspaces }
}

/** Detach one deleted session from the workspace rows captured before removal. */
export async function detachWorkspaceAccounting(owners, sessionId) {
  let changed = false
  for (const workspace of owners?.workspaces ?? []) {
    try {
      await workspace.detachSession(sessionId)
      changed = true
    } catch {
      /* best effort: the display filters an id whose log is gone anyway */
    }
  }
  const registry = owners?.registry
  if (registry !== undefined && registry !== null) {
    for (const variant of sessionIdVariants(sessionId)) {
      for (const method of ['unarchiveSession', 'unpinSession']) {
        const fn = registry[method]
        if (typeof fn !== 'function') continue
        try {
          await fn.call(registry, variant)
        } catch {
          /* idempotent cleanup: unknown ids are fine */
        }
      }
    }
  }
  return changed
}

/**
 * Move one session directory outside the sessions root and delete it there.
 * A failed step restores the original directory.
 */
export async function removeSessionDirectory(root, location) {
  let realDir
  let realFile
  try {
    realDir = await fsp.realpath(location.dir)
    realFile = await fsp.realpath(location.file)
  } catch (error) {
    throw new TidyError('storage-error', `无法读取会话目录：${error.message}`, 500)
  }
  if (
    realDir !== location.dir
    || path.dirname(realFile) !== realDir
    || path.basename(realDir).toLowerCase() !== path.basename(location.dir).toLowerCase()
    || !isInside(root, realDir)
    || !isInside(root, path.dirname(realDir))
  ) {
    throw new TidyError('unsafe-path', '会话目录在删除期间发生了身份变化，未删除任何内容。', 500)
  }
  const trashRoot = workArea(root, 'session-tidy-trash')
  const quarantine = path.join(
    trashRoot,
    `${path.basename(realDir)}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
  )
  await fsp.mkdir(trashRoot, { recursive: true })
  try {
    await fsp.rename(realDir, quarantine)
  } catch (error) {
    throw new TidyError(
      'storage-error',
      `无法将会话目录移出（${error.message}），未删除任何内容。`,
      500,
    )
  }
  if (fs.existsSync(realDir)) {
    // A racing writer re-created the path: put the quarantine back.
    try {
      await fsp.rename(quarantine, realDir)
    } catch {
      /* quarantine stays recoverable */
    }
    throw new TidyError('storage-error', '会话目录未能移出，未继续删除。', 500)
  }
  try {
    await fsp.rm(quarantine, { recursive: true, force: true })
  } catch (error) {
    // The directory is already out of the sessions root; report exactly that
    // instead of claiming nothing was deleted.
    throw new TidyError(
      'storage-partial',
      `会话已从会话列表中移出，但隔离目录清理未完成：${quarantine}（${error.message}）`,
      500,
    )
  }
  return true
}

/** Same-directory temp write + fsync + rename over the existing file. */
export async function writeFileAtomic(target, buffer) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`)
  let handle
  try {
    handle = await fsp.open(temp, 'wx')
    await handle.writeFile(buffer)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(temp, target)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Store a restorable copy of one session log outside the sessions root. */
export async function backupSessionLog(root, sessionId, tag, buffer) {
  const dir = workArea(root, 'session-tidy-backups')
  await fsp.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${sessionId}-${tag}-${stamp}.jsonl.zstd`)
  await fsp.writeFile(file, buffer, { flag: 'wx' })
  return file
}
