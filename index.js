/**
 * Session adopt (Host half).
 *
 * Sessions written by another DeepSeek Harness process -- for example the ACP
 * server launched by an IDE -- live in the same durable session store but are
 * invisible to this process's workspace registry until startup or a full
 * restart. This plugin scans durable sessions, resolves each session's
 * canonical cwd to a Workspace, and attaches the session to that Workspace.
 *
 * Scans run on a timer for recently active workspaces, immediately at startup,
 * and on demand from the sidebar action (the Client half POSTs to
 * `/session-adopt/scan`).
 *
 * The bundle deliberately has no package dependencies: only Node built-ins.
 */
import { realpath, stat } from 'node:fs/promises'

/** @typedef {'startup' | 'periodic' | 'manual' | 'focus'} ScanTrigger */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** Tunables, overridable through the Loader row's `config` mapping. */
const DEFAULT_OPTIONS = {
  /** How often an active-workspace scan runs. */
  pollIntervalMs: 2 * HOUR,
  /** A workspace counts as active when a session log changed within this window. */
  activeWindowMs: 6 * HOUR,
  /** Create a workspace for a session whose canonical cwd has no registration. */
  autoCreateWorkspaces: true,
  /** Subagent sessions belong to their parent conversation, not the session tree. */
  includeSubagents: false,
  /** Run one full scan shortly after the plugin mounts, so already-written IDE sessions appear. */
  startupScan: true,
  /** Delay before that first scan, letting the rest of the composition settle. */
  startupDelayMs: 2500,
}

const SCAN_PATH = '/session-adopt/scan'
const STATUS_PATH = '/session-adopt/status'
const MAX_BODY_BYTES = 16 * 1024
const MAX_REPORTED_ITEMS = 25
const LIST_CONCURRENCY = 16

/** Cordis plugin name. */
export const name = 'session-adopt'

/** Services this Host half needs before it can observe sessions and attach them. */
export const inject = ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry']

/**
 * Read one positive duration from configuration, clamped to a usable minimum.
 * @param {unknown} value configured value.
 * @param {number} fallback value used when the configuration is absent or invalid.
 * @param {number} minimum smallest accepted value in milliseconds.
 * @returns {number} a whole number of milliseconds.
 */
function duration(value, fallback, minimum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback
}

/**
 * Normalize the row configuration into the options this plugin reads.
 * @param {Record<string, unknown> | undefined} config Loader row config.
 * @returns {typeof DEFAULT_OPTIONS} resolved options.
 */
function readOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    pollIntervalMs: duration(source.pollIntervalMs, DEFAULT_OPTIONS.pollIntervalMs, MINUTE),
    activeWindowMs: duration(source.activeWindowMs, DEFAULT_OPTIONS.activeWindowMs, MINUTE),
    autoCreateWorkspaces: source.autoCreateWorkspaces !== false,
    includeSubagents: source.includeSubagents === true,
    startupScan: source.startupScan !== false,
    startupDelayMs: duration(source.startupDelayMs, DEFAULT_OPTIONS.startupDelayMs, 0),
  }
}

/**
 * Describe one error without leaking a stack into a wire response.
 * @param {unknown} error thrown value.
 * @returns {string} a stable human-readable reason.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * ISO-8601 spelling for a millisecond timestamp.
 * @param {number} time epoch milliseconds.
 * @returns {string} UTC timestamp.
 */
function iso(time) {
  return new Date(time).toISOString()
}

/**
 * Answer one JSON response with caching disabled.
 * @param {import('node:http').ServerResponse} res response owner.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Answer a method mismatch with the one allowed method.
 * @param {import('node:http').ServerResponse} res response owner.
 * @param {string} allow allowed method.
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Read a request body with a hard byte ceiling.
 * @param {import('node:http').IncomingMessage} req request stream.
 * @returns {Promise<string | null>} UTF-8 body, or null past the ceiling.
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Run `operation` over every item with bounded concurrency, preserving order.
 * @template T, R
 * @param {readonly T[]} items input items.
 * @param {number} limit maximum in-flight operations.
 * @param {(item: T, index: number) => Promise<R>} operation per-item work.
 * @returns {Promise<R[]>} results in input order.
 */
async function mapLimit(items, limit, operation) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await operation(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Register the Host half: routes, the startup scan, and the periodic scan.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning Host context.
 * @param {Record<string, unknown> | undefined} config row configuration.
 */
export function apply(ctx, config) {
  const options = readOptions(config)
  /** Process-local start, used to distinguish sessions created under this plugin from older history. */
  const startedAt = Date.now()

  /** The most recent completed scan summary, or null before the first scan. */
  let lastScan = null
  /** Whether a scan is running right now. */
  let scanning = false
  /** Scans waiting for the serialized scan chain. */
  let queued = 0
  /** Serializes scans and registry mutations this plugin initiates. */
  let scanTail = Promise.resolve()
  /** Next scheduled periodic scan, for the status surface. */
  let nextScheduledScanAt = Date.now() + options.pollIntervalMs

  /**
   * Run one scan and publish its summary through {@link lastScan}.
   * @param {ScanTrigger} trigger what asked for the scan.
   * @param {'all' | 'active'} scope whether inactive groups are skipped.
   * @returns {Promise<object>} the bounded scan summary.
   */
  async function runScan(trigger, scope) {
    const startedAt = Date.now()
    const snapshots = await ctx.sessionPersistence.list()
    const workspaces = ctx.workspaceRegistry.list()

    /** @type {Map<string, import('@deepseek-ai/dsh-workspace').Workspace>} */
    const workspaceByPath = new Map()
    /** @type {Map<string, number>} newest observed activity per workspace path. */
    const activityByPath = new Map()
    /** @type {Set<string>} sessions already present on some workspace record. */
    const accounted = new Set()

    for (const workspace of workspaces) {
      workspaceByPath.set(workspace.path, workspace)
      const updatedAt = Date.parse(workspace.updatedAt)
      activityByPath.set(workspace.path, Number.isFinite(updatedAt) ? updatedAt : 0)
      for (const sessionId of workspace.sessionIds) accounted.add(String(sessionId))
    }

    const inspected = await mapLimit(snapshots, LIST_CONCURRENCY, async (snapshot) => {
      const header = snapshot.header
      const base = {
        id: String(header.id),
        header,
        subagent: header.origin === 'subagent',
        formatStatus: snapshot.formatStatus,
      }
      if (snapshot.formatStatus === 'migration-required') {
        return { ...base, skip: 'migration-required' }
      }
      if (header.cwd === undefined || header.cwd === '') {
        return { ...base, skip: 'no-cwd' }
      }
      let canonical
      try {
        canonical = await realpath(header.cwd)
        if (!(await stat(canonical)).isDirectory()) {
          return { ...base, skip: 'cwd-not-directory' }
        }
      } catch (error) {
        return { ...base, skip: 'cwd-unresolved', detail: messageOf(error) }
      }
      let mtime = Number.isFinite(header.createdAt) ? header.createdAt : 0
      const location = snapshot.location?.path
      if (location !== undefined) {
        try {
          mtime = Math.max(mtime, (await stat(location)).mtimeMs)
        } catch {
          // A log that disappeared between listing and stat keeps its header time.
        }
      }
      return { ...base, cwd: canonical, mtime }
    })

    const now = startedAt
    const skipCounts = {}
    const skipped = []
    /** Record a skip reason without letting the bounded report grow forever. */
    const skip = (reason, item, detail) => {
      skipCounts[reason] = (skipCounts[reason] ?? 0) + 1
      if (skipped.length >= MAX_REPORTED_ITEMS) return
      skipped.push({
        sessionId: item?.id,
        reason,
        ...(item?.cwd === undefined ? {} : { path: item.cwd }),
        ...(detail === undefined ? {} : { detail }),
      })
    }

    for (const item of inspected) {
      if (item.skip !== undefined) {
        skip(item.skip, item, item.detail)
        continue
      }
      const workspace = workspaceByPath.get(item.cwd)
      if (workspace === undefined) continue
      activityByPath.set(workspace.path, Math.max(activityByPath.get(workspace.path) ?? 0, item.mtime))
    }

    /** Existing workspaces with recent session activity. */
    const activePaths = new Set()
    for (const workspace of workspaces) {
      if (now - (activityByPath.get(workspace.path) ?? 0) <= options.activeWindowMs) {
        activePaths.add(workspace.path)
      }
    }

    /** @type {Map<string, Array<any>>} unaccounted sessions grouped by canonical cwd. */
    const groups = new Map()
    /** @type {Set<string>} ids of scanned sessions still absent from every workspace. */
    const unaccounted = new Set()
    for (const item of inspected) {
      if (item.skip !== undefined || accounted.has(item.id)) continue
      if (item.subagent && !options.includeSubagents) {
        skip('subagent', item)
        continue
      }
      unaccounted.add(item.id)
      const group = groups.get(item.cwd)
      if (group === undefined) groups.set(item.cwd, [item])
      else group.push(item)
    }

    const attached = []
    const created = []
    const errors = []
    /** @type {Record<string, number>} */
    const errorCounts = {}
    let errorTotal = 0
    const fail = (message, item) => {
      errorTotal += 1
      if (errorCounts[message] !== undefined || Object.keys(errorCounts).length < MAX_REPORTED_ITEMS) {
        errorCounts[message] = (errorCounts[message] ?? 0) + 1
      }
      if (errors.length < MAX_REPORTED_ITEMS) {
        errors.push({
          ...(item?.id === undefined ? {} : { sessionId: item.id }),
          ...(item?.cwd === undefined ? {} : { path: item.cwd }),
          message,
        })
      }
    }
    let deferredCount = 0

    for (const [cwd, group] of groups) {
      const existing = workspaceByPath.get(cwd)
      const newest = Math.max(...group.map((item) => item.mtime))
      const active = existing === undefined
        ? now - newest <= options.activeWindowMs
        : activePaths.has(existing.path)
      if (scope !== 'all' && !active) {
        deferredCount += group.length
        continue
      }

      let workspace = existing
      if (workspace === undefined) {
        // Creating a Workspace is durable and visible. Do it for sessions this
        // plugin process saw born, and for an explicit manual sync; never for
        // old history on every restart, which would resurrect a Workspace the
        // user deleted on purpose.
        const newestCreatedAt = group.reduce(
          (newest, item) => Math.max(newest, Number.isFinite(item.header.createdAt) ? item.header.createdAt : 0),
          0,
        )
        const mayCreate = options.autoCreateWorkspaces && (trigger === 'manual' || newestCreatedAt >= startedAt)
        if (!mayCreate) {
          for (const item of group) skip('no-workspace', item)
          continue
        }
        try {
          workspace = await ctx.workspaceRegistry.create(cwd)
          workspaceByPath.set(cwd, workspace)
          activityByPath.set(workspace.path, now)
          created.push({
            workspaceId: String(workspace.id),
            title: workspace.title,
            path: workspace.path,
          })
          ctx.logger.info(`session-adopt: created workspace "${workspace.title}" for ${cwd}`)
        } catch (error) {
          fail(`cannot create workspace for ${cwd}: ${messageOf(error)}`, group[0])
          continue
        }
      }

      // Oldest first: attachSession prepends, so the newest session ends first.
      const ordered = [...group].sort((left, right) => (left.header.createdAt ?? 0) - (right.header.createdAt ?? 0))
      for (const item of ordered) {
        try {
          await workspace.attachSession(item.header.id)
          attached.push({
            sessionId: item.id,
            workspaceId: String(workspace.id),
            workspaceTitle: workspace.title,
            path: workspace.path,
            createdAt: item.header.createdAt,
          })
          ctx.logger.info(`session-adopt: attached session "${item.id}" to workspace "${workspace.title}"`)
        } catch (error) {
          fail(`cannot attach session "${item.id}" to workspace "${workspace.title}": ${messageOf(error)}`, item)
        }
      }
    }

    const finishedAt = Date.now()
    const summary = {
      trigger,
      scope,
      startedAt: iso(startedAt),
      finishedAt: iso(finishedAt),
      durationMs: finishedAt - startedAt,
      sessionCount: snapshots.length,
      unaccountedCount: unaccounted.size,
      activeWorkspaceCount: activePaths.size,
      activeWorkspaces: workspaces
        .filter((workspace) => activePaths.has(workspace.path))
        .slice(0, MAX_REPORTED_ITEMS)
        .map((workspace) => ({
          workspaceId: String(workspace.id),
          title: workspace.title,
          path: workspace.path,
          lastActivityAt: iso(activityByPath.get(workspace.path) ?? 0),
        })),
      attachedCount: attached.length,
      attached: attached.slice(0, MAX_REPORTED_ITEMS),
      createdCount: created.length,
      created,
      deferredCount,
      skipCounts,
      skipped,
      errorCount: errorTotal,
      errorCounts,
      errors,
    }
    lastScan = summary
    if (attached.length > 0 || created.length > 0 || summary.errorCount > 0) {
      ctx.logger.info(
        `session-adopt: ${trigger} scan attached ${attached.length} session(s) in ${created.length} new workspace(s)` +
          (summary.errorCount > 0 ? `, ${summary.errorCount} error(s)` : ''),
      )
    }
    return summary
  }

  /**
   * Queue one scan behind earlier scans.
   * @param {ScanTrigger} trigger what asked for the scan.
   * @param {'all' | 'active'} scope scan breadth.
   * @returns {Promise<object>} the scan summary.
   */
  function scan(trigger, scope) {
    queued += 1
    const operation = scanTail.then(async () => {
      queued -= 1
      scanning = true
      try {
        return await runScan(trigger, scope)
      } finally {
        scanning = false
      }
    })
    scanTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /**
   * Reject an untrusted or unauthenticated request.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {boolean} whether the request was answered already.
   */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SCAN_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          sendJson(res, 415, { ok: false, error: { message: 'content-type must be application/json' } })
          return
        }
        let text
        try {
          text = await readBoundedBody(req)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { message: `request body unreadable: ${messageOf(error)}` } })
          return
        }
        if (text === null) {
          sendJson(res, 413, { ok: false, error: { message: 'request body is too large' } })
          return
        }
        let body
        try {
          body = text === '' ? {} : JSON.parse(text)
        } catch {
          sendJson(res, 400, { ok: false, error: { message: 'request body must be valid JSON' } })
          return
        }
        const scope = body?.scope === 'active' ? 'active' : 'all'
        try {
          sendJson(res, 200, { ok: true, scan: await scan('manual', scope) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: { message: messageOf(error) } })
        }
      },
    }),
    `session-adopt: POST ${SCAN_PATH}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        sendJson(res, 200, {
          ok: true,
          config: {
            pollIntervalMs: options.pollIntervalMs,
            activeWindowMs: options.activeWindowMs,
            autoCreateWorkspaces: options.autoCreateWorkspaces,
            includeSubagents: options.includeSubagents,
            startupScan: options.startupScan,
          },
          scanning,
          queued,
          nextScheduledScanAt: iso(nextScheduledScanAt),
          lastScan,
        })
      },
    }),
    `session-adopt: GET ${STATUS_PATH}`,
  )

  ctx.effect(() => {
    if (!options.startupScan) return () => {}
    const timer = setTimeout(() => {
      scan('startup', 'all').catch((error) => {
        ctx.logger.warn(`session-adopt: startup scan failed: ${messageOf(error)}`)
      })
    }, options.startupDelayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'session-adopt: startup scan')

  ctx.effect(() => {
    nextScheduledScanAt = Date.now() + options.pollIntervalMs
    const timer = setInterval(() => {
      nextScheduledScanAt = Date.now() + options.pollIntervalMs
      scan('periodic', 'active').catch((error) => {
        ctx.logger.warn(`session-adopt: periodic scan failed: ${messageOf(error)}`)
      })
    }, options.pollIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'session-adopt: periodic scan')

  ctx.logger.info(
    `session-adopt: active; checking active workspaces every ${Math.round(options.pollIntervalMs / 60000)} minute(s)` +
      ` and treating the last ${Math.round(options.activeWindowMs / 3600000)} hour(s) as active`,
  )
}
