/**
 * Tests for the pi harness adapter.
 *
 * Two layers:
 * - synthetic JSONL fixtures under a temp directory exercise every mapping and
 *   the defensive parsing paths (malformed lines, truncated tails, v1 files,
 *   branches, unknown record types);
 * - the machine's real pi store (`~/.pi/agent/sessions`) is parsed end to end
 *   when present, so the adapter is verified against the actual sessions the
 *   feature must import. Those tests skip gracefully when the store is absent.
 *
 * Run with: `node --test dsh-session-adopt/import/adapters/pi.test.mjs`
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { available, id, listSessions, readSession, title } from './pi.js'

/** Adapter context pointing at the real user environment. */
const REAL_CTX = { home: homedir(), env: {}, platform: process.platform }

/** Base timestamp used by synthetic fixtures. */
const BASE_TIME = '2026-01-02T03:04:05.000Z'

/** Base timestamp in epoch milliseconds. */
const BASE_MS = Date.parse(BASE_TIME)

/** A valid pi session id used by the synthetic header. */
const SESSION_ID = '019f0000-0000-7000-8000-000000000001'

/**
 * Build an ISO timestamp offset from the fixture base.
 * @param {number} offsetMs milliseconds after the header timestamp.
 * @returns {string} ISO 8601 timestamp.
 */
function at(offsetMs) {
  return new Date(BASE_MS + offsetMs).toISOString()
}

/**
 * Build the pi session header line.
 * @param {object} [overrides] header fields to replace.
 * @returns {object} session header record.
 */
function header(overrides) {
  return { type: 'session', version: 3, id: SESSION_ID, timestamp: BASE_TIME, cwd: '/tmp/pi-adapter-project', ...overrides }
}

/**
 * Build one pi session entry envelope.
 * @param {string} type entry type.
 * @param {string | null} entryId entry id.
 * @param {string | null} parentId parent entry id.
 * @param {number} offsetMs entry timestamp offset from the base.
 * @param {object} [fields] extra fields.
 * @returns {object} session entry.
 */
function entry(type, entryId, parentId, offsetMs, fields) {
  return { type, ...entryId === null ? {} : { id: entryId }, ...parentId === null ? {} : { parentId }, timestamp: at(offsetMs), ...fields }
}

/**
 * Build one pi message entry.
 * @param {string | null} entryId entry id.
 * @param {string | null} parentId parent entry id.
 * @param {number} offsetMs entry timestamp offset from the base.
 * @param {object} message nested pi message.
 * @returns {object} message entry.
 */
function messageEntry(entryId, parentId, offsetMs, message) {
  return entry('message', entryId, parentId, offsetMs, {
    message: { ...message, timestamp: BASE_MS + offsetMs },
  })
}

/**
 * Serialize records as JSONL.
 * @param {object[]} records records.
 * @param {{ trailingNewline?: boolean }} [options] serialization options.
 * @returns {string} JSONL text.
 */
function jsonl(records, options) {
  const text = records.map((record) => JSON.stringify(record)).join('\n')
  return options?.trailingNewline === false ? text : `${text}\n`
}

/**
 * Create a temporary directory removed when the test finishes.
 * @param {import('node:test').TestContext} t test context.
 * @returns {Promise<string>} absolute temp directory path.
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * Write a session file at `<root>/<working dir name>/<file>`.
 * @param {string} root sessions root.
 * @param {string} relativePath path under the sessions root.
 * @param {string} content file content.
 * @returns {Promise<string>} absolute file path.
 */
async function writeSession(root, relativePath, content) {
  const file = join(root, relativePath)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, content)
  return file
}

/**
 * Build an adapter context whose store is the given sessions directory,
 * overriding the real environment completely.
 * @param {string} sessionsRoot synthetic sessions root (flat session file dir).
 * @param {string} home synthetic home directory.
 * @returns {{ home: string, env: object, platform: string }} adapter context.
 */
function storeContext(sessionsRoot, home) {
  return { home, env: { PI_CODING_AGENT_SESSION_DIR: sessionsRoot }, platform: process.platform }
}

/**
 * A complete synthetic session exercising every mapping and skipped record type.
 * @returns {object[]} JSONL records.
 */
function fullFeatureRecords() {
  const records = [
    header(),
    entry('model_change', 'm1', null, 1, { provider: 'deepseek', modelId: 'deepseek-v4-pro' }),
    entry('thinking_level_change', 't1', 'm1', 2, { thinkingLevel: 'high' }),
    messageEntry('s1', 't1', 3, { role: 'system', content: '', sections: { preamble: 'you are pi' }, toolsAdded: [] }),
    messageEntry('u1', 's1', 4, { role: 'user', content: [{ type: 'text', text: 'hello pi' }] }),
    messageEntry('a1', 'u1', 10, {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'pondering the request', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'hi there' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/x' } },
      ],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, reasoning: 4, totalTokens: 20, cost: { total: 0 } },
      stopReason: 'toolUse',
    }),
    messageEntry('r1', 'a1', 11, {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'file body' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      isError: false,
    }),
    messageEntry('r2', 'r1', 12, {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'bash',
      content: [{ type: 'text', text: '' }],
      isError: true,
    }),
    messageEntry('a2', 'r2', 13, { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'operation aborted' }),
    entry('session_info', 'i1', 'a2', 14, { name: '  Renamed   pi session  ' }),
    entry('compaction', 'c1', 'i1', 15, { summary: 'earlier work', firstKeptEntryId: 'u1', tokensBefore: 100 }),
    entry('context_edit', 'e1', 'c1', 16, { targetId: 'u1', replacement: null }),
    entry('custom', 'x1', 'e1', 17, { customType: 'web-search-results', data: { id: 'x' } }),
    entry('custom_message', 'cm1', 'x1', 18, { customType: 'ext', content: [{ type: 'text', text: 'injected' }], display: true }),
    entry('usage', 'us1', 'cm1', 19, { kind: 'cache_warm', provider: 'deepseek', model: 'deepseek-v4-pro', usage: { input: 1 } }),
    entry('future_record_type', 'f1', 'us1', 20, { somethingNew: true }),
    messageEntry('u2', 'f1', 21, { role: 'user', content: [{ type: 'text', text: 'second prompt' }] }),
    messageEntry('a3', 'u2', 22, {
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
      api: 'openai-completions',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      stopReason: 'stop',
    }),
    entry('branch_summary', 'b1', 'a3', 23, { fromId: 'a2', summary: 'abandoned branch' }),
  ]
  return records
}

/**
 * Assert one candidate row satisfies the adapter contract.
 * @param {object} candidate candidate row.
 */
function assertCandidateShape(candidate) {
  assert.equal(typeof candidate.key, 'string')
  assert.ok(candidate.key.startsWith('pi:'), `candidate key is prefixed with pi: (${candidate.key})`)
  const decoded = Buffer.from(candidate.key.slice(3), 'base64url').toString('utf8')
  assert.ok(decoded !== '')
  assert.ok(!isAbsolute(decoded))
  assert.ok(!decoded.split('/').includes('..'))
  assert.equal(typeof candidate.foreignId, 'string')
  assert.equal(typeof candidate.title, 'string')
  assert.ok(candidate.cwd === '' || isAbsolute(candidate.cwd), 'cwd is absolute when present')
  assert.ok(Number.isFinite(candidate.createdAt))
  assert.ok(Number.isFinite(candidate.updatedAt))
  assert.ok(Number.isInteger(candidate.messageCount))
  assert.ok(candidate.messageCount >= 0)
  assert.equal(typeof candidate.sourceLabel, 'string')
  assert.ok(candidate.sourceLabel.startsWith('pi · '), `sourceLabel names the harness (${candidate.sourceLabel})`)
  assert.ok(candidate.model === null || typeof candidate.model === 'string')
  assert.ok(candidate.key.length > 3)
}

/**
 * Assert one normalized session satisfies the PLAN §4.4 contract.
 * @param {object} session normalized session.
 * @param {{ requireToolCallMatch?: boolean }} [options] strictness options.
 */
function assertNormalizedSession(session, options) {
  const requireToolCallMatch = options?.requireToolCallMatch !== false
  assert.equal(typeof session.foreignId, 'string')
  assert.equal(typeof session.title, 'string')
  assert.ok(isAbsolute(session.cwd), 'normalized cwd is absolute')
  assert.ok(Number.isFinite(session.createdAt))
  assert.ok(Number.isFinite(session.updatedAt))
  assert.ok(session.provider === null || typeof session.provider === 'string')
  assert.ok(session.model === null || typeof session.model === 'string')
  assert.ok(Array.isArray(session.messages))
  assert.ok(session.messages.length > 0)
  const toolCallIds = new Set()
  for (const message of session.messages) {
    assert.ok(['user', 'assistant', 'tool'].includes(message.role), `known role: ${message.role}`)
    assert.ok(Array.isArray(message.content), 'message content is an array')
    assert.ok(message.content.length > 0, `message ${message.role} has content`)
    if (message.timestamp !== undefined) assert.ok(Number.isFinite(message.timestamp))
    if (message.role === 'tool') {
      assert.equal(typeof message.toolCallId, 'string')
      assert.ok(message.toolCallId !== '')
      assert.equal(typeof message.isError, 'boolean')
    }
    if (message.role === 'assistant' && message.usage !== undefined) {
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
        const value = message.usage[key]
        if (value !== undefined) assert.ok(Number.isInteger(value) && value >= 0, `${key} is a non-negative integer`)
      }
    }
    for (const block of message.content) {
      assert.ok(['text', 'reasoning', 'tool-call'].includes(block.type), `known block type: ${block.type}`)
      if (block.type === 'text' || block.type === 'reasoning') assert.equal(typeof block.text, 'string')
      if (block.type === 'tool-call') {
        assert.equal(typeof block.id, 'string')
        assert.equal(typeof block.name, 'string')
        assert.equal(typeof block.arguments, 'string')
        assert.doesNotThrow(() => JSON.parse(block.arguments), 'tool-call arguments are JSON text')
        toolCallIds.add(block.id)
      }
    }
    if (message.role === 'tool' && requireToolCallMatch) {
      assert.ok(toolCallIds.has(message.toolCallId), `tool result ${message.toolCallId} has a matching call`)
    }
  }
}

test('module exposes the pi adapter contract', () => {
  assert.equal(id, 'pi')
  assert.deepEqual(title, { en: 'Pi', zh: 'Pi' })
  assert.equal(typeof available, 'function')
  assert.equal(typeof listSessions, 'function')
  assert.equal(typeof readSession, 'function')
})

test('available() reports a missing store lazily without walking directories', async (t) => {
  const dir = await tempDir(t)
  const status = await available({ home: dir, env: {}, platform: process.platform })
  assert.equal(status.available, false)
  assert.ok(status.roots.length >= 1)
  assert.ok(status.roots.every((root) => isAbsolute(root)))
  assert.ok(status.roots.some((root) => root === join(dir, '.pi', 'agent', 'sessions')))
})

test('available() resolves PI_CODING_AGENT_DIR and PI_HOME precedence without creating dirs', async (t) => {
  const dir = await tempDir(t)
  const agentDir = join(dir, 'custom-agent')
  const piHome = join(dir, 'custom-pihome')
  const directDir = join(dir, 'direct-sessions')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(join(piHome, 'agent', 'sessions'), { recursive: true })
  await mkdir(directDir, { recursive: true })
  const agentStatus = await available({ home: dir, env: { PI_CODING_AGENT_DIR: agentDir }, platform: process.platform })
  assert.deepEqual(agentStatus.roots, [join(agentDir, 'sessions')])
  const piHomeStatus = await available({ home: dir, env: { PI_HOME: piHome }, platform: process.platform })
  assert.deepEqual(piHomeStatus.roots, [join(piHome, 'agent', 'sessions')])
  const directStatus = await available({
    home: dir,
    env: { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: directDir },
    platform: process.platform,
  })
  assert.deepEqual(directStatus.roots, [directDir], 'the direct session dir override wins')
})

test('synthetic session maps every pi construct to the normalized contract', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  const file = await writeSession(sessionsRoot, `--tmp-pi-adapter-project--/${SESSION_ID}.jsonl`, jsonl(fullFeatureRecords()))
  const ctx = storeContext(sessionsRoot, dir)

  const candidates = await listSessions(ctx)
  assert.equal(candidates.length, 1)
  const [candidate] = candidates
  assertCandidateShape(candidate)
  assert.equal(candidate.foreignId, SESSION_ID)
  assert.equal(candidate.title, 'Renamed pi session')
  assert.equal(candidate.cwd, '/tmp/pi-adapter-project')
  assert.equal(candidate.createdAt, BASE_MS)
  assert.equal(candidate.model, 'deepseek-v4-pro')
  // Every `message` record counts, including the system prompt (pi's own count).
  assert.equal(candidate.messageCount, 8)
  assert.ok(candidate.key.startsWith('pi:'))
  assert.equal(Buffer.from(candidate.key.slice(3), 'base64url').toString('utf8'), `--tmp-pi-adapter-project--/${SESSION_ID}.jsonl`)
  assert.ok(file.endsWith('.jsonl'))

  const session = await readSession(ctx, candidate.key)
  // The fixture deliberately contains one orphan tool result (no matching call):
  // pi can persist those around aborted turns and the adapter must not drop them.
  assertNormalizedSession(session, { requireToolCallMatch: false })
  assert.equal(session.foreignId, SESSION_ID)
  assert.equal(session.title, 'Renamed pi session')
  assert.equal(session.cwd, '/tmp/pi-adapter-project')
  assert.equal(session.createdAt, BASE_MS)
  assert.equal(session.provider, 'deepseek')
  assert.equal(session.model, 'deepseek-v4-pro')
  assert.equal(session.formatVersion, 3)
  assert.ok(session.updatedAt > 0)

  const roles = session.messages.map((message) => message.role)
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'user', 'assistant'])
  assert.equal(session.messages[0].timestamp, BASE_MS + 4)

  const assistant = session.messages[1]
  assert.equal(assistant.model, 'deepseek-v4-pro')
  assert.equal(assistant.provider, 'deepseek')
  assert.deepEqual(assistant.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    totalTokens: 20,
  })
  assert.deepEqual(assistant.content.map((block) => block.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(assistant.content[0].text, 'pondering the request')
  assert.equal(assistant.content[1].text, 'hi there')
  assert.equal(assistant.content[2].id, 'call_1')
  assert.equal(assistant.content[2].name, 'read')
  assert.equal(assistant.content[2].arguments, JSON.stringify({ path: '/tmp/x' }))

  const toolResult = session.messages[2]
  assert.equal(toolResult.toolCallId, 'call_1')
  assert.equal(toolResult.isError, false)
  assert.deepEqual(toolResult.content, [{ type: 'text', text: 'file body' }, { type: 'text', text: '[image]' }])
  const emptyToolResult = session.messages[3]
  assert.equal(emptyToolResult.toolCallId, 'call_2')
  assert.equal(emptyToolResult.isError, true)
  assert.deepEqual(emptyToolResult.content, [{ type: 'text', text: '' }])
  // The aborted (empty) assistant message, system prompt, compaction,
  // context_edit, extension entries and unknown record types are all skipped.
  assert.equal(session.messages[4].content[0].text, 'second prompt')
  assert.equal(session.messages[5].content[0].text, 'final answer')

  const again = await readSession(ctx, candidate.key)
  assert.deepEqual(again, session, 'readSession output is deterministic')
})

test('session name falls back to the first user prompt and v1 files have no ids', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  const v1Records = [
    header({ version: 1 }),
    { type: 'message', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'legacy v1 prompt' }], timestamp: BASE_MS + 1 } },
    {
      type: 'message',
      timestamp: at(2),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'legacy v1 reply' }],
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
        timestamp: BASE_MS + 2,
      },
    },
  ]
  await writeSession(sessionsRoot, `--tmp-pi-adapter-project--/${SESSION_ID}.jsonl`, jsonl(v1Records))
  const ctx = storeContext(sessionsRoot, dir)
  const [candidate] = await listSessions(ctx)
  assert.equal(candidate.title, 'legacy v1 prompt')
  assert.equal(candidate.messageCount, 2)
  const session = await readSession(ctx, candidate.key)
  assert.equal(session.formatVersion, 1)
  assert.equal(session.title, 'legacy v1 prompt')
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(session.model, 'deepseek-flash')
})

test('branched sessions import only the active leaf path', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  const records = [
    header(),
    messageEntry('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'root prompt' }] }),
    messageEntry('a1', 'u1', 2, {
      role: 'assistant',
      content: [{ type: 'text', text: 'root answer' }],
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    }),
    messageEntry('abandoned', 'a1', 3, { role: 'assistant', content: [{ type: 'text', text: 'abandoned answer' }] }),
    messageEntry('u2', 'a1', 4, { role: 'user', content: [{ type: 'text', text: 'active prompt' }] }),
    messageEntry('a2', 'u2', 5, {
      role: 'assistant',
      content: [{ type: 'text', text: 'active answer' }],
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    }),
  ]
  await writeSession(sessionsRoot, `--tmp-pi-adapter-project--/${SESSION_ID}.jsonl`, jsonl(records))
  const ctx = storeContext(sessionsRoot, dir)
  const [candidate] = await listSessions(ctx)
  const session = await readSession(ctx, candidate.key)
  const texts = session.messages.map((message) => message.content[0].text)
  assert.ok(!texts.includes('abandoned answer'), 'abandoned branch entries are not imported')
  assert.deepEqual(texts, ['root prompt', 'root answer', 'active prompt', 'active answer'])
})

test('malformed lines and a truncated tail are tolerated; complete last line without newline is kept', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  const goodUser = JSON.stringify(messageEntry('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'tolerant prompt' }] }))
  const goodAssistant = JSON.stringify(messageEntry('a1', 'u1', 2, {
    role: 'assistant',
    content: [{ type: 'text', text: 'tolerant answer' }],
    provider: 'deepseek',
    model: 'deepseek-flash',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  }))
  const truncated = '{"type":"message","id":"truncated","parentId":"a1","timestamp":"2026-01-02T03:04:'
  const corrupt = `${jsonl([header()])}this line is not JSON\n${goodUser}\n${goodAssistant}\n${truncated}`
  await writeSession(sessionsRoot, 'broken/session.jsonl', corrupt)
  const ctx = storeContext(sessionsRoot, dir)

  const [candidate] = await listSessions(ctx)
  assert.ok(candidate !== undefined, 'corrupt session is still listed')
  assert.equal(candidate.messageCount, 2, 'only complete message lines count')
  const session = await readSession(ctx, candidate.key)
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(session.messages[1].content[0].text, 'tolerant answer')

  // A complete final record that merely lacks its trailing newline is salvaged.
  const noTrailingNewline = jsonl(
    [header({ id: '019f0000-0000-7000-8000-000000000002' }), messageEntry('u9', null, 1, { role: 'user', content: [{ type: 'text', text: 'no newline' }] })],
    { trailingNewline: false },
  )
  await writeSession(sessionsRoot, 'broken/second.jsonl', noTrailingNewline)
  const candidates = await listSessions(ctx)
  assert.equal(candidates.length, 2)
  const second = candidates.find((row) => row.foreignId.endsWith('0002'))
  assert.equal(second.messageCount, 1)
  const secondSession = await readSession(ctx, second.key)
  assert.equal(secondSession.messages.length, 1)
})

test('files without a valid session header are not listed', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  await writeSession(sessionsRoot, 'junk/not-a-session.jsonl', jsonl([{ type: 'message', message: { role: 'user', content: [] } }]))
  await writeSession(sessionsRoot, 'junk/empty.jsonl', '')
  const ctx = storeContext(sessionsRoot, dir)
  assert.deepEqual(await listSessions(ctx), [])
})

test('readSession rejects malformed or escaping candidate keys', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const ctx = storeContext(sessionsRoot, dir)
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64url')
  await assert.rejects(readSession(ctx, `pi:${encode('../escape.jsonl')}`), /invalid pi session key path/u)
  await assert.rejects(readSession(ctx, `pi:${encode('/etc/passwd')}`), /invalid pi session key path/u)
  await assert.rejects(readSession(ctx, `pi:${encode('a/../../b.jsonl')}`), /invalid pi session key path/u)
  await assert.rejects(readSession(ctx, `pi:${encode('')}`), /invalid pi session key encoding/u)
  await assert.rejects(readSession(ctx, 'claude-code:abc'), /invalid pi session key/u)
  await assert.rejects(readSession(ctx, 'pi:not base64!'), /invalid pi session key encoding/u)
  await assert.rejects(readSession(ctx, `pi:${encode('missing/session.jsonl')}`), /pi session file not found/u)
})

test('listSessions is resilient per file and safe to call concurrently', async (t) => {
  const dir = await tempDir(t)
  const sessionsRoot = join(dir, 'sessions')
  await writeSession(sessionsRoot, '--tmp-pi-adapter-project--/good.jsonl', jsonl([
    header(),
    messageEntry('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'concurrent prompt' }] }),
  ]))
  await writeSession(sessionsRoot, 'junk/bad.jsonl', 'not jsonl at all\n')
  const ctx = storeContext(sessionsRoot, dir)
  const [first, second] = await Promise.all([listSessions(ctx), listSessions(ctx)])
  assert.equal(first.length, 1)
  assert.deepEqual(first.map((row) => row.key), second.map((row) => row.key))
})

test('available()/listSessions()/readSession() handle a missing store without throwing', async (t) => {
  const dir = await tempDir(t)
  const ctx = { home: dir, env: {}, platform: process.platform }
  assert.equal((await available(ctx)).available, false)
  assert.deepEqual(await listSessions(ctx), [])
  await assert.rejects(readSession(ctx, `pi:${Buffer.from('x.jsonl').toString('base64url')}`), /pi session store not found/u)
})

test('real pi sessions on this machine all list and read into the contract', async (t) => {
  const status = await available(REAL_CTX)
  if (!status.available) {
    t.skip('no pi session store on this machine')
    return
  }
  const startedAt = performance.now()
  const candidates = await listSessions(REAL_CTX)
  const listMs = performance.now() - startedAt
  assert.ok(candidates.length >= 1, 'at least one real session is listed')
  assert.ok(listMs < 2000, `listSessions stays cheap (${listMs.toFixed(0)}ms)`)
  const keys = new Set()
  for (const candidate of candidates) {
    assertCandidateShape(candidate)
    assert.ok(!keys.has(candidate.key), 'candidate keys are unique')
    keys.add(candidate.key)
  }
  for (const candidate of candidates) {
    const session = await readSession(REAL_CTX, candidate.key)
    assertNormalizedSession(session)
    assert.equal(session.foreignId, candidate.foreignId)
    assert.equal(session.cwd, candidate.cwd)
    assert.equal(session.createdAt, candidate.createdAt)
    assert.ok(session.messages.length >= 1)
    assert.ok(session.messages.some((message) => message.role === 'user'), 'transcript starts from a user-visible message')
    if (candidate.title !== '') {
      // The list pass scans metadata cheaply; the full read is authoritative but
      // for ordinary sessions both must agree.
      assert.equal(session.title, candidate.title, `title agrees for ${candidate.key}`)
    }
  }
})
