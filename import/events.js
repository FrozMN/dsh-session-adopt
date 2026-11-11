/**
 * Build a native DSH v4 session artifact from a normalized foreign transcript.
 *
 * The persistence backend stores an event-sourced log, and the client derives
 * both the model history and the rendered transcript from surface events. The
 * importer therefore cannot write a "conversation file" directly: it must
 * synthesize a log the installed Session implementation accepts. This module
 * owns that synthesis and nothing else — it never touches the filesystem.
 *
 * Shape of the produced log (one turn per user message, one step per assistant
 * response, tool calls/results attached to the step that produced them):
 *
 *   turn/start t
 *   step/start (t, 1)
 *   user/message                      surfaceOp: append
 *   step/end   (t, 1)                 (when the turn closes)
 *   turn/end   t, reason {kind:completed}
 *
 *   assistant response:
 *   step/start (t, s)
 *   assistant/message                 surfaceOp: append
 *   tool/call (log-only)              one per tool call
 *   tool/result                       surfaceOp: append, sourceEventSeqs [tool/call seq]
 *   step/end   (t, s)
 *
 * A session title event is appended last when a title can be derived.
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** Format version this build writes; matches `SESSION_FORMAT_VERSION` in the harness. */
export const SESSION_FORMAT_VERSION = 4

/** Upper bound on the derived fallback title length, in Unicode code points. */
const MAX_TITLE_CODE_POINTS = 60

/** Default ceiling on imported transcript length, in normalized messages. */
export const DEFAULT_MAX_MESSAGES = 4000

/** Provider/model pair used when a foreign message carries no model metadata. */
const IMPORTED_PROVIDER = 'imported'
const IMPORTED_MODEL = 'unknown'

/**
 * Error carrying a stable machine-readable `code` for the import report.
 */
export class ImportBuildError extends Error {
  /**
   * @param {string} code stable reason, for example `empty-session`.
   * @param {string} message human-readable detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ImportBuildError'
    this.code = code
  }
}

/**
 * Collapse whitespace and cap a title to a display-friendly length.
 * @param {unknown} value candidate title text.
 * @returns {string} normalized title, or an empty string.
 */
function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  if (collapsed === '') return ''
  const points = Array.from(collapsed)
  return points.length <= MAX_TITLE_CODE_POINTS ? collapsed : points.slice(0, MAX_TITLE_CODE_POINTS).join('')
}

/**
 * Extract the first plain-text fragment of a content block list.
 * @param {readonly object[]} blocks normalized content blocks.
 * @returns {string} concatenated text, or an empty string.
 */
function firstText(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Map one normalized block list into DSH message content blocks.
 *
 * Only the block kinds the session format and the transcript renderer know are
 * forwarded; foreign extensions degrade to text instead of failing the import.
 * @param {readonly object[]} blocks blocks reported by an adapter.
 * @param {'user' | 'assistant' | 'tool'} role owning message role.
 * @returns {object[]} JSON-safe DSH content blocks.
 */
function contentBlocks(blocks, role) {
  const out = []
  if (!Array.isArray(blocks)) return out
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') out.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        if (role === 'assistant' && typeof block.text === 'string') {
          out.push({ type: 'reasoning', text: block.text })
        }
        break
      case 'tool-call':
        if (role === 'assistant' && typeof block.name === 'string' && block.name !== '') {
          out.push({
            type: 'tool-call',
            id: typeof block.id === 'string' && block.id !== '' ? block.id : randomUUID(),
            name: block.name,
            arguments: typeof block.arguments === 'string'
              ? block.arguments
              : JSON.stringify(block.arguments ?? {}),
          })
        }
        break
      case 'image':
        if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          out.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        } else {
          out.push({ type: 'text', text: '[image]' })
        }
        break
      default:
        // Unknown foreign block kinds are dropped rather than failing the session.
        break
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: `[${role} message without supported content]` })
  return out
}

/**
 * Copy a provider/model pair into the non-empty form the session validator requires.
 * @param {unknown} provider candidate provider id.
 * @param {unknown} model candidate model id.
 * @param {{ provider?: unknown, model?: unknown }} fallback session-level defaults.
 * @returns {{ provider: string, model: string }} validated pair.
 */
function modelSource(provider, model, fallback) {
  const resolvedProvider = typeof provider === 'string' && provider !== ''
    ? provider
    : typeof fallback?.provider === 'string' && fallback.provider !== ''
      ? fallback.provider
      : IMPORTED_PROVIDER
  const resolvedModel = typeof model === 'string' && model !== ''
    ? model
    : typeof fallback?.model === 'string' && fallback.model !== ''
      ? fallback.model
      : IMPORTED_MODEL
  return { provider: resolvedProvider, model: resolvedModel }
}

/**
 * Normalize a token usage record into the DSH field names.
 * @param {unknown} usage adapter-reported usage.
 * @returns {object | undefined} usage payload, or undefined when nothing usable is present.
 */
function usageRecord(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined)
  const input = pick(usage.inputTokens ?? usage.input)
  const output = pick(usage.outputTokens ?? usage.output)
  const cacheRead = pick(usage.cacheReadTokens ?? usage.cacheRead)
  const cacheWrite = pick(usage.cacheWriteTokens ?? usage.cacheWrite)
  const total = pick(usage.totalTokens ?? usage.total)
  const record = {
    ...input === undefined ? {} : { inputTokens: input },
    ...output === undefined ? {} : { outputTokens: output },
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...total === undefined ? {} : { totalTokens: total },
  }
  return Object.keys(record).length === 0 ? undefined : record
}

/**
 * Build the durable session header for an import.
 *
 * `createdAt` is the import time, not the foreign session's creation time: the
 * session catalog sorts by `max(createdAt, lastPromptAt)`, and imported history
 * carries old prompt timestamps, so preserving the foreign date would bury a
 * just-imported session at the bottom of the sidebar. The original timestamps
 * still shape the imported events' own `time` values.
 * @param {string} id deterministic DSH session id.
 * @param {string} cwd canonical working directory.
 * @param {number} now import time, epoch milliseconds.
 * @returns {object} v4 session header.
 */
function sessionHeader(id, cwd, now) {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: now,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

/**
 * Synthesize a complete DSH v4 session artifact from a normalized transcript.
 *
 * The result is pure JSON data: it can be validated by the installed Session
 * implementation before it is written, and it carries no references into the
 * adapter's objects.
 * @param {object} input normalized session from an adapter:
 *   `{ harness, foreignId, title, cwd, createdAt, updatedAt, provider, model, messages }`.
 * @param {{ id: string, now?: number, maxMessages?: number }} options target id and limits.
 * @returns {{ header: object, events: object[], stats: object }} validated-shape artifact.
 * @throws {ImportBuildError} when the transcript cannot form a session.
 */
export function buildSessionArtifact(input, options) {
  const now = Number.isFinite(options?.now) ? Math.trunc(options.now) : Date.now()
  const maxMessages = Number.isFinite(options?.maxMessages) ? Math.trunc(options.maxMessages) : DEFAULT_MAX_MESSAGES
  const messages = Array.isArray(input?.messages) ? input.messages : []
  if (messages.length === 0) throw new ImportBuildError('empty-session', 'foreign session contains no messages')
  if (messages.length > maxMessages) {
    throw new ImportBuildError(
      'too-large',
      `foreign session has ${messages.length} messages (limit ${maxMessages}); raise maxMessages to import it`,
    )
  }
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
    throw new ImportBuildError('missing-cwd', 'foreign session has no absolute working directory')
  }

  const header = sessionHeader(options.id, input.cwd, now)
  /** @type {object[]} */
  const events = []
  /** Monotonic event clock; source timestamps are clamped into [foreign creation, now]. */
  let clock = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) && input.createdAt >= 0
    ? Math.min(Math.trunc(input.createdAt), now)
    : now

  /**
   * Append one event record at the next sequence number.
   * @param {string} type event type.
   * @param {object} data JSON payload.
   * @param {{ surfaceOp?: string, sourceEventSeqs?: number[] }} [surface] surface metadata.
   * @param {number} [at] source timestamp.
   * @returns {object} the appended record.
   */
  const push = (type, data, surface, at) => {
    if (typeof at === 'number' && Number.isFinite(at)) {
      clock = Math.max(clock, Math.min(Math.trunc(at), now))
    }
    const event = {
      type,
      seq: events.length,
      time: clock,
      data,
      ...surface?.surfaceOp === undefined ? {} : { surfaceOp: surface.surfaceOp },
      ...surface?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surface.sourceEventSeqs },
    }
    events.push(event)
    return event
  }

  const fallbackModel = { provider: input.provider, model: input.model }
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  /** Whether the open step already committed its assistant response. */
  let stepHasAssistant = false
  /** @type {Map<string, number>} tool call id to its `tool/call` event seq. */
  const callSeqs = new Map()
  /** The protected first surface node, emitted once before any other message. */
  let systemPushed = false
  let firstUserSeq = null
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let skippedToolResults = 0

  /** Close the currently open step with a matching `step/end`. */
  const closeStep = () => {
    if (!stepOpen) return
    // Every advertised call must be settled before the step closes. Foreign
    // histories do contain calls whose result never arrived (interrupted or
    // truncated sessions), so repair them exactly like the harness's own
    // crash recovery: one error tool result per unsettled call.
    for (const [callId, callSeq] of callSeqs) {
      push('tool/result', {
        turn,
        step,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{
            type: 'text',
            text: 'The tool call was interrupted before its result was recorded. Retry it if it is still needed.',
          }],
          isError: true,
          id: randomUUID(),
        },
        error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    }
    callSeqs.clear()
    push('step/end', { turn, step })
    stepOpen = false
    stepHasAssistant = false
  }

  /** Close the currently open turn with a completed `turn/end`. */
  const closeTurn = () => {
    closeStep()
    if (!turnOpen) return
    push('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }

  /** Open the next turn and its first step; the user prompt joins this step. */
  const openTurn = () => {
    turn += 1
    turns += 1
    step = 1
    steps += 1
    turnOpen = true
    stepOpen = true
    stepHasAssistant = false
    push('turn/start', { turn })
    push('step/start', { turn, step })
    if (!systemPushed) {
      // Surface node 0 must be a system/message. A resumed agent loop rewrites
      // or appends the rendered prompt against this protected head; without it
      // the first resume produces a log the read path refuses.
      systemPushed = true
      push('system/message', {
        turn,
        step,
        message: { role: 'system', content: [], source: { kind: 'system-prompt' }, id: randomUUID() },
      }, { surfaceOp: 'append' })
    }
  }

  /** Open the next step inside the current turn (one model response per step). */
  const openStep = () => {
    step += 1
    steps += 1
    stepOpen = true
    stepHasAssistant = false
    push('step/start', { turn, step })
  }

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    if (role === 'user') {
      const content = contentBlocks(message.content, 'user')
      if (turnOpen) closeTurn()
      openTurn()
      const event = push('user/message', {
        content,
        source: { kind: 'user' },
        role: 'user',
        id: randomUUID(),
      }, { surfaceOp: 'append' }, message.timestamp)
      if (firstUserSeq === null) firstUserSeq = event.seq
      continue
    }
    if (role === 'assistant') {
      if (!turnOpen) openTurn()
      // The first assistant response shares the step opened with the prompt; a
      // later response in the same turn starts its own step, mirroring the
      // agent loop's step boundaries around a model call.
      if (stepHasAssistant) {
        closeStep()
        openStep()
      }
      stepHasAssistant = true
      const content = contentBlocks(message.content, 'assistant')
      const source = modelSource(message.provider, message.model, fallbackModel)
      const usage = usageRecord(message.usage)
      push('assistant/message', {
        turn,
        step,
        message: {
          role: 'assistant',
          content,
          source: { kind: 'model', provider: source.provider, model: source.model },
          id: randomUUID(),
        },
        ...usage === undefined ? {} : { usage },
        stream: [],
      }, { surfaceOp: 'append' }, message.timestamp)
      for (const block of content) {
        if (block.type !== 'tool-call') continue
        toolCalls += 1
        const call = push('tool/call', {
          turn,
          step,
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
        })
        callSeqs.set(block.id, call.seq)
      }
      continue
    }
    if (role === 'tool') {
      if (!stepOpen) {
        skippedToolResults += 1
        continue
      }
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      if (toolCallId === '') {
        skippedToolResults += 1
        continue
      }
      const callSeq = callSeqs.get(toolCallId)
      if (callSeq === undefined) {
        skippedToolResults += 1
        continue
      }
      callSeqs.delete(toolCallId)
      push('tool/result', {
        turn,
        step,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: toolCallId },
          toolCallId,
          content: contentBlocks(message.content, 'tool'),
          isError: message.isError === true,
          id: randomUUID(),
        },
      }, {
        surfaceOp: 'append',
        sourceEventSeqs: [callSeq],
      }, message.timestamp)
      continue
    }
    // Unknown normalized roles cannot join the native surface; ignore them.
  }
  closeTurn()

  const derivedTitle = normalizeTitle(input.title) || normalizeTitle(firstUserText(messages)) || normalizeTitle(`${input.harness ?? 'external'} session`)
  if (derivedTitle !== '') {
    push('session/title', {
      title: derivedTitle,
      messageSeqs: firstUserSeq === null ? [] : [firstUserSeq],
      source: { kind: 'fallback' },
    })
  }

  return {
    header,
    events,
    stats: {
      turns,
      steps,
      toolCalls,
      skippedToolResults,
      title: derivedTitle,
      messageCount: messages.length,
    },
  }
}

/**
 * First user text across the normalized transcript, used for the fallback title.
 * @param {readonly object[]} messages normalized messages.
 * @returns {string} text of the first user message, or an empty string.
 */
function firstUserText(messages) {
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && message.role === 'user') {
      const text = firstText(Array.isArray(message.content) ? message.content : [])
      if (text !== '') return text
    }
  }
  return ''
}
