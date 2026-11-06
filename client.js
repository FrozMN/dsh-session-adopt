/**
 * Session adopt (Client half).
 *
 * Adds one sidebar-foot action that asks the Host to rescan durable sessions
 * and place newly discovered ones in their Workspace. The same action also
 * refreshes the Client session catalog, which is the list a running page never
 * re-reads by itself.
 *
 * The Workspace follow stream notifies this component whenever a periodic Host
 * scan attaches a session; when the Workspace snapshot names a session the
 * Client catalog does not know yet, the catalog is refreshed once.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-adopt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-adopt'
    const SCAN_ROUTE = 'session-adopt/scan'
    const STATUS_ROUTE = 'session-adopt/status'

    const EN = {
      'action.label': 'Sync sessions',
      'action.title':
        'Find sessions created in another window or IDE and move them into their Workspace.',
      'action.busy': 'Syncing sessions…',
      'action.last': 'Last sync {time}: {count} session(s) placed.',
      'action.none': 'All sessions are already grouped.',
      'action.new': '{count} new',
      'action.failed': 'Session sync failed',
      'action.refreshFailed': 'Sessions were placed, but the list refresh failed',
      'action.refreshing': 'Refreshing session list…',
    }

    const ZH = {
      'action.label': '同步会话',
      'action.title': '查找在其他窗口或 IDE 中创建、尚未归入工作区的会话，并把它们归置到对应工作区。',
      'action.busy': '正在同步会话…',
      'action.last': '上次同步 {time}：归置 {count} 个会话。',
      'action.none': '所有会话均已归入工作区。',
      'action.new': '新增 {count}',
      'action.failed': '会话同步失败',
      'action.refreshFailed': '会话已归置，但刷新会话列表失败',
      'action.refreshing': '正在刷新会话列表…',
    }

    const EMPTY_SESSION_STATE = { ids: [], phase: 'pending' }
    const EMPTY_WORKSPACE_STATE = { items: [] }

    const CSS = `
.wss-root{display:flex;align-items:center;width:100%}
.wss-button{width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:20px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;overflow:hidden;position:relative}
@media (hover:hover){.wss-button:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.wss-button[data-busy]{cursor:progress}
.wss-button[data-failed]{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}
.wss-button:disabled{cursor:progress}
.wss-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.wss-button-rail{width:36px;height:36px;padding:0;justify-content:center;border-radius:50%}
.wss-icon{flex:none;display:block}
.wss-spin{animation:wss-rotate 1s linear infinite}
@keyframes wss-rotate{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wss-spin{animation:none}}
.wss-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-badge{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums;flex:none}
.wss-button-rail .wss-badge{position:absolute;top:1px;right:1px;min-width:9px;width:9px;height:9px;padding:0;font-size:0;line-height:0}
.wss-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`

    /**
     * Two arrows around a center dot: refresh, not an infinite spinner.
     * @param {{ size: number, spinning?: boolean }} props icon geometry.
     * @returns {import('react').ReactElement} inline SVG.
     */
    function SyncIcon({ size, spinning }) {
      return h(
        'svg',
        {
          className: spinning ? 'wss-icon wss-spin' : 'wss-icon',
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M20 11a8 8 0 0 0-13.7-4.7L4 8.6' }),
        h('path', { d: 'M4 4v4.6h4.6' }),
        h('path', { d: 'M4 13a8 8 0 0 0 13.7 4.7L20 15.4' }),
        h('path', { d: 'M20 20v-4.6h-4.6' }),
      )
    }

    /**
     * Absolute route URL under the document base the shell injects.
     * @param {string} path document-relative route.
     * @returns {string} absolute URL.
     */
    function routeUrl(path) {
      return new URL(path, document.baseURI).toString()
    }

    /**
     * Ask the Host for one scan.
     * @param {'all' | 'active'} scope whether inactive groups are skipped.
     * @returns {Promise<{ ok: true, scan: object }>} accepted scan payload.
     */
    async function postScan(scope) {
      const response = await fetch(routeUrl(SCAN_ROUTE), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope }),
      })
      if (!response.ok) throw new Error(`workspace sync scan failed: HTTP ${response.status}`)
      const payload = await response.json()
      if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'workspace sync scan failed')
      return payload
    }

    /**
     * Read the Host's last scan summary.
     * @returns {Promise<object>} status payload.
     */
    async function fetchStatus() {
      const response = await fetch(routeUrl(STATUS_ROUTE), { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`workspace sync status failed: HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * Re-read the Client Session catalog from the Host.
     * @param {import('@deepseek-ai/cordis').Context} ctx Client root context.
     * @returns {Promise<void>} completion of the baseline pull.
     */
    async function refreshSessions(ctx) {
      const sessions = ctx.get('sessions')
      if (sessions !== null && typeof sessions === 'object' && typeof sessions.refresh === 'function') {
        await sessions.refresh()
      }
    }

    /**
     * Format a scan timestamp for a tooltip.
     * @param {string | undefined} value ISO timestamp.
     * @returns {string} local wall-clock time, or an empty string.
     */
    function formatTime(value) {
      if (value === undefined) return ''
      const time = new Date(value)
      if (Number.isNaN(time.getTime())) return ''
      return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /**
     * Sidebar-foot action: scan on click, announce results, and refresh the
     * session catalog when Workspace membership names an unknown session.
     * @param {object} props slot props plus the plugin's translate and context.
     * @returns {import('react').ReactElement} footer action.
     */
    function SyncAction(props) {
      const { wide = false, useSessions, useWorkspaces, t, syncCtx } = props
      const useSessionState = typeof useSessions === 'function'
        ? useSessions
        : (select) => select(EMPTY_SESSION_STATE)
      const useWorkspaceState = typeof useWorkspaces === 'function'
        ? useWorkspaces
        : (select) => select(EMPTY_WORKSPACE_STATE)

      const sessionIds = useSessionState((state) => state.ids)
      const sessionPhase = useSessionState((state) => state.phase)
      const workspaceItems = useWorkspaceState((state) => state.items)

      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [last, setLast] = React.useState(null)
      const [badge, setBadge] = React.useState(0)
      const [notice, setNotice] = React.useState('')
      const busyRef = React.useRef(false)
      const knownMembersRef = React.useRef(null)
      const refreshGuardRef = React.useRef({ signature: '', at: 0 })
      const focusRef = React.useRef({ busy: false, at: 0 })
      const noticeTimerRef = React.useRef(undefined)

      /** Publish one transient announcement for sighted and assistive users. */
      const announce = (text) => {
        setNotice(text)
        if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(() => setNotice(''), 8000)
      }

      React.useEffect(() => () => {
        if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current)
      }, [])

      React.useEffect(() => {
        let cancelled = false
        fetchStatus()
          .then((payload) => {
            if (!cancelled && payload?.lastScan !== undefined && payload.lastScan !== null) setLast(payload.lastScan)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [])

      /**
       * Workspace membership can name a session this page never fetched: a
       * periodic Host scan just attached one. Refresh the catalog once per
       * distinct unknown set, with a short guard against a refresh loop.
       */
      React.useEffect(() => {
        if (sessionPhase !== 'ready') return
        const known = new Set(sessionIds)
        const missing = []
        for (const workspace of workspaceItems) {
          for (const sessionId of workspace.sessionIds) {
            if (!known.has(sessionId)) missing.push(sessionId)
          }
        }
        if (missing.length === 0) return
        const signature = [...new Set(missing)].sort().join('|')
        const at = Date.now()
        if (refreshGuardRef.current.signature === signature && at - refreshGuardRef.current.at < 30000) return
        refreshGuardRef.current = { signature, at }
        refreshSessions(syncCtx).catch(() => {})
      }, [workspaceItems, sessionIds, sessionPhase, syncCtx])

      /** Surface sessions a background scan added since this page last rendered. */
      React.useEffect(() => {
        if (sessionPhase !== 'ready') return
        const current = new Set()
        for (const workspace of workspaceItems) {
          for (const sessionId of workspace.sessionIds) current.add(sessionId)
        }
        const previous = knownMembersRef.current
        knownMembersRef.current = current
        if (previous === null) return
        let added = 0
        for (const sessionId of current) if (!previous.has(sessionId)) added += 1
        if (added === 0) return
        setBadge(added)
        announce(t('action.new', { count: added }))
      }, [workspaceItems, sessionPhase, t])

      /** Run one explicit full scan, then re-read the session catalog. */
      const runManual = React.useCallback(async () => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        setFailed(false)
        let scanFailed = false
        let listFailed = false
        let finalNotice = t('action.refreshing')
        try {
          const payload = await postScan('all')
          const summary = payload.scan
          setLast(summary)
          const count = summary?.attachedCount ?? 0
          setBadge(count)
          finalNotice = count > 0 ? t('action.new', { count }) : t('action.none')
        } catch {
          scanFailed = true
          finalNotice = t('action.failed')
        }
        try {
          await refreshSessions(syncCtx)
        } catch {
          listFailed = true
        }
        busyRef.current = false
        setBusy(false)
        setFailed(scanFailed)
        announce(scanFailed ? t('action.failed') : listFailed ? t('action.refreshFailed') : finalNotice)
      }, [syncCtx, t])

      /**
       * A window that regains focus is the usual return from an IDE. Ask for
       * an active-only scan; the periodic timer covers the unfocused case.
       */
      React.useEffect(() => {
        const maybeScan = () => {
          if (document.visibilityState !== 'visible') return
          const at = Date.now()
          if (focusRef.current.busy || at - focusRef.current.at < 60000) return
          focusRef.current = { busy: true, at }
          postScan('active')
            .then((payload) => {
              const summary = payload.scan
              if (summary === undefined) return
              setLast(summary)
              const count = summary.attachedCount ?? 0
              if (count > 0) {
                setBadge(count)
                announce(t('action.new', { count }))
              }
            })
            .catch(() => {})
            .finally(() => {
              focusRef.current = { busy: false, at }
              refreshSessions(syncCtx).catch(() => {})
            })
        }
        window.addEventListener('focus', maybeScan)
        document.addEventListener('visibilitychange', maybeScan)
        return () => {
          window.removeEventListener('focus', maybeScan)
          document.removeEventListener('visibilitychange', maybeScan)
        }
      }, [syncCtx, t])

      const lastText = last === null
        ? ''
        : t('action.last', {
            time: formatTime(last.finishedAt),
            count: last.attachedCount ?? 0,
          })
      const title = [t('action.title'), lastText, failed ? t('action.failed') : '']
        .filter((part) => part !== '')
        .join(' · ')

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'wss-root', 'data-session-adopt': 'action' },
          h(
            'button',
            {
              type: 'button',
              className: wide ? 'wss-button' : 'wss-button wss-button-rail',
              'data-busy': busy || undefined,
              'data-failed': failed || undefined,
              'aria-label': t('action.label'),
              'aria-busy': busy || undefined,
              title,
              disabled: busy,
              onClick: runManual,
            },
            h(SyncIcon, { size: wide ? 16 : 18, spinning: busy }),
            wide ? h('span', { className: 'wss-label' }, t('action.label')) : null,
            badge > 0 ? h('span', { className: 'wss-badge', 'aria-hidden': true }, `+${badge}`) : null,
          ),
          h(
            'span',
            { className: 'wss-sr', role: 'status', 'aria-live': 'polite' },
            busy ? t('action.busy') : notice,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionary and the sidebar-foot action.
       * @param {import('@deepseek-ai/cordis').Context} ctx Client root context.
       */
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: EN, zh: ZH }),
          'session-adopt: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'session-adopt',
            order: 20,
            locale: NS,
          },
          (props) => h(SyncAction, { ...props, t, syncCtx: ctx }),
        ))
      },
    }
  },
})
