/**
 * Tests for the VS Code Copilot chat adapter.
 *
 * Two layers, mirroring the pi adapter suite:
 * - synthetic session stores under a temp directory pin the operation-log
 *   replay, the workspace mapping, the transcript mapping, and every defensive
 *   path (malformed lines, truncated tails, forged keys, legacy JSON files);
 * - the machine's real VS Code store, when present, is listed and read end to
 *   end so the adapter is verified against the sessions the feature must import.
 *
 * Run with: `node --test dsh-session-adopt/import/adapters/copilot.test.mjs`
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { available, id, listSessions, readSession, replayOperationLog, title, userDataDirs } from './copilot.js'

/** Base timestamp used by synthetic fixtures. */
const BASE_MS = Date.UTC(2026, 2, 4, 5, 6, 7)

/** Session id used by the synthetic fixtures. */
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

/** Workspace hash directory name used by the synthetic fixtures. */
const WORKSPACE_HASH = 'abc123def456'

/**
 * Resolve the adapter context for one synthetic user-data directory.
 * @param {string} dir synthetic user-data directory.
 * @returns {{ home: string, env: object, platform: string }} adapter context.
 */
function contextFor(dir) {
  return { home: dir, env: { COPILOT_USER_DATA_DIR: dir }, platform: process.platform }
}

/**
 * Create a temp user-data directory that the test cleans up.
 * @param {import('node:test').TestContext} t test context.
 * @returns {Promise<string>} absolute temp directory.
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-adapter-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Create one workspace storage directory with its `chatSessions` folder.
 * @param {string} userData synthetic user-data directory.
 * @param {string} hash workspace hash directory name.
 * @param {string} folder working directory to record, or '' for none.
 * @returns {Promise<string>} absolute `chatSessions` directory.
 */
async function workspaceStore(userData, hash = WORKSPACE_HASH, folder = '') {
  const storageDir = join(userData, 'User', 'workspaceStorage', hash)
  const sessionsDir = join(storageDir, 'chatSessions')
  await mkdir(sessionsDir, { recursive: true })
  if (folder !== '') {
    await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }))
  }
  return sessionsDir
}

/**
 * Build one serialized chat response part for a markdown fragment.
 * @param {string} value markdown text.
 * @returns {object} serialized markdown part.
 */
function markdown(value) {
  return { value, supportThemeIcons: false, supportHtml: false, uris: {} }
}

/**
 * Build one serialized tool invocation part.
 * @param {{ callId: string, toolId: string, output?: string, isError?: boolean, terminal?: string }} options part options.
 * @returns {object} serialized tool invocation.
 */
function toolPart(options) {
  const part = {
    kind: 'toolInvocationSerialized',
    invocationMessage: markdown(`Running ${options.toolId}`),
    pastTenseMessage: markdown(`Ran ${options.toolId}`),
    isComplete: true,
    source: { type: 'internal', label: 'Built-In' },
    toolCallId: options.callId,
    toolId: options.toolId,
  }
  if (options.output !== undefined) {
    part.resultDetails = { input: 'input-value', output: [{ type: 'embed', isText: true, value: options.output }], isError: options.isError === true }
  }
  if (options.terminal !== undefined) {
    part.toolSpecificData = { kind: 'terminal', terminalCommandOutput: { text: options.terminal, lineCount: 2 } }
  }
  return part
}

/**
 * Build the session document the fixture log snapshots.
 * @param {object} [overrides] document overrides.
 * @returns {object} v3 chat session document.
 */
function sessionDocument(overrides = {}) {
  return {
    version: 3,
    creationDate: BASE_MS,
    responderUsername: 'GitHub Copilot',
    sessionId: SESSION_ID,
    hasPendingEdits: false,
    inputState: { selectedModel: { identifier: 'copilot/gpt-4.1' }, inputText: '' },
    requests: [],
    ...overrides,
  }
}

/**
 * Write one append-only operation log.
 * @param {string} sessionsDir target `chatSessions` directory.
 * @param {string} name file name.
 * @param {object[]} entries log entries in order.
 * @returns {Promise<string>} absolute file path.
 */
async function writeLog(sessionsDir, name, entries) {
  const file = join(sessionsDir, name)
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return file
}

/**
 * The request fixture used by most tests: prose, reasoning, a tool call, more prose.
 * @param {object} [overrides] request overrides.
 * @returns {object} serialized chat request.
 */
function request(overrides = {}) {
  return {
    requestId: 'request_1',
    timestamp: BASE_MS + 1000,
    modelId: 'copilot/gpt-4.1',
    message: { text: '请读取配置并解释', parts: [{ kind: 'text', text: '请读取配置并解释' }] },
    response: [
      markdown('我将先读取'),
      markdown('配置文件。'),
      { kind: 'thinking', value: [markdown('用户想要配置解释。')], id: 'thinking-1' },
      toolPart({ callId: 'call_1', toolId: 'copilot_readFile', output: '{"a":1}' }),
      markdown('配置只有一个键。'),
    ],
    result: { timings: { totalElapsed: 1200 } },
    ...overrides,
  }
}

test('module exposes the VS Code Copilot adapter contract', () => {
  assert.equal(id, 'copilot')
  assert.deepEqual(title, { en: 'VS Code Copilot', zh: 'VS Code Copilot' })
  assert.equal(typeof available, 'function')
  assert.equal(typeof listSessions, 'function')
  assert.equal(typeof readSession, 'function')
})

test('available() reports whether any VS Code store exists', async (t) => {
  const userData = await tempDir(t)
  assert.equal((await available(contextFor(userData))).available, false)
  const sessionsDir = await workspaceStore(userData)
  const status = await available(contextFor(userData))
  assert.equal(status.available, true)
  assert.deepEqual(status.roots, [join(userData, 'User', 'workspaceStorage')])
  assert.ok(sessionsDir.startsWith(userData))
})

test('available() resolves the per-platform user-data directory without an override', () => {
  const home = join(tmpdir(), 'fake-home')
  const windows = userDataDirs({ home, env: { APPDATA: join(home, 'Roaming') }, platform: 'win32' })
  assert.ok(windows.includes(join(home, 'Roaming', 'Code')))
  assert.ok(windows.includes(join(home, 'Roaming', 'Code - Insiders')))
  const mac = userDataDirs({ home, env: {}, platform: 'darwin' })
  assert.ok(mac.includes(join(home, 'Library', 'Application Support', 'Code')))
  const linux = userDataDirs({ home, env: { XDG_CONFIG_HOME: join(home, 'cfg') }, platform: 'linux' })
  assert.ok(linux.includes(join(home, 'cfg', 'Code')))
  assert.ok(linux.includes(join(home, 'cfg', 'VSCodium')))
})

test('replayOperationLog applies snapshot, set, push, splice and delete entries', () => {
  const document = replayOperationLog([
    JSON.stringify({ kind: 0, v: sessionDocument({ requests: [request({ requestId: 'request_1' })] }) }),
    JSON.stringify({ kind: 1, k: ['customTitle'], v: '自定义标题' }),
    JSON.stringify({ kind: 2, k: ['requests'], v: [request({ requestId: 'request_2' })] }),
    JSON.stringify({ kind: 2, k: ['requests'], i: 1, v: [request({ requestId: 'request_9' })] }),
    JSON.stringify({ kind: 1, k: ['responderUsername'], v: 'Copilot' }),
    JSON.stringify({ kind: 3, k: ['hasPendingEdits'] }),
    '',
  ].join('\n'))
  assert.equal(document.customTitle, '自定义标题')
  assert.equal(document.responderUsername, 'Copilot')
  assert.equal(document.hasPendingEdits, undefined)
  assert.deepEqual(document.requests.map((item) => item.requestId), ['request_1', 'request_9'])
})

test('replayOperationLog ignores malformed and truncated trailing lines', () => {
  const document = replayOperationLog([
    JSON.stringify({ kind: 0, v: sessionDocument() }),
    'not json at all',
    JSON.stringify({ kind: 1, k: ['customTitle'], v: '标题' }),
    '{"kind":1,"k":["customTitle"],"v":"trunc',
  ].join('\n'))
  assert.equal(document.customTitle, '标题')
  assert.throws(() => replayOperationLog('{"kind":1,"k":["a"],"v":1}'), /no snapshot entry/)
})

test('listSessions maps workspace.json to a working directory and reads both formats', async (t) => {
  const userData = await tempDir(t)
  const project = join(userData, 'project')
  await mkdir(project, { recursive: true })
  const sessionsDir = await workspaceStore(userData, WORKSPACE_HASH, project)
  await writeLog(sessionsDir, 'a.jsonl', [
    { kind: 0, v: sessionDocument({ requests: [request()] }) },
    { kind: 1, k: ['customTitle'], v: '会话标题' },
  ])
  await writeFile(join(sessionsDir, 'b.json'), JSON.stringify(sessionDocument({ sessionId: 'legacy-id', requests: [request({ requestId: 'request_legacy' })] })))
  // Unrelated files in the same directory must never be listed.
  await writeFile(join(sessionsDir, 'state.jsonl.part-bak'), '{"kind":0,"v":{}}')
  await writeFile(join(sessionsDir, 'notes.txt'), 'hello')
  const emptyWindow = join(userData, 'User', 'globalStorage', 'emptyWindowChatSessions')
  await mkdir(emptyWindow, { recursive: true })
  await writeFile(join(emptyWindow, 'e.jsonl'), `${JSON.stringify({ kind: 0, v: sessionDocument({ sessionId: 'empty-id' }) })}\n`)
  await writeFile(join(emptyWindow, 'e2.jsonl'), `${JSON.stringify({
    kind: 0,
    v: sessionDocument({ sessionId: 'folderless-id', requests: [request({ requestId: 'request_folderless' })] }),
  })}\n`)

  const candidates = await listSessions(contextFor(userData))
  assert.equal(candidates.length, 3)
  const byId = new Map(candidates.map((candidate) => [candidate.foreignId, candidate]))
  const modern = byId.get(SESSION_ID)
  assert.equal(modern.title, '会话标题')
  assert.equal(modern.cwd, project)
  assert.equal(modern.messageCount, 1)
  assert.equal(modern.model, 'copilot/gpt-4.1')
  assert.ok(modern.key.startsWith('copilot:'))
  assert.ok(modern.sourceLabel.startsWith('copilot · '))
  assert.equal(modern.createdAt, BASE_MS)
  assert.ok(modern.updatedAt > 0)
  assert.equal(byId.get('legacy-id').cwd, project)
  // A folder-less window's session is listed with no cwd (and is therefore not
  // importable), but an empty chat shell is not listed at all.
  assert.equal(byId.get('folderless-id').cwd, '')
  assert.equal(byId.has('empty-id'), false)
})

test('listSessions omits empty chat shells created without any request', async (t) => {
  const userData = await tempDir(t)
  const project = join(userData, 'project')
  await mkdir(project, { recursive: true })
  const sessionsDir = await workspaceStore(userData, WORKSPACE_HASH, project)
  await writeLog(sessionsDir, 'empty.jsonl', [{ kind: 0, v: sessionDocument({ sessionId: 'empty-id' }) }])
  await writeFile(join(sessionsDir, 'empty.json'), JSON.stringify(sessionDocument({ sessionId: 'empty-legacy' })))
  await writeLog(sessionsDir, 'real.jsonl', [{ kind: 0, v: sessionDocument({ requests: [request()] }) }])
  const candidates = await listSessions(contextFor(userData))
  assert.deepEqual(candidates.map((candidate) => candidate.foreignId), [SESSION_ID])
})

test('listSessions survives unreadable and non-session files', async (t) => {
  const userData = await tempDir(t)
  const sessionsDir = await workspaceStore(userData)
  await writeFile(join(sessionsDir, 'broken.json'), '{ not json')
  await writeFile(join(sessionsDir, 'array.json'), '[]')
  await writeLog(sessionsDir, 'ok.jsonl', [{ kind: 0, v: sessionDocument({ requests: [request()] }) }])
  const candidates = await listSessions(contextFor(userData))
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].foreignId, SESSION_ID)
})

test('readSession normalizes prose, reasoning, tool calls and results', async (t) => {
  const userData = await tempDir(t)
  const project = join(userData, 'project')
  await mkdir(project, { recursive: true })
  const sessionsDir = await workspaceStore(userData, WORKSPACE_HASH, project)
  await writeLog(sessionsDir, 'session.jsonl', [
    { kind: 0, v: sessionDocument({ requests: [request()] }) },
    { kind: 1, k: ['customTitle'], v: '配置解释' },
  ])
  const [candidate] = await listSessions(contextFor(userData))
  const session = await readSession(contextFor(userData), candidate.key)
  assert.equal(session.foreignId, SESSION_ID)
  assert.equal(session.title, '配置解释')
  assert.equal(session.cwd, project)
  assert.equal(session.createdAt, BASE_MS)
  assert.equal(session.formatVersion, 3)
  assert.equal(session.provider, 'copilot')
  assert.equal(session.model, 'copilot/gpt-4.1')

  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant'])
  const [prompt, firstProse, result, lastProse] = session.messages
  assert.equal(prompt.content[0].text, '请读取配置并解释')
  assert.equal(prompt.timestamp, BASE_MS + 1000)
  // Streamed markdown fragments merge into one text block.
  assert.deepEqual(firstProse.content, [
    { type: 'text', text: '我将先读取配置文件。' },
    { type: 'reasoning', text: '用户想要配置解释。' },
    { type: 'tool-call', id: 'call_1', name: 'copilot_readFile', arguments: '{"input":"input-value"}' },
  ])
  assert.equal(result.toolCallId, 'call_1')
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, '{"a":1}')
  assert.deepEqual(lastProse.content, [{ type: 'text', text: '配置只有一个键。' }])
})

test('readSession falls back to terminal output, summaries and error flags', async (t) => {
  const userData = await tempDir(t)
  const sessionsDir = await workspaceStore(userData)
  await writeLog(sessionsDir, 'terminal.jsonl', [{
    kind: 0,
    v: sessionDocument({
      requests: [request({
        requestId: 'request_terminal',
        message: { text: 'run it' },
        response: [
          toolPart({ callId: 'call_term', toolId: 'run_in_terminal', terminal: '\u001b[32mok\u001b[0m\r\ndone' }),
          toolPart({ callId: 'call_fail', toolId: 'copilot_readFile' }),
          toolPart({ callId: 'call_error', toolId: 'copilot_readFile', output: 'boom', isError: true }),
        ],
      })],
    }),
  }])
  const [candidate] = await listSessions(contextFor(userData))
  const session = await readSession(contextFor(userData), candidate.key)
  const results = session.messages.filter((message) => message.role === 'tool')
  assert.equal(results.length, 3)
  assert.equal(results[0].content[0].text, 'ok\r\ndone')
  assert.equal(results[1].content[0].text, 'Ran copilot_readFile')
  assert.equal(results[1].isError, false)
  assert.equal(results[2].isError, true)
  assert.equal(results[2].content[0].text, 'boom')
})

test('readSession drops progress parts and keeps question carousels as text', async (t) => {
  const userData = await tempDir(t)
  const sessionsDir = await workspaceStore(userData)
  await writeLog(sessionsDir, 'progress.jsonl', [{
    kind: 0,
    v: sessionDocument({
      requests: [request({
        response: [
          { kind: 'progressTaskSerialized', content: { value: 'collecting' }, progress: [] },
          markdown('答案如下。'),
          { kind: 'codeblockUri', uri: { path: '/tmp/x' } },
          { kind: 'undoStop', id: 'stop-1' },
          { kind: 'mcpServersStarting', didStartServerIds: [] },
          { kind: 'questionCarousel', questions: [{ title: '选择方案', message: '要 A 还是 B？' }] },
          markdown('继续。'),
        ],
      })],
    }),
  }])
  const [candidate] = await listSessions(contextFor(userData))
  const session = await readSession(contextFor(userData), candidate.key)
  const assistant = session.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.content.length, 1)
  const text = assistant.content[0].text
  assert.ok(text.startsWith('答案如下。'))
  assert.ok(text.includes('[question] 选择方案\n要 A 还是 B？'))
  assert.ok(text.endsWith('继续。'))
})

test('readSession reads legacy JSON sessions without an operation log', async (t) => {
  const userData = await tempDir(t)
  const project = join(userData, 'project')
  await mkdir(project, { recursive: true })
  const sessionsDir = await workspaceStore(userData, WORKSPACE_HASH, project)
  await writeFile(join(sessionsDir, 'legacy.json'), JSON.stringify(sessionDocument({ requests: [request()] })))
  const [candidate] = await listSessions(contextFor(userData))
  const session = await readSession(contextFor(userData), candidate.key)
  assert.equal(session.messages.length, 4)
  // No custom title: the first prompt names the session.
  assert.equal(session.title, '请读取配置并解释')
  assert.equal(session.cwd, project)
})

test('readSession falls back to the first prompt for the title and skips hidden requests', async (t) => {
  const userData = await tempDir(t)
  const sessionsDir = await workspaceStore(userData)
  await writeLog(sessionsDir, 'hidden.jsonl', [{
    kind: 0,
    v: sessionDocument({
      requests: [
        request({ requestId: 'request_hidden', message: { text: 'hidden prompt' }, hiddenFromTranscript: true }),
        request({ requestId: 'request_visible', message: { text: '可见的问题' } }),
      ],
    }),
  }])
  const [candidate] = await listSessions(contextFor(userData))
  const session = await readSession(contextFor(userData), candidate.key)
  assert.equal(session.title, '可见的问题')
  assert.ok(!session.messages.some((message) => message.content?.[0]?.text === 'hidden prompt'))
})

test('readSession rejects forged, foreign and escaping keys', async (t) => {
  const userData = await tempDir(t)
  const sessionsDir = await workspaceStore(userData)
  const file = await writeLog(sessionsDir, 'session.jsonl', [{ kind: 0, v: sessionDocument() }])
  const ctx = contextFor(userData)
  await assert.rejects(() => readSession(ctx, 'pi:abc'), /invalid VS Code Copilot session key/)
  await assert.rejects(() => readSession(ctx, 'copilot:'), /invalid VS Code Copilot session key encoding/)
  await assert.rejects(() => readSession(ctx, 'copilot:!!!'), /invalid VS Code Copilot session key encoding/)
  // A syntactically valid key that names a file outside every store is refused.
  const outside = Buffer.from(join(userData, 'evil.json'), 'utf8').toString('base64url')
  await assert.rejects(() => readSession(ctx, `copilot:${outside}`), /outside every known store/)
  // A non-session suffix is refused before the filesystem is touched.
  const wrongSuffix = Buffer.from(`${file}.part-bak`, 'utf8').toString('base64url')
  await assert.rejects(() => readSession(ctx, `copilot:${wrongSuffix}`), /invalid VS Code Copilot session key path/)
})

test('readSession rejects a file removed after the scan', async (t) => {
  const userData = await tempDir(t)
  const sessionsDir = await workspaceStore(userData)
  const file = await writeLog(sessionsDir, 'gone.jsonl', [{ kind: 0, v: sessionDocument({ requests: [request()] }) }])
  const [candidate] = await listSessions(contextFor(userData))
  assert.ok(file.endsWith('gone.jsonl'))
  await rm(file)
  await assert.rejects(() => readSession(contextFor(userData), candidate.key), /not found/)
})

test('available()/listSessions()/readSession() handle a missing store without throwing', async (t) => {
  const userData = await tempDir(t)
  const ctx = contextFor(userData)
  assert.deepEqual(await available(ctx), { available: false, roots: [] })
  assert.deepEqual(await listSessions(ctx), [])
  const key = `copilot:${Buffer.from(join(userData, 'nope.json'), 'utf8').toString('base64url')}`
  await assert.rejects(() => readSession(ctx, key), /outside every known store/)
})

test('real VS Code Copilot sessions on this machine all list and read', async (t) => {
  const ctx = { home: homedir(), env: {}, platform: process.platform }
  const status = await available(ctx)
  if (!status.available) {
    t.skip('no VS Code Copilot store on this machine')
    return
  }
  const candidates = await listSessions(ctx)
  assert.ok(candidates.length > 0)
  for (const candidate of candidates) {
    assert.ok(candidate.key.startsWith('copilot:'))
    assert.equal(typeof candidate.foreignId, 'string')
    assert.equal(typeof candidate.title, 'string')
    assert.ok(candidate.cwd === '' || candidate.cwd.includes(process.platform === 'win32' ? '\\' : '/'))
    assert.ok(Number.isInteger(candidate.messageCount) && candidate.messageCount >= 0)
  }
  const importable = candidates.filter((candidate) => candidate.cwd !== '')
  assert.ok(importable.length > 0, 'at least one session resolves to a workspace folder')
  const sample = importable.find((candidate) => candidate.messageCount > 0) ?? importable[0]
  const session = await readSession(ctx, sample.key)
  assert.ok(Array.isArray(session.messages) && session.messages.length > 0)
  assert.equal(typeof session.cwd, 'string')
  assert.ok(session.cwd !== '')
  for (const message of session.messages) {
    assert.ok(['user', 'assistant', 'tool'].includes(message.role))
    assert.ok(Array.isArray(message.content) && message.content.length > 0)
    if (message.role === 'tool') assert.equal(typeof message.toolCallId, 'string')
  }
})
