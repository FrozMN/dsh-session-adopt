/**
 * Deterministic DSH session ids for imported foreign sessions.
 *
 * An import must be idempotent: importing the same foreign session twice must
 * not create two native sessions. The persistence backend is append-only and
 * has no delete/rename API, so the only identity we can rely on is the id
 * itself. Deriving it deterministically from (harness, foreign id) turns
 * "already imported?" into a plain existence check and keeps the mapping
 * reproducible across restarts without a sidecar ledger.
 *
 * UUIDv5 uses SHA-1, which is collision-resistant for this naming use; the
 * plugin has no npm dependencies, so the small UUIDv5 implementation lives
 * here rather than in a package.
 */
import { createHash } from 'node:crypto'

/**
 * Fixed UUID namespace for every id this plugin mints. Changing it is a
 * breaking change: older imports would stop being recognized as duplicates.
 */
const SESSION_ADOPT_NAMESPACE = '5d8f4b1e-6a2c-5f7d-9b3e-1c4a7e2d8f60'

/** Prefix every durable DSH session id carries. */
const SESSION_ID_PREFIX = 'session-'

/**
 * Parse a canonical UUID into its 16 bytes.
 * @param {string} uuid lower-case hyphenated UUID.
 * @returns {Buffer} the 16 raw bytes.
 */
function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

/**
 * Format 16 raw bytes as a lower-case hyphenated UUID.
 * @param {Buffer} bytes exactly 16 bytes.
 * @returns {string} canonical UUID text.
 */
function formatUuid(bytes) {
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Compute a name-based (v5) UUID over UTF-8 input.
 * @param {string} name namespaced name to hash.
 * @returns {string} canonical UUID text.
 */
function uuidv5(name) {
  const hash = createHash('sha1')
  hash.update(uuidBytes(SESSION_ADOPT_NAMESPACE))
  hash.update(Buffer.from(name, 'utf8'))
  const bytes = hash.digest().subarray(0, 16)
  // Version 5 in the high nibble of time_hi_and_version, RFC 4122 variant in clock_seq_hi.
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return formatUuid(bytes)
}

/**
 * Derive the durable DSH session id for one foreign session.
 *
 * `sourceKey` is the adapter's opaque candidate key (harness id plus an encoded
 * relative path). It is the fallback identity when the foreign format does not
 * expose a stable id of its own.
 * @param {string} harness adapter id, for example `pi`.
 * @param {string | undefined} foreignId session id reported by the foreign store.
 * @param {string} sourceKey adapter candidate key.
 * @returns {string} `session-<uuid>` in the DSH convention.
 */
export function importedSessionId(harness, foreignId, sourceKey) {
  const identity = typeof foreignId === 'string' && foreignId.length > 0 ? foreignId : sourceKey
  return SESSION_ID_PREFIX + uuidv5(`dsh-session-adopt:1:${harness}:${identity}`)
}

/**
 * Whether a session id looks like one this plugin minted.
 * @param {string} id candidate session id.
 * @returns {boolean} true when the id follows the deterministic import form.
 */
export function isImportedSessionId(id) {
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)
}
