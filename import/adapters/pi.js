/**
 * `pi` harness adapter: find, list, and parse pi session JSONL files.
 *
 * pi (https://github.com/earendil-works/pi) keeps sessions under
 * `<agent dir>/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl`, one JSON
 * record per line. The first line is a `{"type":"session", ...}` header; the
 * remaining lines are a `id`/`parentId` tree of conversation entries. This
 * adapter reads that store without ever writing to it, lists cheap metadata for
 * the import dialog, and converts one session snapshot into the normalized
 * transcript described in `PLAN.md` §4.4.
 *
 * The format reference used for this implementation is pi 1.4.0's
 * `docs/session-format.md` plus real v3 sessions observed in practice.
 * All parsing is defensive: malformed lines are skipped (pi tolerates them too)
 * and a truncated tail — a pi process may still be appending — is ignored
 * rather than failing the session.
 */
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** Adapter id; also the candidate key prefix and the `harness` value. */
export const id = 'pi'

/** Display titles for the harness badge. */
export const title = { en: 'Pi', zh: 'Pi' }

/** Candidate keys are `pi:<base64url(relative path from the sessions root)>`. */
const KEY_PREFIX = `${id}:`

/** Session files pi writes always end with this suffix. */
const SESSION_FILE_SUFFIX = '.jsonl'

/** Default agent config directory relative to the home directory. */
const DEFAULT_AGENT_DIR = ['.pi', 'agent']

/** Sessions live in `<agent dir>/sessions`. */
const SESSIONS_DIR = 'sessions'

/** Cap on derived candidate/session titles, in characters. */
const MAX_TITLE_CHARS = 200

/** A line matching this prefix is a conversation message record (pi writes compact JSON). */
const MESSAGE_PREFIX = '{"type":"message"'

/** A line matching this prefix is a session display-name record. */
const SESSION_INFO_PREFIX = '{"type":"session_info"'

/** A line matching this prefix is a model switch record. */
const MODEL_CHANGE_PREFIX = '{"type":"model_change"'

/**
 * Files up to this size are scanned end to end for exact message counts.
 * listSessions never decodes conversation JSON in the bulk pass; it only
 * counts line prefixes and parses the handful of metadata lines it needs.
 */
const FULL_SCAN_MAX_BYTES = 128 * 1024 * 1024

/** Bounded head window used for files above `FULL_SCAN_MAX_BYTES`. */
const BOUNDED_HEAD_BYTES = 256 * 1024

/** Bounded tail window used for files above `FULL_SCAN_MAX_BYTES`. */
const BOUNDED_TAIL_BYTES = 256 * 1024

/**
 * Maximum number of message lines parsed while probing a non-head region for a
 * title/model, so metadata scans stay cheap on very long sessions.
 */
const MAX_PROBE_PARSES = 8

/** Newline byte in UTF-8, used to tell whether the final line was fully flushed. */
const NEWLINE_BYTE = 0x0a

/**
 * Cache candidate key -> absolute path recorded by the last listSessions pass.
 * This keeps readSession independent of a filesystem listing race while the
 * decoded key still re-validates containment under the current root.
 * @type {Map<string, string>}
 */
const knownFiles = new Map()

/**
 * Expand `~` and resolve a pi configuration path from the environment.
 * pi itself expands `~` (using the real home directory); relative values are
 * resolved against the home directory here rather than the host process cwd so
 * the result does not depend on where the DSH application was launched.
 * @param {string} value raw path from the environment.
 * @param {string} home user home directory.
 * @returns {string} absolute path.
 */
function resolveConfigPath(value, home) {
  if (value === '~') return home
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) return join(home, value.slice(2))
  if (isAbsolute(value)) return resolve(value)
  return resolve(home, value)
}

/**
 * Read the adapter context with safe fallbacks (the contract always supplies it,
 * but exported functions are also called directly from tests and tooling).
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {{ home: string, env: NodeJS.ProcessEnv }} resolved context inputs.
 */
function contextOf(ctx) {
  const home = typeof ctx?.home === 'string' && ctx.home !== '' ? ctx.home : homedir()
  const env = ctx?.env !== null && typeof ctx?.env === 'object' ? ctx.env : process.env
  return { home, env: env ?? {} }
}

/**
 * Resolve every pi session-store root the environment could point at, in
 * precedence order. The first existing directory is the effective store.
 *
 * pi (1.4.0) names its directories with `PI_CODING_AGENT_SESSION_DIR`
 * (direct session dir) and `PI_CODING_AGENT_DIR` (agent config dir); `PI_HOME`
 * is accepted as the older plan-level spelling. `~/.pi/agent/sessions` is the
 * default every installation falls back to.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv }} [ctx] adapter context.
 * @returns {Promise<{ root: string | null, roots: string[], candidates: string[] }>} resolved roots.
 */
async function resolveRoots(ctx) {
  const { home, env } = contextOf(ctx)
  /** @type {string[]} */
  const candidates = []
  /**
   * Add one candidate root, de-duplicated by resolved text.
   * @param {string} path candidate path.
   */
  const add = (path) => {
    if (candidates.includes(path)) return
    candidates.push(path)
  }
  const directSessionDir = env.PI_CODING_AGENT_SESSION_DIR
  if (typeof directSessionDir === 'string' && directSessionDir.trim() !== '') {
    add(resolveConfigPath(directSessionDir, home))
  }
  const agentDir = env.PI_CODING_AGENT_DIR
  if (typeof agentDir === 'string' && agentDir.trim() !== '') {
    add(join(resolveConfigPath(agentDir, home), SESSIONS_DIR))
  }
  const piHome = env.PI_HOME
  if (typeof piHome === 'string' && piHome.trim() !== '') {
    add(join(resolveConfigPath(piHome, home), 'agent', SESSIONS_DIR))
  }
  add(join(home, ...DEFAULT_AGENT_DIR, SESSIONS_DIR))
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return { root: candidate, roots: [candidate], candidates }
    } catch {
      // Candidate does not exist; try the next precedence level.
    }
  }
  return { root: null, roots: candidates, candidates }
}

/**
 * Shorten a root path with `~` for display in candidate source labels.
 * @param {string} path absolute path.
 * @param {string} home user home directory.
 * @returns {string} display path.
 */
function displayPath(path, home) {
  if (path === home) return '~'
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`
  return path
}

/**
 * Whether `candidate` is a path strictly inside `root`.
 * @param {string} root containment root.
 * @param {string} candidate candidate path.
 * @returns {boolean} true when the path stays under the root.
 */
function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Encode one session file path as the opaque candidate key.
 * @param {string} root effective sessions root.
 * @param {string} file absolute session file path inside `root`.
 * @returns {string} candidate key.
 */
function keyFor(root, file) {
  const rel = relative(root, file).split(sep).join('/')
  return KEY_PREFIX + Buffer.from(rel, 'utf8').toString('base64url')
}

/**
 * Decode and validate a candidate key, returning the session file path.
 * The key is untrusted input from the browser: absolute paths, `..` traversal,
 * and paths that resolve outside the sessions root are all rejected.
 * @param {string} root effective sessions root.
 * @param {unknown} key candidate key.
 * @returns {string} absolute path of the session file.
 * @throws {Error} when the key is malformed or escapes the root.
 */
function filePathForKey(root, key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
    throw new Error('invalid pi session key')
  }
  const encoded = key.slice(KEY_PREFIX.length)
  if (encoded === '' || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error('invalid pi session key encoding')
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
  // Node's base64 decoder is lenient, so require the canonical encoding back.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    throw new Error('invalid pi session key encoding')
  }
  if (decoded === '' || decoded.includes('\0') || decoded.includes('\\') || isAbsolute(decoded)) {
    throw new Error('invalid pi session key path')
  }
  const segments = decoded.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('invalid pi session key path')
    }
  }
  const file = resolve(root, ...segments)
  if (!isInside(root, file)) {
    throw new Error('invalid pi session key path')
  }
  return file
}

/**
 * List the `.jsonl` files of a sessions root.
 *
 * The default pi layout has one directory per working directory holding session
 * files; an explicit `PI_CODING_AGENT_SESSION_DIR` may also point at a flat
 * directory of sessions. Symlinked working-directory folders are followed
 * (pi's own session discovery does the same).
 * @param {string} root sessions root.
 * @returns {Promise<string[]>} absolute session file paths, sorted.
 */
async function discoverSessionFiles(root) {
  const files = []
  /**
   * Append every session file directly inside one directory.
   * @param {string} dir directory to inspect.
   * @returns {Promise<void>} resolves after listing.
   */
  const listDir = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith(SESSION_FILE_SUFFIX)) continue
      if (entry.isFile()) {
        files.push(join(dir, entry.name))
        continue
      }
      if (!entry.isSymbolicLink()) continue
      try {
        if ((await stat(join(dir, entry.name))).isFile()) files.push(join(dir, entry.name))
      } catch {
        // Broken symlink; ignore it like pi's own listing does.
      }
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.name.endsWith(SESSION_FILE_SUFFIX) && entry.isFile()) {
      // Flat layout: $PI_CODING_AGENT_SESSION_DIR points straight at session files.
      files.push(full)
      continue
    }
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await stat(full)).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (isDir) await listDir(full)
  }
  files.sort((left, right) => left.localeCompare(right))
  return files
}

/**
 * Iterate the complete lines of one byte range of a file.
 * The caller decides whether a leading partial line (start > 0) or a trailing
 * partial line (range cut before EOF) must be dropped.
 * @param {string} filePath file to read.
 * @param {number} start first byte offset.
 * @param {number} end exclusive byte offset.
 * @returns {AsyncGenerator<string>} decoded lines without their newline.
 */
async function* readRangeLines(filePath, start, end) {
  if (end <= start) return
  const input = createReadStream(filePath, { start, end: end - 1 })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) yield line
  } finally {
    lines.close()
    input.destroy()
  }
}

/**
 * Read the very last byte of a file, used to tell whether the final line was
 * completely written or is a trailing fragment from an interrupted append.
 * @param {string} filePath file to inspect.
 * @param {number} fileSize byte size of the file.
 * @returns {Promise<number>} final byte value, or -1 when unreadable.
 */
async function readLastByte(filePath, fileSize) {
  if (fileSize <= 0) return -1
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.allocUnsafe(1)
    const { bytesRead } = await handle.read(buffer, 0, 1, fileSize - 1)
    return bytesRead === 1 ? buffer[0] : -1
  } catch {
    return -1
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Parse one JSONL line, returning null for malformed input.
 * Truncated tails (a pi process was writing when we read) fail here and are
 * skipped, matching pi's own tolerant file loader.
 * @param {string} line raw line.
 * @returns {object | null} parsed record, or null.
 */
function parseLine(line) {
  if (line === '' || line === '\r') return null
  // pi's own loader trims the whole file before splitting, which also drops a
  // leading UTF-8 BOM; do the same per line so a BOM never hides the header.
  const text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Collapse whitespace and cap a display title.
 * @param {unknown} value candidate title.
 * @returns {string} normalized title (possibly empty).
 */
function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  const points = Array.from(collapsed)
  if (points.length <= MAX_TITLE_CHARS) return collapsed
  return `${points.slice(0, MAX_TITLE_CHARS - 1).join('')}…`
}

/**
 * Extract the first renderable text from a pi message content value.
 * @param {unknown} content pi content (string or content block array).
 * @returns {string} first text, uncapped.
 */
function firstText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return block.text.trim()
  }
  return ''
}

/**
 * Fresh metadata accumulator for one file scan.
 * @returns {object} scan state.
 */
function emptyScanState() {
  return {
    header: null,
    messageCount: 0,
    sessionName: '',
    firstUserText: '',
    modelProvider: null,
    modelId: null,
    assistantModel: null,
    assistantProvider: null,
    probeParses: 0,
    approximateCount: false,
  }
}

/**
 * Consume one message line during a metadata scan.
 *
 * Only the first few message records are JSON-decoded (to learn the first user
 * prompt and the model); every other message line is just counted. This is what
 * keeps listSessions cheap on sessions with thousands of messages.
 * @param {object} state scan state.
 * @param {string} line raw JSONL line.
 * @returns {void}
 */
function probeMessageLine(state, line) {
  if (state.probeParses >= MAX_PROBE_PARSES) return
  if (state.firstUserText !== '' && (state.assistantProvider !== null || state.modelProvider !== null)) return
  const record = parseLine(line)
  if (record === null || record.type !== 'message' || record.message === null || typeof record.message !== 'object') return
  state.probeParses += 1
  const message = record.message
  if (message.role === 'user' && state.firstUserText === '') {
    state.firstUserText = firstText(message.content)
  } else if (message.role === 'assistant') {
    if (state.assistantModel === null && typeof message.model === 'string' && message.model !== '') {
      state.assistantModel = message.model
      state.assistantProvider = typeof message.provider === 'string' ? message.provider : null
    }
    if (typeof message.model === 'string' && message.model !== '') {
      state.modelProvider = typeof message.provider === 'string' ? message.provider : state.modelProvider
      state.modelId = message.model
    }
  }
}

/**
 * Consume one complete line of a metadata scan.
 * @param {object} state scan state.
 * @param {string} line raw JSONL line.
 * @param {boolean} isFirstLineOfRange first line of the scanned byte range.
 * @param {{ hasHeader: boolean, dropLeadingPartial: boolean }} range range flags.
 * @returns {void}
 */
function consumeScanLine(state, line, isFirstLineOfRange, range) {
  if (isFirstLineOfRange) {
    if (range.dropLeadingPartial || !range.hasHeader) return
    const header = parseLine(line)
    if (header !== null && header.type === 'session') state.header = header
    return
  }
  if (line.startsWith(MESSAGE_PREFIX)) {
    state.messageCount += 1
    probeMessageLine(state, line)
    return
  }
  if (line.startsWith(SESSION_INFO_PREFIX)) {
    const record = parseLine(line)
    if (record !== null && record.type === 'session_info') {
      state.sessionName = typeof record.name === 'string' ? record.name : ''
    }
    return
  }
  if (line.startsWith(MODEL_CHANGE_PREFIX)) {
    const record = parseLine(line)
    if (record !== null && typeof record.provider === 'string' && typeof record.modelId === 'string') {
      state.modelProvider = record.provider
      state.modelId = record.modelId
    }
  }
}

/**
 * Scan one byte range of a session file for metadata.
 *
 * The last yielded line is dropped when the range ends before EOF (it was cut
 * by the window boundary). At EOF it is dropped only when it is not valid JSON:
 * a complete line whose final newline was never flushed is still metadata, while
 * a half-written append (pi still running) must not be counted or parsed.
 * @param {string} filePath session file.
 * @param {number} start first byte offset.
 * @param {number} end exclusive byte offset.
 * @param {number} fileSize total file size.
 * @param {object} state scan state.
 * @param {{ hasHeader: boolean, dropLeadingPartial: boolean, atEof: boolean, endsWithNewline: boolean }} flags range flags.
 * @returns {Promise<void>} resolves after the range is consumed.
 */
async function scanRange(filePath, start, end, fileSize, state, flags) {
  const range = { hasHeader: flags.hasHeader, dropLeadingPartial: flags.dropLeadingPartial }
  const cutByWindow = end < fileSize
  let held = null
  let first = true
  for await (const line of readRangeLines(filePath, start, end)) {
    if (held !== null) {
      consumeScanLine(state, held, first, range)
      if (first) first = false
    }
    held = line
  }
  if (held === null) return
  if (cutByWindow) return
  if (!flags.atEof) {
    consumeScanLine(state, held, first, range)
    return
  }
  if (flags.endsWithNewline || parseLine(held) !== null) consumeScanLine(state, held, first, range)
}

/**
 * Scan one session file for cheap list metadata.
 *
 * Up to `FULL_SCAN_MAX_BYTES` the whole file is streamed (still without a full
 * JSON decode) for an exact message count. Larger files are bounded to a head
 * and tail window, trading count exactness for bounded work, and the candidate
 * is still listed.
 * @param {string} filePath session file.
 * @param {number} fileSize byte size of the file.
 * @returns {Promise<object>} scan state, `header === null` when not a pi session.
 */
async function scanSessionFile(filePath, fileSize) {
  const state = emptyScanState()
  const lastByte = await readLastByte(filePath, fileSize)
  const endsWithNewline = lastByte === NEWLINE_BYTE
  if (fileSize <= FULL_SCAN_MAX_BYTES) {
    await scanRange(filePath, 0, fileSize, fileSize, state, {
      hasHeader: true,
      dropLeadingPartial: false,
      atEof: true,
      endsWithNewline,
    })
    return state
  }
  await scanRange(filePath, 0, BOUNDED_HEAD_BYTES, fileSize, state, {
    hasHeader: true,
    dropLeadingPartial: false,
    atEof: false,
    endsWithNewline: false,
  })
  const tailStart = Math.max(BOUNDED_HEAD_BYTES, fileSize - BOUNDED_TAIL_BYTES)
  await scanRange(filePath, tailStart, fileSize, fileSize, state, {
    hasHeader: false,
    dropLeadingPartial: true,
    atEof: true,
    endsWithNewline,
  })
  state.approximateCount = true
  return state
}

/**
 * Derive the foreign session id from a session file name.
 * pi names files `<ISO timestamp>_<session id>.jsonl`; this is only a fallback
 * for headers that lost their id.
 * @param {string} filePath session file.
 * @returns {string} best available foreign id (possibly empty).
 */
function foreignIdFromFilename(filePath) {
  const base = filePath.slice(filePath.lastIndexOf(sep) + 1)
  const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(base)
  return match === null ? '' : match[1]
}

/**
 * Build one candidate row from a scanned session file.
 * @param {string} root effective sessions root.
 * @param {string} file session file path.
 * @param {object} stats file stat.
 * @param {object} scan scan state.
 * @param {string} home user home directory.
 * @returns {object | null} candidate, or null when the file is not a pi session.
 */
function candidateFromScan(root, file, stats, scan, home) {
  if (scan.header === null) return null
  const header = scan.header
  const createdAt = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN
  const modelId = scan.modelId ?? scan.assistantModel
  const title = normalizeTitle(scan.sessionName) || normalizeTitle(scan.firstUserText)
  return {
    key: keyFor(root, file),
    foreignId: typeof header.id === 'string' ? header.id : foreignIdFromFilename(file),
    title,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: Number.isFinite(createdAt) ? Math.trunc(createdAt) : Math.trunc(stats.mtimeMs),
    updatedAt: Math.trunc(stats.mtimeMs),
    messageCount: scan.messageCount,
    sourceLabel: `${id} · ${displayPath(root, home)}`,
    model: typeof modelId === 'string' && modelId !== '' ? modelId : null,
  }
}

/**
 * Report whether the pi session store exists on this machine.
 *
 * This runs on every import-dialog open (`GET /session-import/sources`), so it
 * only stats a handful of candidate roots and never walks the store.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {Promise<{ available: boolean, roots: string[] }>} availability plus resolved roots.
 */
export async function available(ctx) {
  const resolution = await resolveRoots(ctx)
  return {
    available: resolution.root !== null,
    roots: resolution.root === null ? resolution.roots : [resolution.root],
  }
}

/**
 * List every pi session as import-dialog metadata.
 *
 * One corrupt or unreadable file never fails the whole list: it is skipped
 * silently (the scan summary already reports adapter-level errors).
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {Promise<object[]>} candidate rows, newest first.
 */
export async function listSessions(ctx) {
  const resolution = await resolveRoots(ctx)
  if (resolution.root === null) return []
  const root = resolution.root
  const { home } = contextOf(ctx)
  let files
  try {
    files = await discoverSessionFiles(root)
  } catch {
    return []
  }
  knownFiles.clear()
  const candidates = []
  for (const file of files) {
    try {
      const stats = await stat(file)
      if (!stats.isFile() || stats.size === 0) continue
      const scan = await scanSessionFile(file, stats.size)
      const candidate = candidateFromScan(root, file, stats, scan, home)
      if (candidate === null) continue
      knownFiles.set(candidate.key, file)
      candidates.push(candidate)
    } catch {
      // Per-file resilience: a file being rewritten or removed mid-scan is
      // simply absent from this listing; the next scan will pick it up.
    }
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
  return candidates
}

/**
 * Convert one pi content value into normalized content blocks.
 *
 * Mapping (see `.session-adopt-dev/pi-format.md` for the full table):
 * - text -> `{type:'text'}` (empty text blocks dropped for user/assistant,
 *   kept for tool results so "empty output" stays visible),
 * - thinking -> `{type:'reasoning'}` (assistant only; redacted/empty dropped),
 * - toolCall -> `{type:'tool-call'}` with JSON-string arguments,
 * - image -> a single `'[image]'` text placeholder (base64 images are not
 *   imported into DSH v1; durable attachments are future work).
 * @param {unknown} value pi message content (string or block array).
 * @param {'user' | 'assistant' | 'tool'} role owning normalized role.
 * @returns {object[]} normalized content blocks.
 */
function normalizeContent(value, role) {
  const out = []
  if (typeof value === 'string') {
    if (role === 'tool' || value !== '') out.push({ type: 'text', text: value })
    return out
  }
  if (!Array.isArray(value)) return out
  for (const block of value) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': {
        if (typeof block.text !== 'string') break
        if (role === 'tool' || block.text !== '') out.push({ type: 'text', text: block.text })
        break
      }
      case 'thinking': {
        if (role !== 'assistant') break
        if (typeof block.thinking !== 'string' || block.thinking === '') break
        out.push({ type: 'reasoning', text: block.thinking })
        break
      }
      case 'toolCall': {
        if (role !== 'assistant') break
        const call = normalizeToolCall(block)
        if (call !== null) out.push(call)
        break
      }
      case 'image': {
        if (role !== 'user' && role !== 'tool') break
        out.push({ type: 'text', text: '[image]' })
        break
      }
      default:
        // Unknown/extension blocks are dropped; one odd block must not fail the session.
        break
    }
  }
  return out
}

/**
 * Normalize one pi tool call.
 * @param {object} block pi `toolCall` content block.
 * @returns {{ type: 'tool-call', id: string, name: string, arguments: string } | null} normalized call, or null when unusable.
 */
function normalizeToolCall(block) {
  const callId = typeof block.id === 'string' && block.id !== '' ? block.id : ''
  const name = typeof block.name === 'string' && block.name !== '' ? block.name : ''
  if (callId === '' || name === '') return null
  return { type: 'tool-call', id: callId, name, arguments: argumentString(block.arguments) }
}

/**
 * Render pi tool-call arguments as the JSON string DSH expects.
 * @param {unknown} value pi arguments (normally an object).
 * @returns {string} JSON string.
 */
function argumentString(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

/**
 * Map pi assistant usage onto the normalized usage fields.
 * @param {unknown} usage pi usage record.
 * @returns {object | undefined} normalized usage, or undefined when nothing usable.
 */
function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const pick = (value) => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined)
  const inputTokens = pick(usage.input)
  const outputTokens = pick(usage.output)
  const cacheReadTokens = pick(usage.cacheRead)
  const cacheWriteTokens = pick(usage.cacheWrite)
  let totalTokens = pick(usage.totalTokens)
  if (totalTokens === undefined) {
    const parts = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
    if (parts.some((part) => part !== undefined)) {
      totalTokens = parts.reduce((sum, part) => sum + (part ?? 0), 0)
    }
  }
  const record = {
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...totalTokens === undefined ? {} : { totalTokens },
  }
  return Object.keys(record).length === 0 ? undefined : record
}

/**
 * Message timestamp in epoch milliseconds.
 * The nested pi message timestamp is authoritative; the entry envelope ISO
 * timestamp is the fallback for older/partial records.
 * @param {object} entry pi session entry.
 * @param {object | null} message nested pi message, when present.
 * @returns {number | undefined} epoch milliseconds, or undefined.
 */
function messageTimestamp(entry, message) {
  if (message !== null && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return Math.trunc(message.timestamp)
  }
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

/**
 * Normalize one pi `message` entry.
 * @param {object} entry pi session entry.
 * @returns {object | null} normalized message, or null when the entry carries nothing importable.
 */
function normalizeMessageEntry(entry) {
  const message = entry.message
  if (message === null || typeof message !== 'object') return null
  const timestamp = messageTimestamp(entry, message)
  switch (message.role) {
    case 'user': {
      const content = normalizeContent(message.content, 'user')
      if (content.length === 0) return null
      return {
        role: 'user',
        content,
        ...timestamp === undefined ? {} : { timestamp },
      }
    }
    case 'assistant': {
      const content = normalizeContent(message.content, 'assistant')
      if (content.length === 0) return null
      const provider = typeof message.provider === 'string' && message.provider !== '' ? message.provider : undefined
      const model = typeof message.model === 'string' && message.model !== ''
        ? message.model
        : typeof message.responseModel === 'string' && message.responseModel !== ''
          ? message.responseModel
          : undefined
      const usage = normalizeUsage(message.usage)
      return {
        role: 'assistant',
        content,
        ...timestamp === undefined ? {} : { timestamp },
        ...provider === undefined ? {} : { provider },
        ...model === undefined ? {} : { model },
        ...usage === undefined ? {} : { usage },
      }
    }
    case 'toolResult': {
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      if (toolCallId === '') return null
      return {
        role: 'tool',
        toolCallId,
        isError: message.isError === true,
        content: normalizeContent(message.content, 'tool'),
        ...timestamp === undefined ? {} : { timestamp },
      }
    }
    default:
      // system prompts, extension (`custom`) messages, bashExecution, ... do not
      // have a normalized role; they are pi bookkeeping and are not imported.
      return null
  }
}

/**
 * Select the active conversation path of a pi session tree.
 *
 * pi files are `id`/`parentId` trees: entries from abandoned branches stay in
 * the file. The current conversation is the path from the last entry (the
 * current leaf) up to its root, in file order. Version 1 sessions are a plain
 * linear list with no ids, and a broken chain falls back to file order rather
 * than losing messages.
 * @param {object[]} body entries after the session header.
 * @returns {object[]} entries on the active path, root first.
 */
function activePath(body) {
  if (body.length === 0) return []
  const byId = new Map()
  for (const entry of body) {
    if (typeof entry.id === 'string' && entry.id !== '') byId.set(entry.id, entry)
  }
  if (byId.size === 0) return body
  const leaf = body[body.length - 1]
  if (typeof leaf.id !== 'string' || leaf.id === '') return body
  const path = []
  const seen = new Set()
  let current = leaf
  let rootReached = false
  while (current !== undefined && current !== null) {
    if (typeof current.id !== 'string' || seen.has(current.id)) break
    seen.add(current.id)
    path.push(current)
    const parentId = current.parentId
    if (parentId === null || parentId === undefined) {
      rootReached = true
      break
    }
    current = byId.get(parentId)
  }
  if (!rootReached || path.length === 0) return body
  path.reverse()
  return path
}

/**
 * Latest pi session display name from all entries (pi walks the raw file in
 * reverse, including entries on abandoned branches, so the adapter does too).
 * An empty `name` explicitly clears the title.
 * @param {object[]} entries all session entries including the header.
 * @returns {string} display name (possibly empty).
 */
function sessionNameFromEntries(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type !== 'session_info') continue
    return typeof entry.name === 'string' ? entry.name : ''
  }
  return ''
}

/**
 * Session-level provider/model fallback, taken from the newest model metadata
 * on the active path (last `model_change`, else last assistant message).
 * @param {object[]} path active session entries.
 * @returns {{ provider: string | null, model: string | null }} provider/model pair.
 */
function sessionModel(path) {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index]
    if (entry.type === 'model_change') {
      if (typeof entry.provider === 'string' && typeof entry.modelId === 'string' && entry.modelId !== '') {
        return { provider: entry.provider, model: entry.modelId }
      }
      continue
    }
    if (entry.type !== 'message' || entry.message === null || typeof entry.message !== 'object') continue
    const message = entry.message
    if (message.role !== 'assistant') continue
    const model = typeof message.model === 'string' && message.model !== ''
      ? message.model
      : typeof message.responseModel === 'string' && message.responseModel !== ''
        ? message.responseModel
        : ''
    if (model === '') continue
    return { provider: typeof message.provider === 'string' ? message.provider : null, model }
  }
  return { provider: null, model: null }
}

/**
 * First user prompt text in a normalized transcript, used as the title fallback.
 * @param {object[]} messages normalized messages.
 * @returns {string} first user text (uncapped).
 */
function firstUserText(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '') return block.text
    }
  }
  return ''
}

/**
 * Resolve the file for one candidate key, preferring the path recorded by the
 * last listing but re-validating containment under the effective root.
 * @param {string} root effective sessions root.
 * @param {string} key candidate key.
 * @returns {string} absolute session file path.
 */
function sessionFileFor(root, key) {
  const known = knownFiles.get(key)
  if (known !== undefined && isInside(root, known)) return known
  return filePathForKey(root, key)
}

/**
 * Read and normalize one pi session into the adapter contract.
 *
 * This is the full read: every JSONL line is parsed (malformed lines are
 * skipped), the active branch is selected, and the transcript is mapped.
 * pi bookkeeping entries (system prompts, model/thinking changes, compaction,
 * context edits, extension state and messages, session metadata) are not
 * imported; see `.session-adopt-dev/pi-format.md`.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @param {string} key candidate key from `listSessions()`.
 * @returns {Promise<object>} normalized session: `foreignId, title, cwd, createdAt,
 *   updatedAt, model, provider, formatVersion, messages`.
 * @throws {Error} when the store/key/file/header is unusable.
 */
export async function readSession(ctx, key) {
  const resolution = await resolveRoots(ctx)
  if (resolution.root === null) throw new Error('pi session store not found')
  const root = resolution.root
  const file = sessionFileFor(root, key)
  let stats
  try {
    stats = await stat(file)
  } catch {
    throw new Error('pi session file not found')
  }
  if (!stats.isFile()) throw new Error('pi session path is not a file')
  const text = await readFile(file, 'utf8')
  const entries = []
  for (const line of text.split('\n')) {
    const record = parseLine(line)
    if (record !== null) entries.push(record)
  }
  const header = entries[0]
  if (header === undefined || header.type !== 'session') {
    throw new Error('not a pi session file (missing session header)')
  }
  const body = entries.slice(1)
  const path = activePath(body)
  const messages = []
  for (const entry of path) {
    if (entry.type !== 'message') continue
    const message = normalizeMessageEntry(entry)
    if (message !== null) messages.push(message)
  }
  const { provider, model } = sessionModel(path)
  const title = normalizeTitle(sessionNameFromEntries(entries)) || normalizeTitle(firstUserText(messages))
  const createdAt = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN
  return {
    foreignId: typeof header.id === 'string' ? header.id : foreignIdFromFilename(file),
    title,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: Number.isFinite(createdAt) ? Math.trunc(createdAt) : Math.trunc(stats.mtimeMs),
    updatedAt: Math.trunc(stats.mtimeMs),
    model,
    provider,
    formatVersion: typeof header.version === 'number' ? header.version : 1,
    messages,
  }
}
