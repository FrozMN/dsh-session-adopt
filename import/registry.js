/**
 * Cross-harness scan registry.
 *
 * A scan talks to every available adapter, normalizes the candidate metadata,
 * computes the workspace a candidate would land in, and caches the candidates
 * by their opaque key. The import route then resolves keys against this cache
 * only, so a browser request never carries — and the host never trusts — a
 * filesystem path.
 */
import { realpath, stat } from 'node:fs/promises'
import { adapterContext } from './adapters/index.js'

/** Bound on concurrent adapter metadata reads. */
const LIST_CONCURRENCY = 8

/** Maximum characters kept from a foreign title in a candidate row. */
const MAX_CANDIDATE_TITLE = 200

/** Default candidate page size returned to the client (the cache keeps everything). */
export const DEFAULT_MAX_CANDIDATES = 500

/**
 * Stable error carrying a machine-readable import/scan rejection reason.
 */
export class ImportError extends Error {
  /**
   * @param {string} code stable reason such as `unknown-candidate`.
   * @param {string} message human-readable detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ImportError'
    this.code = code
  }
}

/**
 * Describe one error without leaking a stack into logs or responses.
 * @param {unknown} error thrown value.
 * @returns {string} stable message.
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run `operation` over items with bounded concurrency, preserving order.
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
 * Cap a foreign title to a display-friendly string.
 * @param {unknown} value candidate title.
 * @returns {string} trimmed title.
 */
function titleOf(value) {
  if (typeof value !== 'string') return ''
  return value.length <= MAX_CANDIDATE_TITLE ? value : `${value.slice(0, MAX_CANDIDATE_TITLE - 1)}…`
}

/**
 * Join a candidate cwd to the workspace it would land in.
 *
 * `existing` means the canonical path already owns a workspace; `new` is the
 * preview the client shows before the import creates one. `undefined` means the
 * path cannot be used at all (missing, relative, not a directory).
 * @param {string} cwd candidate working directory.
 * @param {Map<string, object>} workspaceByPath canonical workspace path index.
 * @param {(path: string) => Promise<string | undefined>} canonicalize cached realpath helper.
 * @returns {Promise<object | undefined>} workspace hint.
 */
async function workspaceHint(cwd, workspaceByPath, canonicalize) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined
  const canonical = await canonicalize(cwd)
  if (canonical === undefined) return undefined
  const existing = workspaceByPath.get(canonical)
  if (existing !== undefined) {
    return { kind: 'existing', workspaceId: String(existing.id), title: existing.title, path: existing.path }
  }
  const segments = canonical.split('/').filter((segment) => segment !== '')
  return { kind: 'new', path: canonical, title: segments.at(-1) ?? canonical }
}

/**
 * Adapter session store cache shared by scans and imports.
 */
export class ImportRegistry {
  /** @type {Map<string, { candidate: object, adapter: object }>} */
  #candidates = new Map()
  /** In-flight scan promise, so concurrent scans share one pass. */
  #scanning = null
  /** @type {object | null} */
  #lastScan = null

  /**
   * @param {{ ctx: object, adapters: object[], options?: object }} init host context, adapters, options.
   */
  constructor(init) {
    this.ctx = init.ctx
    this.adapters = init.adapters
    this.options = init.options ?? {}
    this.adapterEnv = adapterContext()
  }

  /** Last completed scan summary, or null. */
  get lastScan() {
    return this.#lastScan
  }

  /** Whether a scan is running. */
  get scanning() {
    return this.#scanning !== null
  }

  /**
   * Availability of every adapter without listing any sessions.
   * @returns {Promise<{ adapters: object[], errors: object[] }>} adapter inventory.
   */
  async sources() {
    const adapters = []
    const errors = []
    for (const adapter of this.adapters) {
      try {
        const status = await adapter.available(this.adapterEnv)
        adapters.push({
          id: adapter.id,
          title: adapter.title,
          available: status?.available === true,
          roots: Array.isArray(status?.roots) ? status.roots.filter((root) => typeof root === 'string') : [],
        })
      } catch (error) {
        errors.push({ adapterId: adapter.id, message: messageOf(error) })
        adapters.push({ id: adapter.id, title: adapter.title, available: false, roots: [] })
      }
    }
    return { adapters, errors }
  }

  /**
   * Scan every requested adapter for importable sessions.
   * @param {{ adapterIds?: readonly string[] }} [request] optional adapter filter.
   * @returns {Promise<object>} scan summary.
   */
  scan(request) {
    if (this.#scanning !== null) return this.#scanning
    this.#scanning = this.#runScan(request).finally(() => {
      this.#scanning = null
    })
    return this.#scanning
  }

  /**
   * Execute one scan pass and replace the candidate cache.
   * @param {{ adapterIds?: readonly string[] }} [request] optional adapter filter.
   * @returns {Promise<object>} scan summary.
   */
  async #runScan(request) {
    const startedAt = Date.now()
    const only = Array.isArray(request?.adapterIds)
      ? new Set(request.adapterIds.filter((id) => typeof id === 'string'))
      : undefined
    const selected = this.adapters.filter((adapter) => only === undefined || only.has(adapter.id))
    const workspaceByPath = new Map(
      this.ctx.workspaceRegistry.list().map((workspace) => [workspace.path, workspace]),
    )
    /** @type {Map<string, string | undefined>} */
    const canonicalCache = new Map()
    /**
     * Resolve a cwd to its canonical directory, cached per scan.
     * @param {string} path candidate path.
     * @returns {Promise<string | undefined>} canonical path, or undefined when unusable.
     */
    const canonicalize = async (path) => {
      if (canonicalCache.has(path)) return canonicalCache.get(path)
      let value
      try {
        const canonical = await realpath(path)
        if ((await stat(canonical)).isDirectory()) value = canonical
      } catch {
        value = undefined
      }
      canonicalCache.set(path, value)
      return value
    }

    const adaptersReport = []
    const errors = []
    const skipped = []
    const nextCache = new Map()
    const candidates = []
    const seenKeys = new Set()

    for (const adapter of selected) {
      const report = { id: adapter.id, title: adapter.title, available: false, roots: [], sessionCount: 0 }
      adaptersReport.push(report)
      let status
      try {
        status = await adapter.available(this.adapterEnv)
      } catch (error) {
        const message = messageOf(error)
        report.error = message
        errors.push({ adapterId: adapter.id, message })
        continue
      }
      report.available = status?.available === true
      report.roots = Array.isArray(status?.roots) ? status.roots.filter((root) => typeof root === 'string') : []
      if (!report.available) continue
      let listed
      try {
        listed = await adapter.listSessions(this.adapterEnv)
      } catch (error) {
        const message = messageOf(error)
        report.error = message
        errors.push({ adapterId: adapter.id, message })
        continue
      }
      if (!Array.isArray(listed)) {
        const message = 'adapter listSessions() did not return an array'
        report.error = message
        errors.push({ adapterId: adapter.id, message })
        continue
      }
      const hints = await mapLimit(listed, LIST_CONCURRENCY, (raw) => {
        const cwd = typeof raw?.cwd === 'string' ? raw.cwd : ''
        return workspaceHint(cwd, workspaceByPath, canonicalize)
      })
      listed.forEach((raw, index) => {
        try {
          const candidate = this.#normalizeCandidate(adapter, raw, hints[index])
          if (seenKeys.has(candidate.key)) {
            skipped.push({ harness: adapter.id, reason: 'duplicate-key', detail: candidate.key })
            return
          }
          seenKeys.add(candidate.key)
          nextCache.set(candidate.key, { candidate, adapter })
          candidates.push(candidate)
        } catch (error) {
          skipped.push({ harness: adapter.id, reason: 'invalid-candidate', detail: messageOf(error) })
        }
      })
      report.sessionCount = listed.length
    }

    candidates.sort((left, right) => resettingSort(right.updatedAt, left.updatedAt) || left.title.localeCompare(right.title))
    const maxCandidates = Number.isFinite(this.options.maxCandidates)
      ? Math.max(1, Math.trunc(this.options.maxCandidates))
      : DEFAULT_MAX_CANDIDATES
    const finishedAt = Date.now()
    const summary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      adapters: adaptersReport,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, maxCandidates),
      truncated: candidates.length > maxCandidates,
      errors,
      skipped: skipped.slice(0, 50),
      skippedCount: skipped.length,
    }
    this.#candidates = nextCache
    this.#lastScan = summary
    this.ctx.logger?.info?.(
      `session-adopt: import scan found ${summary.candidateCount} session(s) from ${adaptersReport.filter((item) => item.available).length} harness(es)`,
    )
    return summary
  }

  /**
   * Validate and normalize one adapter-reported candidate.
   * @param {object} adapter owning adapter.
   * @param {unknown} raw adapter candidate.
   * @param {object | undefined} hint workspace hint computed by the scan.
   * @returns {object} normalized candidate.
   * @throws {ImportError} when required metadata is missing.
   */
  #normalizeCandidate(adapter, raw, hint) {
    if (raw === null || typeof raw !== 'object') throw new ImportError('invalid-candidate', 'candidate is not an object')
    const key = raw.key
    if (typeof key !== 'string' || !key.startsWith(`${adapter.id}:`)) {
      throw new ImportError('invalid-candidate', `candidate key does not belong to adapter "${adapter.id}"`)
    }
    if (raw.foreignId !== undefined && raw.foreignId !== null && typeof raw.foreignId !== 'string') {
      throw new ImportError('invalid-candidate', 'candidate foreignId is not a string')
    }
    const createdAt = Number.isFinite(raw.createdAt) ? Math.trunc(raw.createdAt) : 0
    const updatedAt = Number.isFinite(raw.updatedAt) ? Math.trunc(raw.updatedAt) : createdAt
    return {
      key,
      harness: adapter.id,
      harnessTitle: adapter.title,
      foreignId: typeof raw.foreignId === 'string' ? raw.foreignId : null,
      title: titleOf(raw.title),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      createdAt,
      updatedAt,
      messageCount: Number.isFinite(raw.messageCount) ? Math.max(0, Math.trunc(raw.messageCount)) : 0,
      sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : adapter.id,
      model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : null,
      importable: hint !== undefined,
      workspaceHint: hint ?? null,
    }
  }

  /**
   * Look up one cached candidate by key.
   * @param {string} key opaque adapter key from a scan.
   * @returns {{ candidate: object, adapter: object }} cached entry.
   * @throws {ImportError} when the key was never scanned.
   */
  entry(key) {
    const entry = this.#candidates.get(key)
    if (entry === undefined) {
      throw new ImportError('unknown-candidate', 'session was not part of the last scan; run a scan first')
    }
    return entry
  }

  /**
   * Read the full transcript for one cached candidate.
   * @param {{ candidate: object, adapter: object }} entry cached entry.
   * @returns {Promise<object>} normalized session.
   */
  async read(entry) {
    const normalized = await entry.adapter.readSession(this.adapterEnv, entry.candidate.key)
    if (normalized === null || typeof normalized !== 'object') {
      throw new ImportError('invalid-session', 'adapter returned no session data')
    }
    return normalized
  }
}

/**
 * Sort helper tolerating non-finite epoch values.
 * @param {number} right newer value.
 * @param {number} left older value.
 * @returns {number} comparison result.
 */
function resettingSort(right, left) {
  return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0)
}
