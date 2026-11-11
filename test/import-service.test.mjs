/**
 * Self-contained tests for the import orchestrator.
 *
 * The host context is mocked with an in-memory persistence backend and a
 * minimal workspace registry. The mock deliberately mirrors the real services'
 * contract points this plugin depends on (existence check, single-writer create,
 * header cwd validation on attach) so the orchestration semantics — including
 * idempotency and per-selection error isolation — are pinned without a live
 * Harness.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import test from 'node:test'

import { SessionImportService } from '../import/index.js'
import { importedSessionId } from '../import/ids.js'

/** Existing canonical directory used as the fixture working directory. */
const CWD = realpathSync(mkdtempSync(join(tmpdir(), 'session-adopt-test-')))

/**
 * Build a mock host context.
 * @param {{ wavCwd?: string }} [options] overrides.
 * @returns {object} host context plus internal state handles.
 */
function mockHost(options = {}) {
  const stored = new Map()
  const workspaces = []
  let workspaceCounter = 0
  let closedHandles = 0
  /** Sessions whose next write is forced to fail. */
  const failing = new Set()

  const sessionPersistence = {
    async stat(id) {
      return stored.get(id)
    },
    async create(header) {
      if (stored.has(header.id)) throw new Error('session already exists')
      const record = { header, events: [] }
      const fail = failing.has(header.id)
      const handle = {
        async append(events) {
          if (fail) throw new Error('simulated disk failure')
          for (const event of events) {
            if (event.seq !== record.events.length) throw new Error(`seq gap: ${event.seq} != ${record.events.length}`)
            record.events.push(event)
          }
        },
        async flush() {
          if (fail) throw new Error('simulated flush failure')
        },
        async close() {
          closedHandles += 1
        },
      }
      stored.set(header.id, record)
      return handle
    },
  }

  const sessions = {
    prepare(id, { seed, meta }) {
      // Mirror the shape constraints the installed Session restore enforces.
      if (typeof id !== 'string' || id === '') throw new Error('bad id')
      if (!Array.isArray(seed)) throw new Error('bad seed')
      if (typeof meta?.cwd !== 'string' || !isAbsolute(meta.cwd)) throw new Error('bad cwd')
      seed.forEach((event, index) => {
        if (event.seq !== index) throw new Error('non-contiguous seed')
        if (event.type === 'user/message' && event.surfaceOp !== 'append') throw new Error('surface marker missing')
      })
    },
  }

  const workspaceRegistry = {
    list() {
      return workspaces
    },
    get(id) {
      return workspaces.find((workspace) => String(workspace.id) === id)
    },
    async create(path) {
      const existing = workspaces.find((workspace) => workspace.path === path)
      if (existing !== undefined) return existing
      const workspace = {
        id: `ws-${++workspaceCounter}`,
        path,
        title: basename(path) || path,
        sessionIds: [],
        async attachSession(sessionId) {
          const record = stored.get(sessionId)
          if (record === undefined) throw new Error(`cannot attach unknown session ${sessionId}`)
          if (record.header.cwd !== this.path) throw new Error(`header cwd ${record.header.cwd} does not match ${this.path}`)
          if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
        },
      }
      workspaces.push(workspace)
      return workspace
    },
  }

  const ctx = {
    sessionPersistence,
    sessions,
    workspaceRegistry,
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, stored, workspaces, failing, stats: () => ({ closedHandles }) }
}

/**
 * Build a fake adapter over one fixture transcript.
 * @param {object} [overrides] transcript overrides.
 * @returns {object} adapter.
 */
function fakeAdapter(overrides = {}) {
  const transcript = {
    foreignId: 'foreign-1',
    title: 'Mock session',
    cwd: CWD,
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
    provider: 'pi-ai',
    model: 'mock-model',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.UTC(2026, 9, 1) },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.UTC(2026, 9, 1, 0, 0, 5) },
    ],
    ...overrides,
  }
  return {
    id: 'fake',
    title: { en: 'Fake', zh: '假' },
    async available() {
      return { available: true, roots: ['/tmp/fake-sessions'] }
    },
    async listSessions() {
      return [{
        key: 'fake:one',
        foreignId: transcript.foreignId,
        title: transcript.title,
        cwd: transcript.cwd,
        createdAt: transcript.createdAt,
        updatedAt: transcript.updatedAt,
        messageCount: transcript.messages.length,
        sourceLabel: 'fake store',
        model: transcript.model,
      }]
    },
    async readSession(_env, key) {
      if (key !== 'fake:one') throw new Error('unknown key')
      return transcript
    },
  }
}

/**
 * Build a service over the mock host.
 * @param {object} [options] overrides.
 * @returns {object} service and host internals.
 */
function serviceTree(options = {}) {
  const host = mockHost()
  const service = new SessionImportService({
    ctx: host.ctx,
    adapters: [fakeAdapter(options.transcript)],
    options: { importEnabled: true, maxMessages: 4000, maxCandidates: 500 },
  })
  return { host, service }
}

test('scan reports candidates with workspace hints', async () => {
  const { service } = serviceTree()
  const sources = await service.sources()
  assert.deepEqual(sources.adapters, [{ id: 'fake', title: { en: 'Fake', zh: '假' }, available: true, roots: ['/tmp/fake-sessions'] }])
  const summary = await service.scan({})
  assert.equal(summary.candidateCount, 1)
  const candidate = summary.candidates[0]
  assert.equal(candidate.key, 'fake:one')
  assert.equal(candidate.harness, 'fake')
  assert.equal(candidate.importable, true)
  assert.equal(candidate.workspaceHint.kind, 'new')
  assert.equal(summary.adapters[0].sessionCount, 1)
})

test('import writes a valid session and attaches it to a new workspace', async () => {
  const { host, service } = serviceTree()
  await service.scan({})
  const result = await service.importSelections({ selections: ['fake:one'], workspace: 'auto' })
  assert.equal(result.errors.length, 0)
  assert.equal(result.imported.length, 1)
  assert.equal(result.createdWorkspaceCount, 1)
  const imported = result.imported[0]
  const expectedId = importedSessionId('fake', 'foreign-1', 'fake:one')
  assert.equal(imported.sessionId, expectedId)
  assert.equal(imported.attached, 'attached')
  const record = host.stored.get(expectedId)
  assert.ok(record.events.length > 0)
  assert.equal(record.header.cwd, CWD)
  assert.equal(host.workspaces.length, 1)
  assert.deepEqual(host.workspaces[0].sessionIds, [expectedId])
})

test('re-import is idempotent and reports the existing session', async () => {
  const { host, service } = serviceTree()
  await service.scan({})
  const first = await service.importSelections({ selections: ['fake:one'], workspace: 'auto' })
  const second = await service.importSelections({ selections: ['fake:one'], workspace: 'auto' })
  assert.equal(second.imported.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.equal(second.skipped[0].reason, 'already-imported')
  assert.equal(second.skipped[0].sessionId, first.imported[0].sessionId)
  assert.equal(second.errors.length, 0)
  assert.equal(host.stored.size, 1)
  assert.equal(host.workspaces.length, 1)
})

test('an explicit existing workspace that owns the cwd receives the session', async () => {
  const { host, service } = serviceTree()
  const workspace = await host.ctx.workspaceRegistry.create(CWD)
  await service.scan({})
  const result = await service.importSelections({ selections: ['fake:one'], workspace: { kind: 'existing', workspaceId: String(workspace.id) } })
  assert.equal(result.errors.length, 0)
  assert.equal(result.createdWorkspaceCount, 0)
  assert.deepEqual(host.workspaces[0].sessionIds, [result.imported[0].sessionId])
})

test('per-selection failures do not abort the batch', async () => {
  const { service } = serviceTree()
  await service.scan({})
  const result = await service.importSelections({ selections: ['fake:one', 'fake:missing'], workspace: 'auto' })
  assert.equal(result.imported.length, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].candidateKey, 'fake:missing')
  assert.equal(result.errors[0].code, 'unknown-candidate')
})

test('invalid requests are rejected before any work', async () => {
  const { service } = serviceTree()
  await assert.rejects(() => service.importSelections({ selections: [] }), /non-empty array/)
  await assert.rejects(() => service.importSelections({ selections: ['fake:one'], workspace: { kind: 'nope' } }), /workspace.kind/)
  await assert.rejects(() => service.importSelections({ selections: [123] }), /candidate key string/)
})

test('a persistence failure surfaces as an error and leaves nothing half-imported', async () => {
  const { host, service } = serviceTree()
  await service.scan({})
  host.failing.add(importedSessionId('fake', 'foreign-1', 'fake:one'))
  const result = await service.importSelections({ selections: ['fake:one'], workspace: 'auto' })
  assert.equal(result.imported.length, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'persist-failed')
  assert.equal(host.workspaces.length, 0)
})

test('status exposes scanning/importing and the last summaries', async () => {
  const { service } = serviceTree()
  const before = service.status()
  assert.equal(before.enabled, true)
  assert.equal(before.scanning, false)
  assert.equal(before.lastScan, null)
  await service.scan({})
  await service.importSelections({ selections: ['fake:one'], workspace: 'auto' })
  const after = service.status()
  assert.notEqual(after.lastScan, null)
  assert.equal(after.lastImport.imported.length, 1)
})
