/**
 * Harness adapter discovery.
 *
 * Each adapter is a small, dependency-free module that knows how to find one
 * foreign harness's session store and translate its sessions into the
 * normalized transcript this plugin imports. Adapters are optional: a checkout
 * that ships only the pi adapter must still load, and a broken adapter must
 * degrade into a per-adapter scan error instead of taking the plugin down.
 * Dynamic import with `allSettled` gives that isolation without a build step.
 */
import os from 'node:os'

/** Built-in adapter modules, imported lazily and tolerated when absent. */
const BUILTIN_MODULES = ['./pi.js', './copilot.js', './claude-code.js', './codex.js', './gemini.js', './opencode.js']

/** Functions every adapter module must export. */
const REQUIRED_FUNCTIONS = ['available', 'listSessions', 'readSession']

/**
 * Build the read-only environment handed to adapters.
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [overrides] test seams.
 * @returns {{ home: string, env: NodeJS.ProcessEnv, platform: string }} adapter context.
 */
export function adapterContext(overrides) {
  return {
    home: overrides?.home ?? os.homedir(),
    env: overrides?.env ?? process.env,
    platform: overrides?.platform ?? process.platform,
  }
}

/**
 * Validate one adapter module against the contract in `PLAN.md` §4.4.
 * @param {unknown} module imported module namespace.
 * @returns {{ id: string, title: { en: string, zh: string }, available: Function, listSessions: Function, readSession: Function }} validated adapter.
 * @throws {Error} when the module cannot serve as an adapter.
 */
export function validateAdapter(module) {
  if (module === null || typeof module !== 'object') throw new Error('adapter module is not an object')
  const candidate = module
  if (typeof candidate.id !== 'string' || candidate.id === '') throw new Error('adapter is missing a non-empty id')
  const title = candidate.title
  if (title === null || typeof title !== 'object' || typeof title.en !== 'string' || typeof title.zh !== 'string') {
    throw new Error(`adapter "${candidate.id}" is missing en/zh titles`)
  }
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof candidate[name] !== 'function') throw new Error(`adapter "${candidate.id}" is missing ${name}()`)
  }
  return candidate
}

/**
 * Import every built-in adapter that exists on disk.
 * @param {string[]} [modules] module specifiers to try, relative to this file.
 * @returns {Promise<{ adapters: object[], errors: { module: string, message: string }[] }>} discovered adapters.
 */
export async function loadAdapters(modules = BUILTIN_MODULES) {
  const results = await Promise.allSettled(modules.map((module) => import(module)))
  const adapters = []
  const errors = []
  const seen = new Set()
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      // Absent optional adapters are expected: a checkout may ship any subset.
      // A missing file reports its basename (the absolute path also appears in
      // the message for the importer itself), so match on that, not on the
      // relative specifier.
      const reason = result.reason
      const basename = modules[index].split('/').at(-1)
      if (reason?.code === 'ERR_MODULE_NOT_FOUND' && String(reason.message).includes(basename)) return
      errors.push({ module: modules[index], message: reason instanceof Error ? reason.message : String(reason) })
      return
    }
    try {
      const adapter = validateAdapter(result.value)
      if (seen.has(adapter.id)) throw new Error(`duplicate adapter id "${adapter.id}"`)
      seen.add(adapter.id)
      adapters.push(adapter)
    } catch (error) {
      errors.push({ module: modules[index], message: error instanceof Error ? error.message : String(error) })
    }
  })
  return { adapters, errors }
}
