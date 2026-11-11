/**
 * Self-contained tests for the deterministic id and event-synthesis modules.
 *
 * They deliberately do not import the harness packages: the plugin ships with
 * no dependencies, so the repository test suite pins the invariants this
 * plugin is responsible for (contiguous seq, surface markers, ordering) while
 * the live harness remains the authoritative validator for the whole log.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { importedSessionId, isImportedSessionId } from '../import/ids.js'
import { buildSessionArtifact, ImportBuildError, SESSION_FORMAT_VERSION } from '../import/events.js'

const NOW = 1790000000000

/**
 * Build a normalized transcript fixture.
 * @param {object[]} messages message overrides.
 * @returns {object} normalized session.
 */
function fixture(messages) {
  return {
    harness: 'pi',
    foreignId: 'foreign-1',
    title: 'Example session',
    cwd: '/example/project',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    provider: 'deepseek',
    model: 'deepseek-flash',
    messages,
  }
}

/**
 * Assert the invariants every generated log must keep.
 * @param {object} artifact build result.
 */
function assertArtifactInvariants(artifact) {
  assert.equal(artifact.header.version, SESSION_FORMAT_VERSION)
  assert.equal(artifact.header.isSeeded, false)
  assert.equal(typeof artifact.header.createdAt, 'number')
  const firstSurface = artifact.events.find((event) => event.type.endsWith('/message') || event.type === 'tool/result')
  assert.equal(firstSurface?.type, 'system/message', 'surface node 0 must be the protected system head')
  artifact.events.forEach((event, index) => {
    assert.equal(event.seq, index, `seq must equal index at ${index}`)
    assert.equal(typeof event.type, 'string')
    assert.ok(Number.isSafeInteger(event.time) && event.time >= 0, `time must be integral at ${index}`)
    if (index > 0) assert.ok(event.time >= artifact.events[index - 1].time, `time must not go backwards at ${index}`)
    const surface = event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message' || event.type === 'developer/message'
    if (surface) assert.equal(event.surfaceOp, 'append', `surface event at ${index} needs surfaceOp append`)
    else assert.equal(event.surfaceOp, undefined, `log-only event at ${index} cannot carry surfaceOp`)
    if (event.sourceEventSeqs !== undefined) {
      assert.ok(event.sourceEventSeqs.length > 0)
      for (const seq of event.sourceEventSeqs) assert.ok(seq < event.seq, 'sourceEventSeqs must reference earlier events')
    }
  })
  const turns = artifact.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  assert.deepEqual(turns, turns.map((_, index) => index + 1), 'turn numbers must be 1..n')
  assert.equal(artifact.events.filter((event) => event.type === 'turn/end').length, turns.length, 'every turn must end')
  assert.equal(
    artifact.events.filter((event) => event.type === 'tool/call').length,
    artifact.events.filter((event) => event.type === 'tool/result').length,
    'every advertised tool call must settle',
  )
}

test('importedSessionId is deterministic, harness-scoped, and session-prefixed', () => {
  const first = importedSessionId('pi', 'abc', 'pi:key')
  const second = importedSessionId('pi', 'abc', 'pi:key')
  assert.equal(first, second)
  assert.ok(isImportedSessionId(first))
  assert.notEqual(first, importedSessionId('claude-code', 'abc', 'claude-code:key'))
  assert.notEqual(first, importedSessionId('pi', 'other', 'pi:key'))
  // No foreign id falls back to the adapter key identity.
  assert.notEqual(importedSessionId('pi', undefined, 'pi:a'), importedSessionId('pi', undefined, 'pi:b'))
})

test('builds a two-turn log with tool calls, results, and a title', () => {
  const artifact = buildSessionArtifact(fixture([
    { role: 'user', content: [{ type: 'text', text: 'Hello there' }], timestamp: NOW - 60_000 },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Thinking' },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
      timestamp: NOW - 50_000,
      usage: { input: 10, output: 5, totalTokens: 15 },
    },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file.txt' }], timestamp: NOW - 40_000 },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], timestamp: NOW - 30_000 },
    { role: 'user', content: [{ type: 'text', text: 'Again' }], timestamp: NOW - 20_000 },
    { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }], timestamp: NOW - 10_000 },
  ]), { id: importedSessionId('pi', 'foreign-1', 'pi:key'), now: NOW })

  assertArtifactInvariants(artifact)
  assert.equal(artifact.stats.turns, 2)
  assert.equal(artifact.stats.toolCalls, 1)
  assert.equal(artifact.stats.messageCount, 6)

  assert.equal(artifact.header.createdAt, NOW, 'recency uses import time')
  const types = artifact.events.map((event) => event.type)
  assert.deepEqual(types.slice(0, 8), [
    'turn/start', 'step/start', 'system/message', 'user/message',
    'assistant/message', 'tool/call', 'tool/result', 'step/end',
  ])
  assert.equal(types.at(-1), 'session/title')
  const title = artifact.events.at(-1)
  assert.equal(title.data.title, 'Example session')
  assert.equal(title.data.source.kind, 'fallback')
  const firstUser = artifact.events.find((event) => event.type === 'user/message')
  assert.deepEqual(title.data.messageSeqs, [firstUser.seq])
  assert.notEqual(title.data.messageSeqs[0], 0, 'title must cite the user message, not the system head')

  const assistant = artifact.events.find((event) => event.type === 'assistant/message')
  assert.deepEqual(assistant.data.message.content.map((block) => block.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(assistant.data.message.source.kind, 'model')
  assert.equal(assistant.data.message.source.provider, 'deepseek')
  assert.deepEqual(assistant.data.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  assert.deepEqual(assistant.data.stream, [])

  const toolResult = artifact.events.find((event) => event.type === 'tool/result')
  const toolCall = artifact.events.find((event) => event.type === 'tool/call')
  assert.deepEqual(toolResult.sourceEventSeqs, [toolCall.seq])
  assert.equal(toolResult.data.message.toolCallId, 'call-1')
  assert.equal(toolResult.data.message.source.callId, 'call-1')
  assert.equal(toolResult.data.message.isError, false)
})

test('derives a fallback title from the first user prompt and drops empty titles', () => {
  const noTitle = buildSessionArtifact({
    ...fixture([{ role: 'user', content: [{ type: 'text', text: '  Hello\nworld  ' }] }]),
    title: '',
  }, { id: importedSessionId('pi', 'x', 'pi:x'), now: NOW })
  const titleEvents = noTitle.events.filter((event) => event.type === 'session/title')
  assert.equal(titleEvents.length, 1)
  assert.equal(titleEvents[0].data.title, 'Hello world')

  const blank = buildSessionArtifact({
    ...fixture([{ role: 'user', content: [{ type: 'text', text: '   ' }] }]),
    title: '',
    harness: undefined,
  }, { id: importedSessionId('pi', 'x', 'pi:x'), now: NOW })
  assert.equal(blank.events.filter((event) => event.type === 'session/title').length, 1, 'harness fallback title still lands')
})

test('unknown blocks degrade to text and never fail the import', () => {
  const artifact = buildSessionArtifact(fixture([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }, { type: 'weird' }] },
    { role: 'assistant', content: [{ type: 'unknown-block' }] },
  ]), { id: importedSessionId('pi', 'y', 'pi:y'), now: NOW })
  assertArtifactInvariants(artifact)
  const user = artifact.events.find((event) => event.type === 'user/message')
  assert.deepEqual(user.data.content.map((block) => block.type), ['text', 'image'])
  const assistant = artifact.events.find((event) => event.type === 'assistant/message')
  assert.deepEqual(assistant.data.message.content, [{ type: 'text', text: '[assistant message without supported content]' }])
})

test('rejects unusable transcripts with stable codes', () => {
  assert.throws(
    () => buildSessionArtifact(fixture([]), { id: importedSessionId('pi', 'z', 'pi:z'), now: NOW }),
    (error) => error instanceof ImportBuildError && error.code === 'empty-session',
  )
  assert.throws(
    () => buildSessionArtifact({ ...fixture([{ role: 'user', content: [] }]), cwd: 'relative/path' }, { id: 'session-x', now: NOW }),
    (error) => error instanceof ImportBuildError && error.code === 'missing-cwd',
  )
  assert.throws(
    () => buildSessionArtifact(
      fixture(Array.from({ length: 5 }, () => ({ role: 'user', content: [{ type: 'text', text: 'hi' }] }))),
      { id: 'session-x', now: NOW, maxMessages: 2 },
    ),
    (error) => error instanceof ImportBuildError && error.code === 'too-large',
  )
})

test('unsettled tool calls are repaired with a synthetic error result before step/end', () => {
  const artifact = buildSessionArtifact(fixture([
    { role: 'user', content: [{ type: 'text', text: 'search something' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Searching.' },
        { type: 'tool-call', id: 'call-lost', name: 'web_search', arguments: '{"q":"x"}' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ]), { id: importedSessionId('pi', 'lost', 'pi:lost'), now: NOW })
  assertArtifactInvariants(artifact)
  const result = artifact.events.find((event) => event.type === 'tool/result')
  assert.equal(result.data.message.toolCallId, 'call-lost')
  assert.equal(result.data.message.isError, true)
  assert.equal(result.data.error.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(result.surfaceOp, 'append')
  const callSeq = artifact.events.find((event) => event.type === 'tool/call').seq
  assert.deepEqual(result.sourceEventSeqs, [callSeq])
  // The repair must directly precede its step/end so the step never closes on an open call.
  const next = artifact.events[result.seq + 1]
  assert.equal(next.type, 'step/end')
})

test('orphan tool results are counted and skipped instead of breaking the log', () => {
  const artifact = buildSessionArtifact(fixture([
    { role: 'tool', toolCallId: 'missing', content: [{ type: 'text', text: 'stray' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ]), { id: importedSessionId('pi', 'w', 'pi:w'), now: NOW })
  assertArtifactInvariants(artifact)
  assert.equal(artifact.stats.skippedToolResults, 1)
  assert.equal(artifact.events.filter((event) => event.type === 'tool/result').length, 0)
})
