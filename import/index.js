/**
 * Cross-harness import orchestration.
 *
 * Responsibilities, in order: scan foreign stores through the adapters, convert
 * one selected transcript into a validated native v4 session artifact, write it
 * through the persistence seam, and make sure a Workspace owns the result.
 *
 * Design constraints this module upholds:
 * - the browser selects opaque candidate keys only, never filesystem paths;
 * - every write is validated through the installed Session restore path before
 *   the durable log exists, so an invalid conversion cannot half-import;
 * - imports are serialized inside the host process (one durable write path) and
 *   idempotent across runs via a deterministic session id;
 * - a failure never aborts the remaining selections.
 */
import { realpath, stat } from 'node:fs/promises'
import { buildSessionArtifact, DEFAULT_MAX_MESSAGES, ImportBuildError } from './events.js'
import { importedSessionId } from './ids.js'
import { ImportError, ImportRegistry, messageOf } from './registry.js'

/** Largest number of selections one request may carry. */
const MAX_SELECTIONS = 200

/**
 * Normalize one workspace choice from the request body.
 * @param {unknown} value raw `workspace` field.
 * @returns {{ kind: 'auto' } | { kind: 'existing', workspaceId: string } | { kind: 'new', cwd?: string }} validated choice.
 * @throws {ImportError} on an unsupported shape.
 */
function workspaceChoice(value) {
  if (value === undefined || value === 'auto') return { kind: 'auto' }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ImportError('invalid-request', 'workspace must be "auto" or an object')
  }
  if (value.kind === 'existing') {
    if (typeof value.workspaceId !== 'string' || value.workspaceId === '') {
      throw new ImportError('invalid-request', 'workspace.workspaceId must be a non-empty string')
    }
    return { kind: 'existing', workspaceId: value.workspaceId }
  }
  if (value.kind === 'new') {
    if (value.cwd === undefined) return { kind: 'new' }
    if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) {
      throw new ImportError('invalid-request', 'workspace.cwd must be an absolute path')
    }
    return { kind: 'new', cwd: value.cwd }
  }
  throw new ImportError('invalid-request', 'workspace.kind must be "existing" or "new"')
}

/**
 * Normalize and validate the import request body.
 * @param {unknown} body parsed JSON body.
 * @returns {{ keys: string[], workspace: object }} validated request.
 * @throws {ImportError} on an invalid body.
 */
function importRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ImportError('invalid-request', 'request body must be a JSON object')
  }
  const selections = body.selections
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new ImportError('invalid-request', 'selections must be a non-empty array of candidate keys')
  }
  if (selections.length > MAX_SELECTIONS) {
    throw new ImportError('invalid-request', `at most ${MAX_SELECTIONS} sessions may be imported per request`)
  }
  const keys = []
  for (const key of selections) {
    if (typeof key !== 'string' || key === '') throw new ImportError('invalid-request', 'every selection must be a candidate key string')
    if (!keys.includes(key)) keys.push(key)
  }
  return { keys, workspace: workspaceChoice(body.workspace) }
}

/**
 * Read the workspace registry's canonical path index.
 * @param {object} ctx host context.
 * @returns {Map<string, object>} workspace entities keyed by canonical path.
 */
function workspaceByPath(ctx) {
  return new Map(ctx.workspaceRegistry.list().map((workspace) => [workspace.path, workspace]))
}

/**
 * Serialize workspace resolution and creation for one import run.
 * @param {object} ctx host context.
 * @returns {{ resolve: (choice: object, cwd: string) => Promise<object>, created: object[] }} resolver.
 */
function workspaceResolver(ctx) {
  /** @type {Map<string, object>} canonical path to entity. */
  const cache = new Map()
  const created = []
  const resolve = async (choice, cwd) => {
    if (choice.kind === 'existing') {
      const workspace = ctx.workspaceRegistry.get(choice.workspaceId)
      if (workspace === undefined) throw new ImportError('workspace-not-found', `workspace "${choice.workspaceId}" no longer exists`)
      return workspace
    }
    let target = cwd
    if (choice.kind === 'new' && choice.cwd !== undefined) {
      try {
        target = await realpath(choice.cwd)
        if (!(await stat(target)).isDirectory()) throw new Error('not a directory')
      } catch (error) {
        throw new ImportError('workspace-unresolved', `cannot use workspace directory "${choice.cwd}": ${messageOf(error)}`)
      }
    }
    const cached = cache.get(target)
    if (cached !== undefined) return cached
    const existing = workspaceByPath(ctx).get(target)
    if (existing !== undefined) {
      cache.set(target, existing)
      return existing
    }
    const workspace = await ctx.workspaceRegistry.create(target)
    cache.set(workspace.path, workspace)
    created.push({ workspaceId: String(workspace.id), title: workspace.title, path: workspace.path })
    ctx.logger?.info?.(`session-adopt: created workspace "${workspace.title}" for imported session (${workspace.path})`)
    return workspace
  }
  return { resolve, created }
}

/**
 * Host-side cross-harness import service.
 */
export class SessionImportService {
  #registry
  #options
  /** Monotonic serialization of durable import runs. */
  #tail = Promise.resolve()
  #importing = false
  #lastImport = null

  /**
   * @param {{ ctx: object, adapters: object[], options?: object }} init host context, adapters, options.
   */
  constructor(init) {
    this.ctx = init.ctx
    this.#options = init.options ?? {}
    this.#registry = new ImportRegistry({ ctx: init.ctx, adapters: init.adapters, options: this.#options })
  }

  /** Candidate registry (scan cache shared by scan and import routes). */
  get registry() {
    return this.#registry
  }

  /** Last completed import summary, or null. */
  get lastImport() {
    return this.#lastImport
  }

  /** Whether an import run is executing. */
  get importing() {
    return this.#importing
  }

  /**
   * Report adapter availability without listing sessions.
   * @returns {Promise<object>} sources payload.
   */
  async sources() {
    return await this.#registry.sources()
  }

  /**
   * Run one scan.
   * @param {{ adapterIds?: string[] }} [request] optional adapter filter.
   * @returns {Promise<object>} scan summary.
   */
  async scan(request) {
    return await this.#registry.scan(request)
  }

  /**
   * Status surface for tooling and the client dialog.
   * @returns {object} status payload.
   */
  status() {
    return {
      enabled: this.#options.importEnabled !== false,
      maxMessages: Number.isFinite(this.#options.maxMessages) ? Math.trunc(this.#options.maxMessages) : DEFAULT_MAX_MESSAGES,
      scanning: this.#registry.scanning,
      importing: this.#importing,
      lastScan: this.#registry.lastScan,
      lastImport: this.#lastImport,
    }
  }

  /**
   * Import a selection of scanned candidates.
   * @param {unknown} body parsed request body.
   * @returns {Promise<object>} import summary.
   */
  importSelections(body) {
    const operation = this.#tail.then(async () => {
      this.#importing = true
      try {
        return await this.#runImport(importRequest(body))
      } finally {
        this.#importing = false
      }
    })
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /**
   * Execute one serialized import run.
   * @param {{ keys: string[], workspace: object }} request validated request.
   * @returns {Promise<object>} import summary.
   */
  async #runImport(request) {
    const startedAt = Date.now()
    const resolver = workspaceResolver(this.ctx)
    const imported = []
    const skipped = []
    const errors = []
    for (const key of request.keys) {
      try {
        const outcome = await this.#importOne(key, request.workspace, resolver)
        if (outcome.status === 'imported') imported.push(outcome)
        else skipped.push(outcome)
      } catch (error) {
        errors.push({
          candidateKey: key,
          code: error instanceof ImportError || error instanceof ImportBuildError ? error.code : 'import-failed',
          message: messageOf(error),
        })
        this.ctx.logger?.warn?.(`session-adopt: import of "${key}" failed: ${messageOf(error)}`)
      }
    }
    const finishedAt = Date.now()
    const summary = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      imported,
      skipped,
      errors,
      createdWorkspaceCount: resolver.created.length,
      createdWorkspaces: resolver.created,
    }
    this.#lastImport = summary
    if (imported.length > 0 || errors.length > 0) {
      this.ctx.logger?.info?.(
        `session-adopt: imported ${imported.length} session(s) from external harnesses` +
          (errors.length > 0 ? `, ${errors.length} error(s)` : ''),
      )
    }
    return summary
  }

  /**
   * Import one candidate, or recognize it as already imported.
   * @param {string} key scanned candidate key.
   * @param {object} workspaceChoice normalized workspace choice.
   * @param {{ resolve: Function, created: object[] }} resolver workspace resolver for this run.
   * @returns {Promise<object>} per-selection outcome.
   */
  async #importOne(key, workspaceChoice, resolver) {
    const entry = this.#registry.entry(key)
    const { candidate, adapter } = entry
    const id = importedSessionId(adapter.id, candidate.foreignId ?? undefined, candidate.key)
    const existing = await this.ctx.sessionPersistence.stat(id)
    if (existing !== undefined) {
      const cwd = await this.#canonicalCwd(existing.header?.cwd ?? candidate.cwd)
      const workspace = cwd === undefined
        ? this.#workspaceOwning(id)
        : await resolver.resolve(workspaceChoice, cwd)
      if (workspace === undefined) {
        throw new ImportError('already-imported', `session ${id} was imported before but its working directory no longer resolves`)
      }
      const attached = await this.#attach(workspace, id)
      return {
        status: 'skipped',
        reason: 'already-imported',
        candidateKey: key,
        sessionId: id,
        workspaceId: String(workspace.id),
        workspaceTitle: workspace.title,
        attached,
      }
    }

    const normalized = await this.#registry.read(entry)
    const cwd = await this.#canonicalCwd(typeof normalized.cwd === 'string' ? normalized.cwd : candidate.cwd)
    if (cwd === undefined) {
      throw new ImportError('cwd-unresolved', `working directory "${candidate.cwd}" does not resolve to an existing directory`)
    }
    const transcript = {
      ...normalized,
      harness: adapter.id,
      foreignId: candidate.foreignId ?? normalized.foreignId,
      title: typeof normalized.title === 'string' && normalized.title !== '' ? normalized.title : candidate.title,
      cwd,
    }
    const artifact = buildSessionArtifact(transcript, {
      id,
      now: Date.now(),
      maxMessages: this.#maxMessages(),
    })
    this.#validateArtifact(id, artifact)
    await this.#writeArtifact(artifact)
    const workspace = await resolver.resolve(workspaceChoice, cwd)
    const attached = await this.#attach(workspace, id)
    this.ctx.logger?.info?.(`session-adopt: imported ${adapter.id} session "${candidate.foreignId ?? key}" as ${id}`)
    return {
      status: 'imported',
      candidateKey: key,
      sessionId: id,
      workspaceId: String(workspace.id),
      workspaceTitle: workspace.title,
      workspacePath: workspace.path,
      title: artifact.stats.title,
      turns: artifact.stats.turns,
      messageCount: artifact.stats.messageCount,
      attached,
    }
  }

  /**
   * Validate a candidate artifact through the installed Session restore path.
   * @param {string} id target session id.
   * @param {{ header: object, events: object[] }} artifact candidate artifact.
   * @throws {ImportError} when the harness would refuse the log.
   */
  #validateArtifact(id, artifact) {
    try {
      this.ctx.sessions.prepare(`session-adopt-probe-${id}`, {
        seed: artifact.events,
        meta: { createdAt: artifact.header.createdAt, cwd: artifact.header.cwd },
      })
    } catch (error) {
      throw new ImportError('invalid-session', `converted session failed harness validation: ${messageOf(error)}`)
    }
  }

  /**
   * Write one validated artifact through the persistence seam.
   * @param {{ header: object, events: object[] }} artifact validated artifact.
   * @returns {Promise<void>} completion after close.
   * @throws {ImportError} when persistence rejects the write.
   */
  async #writeArtifact(artifact) {
    let handle
    try {
      handle = await this.ctx.sessionPersistence.create(artifact.header)
      await handle.append(artifact.events)
      await handle.flush()
    } catch (error) {
      await handle?.close?.().catch(() => {})
      throw new ImportError('persist-failed', `durable session write failed: ${messageOf(error)}`)
    }
    await handle.close()
  }

  /**
   * Resolve a path to a canonical existing directory.
   * @param {unknown} path candidate directory.
   * @returns {Promise<string | undefined>} canonical path, or undefined.
   */
  async #canonicalCwd(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) return undefined
    try {
      const canonical = await realpath(path)
      return (await stat(canonical)).isDirectory() ? canonical : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Find the workspace that already accounts for a session id.
   * @param {string} id session id.
   * @returns {object | undefined} owning workspace.
   */
  #workspaceOwning(id) {
    return this.ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(id))
  }

  /**
   * Attach a stored session to a workspace, tolerating an existing membership.
   * @param {object} workspace target workspace entity.
   * @param {string} id stored session id.
   * @returns {Promise<'attached' | 'already-attached'>} attachment outcome.
   */
  async #attach(workspace, id) {
    if (workspace.sessionIds.includes(id)) return 'already-attached'
    await workspace.attachSession(id)
    return 'attached'
  }

  /**
   * Effective normalized-message ceiling for one import.
   * @returns {number} message limit.
   */
  #maxMessages() {
    return Number.isFinite(this.#options.maxMessages)
      ? Math.max(1, Math.trunc(this.#options.maxMessages))
      : DEFAULT_MAX_MESSAGES
  }
}
