/**
 * VS Code Copilot adapter: find, list, and parse GitHub Copilot chat sessions
 * stored by Visual Studio Code.
 *
 * Layout (VS Code 1.x, all platforms):
 *   <user data>/User/workspaceStorage/<workspace id>/chatSessions/<session>.jsonl
 *   <user data>/User/workspaceStorage/<workspace id>/chatSessions/<session>.json   (legacy)
 *   <user data>/User/globalStorage/emptyWindowChatSessions/<session>.json[l]       (no folder)
 *
 * `<user data>` is `%APPDATA%\<variant>`, `~/Library/Application Support/<variant>`
 * or `$XDG_CONFIG_HOME/<variant>`; the supported variants are the stable,
 * Insiders and VSCodium/Code-OSS data directories. `<workspace id>` is a hash
 * directory whose `workspace.json` names the folder the sessions belong to —
 * that folder is the session's working directory, the value the importer files
 * the new native session under.
 *
 * Since microsoft/vscode#286644 (VS Code ~1.109, Insiders since January 2026) a
 * session is an append-only operation log: one JSON object per line, where
 * `kind: 0` is the full snapshot and `kind: 1/2/3` are set/push/delete
 * mutations against a path (`k`) of the snapshot. `readSession` replays that log
 * with the same semantics as `objectMutationLog.ts` in VS Code; older sessions
 * are plain JSON files with the very same v3 object shape.
 *
 * Everything here is read-only: the adapter never writes to, moves, or renames
 * a VS Code file, and it tolerates a session that VS Code is still appending to
 * (a truncated trailing line is ignored).
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Adapter id; also the candidate key prefix and the `harness` value. */
export const id = 'copilot'

/** Display titles for the harness badge. */
export const title = { en: 'VS Code Copilot', zh: 'VS Code Copilot' }

/** Candidate keys are `copilot:<base64url(absolute session file path)>`. */
const KEY_PREFIX = `${id}:`

/** File suffixes VS Code uses for a stored chat session (`.part-bak` is ignored). */
const SESSION_SUFFIXES = ['.jsonl', '.json']

/** VS Code user-data variants this adapter understands, in display order. */
const VARIANTS = ['Code', 'Code - Insiders', 'VSCodium', 'Code - OSS']

/** Environment override naming one or more user-data directories. */
const USER_DATA_ENV = ['COPILOT_USER_DATA_DIR', 'VSCODE_USER_DATA_DIR']

/** Per-workspace session directory, relative to the user-data directory. */
const WORKSPACE_STORAGE = ['User', 'workspaceStorage']

/** Chat directory inside one workspace storage directory. */
const CHAT_SESSIONS = 'chatSessions'

/** Sessions from a window without a folder, relative to the user-data directory. */
const EMPTY_WINDOW_STORAGE = ['User', 'globalStorage', 'emptyWindowChatSessions']

/** Sessions from a window without a workspace, relative to the user-data directory. */
const NO_WORKSPACE_STORAGE = ['User', 'globalStorage', 'no-workspace', CHAT_SESSIONS]

/** Cap on derived candidate/session titles, in characters. */
const MAX_TITLE_CHARS = 200

/** Upper bound on one session file this adapter is willing to replay, in bytes. */
const MAX_SESSION_BYTES = 256 * 1024 * 1024

/** Response part kinds rendered as reasoning instead of text. */
const REASONING_KINDS = new Set(['thinking'])

/** Response part kinds that carry no conversation content. */
const IGNORED_KINDS = new Set([
  'clearToPreviousToolInvocation',
  'codeblockUri',
  'command',
  'extensions',
  'hook',
  'markdownVuln',
  'mcpServersStarting',
  'progressMessage',
  'progressTaskSerialized',
  'systemNotification',
  'undoStop',
  'warning',
  'info',
])

/**
 * Expand `~` and resolve a configuration path from the environment.
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
 * @returns {{ home: string, env: NodeJS.ProcessEnv, platform: string }} resolved context inputs.
 */
function contextOf(ctx) {
  const home = typeof ctx?.home === 'string' && ctx.home !== '' ? ctx.home : homedir()
  const env = ctx?.env !== null && typeof ctx?.env === 'object' ? ctx.env : process.env
  const platform = typeof ctx?.platform === 'string' && ctx.platform !== '' ? ctx.platform : process.platform
  return { home, env: env ?? {}, platform }
}

/**
 * The VS Code user-data directory of one variant on this platform.
 * @param {{ home: string, env: NodeJS.ProcessEnv, platform: string }} context adapter context.
 * @param {string} variant VS Code variant directory name.
 * @returns {string} absolute user-data directory.
 */
function userDataDir(context, variant) {
  const { home, env, platform } = context
  if (platform === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA !== ''
      ? env.APPDATA
      : join(home, 'AppData', 'Roaming')
    return join(appData, variant)
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', variant)
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : join(home, '.config')
  return join(xdg, variant)
}

/**
 * Every user-data directory that could hold Copilot sessions, in precedence
 * order. An explicit `COPILOT_USER_DATA_DIR` / `VSCODE_USER_DATA_DIR` replaces
 * the per-platform variant list, which is what tests and portable installs use.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {string[]} absolute candidate directories.
 */
export function userDataDirs(ctx) {
  const context = contextOf(ctx)
  const configured = USER_DATA_ENV
    .map((name) => context.env[name])
    .find((value) => typeof value === 'string' && value.trim() !== '')
  const candidates = []
  /**
   * Add one candidate directory, de-duplicated by resolved text.
   * @param {string} dir candidate directory.
   */
  const add = (dir) => {
    const absolute = resolveConfigPath(dir, context.home)
    if (!candidates.includes(absolute)) candidates.push(absolute)
  }
  if (configured !== undefined) {
    for (const part of configured.split(delimiter)) {
      if (part.trim() !== '') add(part.trim())
    }
    return candidates
  }
  for (const variant of VARIANTS) add(userDataDir(context, variant))
  return candidates
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
 * Convert a `file:` URI from `workspace.json` into a local path.
 * Non-`file` schemes (remote windows, virtual workspaces) have no local
 * directory and yield an empty string.
 * @param {unknown} value URI string.
 * @returns {string} absolute path, or an empty string.
 */
function uriToPath(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (!value.startsWith('file:')) return ''
  try {
    return fileURLToPath(value)
  } catch {
    return ''
  }
}

/**
 * Read the working directory a workspace storage directory belongs to.
 *
 * `workspace.json` holds either `folder` (a single folder window) or `workspace`
 * (a `.code-workspace` file); for a multi-root window the workspace file's own
 * directory is the closest thing to a working directory, and a window without
 * either has none.
 * @param {string} storageDir absolute `workspaceStorage/<id>` directory.
 * @returns {Promise<string>} absolute working directory, or an empty string.
 */
async function readWorkspaceCwd(storageDir) {
  let document
  try {
    document = JSON.parse(await readFile(join(storageDir, 'workspace.json'), 'utf8'))
  } catch {
    return ''
  }
  if (document === null || typeof document !== 'object') return ''
  const folder = uriToPath(document.folder)
  if (folder !== '') return folder
  const workspaceFile = uriToPath(document.workspace)
  if (workspaceFile === '') return ''
  return dirname(workspaceFile)
}

/**
 * List one directory's session files.
 * @param {string} dir directory to inspect.
 * @returns {Promise<string[]>} absolute session file paths, sorted.
 */
async function listSessionFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!SESSION_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    files.push(join(dir, entry.name))
  }
  files.sort((left, right) => left.localeCompare(right))
  return files
}

/**
 * Enumerate every chat session store on this machine.
 *
 * One store is one `chatSessions` directory plus the working directory its
 * sessions belong to (`''` for a window without a folder, whose sessions cannot
 * be filed into a Workspace) and a short root label for the import dialog.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {Promise<{ sessionsDir: string, cwd: string, displayRoot: string }[]>} discovered stores.
 */
async function discoverStores(ctx) {
  const stores = []
  for (const root of userDataDirs(ctx)) {
    const workspaceStorage = join(root, ...WORKSPACE_STORAGE)
    let entries = []
    try {
      entries = await readdir(workspaceStorage, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const storageDir = join(workspaceStorage, entry.name)
      const sessionsDir = join(storageDir, CHAT_SESSIONS)
      let isDirectory = false
      try {
        isDirectory = (await stat(sessionsDir)).isDirectory()
      } catch {
        isDirectory = false
      }
      if (!isDirectory) continue
      stores.push({ sessionsDir, cwd: await readWorkspaceCwd(storageDir), displayRoot: workspaceStorage })
    }
    for (const layout of [EMPTY_WINDOW_STORAGE, NO_WORKSPACE_STORAGE]) {
      const sessionsDir = join(root, ...layout)
      try {
        if (!(await stat(sessionsDir)).isDirectory()) continue
      } catch {
        continue
      }
      stores.push({ sessionsDir, cwd: '', displayRoot: sessionsDir })
    }
  }
  return stores
}

/**
 * Encode one session file path as the opaque candidate key.
 *
 * The path is absolute and comes from this adapter's own listing; the browser
 * only ever echoes it back, and {@link fileForKey} re-validates that the
 * decoded path is a session file inside a currently discovered store, so a
 * forged key cannot reach any other file.
 * @param {string} file absolute session file path.
 * @returns {string} candidate key.
 */
function keyFor(file) {
  return KEY_PREFIX + Buffer.from(file, 'utf8').toString('base64url')
}

/**
 * Decode and validate a candidate key into a session file path.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} ctx adapter context.
 * @param {unknown} key candidate key from a scan.
 * @returns {Promise<string>} absolute session file path.
 * @throws {Error} when the key is malformed, escapes every store, or is not a session file.
 */
async function fileForKey(ctx, key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
    throw new Error('invalid VS Code Copilot session key')
  }
  const encoded = key.slice(KEY_PREFIX.length)
  if (encoded === '' || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error('invalid VS Code Copilot session key encoding')
  }
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
  // Node's base64 decoder is lenient, so require the canonical encoding back.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    throw new Error('invalid VS Code Copilot session key encoding')
  }
  if (decoded === '' || decoded.includes('\0') || !isAbsolute(decoded)) {
    throw new Error('invalid VS Code Copilot session key path')
  }
  if (!SESSION_SUFFIXES.some((suffix) => decoded.endsWith(suffix))) {
    throw new Error('invalid VS Code Copilot session key path')
  }
  const stores = await discoverStores(ctx)
  if (!stores.some((store) => isInside(store.sessionsDir, decoded))) {
    throw new Error('VS Code Copilot session file is outside every known store')
  }
  return resolve(decoded)
}

/**
 * Whether a replayed document looks like a VS Code chat session.
 * @param {unknown} document replayed value.
 * @returns {boolean} true when the document carries the v3 chat shape.
 */
function isChatSession(document) {
  return document !== null
    && typeof document === 'object'
    && Array.isArray(document.requests)
}

/**
 * Apply one append-log entry to the replayed state.
 *
 * Mirrors `ObjectMutationLog.read`/`_applySet`/`_applyPush` in VS Code: `kind 0`
 * replaces the state, `kind 1` and `kind 3` set (or delete) the property at
 * `k`, and `kind 2` truncates the array at `k` to `i` when `i` is present and
 * then pushes `v`.
 * @param {object} entry parsed log entry.
 * @param {unknown} state current state, or undefined before the first entry.
 * @returns {unknown} the updated state.
 * @throws {Error} when the entry is unusable (unknown kind, path before a snapshot).
 */
function applyEntry(entry, state) {
  const kind = entry?.kind
  if (kind === 0) return entry.v
  const path = entry?.k
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('operation log entry has no property path')
  }
  if (state === null || typeof state !== 'object') {
    throw new Error('operation log is missing its initial entry')
  }
  let parent = state
  for (let index = 0; index < path.length - 1; index += 1) {
    const step = path[index]
    const next = parent?.[step]
    if (next === null || typeof next !== 'object') return state
    parent = next
  }
  const key = path[path.length - 1]
  if (kind === 1) {
    parent[key] = entry.v
    return state
  }
  if (kind === 3) {
    parent[key] = undefined
    return state
  }
  if (kind === 2) {
    const current = Array.isArray(parent[key]) ? parent[key] : []
    const startIndex = typeof entry.i === 'number' && Number.isFinite(entry.i) ? entry.i : undefined
    if (startIndex !== undefined) current.length = Math.max(0, startIndex)
    if (Array.isArray(entry.v) && entry.v.length > 0) current.push(...entry.v)
    parent[key] = current
    return state
  }
  throw new Error(`unsupported operation log entry kind ${String(kind)}`)
}

/**
 * Replay an append-only chat session log.
 *
 * A truncated last line — VS Code is still appending — is ignored, exactly like
 * a half-written entry in any other JSONL store.
 * @param {string} text log file contents.
 * @returns {unknown} replayed session document.
 * @throws {Error} when no snapshot line is present.
 */
export function replayOperationLog(text) {
  let state
  let snapshots = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (entry.kind === 0) snapshots += 1
    try {
      state = applyEntry(entry, state)
    } catch {
      // A malformed mutation cannot be applied; keep the state it started from
      // so the rest of the conversation still imports.
    }
  }
  if (snapshots === 0) throw new Error('not a VS Code Copilot chat session (no snapshot entry)')
  return state
}

/**
 * Read one session file into its complete document.
 * @param {string} file absolute session file path.
 * @param {number} size byte size from a prior stat.
 * @returns {Promise<unknown>} replayed session document.
 * @throws {Error} when the file is too large, unreadable, or not a session.
 */
async function readSessionDocument(file, size) {
  if (size > MAX_SESSION_BYTES) {
    throw new Error(`session file is larger than the ${Math.trunc(MAX_SESSION_BYTES / 1048576)} MB import limit`)
  }
  const text = await readFile(file, 'utf8')
  const document = file.endsWith('.jsonl') ? replayOperationLog(text) : JSON.parse(text)
  if (!isChatSession(document)) throw new Error('not a VS Code Copilot chat session')
  return document
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
 * Read the text of a serialized `MarkdownString` or plain string.
 * @param {unknown} value markdown string, string, or anything else.
 * @returns {string} trimmed text, or an empty string.
 */
function markdownText(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  if (typeof value.value === 'string') return value.value
  return ''
}

/**
 * The user prompt of one request: its rendered text when present, else the
 * concatenation of the text parts of the parsed request.
 * @param {object} request serialized chat request.
 * @returns {string} prompt text (possibly empty).
 */
function userText(request) {
  const message = request?.message
  if (message === null || message === undefined) return ''
  if (typeof message === 'string') return message
  if (typeof message.text === 'string' && message.text.trim() !== '') return message.text
  if (!Array.isArray(message.parts)) return ''
  const parts = []
  for (const part of message.parts) {
    if (part === null || typeof part !== 'object') continue
    if (part.kind === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/**
 * Strip terminal escape sequences from tool output.
 * @param {string} text raw terminal text.
 * @returns {string} plain text.
 */
function stripAnsi(text) {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/gu, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')
    .replace(/\r(?!\n)/gu, '')
}

/**
 * Message timestamp for one request, in epoch milliseconds.
 * @param {object} request serialized chat request.
 * @param {number} fallback session creation date.
 * @returns {number} epoch milliseconds.
 */
function requestTimestamp(request, fallback) {
  return typeof request?.timestamp === 'number' && Number.isFinite(request.timestamp)
    ? Math.trunc(request.timestamp)
    : fallback
}

/**
 * The model a request answered with, as a `provider/model` label.
 * @param {object} request serialized chat request.
 * @returns {string | undefined} model id, or undefined.
 */
function requestModel(request) {
  const modelId = request?.modelId
  if (typeof modelId === 'string' && modelId !== '') return modelId
  return undefined
}

/**
 * Render one serialized tool invocation's result as text.
 *
 * Copilot stores the structured result in `resultDetails` (input plus output
 * parts) and, for terminals, the captured terminal buffer in `toolSpecificData`.
 * The human-readable `pastTenseMessage` is the last resort.
 * @param {object} part serialized `toolInvocationSerialized` part.
 * @returns {string} result text.
 */
function toolResultText(part) {
  const details = part?.resultDetails
  if (details !== null && typeof details === 'object' && Array.isArray(details.output)) {
    const parts = []
    for (const output of details.output) {
      if (output === null || typeof output !== 'object') continue
      const value = typeof output.value === 'string' ? output.value : markdownText(output.value)
      if (value !== '') parts.push(value)
    }
    const text = parts.join('\n').trim()
    if (text !== '') return text
  }
  const terminal = part?.toolSpecificData
  if (terminal !== null && typeof terminal === 'object' && terminal.kind === 'terminal') {
    const output = terminal.terminalCommandOutput
    if (output !== null && typeof output === 'object' && typeof output.text === 'string' && output.text.trim() !== '') {
      return stripAnsi(output.text).trim()
    }
  }
  const past = markdownText(part?.pastTenseMessage).trim()
  if (past !== '') return past
  const invocation = markdownText(part?.invocationMessage).trim()
  if (invocation !== '') return invocation
  return part?.isComplete === false ? 'The tool call did not complete.' : 'Completed.'
}

/**
 * Render one serialized tool invocation's arguments as a JSON string.
 * @param {object} part serialized `toolInvocationSerialized` part.
 * @returns {string} JSON string.
 */
function toolArguments(part) {
  const details = part?.resultDetails
  const input = details !== null && typeof details === 'object' ? details.input : undefined
  if (typeof input === 'string' && input !== '') {
    return JSON.stringify({ input })
  }
  if (input !== null && typeof input === 'object') {
    try {
      return JSON.stringify(input)
    } catch {
      // Fall through to the invocation summary.
    }
  }
  const invocation = markdownText(part?.invocationMessage).trim()
  return JSON.stringify(invocation === '' ? {} : { invocation })
}

/**
 * Append a text item, merging it with the preceding text item.
 *
 * Copilot streams a response as many small markdown parts; merging keeps one
 * text block per response instead of one per streamed fragment.
 * @param {object[]} items ordered response items under construction.
 * @param {string} text text to append.
 * @returns {void}
 */
function pushText(items, text) {
  if (text === '') return
  const last = items.at(-1)
  if (last !== undefined && last.type === 'block' && last.block.type === 'text') {
    last.block.text += text
    return
  }
  items.push({ type: 'block', block: { type: 'text', text } })
}

/**
 * Convert one request's `response` parts into ordered response items.
 *
 * The order of the foreign parts is the conversational order, so content and
 * tool invocations stay interleaved: text → tool call → result → text. A tool
 * item carries everything the caller needs to emit the paired `tool-call` block
 * and `tool` message.
 * @param {readonly unknown[]} parts serialized response parts.
 * @returns {({ type: 'block', block: object } | { type: 'tool', tool: object })[]} ordered items.
 */
function responseItems(parts) {
  const items = []
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part === null || typeof part !== 'object') continue
    const kind = typeof part.kind === 'string' ? part.kind : ''
    if (kind === 'toolInvocationSerialized') {
      const callId = typeof part.toolCallId === 'string' && part.toolCallId !== '' ? part.toolCallId : ''
      const name = typeof part.toolId === 'string' && part.toolId !== '' ? part.toolId : ''
      if (callId !== '' && name !== '') {
        items.push({
          type: 'tool',
          tool: {
            callId,
            name,
            arguments: toolArguments(part),
            text: toolResultText(part),
            isError: part.resultError !== undefined
              || (part.resultDetails !== null && typeof part.resultDetails === 'object' && part.resultDetails.isError === true),
          },
        })
      }
      continue
    }
    if (REASONING_KINDS.has(kind)) {
      const values = Array.isArray(part.value) ? part.value : [part.value]
      for (const value of values) {
        const text = markdownText(value).trim()
        if (text !== '') items.push({ type: 'block', block: { type: 'reasoning', text } })
      }
      continue
    }
    if (IGNORED_KINDS.has(kind)) continue
    if (kind === 'questionCarousel') {
      const questions = Array.isArray(part.questions) ? part.questions : []
      for (const question of questions) {
        if (question === null || typeof question !== 'object') continue
        const title = typeof question.title === 'string' ? question.title.trim() : ''
        const message = typeof question.message === 'string' ? question.message.trim() : ''
        const text = [title, message].filter((value) => value !== '').join('\n')
        if (text !== '') pushText(items, `\n\n[question] ${text}`)
      }
      continue
    }
    if (kind === 'textEditGroup' || kind === 'notebookEditGroup' || kind === 'externalEdit') {
      // Applied edits are already described by the tool call that produced them.
      continue
    }
    // Everything else is either a markdown fragment (no `kind`) or a part whose
    // only renderable field is a markdown string; forward the text when present.
    const text = markdownText(part)
    if (text !== '') pushText(items, text)
  }
  return items
}

/**
 * Build one candidate row from a session document.
 * @param {object} document replayed session document.
 * @param {string} file session file path.
 * @param {object} stats file stat.
 * @param {{ sessionsDir: string, cwd: string }} store owning store.
 * @param {string} home user home directory.
 * @returns {object} candidate row.
 */
function candidateFromDocument(document, file, stats, store, home) {
  const requests = document.requests
  const firstPrompt = requests.map((request) => userText(request).trim()).find((text) => text !== '')
  const title = normalizeTitle(document.customTitle) || normalizeTitle(firstPrompt)
  const createdAt = typeof document.creationDate === 'number' && Number.isFinite(document.creationDate)
    ? Math.trunc(document.creationDate)
    : Math.trunc(stats.mtimeMs)
  let model = null
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const candidate = requestModel(requests[index])
    if (candidate !== undefined) {
      model = candidate
      break
    }
  }
  if (model === null) {
    const identifier = document.inputState?.selectedModel?.identifier
    if (typeof identifier === 'string' && identifier !== '') model = identifier
  }
  const displayRoot = store.displayRoot.startsWith(`${home}${sep}`)
    ? `~${store.displayRoot.slice(home.length)}`
    : store.displayRoot
  return {
    key: keyFor(file),
    foreignId: typeof document.sessionId === 'string' && document.sessionId !== ''
      ? document.sessionId
      : basename(file).replace(/\.(jsonl|json)$/u, ''),
    title,
    cwd: store.cwd,
    createdAt,
    updatedAt: Math.trunc(stats.mtimeMs),
    messageCount: requests.length,
    sourceLabel: `${id} · ${displayRoot}`,
    model,
  }
}

/**
 * Report whether any VS Code Copilot store exists on this machine.
 *
 * This runs on every import-dialog open (`GET /session-import/sources`), so it
 * only stats the candidate roots and the workspace storage directories.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {Promise<{ available: boolean, roots: string[] }>} availability plus resolved roots.
 */
export async function available(ctx) {
  const stores = await discoverStores(ctx)
  const roots = []
  for (const store of stores) {
    if (!roots.includes(store.displayRoot)) roots.push(store.displayRoot)
  }
  return { available: roots.length > 0, roots }
}

/**
 * List every VS Code Copilot session as import-dialog metadata.
 *
 * Each store is read sequentially: replaying one long session costs a few
 * hundred megabytes of transient memory, so a bounded, serial pass keeps a scan
 * predictable. A single corrupt or unreadable file never fails the list.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @returns {Promise<object[]>} candidate rows, newest first.
 */
export async function listSessions(ctx) {
  const { home } = contextOf(ctx)
  const stores = await discoverStores(ctx)
  const candidates = []
  for (const store of stores) {
    for (const file of await listSessionFiles(store.sessionsDir)) {
      try {
        const stats = await stat(file)
        if (!stats.isFile() || stats.size === 0) continue
        const document = await readSessionDocument(file, stats.size)
        // A chat file VS Code created by opening the panel with no request carries no
        // conversation at all; listing it would only offer an import that the event
        // builder must reject as empty.
        if (!Array.isArray(document.requests) || document.requests.length === 0) continue
        candidates.push(candidateFromDocument(document, file, stats, store, home))
      } catch {
        // Per-file resilience: a session being rewritten, a truncated tail, or a
        // file that is not a chat session is simply absent from this listing.
      }
    }
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
  return candidates
}

/**
 * Convert one session document into the normalized adapter transcript.
 *
 * Mapping:
 * - each `request` starts a user turn (`message.text`, else its text parts);
 * - markdown fragments of `response` concatenate into one assistant text block;
 * - `thinking` parts become reasoning blocks;
 * - `toolInvocationSerialized` becomes a `tool-call` block plus a `tool` message
 *   carrying the recorded result, so the importer can pair them by call id;
 * - progress/UI parts (`progressTaskSerialized`, `codeblockUri`, `undoStop`, …)
 *   carry no conversation content and are dropped.
 * @param {object} document replayed session document.
 * @param {{ cwd: string, updatedAt: number }} meta owning store metadata.
 * @returns {object} normalized session.
 */
function normalizeSession(document, meta) {
  const createdAt = typeof document.creationDate === 'number' && Number.isFinite(document.creationDate)
    ? Math.trunc(document.creationDate)
    : meta.updatedAt
  const messages = []
  for (const request of document.requests) {
    if (request === null || typeof request !== 'object') continue
    if (request.hiddenFromTranscript === true) continue
    const timestamp = requestTimestamp(request, createdAt)
    const prompt = userText(request).trim()
    if (prompt !== '') {
      messages.push({ role: 'user', content: [{ type: 'text', text: prompt }], timestamp })
    }
    const items = responseItems(request.response)
    const model = requestModel(request)
    /** @type {object[]} content blocks of the assistant message being built. */
    const blocks = []
    /**
     * Commit the assistant blocks accumulated for this request.
     * @returns {void}
     */
    const flush = () => {
      if (blocks.length === 0) return
      messages.push({
        role: 'assistant',
        content: blocks.splice(0, blocks.length),
        timestamp,
        provider: 'copilot',
        ...model === undefined ? {} : { model },
      })
    }
    for (const item of items) {
      if (item.type === 'block') {
        blocks.push(item.block)
        continue
      }
      // The tool call closes the assistant message that produced it; the result
      // is its own tool message, which the importer pairs by call id.
      blocks.push({ type: 'tool-call', id: item.tool.callId, name: item.tool.name, arguments: item.tool.arguments })
      flush()
      messages.push({
        role: 'tool',
        toolCallId: item.tool.callId,
        isError: item.tool.isError,
        content: [{ type: 'text', text: item.tool.text }],
        timestamp,
      })
    }
    flush()
  }
  const title = normalizeTitle(document.customTitle) || normalizeTitle(messages.find((message) => message.role === 'user')?.content?.[0]?.text ?? '')
  let model = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' && typeof messages[index].model === 'string') {
      model = messages[index].model
      break
    }
  }
  return {
    foreignId: typeof document.sessionId === 'string' && document.sessionId !== '' ? document.sessionId : '',
    title,
    cwd: meta.cwd,
    createdAt,
    updatedAt: meta.updatedAt,
    model,
    provider: model === null ? null : 'copilot',
    formatVersion: typeof document.version === 'number' ? document.version : 3,
    messages,
  }
}

/**
 * Read and normalize one VS Code Copilot session into the adapter contract.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [ctx] adapter context.
 * @param {string} key candidate key from `listSessions()`.
 * @returns {Promise<object>} normalized session: `foreignId, title, cwd, createdAt,
 *   updatedAt, model, provider, formatVersion, messages`.
 * @throws {Error} when the key, file, or document is unusable.
 */
export async function readSession(ctx, key) {
  const file = await fileForKey(ctx, key)
  let stats
  try {
    stats = await stat(file)
  } catch {
    throw new Error('VS Code Copilot session file not found')
  }
  if (!stats.isFile()) throw new Error('VS Code Copilot session path is not a file')
  const document = await readSessionDocument(file, stats.size)
  const stores = await discoverStores(ctx)
  const store = stores.find((item) => isInside(item.sessionsDir, file))
  if (store === undefined) throw new Error('VS Code Copilot session file is outside every known store')
  return normalizeSession(document, { cwd: store.cwd, updatedAt: Math.trunc(stats.mtimeMs) })
}
