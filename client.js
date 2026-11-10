/**
 * Session adopt (Client half).
 *
 * Two sidebar-foot actions:
 * 1. Sync sessions — asks the Host to rescan durable sessions and place newly
 *    discovered ones in their Workspace, then refreshes the Client session
 *    catalog (the list a running page never re-reads by itself).
 * 2. Import sessions — opens a modal dialog that lists sessions found in other
 *    local agent harnesses (pi, Claude Code, …), lets the user pick some, and
 *    has the Host convert them into native DSH sessions attached to a matching
 *    Workspace.
 *
 * The Workspace follow stream notifies the sync action whenever a periodic Host
 * scan attaches a session; when the Workspace snapshot names a session the
 * Client catalog does not know yet, the catalog is refreshed once. After a
 * successful import the same follow stream carries the new/updated Workspace,
 * so only the session catalog needs an explicit refresh.
 *
 * Everything runs inside the factory: this file is served verbatim and its
 * module body is registered before materialization, so no browser global may be
 * touched at script top level.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-adopt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // `react-dom` is a platform seed module of the web shell. A loader change is
    // out of our control, so a missing portal renderer degrades to an inline
    // fixed layer instead of breaking the whole client module.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    const NS = 'session-adopt'
    const SCAN_ROUTE = 'session-adopt/scan'
    const STATUS_ROUTE = 'session-adopt/status'
    const IMPORT_SOURCES_ROUTE = 'session-import/sources'
    const IMPORT_SCAN_ROUTE = 'session-import/scan'
    const IMPORT_IMPORT_ROUTE = 'session-import/import'
    const IMPORT_STATUS_ROUTE = 'session-import/status'

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

      'import.action.label': 'Import sessions',
      'import.action.title':
        'Import sessions from other agent harnesses (for example pi) into a matching workspace.',
      'import.dialog.title': 'Import external sessions',
      'import.dialog.subtitle':
        'Copy sessions from other agent harnesses into DSH. Their original files are never modified.',
      'import.dialog.close': 'Close dialog',
      'import.dialog.closeAction': 'Close',
      'import.status.scanning': 'Scanning for external sessions…',
      'import.status.importing': 'Importing selected sessions…',
      'import.loading': 'Looking for sessions from other agent harnesses…',
      'import.error.disabled': 'Cross-harness session import is disabled in this profile.',
      'import.error.unauthorized':
        'The import service refused this request (session not authorized). Try reloading the page.',
      'import.error.unavailable':
        'The import service is not available in this DSH build. Update the plugin or check the host routes.',
      'import.error.http': 'The import service request failed (HTTP {status}).',
      'import.error.network': 'Could not reach the import service: {message}',
      'import.error.server': 'The import service reported an error: {message}',
      'import.retry': 'Retry',
      'import.rescan': 'Rescan',
      'import.adapters': 'Harnesses',
      'import.adapter.available': 'available',
      'import.adapter.unavailable': 'unavailable',
      'import.summary': 'Found {count} session(s) from {harnesses} harness(es)',
      'import.summary.truncated': 'Showing the first {shown} of {total}.',
      'import.partial': '{count} harness(es) reported errors during the scan.',
      'import.selectAll': 'Select all',
      'import.clear': 'Clear',
      'import.selected': '{count} selected',
      'import.submit': 'Import selected ({count})',
      'import.listLabel': 'External sessions',
      'import.empty.title': 'No external sessions found',
      'import.empty.hint':
        'No sessions matched the registered harnesses. Create a session in another harness, then rescan.',
      'import.row.untitled': '(untitled session)',
      'import.row.messages': '{count} message(s)',
      'import.row.updated': 'Updated {time}',
      'import.row.workspaceExisting': '→ {title}',
      'import.row.workspaceNew': '→ new workspace: {path}',
      'import.row.workspaceUnavailable': '→ workspace unavailable',
      'import.row.unavailableHint':
        'This session’s working directory cannot be resolved on this machine, so it cannot be imported.',
      'import.row.check': 'Select {title}',
      'import.outcome.imported': 'Imported into {workspace}',
      'import.outcome.skipped': 'Already imported · {workspace}',
      'import.outcome.error': 'Import failed: {message}',
      'import.result.summary': 'Imported {imported}, already imported {skipped}, failed {failed}.',
      'import.result.workspaces': '{count} new workspace(s) created.',
      'import.result.refreshFailed':
        'The session list could not be refreshed automatically; reload the page to see the imported sessions.',
      'import.footer.idle': 'Select sessions to import',
      'import.time.justNow': 'just now',
      'import.time.minutes': '{count} min ago',
      'import.time.hours': '{count} h ago',
      'import.time.days': '{count} d ago',
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

      'import.action.label': '导入会话',
      'import.action.title': '把其他智能体工具（例如 pi）中的会话导入到对应工作区。',
      'import.dialog.title': '导入外部会话',
      'import.dialog.subtitle': '把其他智能体工具中的会话复制到 DSH；原始文件不会被修改。',
      'import.dialog.close': '关闭对话框',
      'import.dialog.closeAction': '关闭',
      'import.status.scanning': '正在扫描外部会话…',
      'import.status.importing': '正在导入所选会话…',
      'import.loading': '正在查找其他智能体工具中的会话…',
      'import.error.disabled': '当前配置已禁用跨工具会话导入。',
      'import.error.unauthorized': '导入服务拒绝了这个请求（会话未授权）。请刷新页面后重试。',
      'import.error.unavailable': '当前 DSH 版本没有提供导入服务。请更新插件或检查宿主路由。',
      'import.error.http': '导入服务请求失败（HTTP {status}）。',
      'import.error.network': '无法连接导入服务：{message}',
      'import.error.server': '导入服务返回错误：{message}',
      'import.retry': '重试',
      'import.rescan': '重新扫描',
      'import.adapters': '工具',
      'import.adapter.available': '可用',
      'import.adapter.unavailable': '不可用',
      'import.summary': '在 {harnesses} 个工具中找到 {count} 个会话',
      'import.summary.truncated': '仅显示前 {shown} 个，共 {total} 个。',
      'import.partial': '扫描期间有 {count} 个工具报告了错误。',
      'import.selectAll': '全选',
      'import.clear': '清除',
      'import.selected': '已选 {count} 个',
      'import.submit': '导入所选（{count}）',
      'import.listLabel': '外部会话',
      'import.empty.title': '未找到外部会话',
      'import.empty.hint': '已注册的工具中都没有可导入的会话。请先在另一个工具中创建会话，然后重新扫描。',
      'import.row.untitled': '（无标题会话）',
      'import.row.messages': '{count} 条消息',
      'import.row.updated': '更新于 {time}',
      'import.row.workspaceExisting': '→ {title}',
      'import.row.workspaceNew': '→ 新建工作区：{path}',
      'import.row.workspaceUnavailable': '→ 工作区不可用',
      'import.row.unavailableHint': '无法解析该会话的工作目录，因此不能导入。',
      'import.row.check': '选择 {title}',
      'import.outcome.imported': '已导入到 {workspace}',
      'import.outcome.skipped': '此前已导入 · {workspace}',
      'import.outcome.error': '导入失败：{message}',
      'import.result.summary': '导入 {imported} 个，此前已导入 {skipped} 个，失败 {failed} 个。',
      'import.result.workspaces': '新建 {count} 个工作区。',
      'import.result.refreshFailed': '无法自动刷新会话列表，请刷新页面查看导入的会话。',
      'import.footer.idle': '请选择要导入的会话',
      'import.time.justNow': '刚刚',
      'import.time.minutes': '{count} 分钟前',
      'import.time.hours': '{count} 小时前',
      'import.time.days': '{count} 天前',
    }

    const EMPTY_SESSION_STATE = { ids: [], phase: 'pending' }
    const EMPTY_WORKSPACE_STATE = { items: [] }

    /** Elements a focus trap cycles through, matching the shell's modal layer. */
    const TABBABLE =
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

    const CSS = `
.wss-root{display:flex;align-items:center;width:100%;min-width:0}
/* The shell renders sidebar.footer.action as a flex row. Our outlet anchor is
   display:contents, so the slot anchor's DOM parent is the real flex box; stack
   the entries there instead of letting two full-width actions split the row. */
@supports selector(:has(*)){*:has(> [data-slot='sidebar.footer.action']){flex-direction:column;gap:2px;align-items:stretch}}
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
.wss-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.wss-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}
.wss-dialog{position:relative;z-index:1;display:flex;flex-direction:column;width:760px;max-width:100%;max-height:min(80vh,820px);border-radius:var(--dsw-radius-panel,20px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-prominent,0 24px 64px #0000002e);overflow:hidden;color:var(--dsw-alias-label-primary)}
.wss-dialog:focus{outline:none}
.wss-dialog-header{display:flex;align-items:flex-start;gap:12px;padding:20px 20px 12px 24px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wss-dialog-titles{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.wss-dialog-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.wss-dialog-title:focus{outline:none}
.wss-dialog-subtitle{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.wss-icon-btn{flex:none;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
@media (hover:hover){.wss-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.wss-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wss-dialog-body{flex:1;min-height:0;overflow-y:auto;padding:14px 24px 10px;display:flex;flex-direction:column;gap:10px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.wss-dialog-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px 16px 24px;border-top:.5px solid var(--dsw-alias-border-l2)}
.wss-footer-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-btn{height:32px;padding:0 14px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;flex:none}
@media (hover:hover){.wss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.wss-btn:disabled{opacity:.45;cursor:default}
.wss-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wss-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
@media (hover:hover){.wss-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}}
.wss-link-btn{padding:0;border:none;background:none;color:var(--dsw-alias-link,var(--dsw-alias-label-secondary));font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.wss-link-btn:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.wss-link-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:2px}
.wss-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wss-summary{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.wss-toolbar-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.wss-adapters{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.wss-adapters-label{font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption)}
.wss-adapter{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;white-space:nowrap}
.wss-adapter[data-available=false]{color:var(--dsw-alias-label-caption)}
.wss-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.wss-adapter[data-available=false] .wss-dot{background:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-caption))}
.wss-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.wss-row{display:flex;align-items:flex-start;gap:10px;padding:10px 8px;border-radius:var(--dsw-radius-md,12px);border-top:.5px solid var(--dsw-alias-border-l1);min-width:0}
.wss-row:first-child{border-top:none}
@media (hover:hover){.wss-row:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.wss-row-check{flex:none;display:flex;align-items:center;justify-content:center;width:18px;height:22px}
.wss-row-check input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.wss-check-mark{color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:22px}
.wss-row-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.wss-row-head{display:flex;align-items:center;gap:8px;min-width:0}
.wss-harness{flex:none;height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.wss-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.wss-time{flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.wss-cwd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.wss-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-width:0}
.wss-meta-item{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-model{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}
.wss-workspace-target{color:var(--dsw-alias-label-secondary)}
.wss-outcome{margin-top:2px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.wss-outcome[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.wss-outcome[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.wss-outcome[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.wss-outcome-session{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.wss-banner{padding:10px 12px;border-radius:var(--dsw-radius-md,12px);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.wss-banner-success{background:var(--dsw-alias-state-success-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-success-primary)}
.wss-banner-warn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.wss-banner-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.wss-banner-info{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.wss-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
.wss-loading-icon{color:var(--dsw-alias-label-tertiary)}
.wss-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 12px;text-align:center}
.wss-empty-icon{color:var(--dsw-alias-label-tertiary)}
.wss-empty-title{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.wss-empty-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);max-width:440px}
.wss-note{font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption)}
@media (max-width:767px){.wss-overlay{padding:0}.wss-dialog{max-height:100vh;height:100%;width:100%;border-radius:0}}
`

    /**
     * Absolute route URL under the document base the shell injects.
     * @param {string} path document-relative route.
     * @returns {string} absolute URL.
     */
    function routeUrl(path) {
      return new URL(path, document.baseURI).toString()
    }

    /**
     * Read the Client locale id used to pick bilingual host-provided titles.
     * @param {object} ctx Client root context.
     * @returns {string} active locale id, or 'en' when unavailable.
     */
    function activeLocale(ctx) {
      try {
        const face = ctx?.locale
        const snapshot = typeof face?.getLocale === 'function' ? face.getLocale() : null
        return typeof snapshot?.active === 'string' ? snapshot.active : 'en'
      } catch {
        return 'en'
      }
    }

    /**
     * Pick a bilingual `{ en, zh }` host title for the active locale.
     * @param {unknown} title candidate title object.
     * @param {string} lang active locale id.
     * @returns {string} display title, or '' when the value is unusable.
     */
    function localizedTitle(title, lang) {
      if (title === null || typeof title !== 'object') return ''
      const preferred = lang === 'zh' ? title.zh : title.en
      if (typeof preferred === 'string' && preferred !== '') return preferred
      return typeof title.en === 'string' ? title.en : ''
    }

    /** Inline SVG refresh glyph used by the legacy sync action. */
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

    /** Inline SVG import glyph: an arrow dropping into a tray. */
    function ImportIcon({ size, spinning }) {
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
        h('path', { d: 'M12 3v10' }),
        h('path', { d: 'M7.5 8.5 12 13l4.5-4.5' }),
        h('path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }),
      )
    }

    /** Inline SVG close glyph. */
    function CloseIcon({ size }) {
      return h(
        'svg',
        {
          className: 'wss-icon',
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
        h('path', { d: 'M6 6l12 12' }),
        h('path', { d: 'M18 6 6 18' }),
      )
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
     * Stable failure shape for one import-service request.
     * `status` is 0 for transport failures; `code` mirrors the JSON error code
     * (`disabled`, `invalid-request`, …) so callers can localize the outcome.
     */
    class ImportRequestError extends Error {
      /**
       * @param {number} status HTTP status, or 0 for transport failure.
       * @param {string} code stable failure code.
       * @param {string} message server or transport message (may be empty).
       */
      constructor(status, code, message) {
        super(message)
        this.name = 'ImportRequestError'
        this.status = status
        this.code = code
      }
    }

    /**
     * Whether a thrown value is a fetch abort.
     * @param {unknown} error thrown value.
     * @returns {boolean} true for AbortError.
     */
    function isAbortError(error) {
      return error !== null && typeof error === 'object' && error?.name === 'AbortError'
    }

    /**
     * One same-origin JSON request against the import routes.
     *
     * The Host answers JSON `{ ok: false, error: { code?, message? } }` for route
     * failures and empty-body 401/403/404/405 for transport/authorization
     * failures; both become {@link ImportRequestError}.
     * @param {string} path document-relative route.
     * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options] request options.
     * @returns {Promise<object>} validated `{ ok: true, ... }` payload.
     */
    async function requestJson(path, options = {}) {
      const method = options.method ?? 'GET'
      const headers = { accept: 'application/json' }
      const init = { method, credentials: 'same-origin', headers, signal: options.signal }
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(routeUrl(path), init)
      } catch (error) {
        if (isAbortError(error)) throw error
        throw new ImportRequestError(0, 'network', error instanceof Error ? error.message : String(error))
      }
      const contentType = response.headers?.get?.('content-type') ?? ''
      let payload = null
      if (contentType.includes('application/json')) {
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        const failure = payload?.error
        const code = typeof failure?.code === 'string' ? failure.code : 'http'
        const message = typeof failure?.message === 'string' ? failure.message : ''
        throw new ImportRequestError(response.status, code, message)
      }
      if (payload === null || payload.ok !== true) {
        throw new ImportRequestError(response.status, 'invalid-response', '')
      }
      return payload
    }

    /**
     * Turn one request failure into localized copy.
     * @param {unknown} error thrown value.
     * @param {(key: string, params?: object) => string} t bound translator.
     * @returns {string} user-facing message.
     */
    function describeFailure(error, t) {
      if (error instanceof ImportRequestError) {
        if (error.code === 'disabled') return t('import.error.disabled')
        if (error.code === 'network') return t('import.error.network', { message: error.message })
        if (error.status === 401 || error.status === 403) return t('import.error.unauthorized')
        if (error.status === 404) return t('import.error.unavailable')
        if (error.message !== '') return t('import.error.server', { message: error.message })
        return t('import.error.http', { status: error.status })
      }
      return t('import.error.network', {
        message: error instanceof Error ? error.message : String(error),
      })
    }

    /**
     * Compact relative time for a row timestamp.
     * @param {number} epochMs row instant.
     * @param {number} now current instant.
     * @param {(key: string, params?: object) => string} t bound translator.
     * @returns {string} relative label, or '' for an unusable value.
     */
    function relativeTime(epochMs, now, t) {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return ''
      const minutes = Math.floor(Math.max(0, now - epochMs) / 60000)
      if (minutes < 1) return t('import.time.justNow')
      if (minutes < 60) return t('import.time.minutes', { count: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('import.time.hours', { count: hours })
      return t('import.time.days', { count: Math.floor(hours / 24) })
    }

    /**
     * Absolute local timestamp for a tooltip.
     * @param {number} epochMs row instant.
     * @returns {string} localized date-time, or '' for an unusable value.
     */
    function absoluteTime(epochMs) {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return ''
      try {
        return new Date(epochMs).toLocaleString()
      } catch {
        return ''
      }
    }

    /**
     * Portal the dialog layer into the document body when react-dom is present.
     * @param {import('react').ReactElement} node modal element tree.
     * @returns {import('react').ReactElement} portalled or inline element.
     */
    function portal(node) {
      if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(node, document.body)
      }
      return node
    }

    /**
     * Register the plugin stylesheet on the document head.
     *
     * The CSS lives here instead of inside a rendered `<style>` element because
     * the modal layer is portalled into `document.body`; a single head
     * stylesheet covers both the sidebar foot and the portalled dialog, and the
     * disposer lets the plugin manager unload cleanly.
     * @returns {() => void} removal of this generation's style element.
     */
    function injectStyles() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-session-adopt'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /**
     * Modal layer behavior: initial focus, Tab containment, Escape dismissal, and
     * focus restoration. Mirrors the shell's `useModalLayer` conventions
     * (`[data-modal-autofocus]`, panel `tabIndex=-1`, close on Escape).
     * @param {{ current: HTMLElement | null }} panelRef dialog panel ref.
     * @param {() => void} onClose dismissal callback.
     * @param {{ current: HTMLElement | null } | undefined} [returnFocusRef] explicit focus target on close.
     */
    function useModalBehavior(panelRef, onClose, returnFocusRef) {
      const closeRef = React.useRef(onClose)
      closeRef.current = onClose
      React.useEffect(() => {
        const panel = panelRef.current
        if (panel === null || typeof panel.querySelectorAll !== 'function') return undefined
        const doc = panel.ownerDocument
        const active = doc?.activeElement
        const restore = active !== null && active !== undefined && typeof active.focus === 'function' ? active : null
        const tabbables = () => {
          return Array.from(panel.querySelectorAll(TABBABLE)).filter((element) => {
            if (element.closest?.('[inert], [hidden]') != null) return false
            return element.disabled !== true
          })
        }
        const initial = panel.querySelector('[data-modal-autofocus]') ?? tabbables()[0] ?? panel
        if (typeof initial.focus === 'function') initial.focus({ preventScroll: true })
        const onKeyDown = (event) => {
          if (
            event.defaultPrevented ||
            event.isComposing ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.keyCode === 229
          ) {
            return
          }
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault()
            if (!event.repeat) closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = tabbables()
          if (items.length === 0) {
            event.preventDefault()
            panel.focus({ preventScroll: true })
            return
          }
          const focused = doc?.activeElement
          const index = items.indexOf(focused)
          const step = event.shiftKey ? -1 : 1
          const next = index === -1
            ? (event.shiftKey ? items.length - 1 : 0)
            : (index + step + items.length) % items.length
          event.preventDefault()
          items[next].focus({ preventScroll: true })
        }
        doc?.addEventListener('keydown', onKeyDown)
        return () => {
          doc?.removeEventListener('keydown', onKeyDown)
          const explicit = returnFocusRef?.current
          const target = explicit !== null && explicit !== undefined && explicit.isConnected !== false
            ? explicit
            : restore
          if (target !== null && target !== undefined && target.isConnected !== false && typeof target.focus === 'function') {
            target.focus({ preventScroll: true })
          }
        }
      }, [panelRef, returnFocusRef])
    }

    /**
     * One adapter availability chip for the dialog header line.
     * @param {object} adapter scan/sources adapter report.
     * @param {string} lang active locale id.
     * @param {(key: string, params?: object) => string} t bound translator.
     * @returns {import('react').ReactElement} adapter chip.
     */
    function adapterChip(adapter, lang, t) {
      const name = localizedTitle(adapter?.title, lang) || String(adapter?.id ?? '')
      const available = adapter?.available === true
      const roots = Array.isArray(adapter?.roots) ? adapter.roots.filter((root) => typeof root === 'string') : []
      const count = Number.isFinite(adapter?.sessionCount) ? adapter.sessionCount : null
      const state = available
        ? count === null
          ? ''
          : ` · ${count}`
        : ` · ${t('import.adapter.unavailable')}`
      return h(
        'span',
        {
          key: String(adapter?.id ?? name),
          className: 'wss-adapter',
          'data-available': available ? 'true' : 'false',
          title: roots.length > 0 ? roots.join('\n') : undefined,
        },
        h('span', { className: 'wss-dot', 'aria-hidden': true }),
        `${name}${state}`,
        h('span', { className: 'wss-sr' }, available ? t('import.adapter.available') : t('import.adapter.unavailable')),
      )
    }

    /**
     * Resolve the workspace hint copy for one candidate row.
     * @param {object} candidate scanned candidate.
     * @param {(key: string, params?: object) => string} t bound translator.
     * @returns {{ text: string, title?: string, unavailable: boolean }} hint copy.
     */
    function workspaceHintCopy(candidate, t) {
      const hint = candidate?.workspaceHint
      if (hint === null || hint === undefined || typeof hint !== 'object') {
        return { text: t('import.row.workspaceUnavailable'), unavailable: true }
      }
      if (hint.kind === 'existing') {
        return {
          text: t('import.row.workspaceExisting', { title: String(hint.title ?? '') }),
          title: typeof hint.path === 'string' ? hint.path : undefined,
          unavailable: false,
        }
      }
      if (hint.kind === 'new') {
        return {
          text: t('import.row.workspaceNew', { path: String(hint.path ?? '') }),
          title: typeof hint.title === 'string' ? hint.title : undefined,
          unavailable: false,
        }
      }
      return { text: t('import.row.workspaceUnavailable'), unavailable: true }
    }

    /**
     * Row-level outcome copy after an import run.
     * @param {{ status: string, message?: string, workspaceTitle?: string, sessionId?: string }} outcome per-candidate result.
     * @param {(key: string, params?: object) => string} t bound translator.
     * @returns {{ tone: string, text: string, session: string }} outcome presentation.
     */
    function outcomeCopy(outcome, t) {
      if (outcome === null || outcome === undefined) return null
      if (outcome.status === 'imported') {
        return {
          tone: 'success',
          text: t('import.outcome.imported', { workspace: String(outcome.workspaceTitle ?? '') }),
          session: typeof outcome.sessionId === 'string' ? outcome.sessionId : '',
        }
      }
      if (outcome.status === 'skipped') {
        return {
          tone: 'warn',
          text: t('import.outcome.skipped', { workspace: String(outcome.workspaceTitle ?? '') }),
          session: typeof outcome.sessionId === 'string' ? outcome.sessionId : '',
        }
      }
      return {
        tone: 'error',
        text: t('import.outcome.error', { message: String(outcome.message ?? '') }),
        session: '',
      }
    }

    /**
     * Legacy sidebar-foot action: scan on click, announce results, and refresh
     * the session catalog when Workspace membership names an unknown session.
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

    /**
     * Candidate list row: checkbox (or resolved marker), title, harness badge,
     * cwd, relative updated time, message/model metadata, workspace hint, and a
     * per-row import outcome once the Host reports one.
     * @param {object} props row inputs and callbacks.
     * @returns {import('react').ReactElement} one list row.
     */
    function CandidateRow(props) {
      const { candidate, outcome, selected, lang, now, t, onToggle } = props
      const title = typeof candidate.title === 'string' && candidate.title !== ''
        ? candidate.title
        : t('import.row.untitled')
      const harness = localizedTitle(candidate.harnessTitle, lang) || String(candidate.harness ?? '')
      const importable = candidate.importable !== false
      const resolved = outcome !== undefined && outcome.status !== 'error'
      const hint = workspaceHintCopy(candidate, t)
      const updated = relativeTime(candidate.updatedAt, now, t)
      const updatedTitle = absoluteTime(candidate.updatedAt)
      const copy = outcome === undefined ? null : outcomeCopy(outcome, t)
      const checkbox = importable && !resolved
      return h(
        'li',
        {
          className: 'wss-row',
          'data-harness': String(candidate.harness ?? ''),
          'data-resolved': resolved ? 'true' : undefined,
          'data-outcome': outcome?.status,
        },
        h(
          'span',
          { className: 'wss-row-check' },
          checkbox
            ? h('input', {
                type: 'checkbox',
                checked: selected,
                'aria-label': t('import.row.check', { title }),
                onChange: (event) => onToggle(candidate.key, event.target.checked),
              })
            : resolved
              ? h('span', { className: 'wss-check-mark', 'aria-hidden': true }, '✓')
              : h('span', { className: 'wss-sr' }, t('import.row.workspaceUnavailable')),
        ),
        h(
          'div',
          { className: 'wss-row-main' },
          h(
            'div',
            { className: 'wss-row-head' },
            h('span', { className: 'wss-harness' }, harness),
            h('span', { className: 'wss-title', title }, title),
            updated !== ''
              ? h('span', { className: 'wss-time', title: updatedTitle !== '' ? t('import.row.updated', { time: updatedTitle }) : undefined }, updated)
              : null,
          ),
          importable
            ? h(
                'span',
                {
                  className: 'wss-cwd',
                  title: [candidate.sourceLabel, candidate.cwd].filter((part) => typeof part === 'string' && part !== '').join('\n'),
                },
                typeof candidate.cwd === 'string' && candidate.cwd !== ''
                  ? candidate.cwd
                  : t('import.row.workspaceUnavailable'),
              )
            : h('span', { className: 'wss-cwd', title: t('import.row.unavailableHint') }, t('import.row.workspaceUnavailable')),
          h(
            'span',
            { className: 'wss-meta' },
            Number.isFinite(candidate.messageCount)
              ? h('span', { className: 'wss-meta-item' }, t('import.row.messages', { count: candidate.messageCount }))
              : null,
            typeof candidate.model === 'string' && candidate.model !== ''
              ? h('span', { className: 'wss-meta-item wss-model', title: candidate.model }, candidate.model)
              : null,
            h(
              'span',
              {
                className: 'wss-meta-item wss-workspace-target',
                title: hint.title,
                'data-unavailable': hint.unavailable ? 'true' : undefined,
              },
              hint.text,
            ),
          ),
          copy === null
            ? null
            : h(
                'span',
                {
                  className: 'wss-outcome',
                  'data-tone': copy.tone,
                  role: 'status',
                },
                copy.text,
                copy.session !== ''
                  ? [
                      h('span', { key: 'sep', 'aria-hidden': true }, ' · '),
                      h('span', { key: 'session', className: 'wss-outcome-session' }, copy.session),
                    ]
                  : null,
              ),
        ),
      )
    }

    /**
     * The import modal: portalled dialog layer with header, body states, footer.
     * All data and callbacks are owned by {@link ImportAction}; this component
     * only renders and manages modal focus behavior.
     * @param {object} props dialog state, candidates, and callbacks.
     * @returns {import('react').ReactElement} body-portalled dialog.
     */
    function ImportDialog(props) {
      const {
        phase,
        scanning,
        importing,
        scan,
        error,
        scanError,
        importError,
        result,
        catalogFailed,
        selected,
        adapters,
        candidates,
        selectable,
        allSelected,
        selectedCount,
        outcomes,
        notice,
        lang,
        t,
        onClose,
        onRetry,
        onRescan,
        onToggle,
        onSelectAll,
        onClear,
        onImport,
        returnFocusRef,
      } = props
      const titleId = React.useId()
      const panelRef = React.useRef(null)
      useModalBehavior(panelRef, onClose, returnFocusRef)
      const now = Date.now()
      const busy = scanning || importing
      const ready = phase === 'ready'
      const initialLoading = phase === 'loading'
      const summaryCount = Number.isFinite(scan?.candidateCount) ? scan.candidateCount : candidates.length
      const harnessCount = new Set(candidates.map((candidate) => String(candidate.harness ?? ''))).size
      const partialErrors = Array.isArray(scan?.errors) ? scan.errors : []
      const truncated = scan?.truncated === true
      const banners = []
      if (result !== null && result !== undefined) {
        const importedCount = Array.isArray(result.imported) ? result.imported.length : 0
        const skippedCount = Array.isArray(result.skipped) ? result.skipped.length : 0
        const failedCount = Array.isArray(result.errors) ? result.errors.length : 0
        const createdCount = Number.isFinite(result.createdWorkspaceCount) ? result.createdWorkspaceCount : 0
        const parts = [t('import.result.summary', { imported: importedCount, skipped: skippedCount, failed: failedCount })]
        if (createdCount > 0) parts.push(t('import.result.workspaces', { count: createdCount }))
        if (catalogFailed) parts.push(t('import.result.refreshFailed'))
        banners.push(
          h(
            'div',
            {
              key: 'result',
              className: failedCount > 0 || catalogFailed ? 'wss-banner wss-banner-warn' : 'wss-banner wss-banner-success',
              role: 'status',
            },
            parts.join(' '),
          ),
        )
      }
      if (importError !== '') {
        banners.push(h('div', { key: 'import-error', className: 'wss-banner wss-banner-error', role: 'alert' }, importError))
      }
      if (scanError !== '') {
        banners.push(h('div', { key: 'scan-error', className: 'wss-banner wss-banner-warn', role: 'status' }, scanError))
      }
      const adaptersLine = adapters.length === 0
        ? null
        : h(
            'div',
            { className: 'wss-adapters', 'aria-label': t('import.adapters') },
            h('span', { className: 'wss-adapters-label', 'aria-hidden': true }, t('import.adapters')),
            adapters.map((adapter) => adapterChip(adapter, lang, t)),
          )
      const toolbar = ready
        ? h(
            'div',
            { className: 'wss-toolbar' },
            h(
              'span',
              { className: 'wss-summary' },
              scanning ? h(ImportIcon, { size: 12, spinning: true }) : null,
              h(
                'span',
                null,
                scanning
                  ? t('import.status.scanning')
                  : t('import.summary', { count: summaryCount, harnesses: harnessCount }),
              ),
            ),
            h(
              'span',
              { className: 'wss-toolbar-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'wss-link-btn',
                  disabled: busy || selectable.length === 0 || allSelected,
                  onClick: onSelectAll,
                },
                t('import.selectAll'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wss-link-btn',
                  disabled: busy || selectedCount === 0,
                  onClick: onClear,
                },
                t('import.clear'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wss-btn',
                  disabled: busy,
                  'aria-busy': scanning || undefined,
                  onClick: onRescan,
                },
                t('import.rescan'),
              ),
            ),
          )
        : null
      const list = ready
        ? candidates.length === 0
          ? h(
              'div',
              { className: 'wss-empty' },
              h('span', { className: 'wss-empty-icon', 'aria-hidden': true }, h(ImportIcon, { size: 28 })),
              h('p', { className: 'wss-empty-title' }, t('import.empty.title')),
              h('p', { className: 'wss-empty-hint' }, t('import.empty.hint')),
            )
          : h(
              'ul',
              { className: 'wss-list', 'aria-label': t('import.listLabel') },
              candidates.map((candidate) => h(CandidateRow, {
                key: candidate.key,
                candidate,
                outcome: outcomes[candidate.key],
                selected: selected.includes(candidate.key),
                lang,
                now,
                t,
                onToggle,
              })),
            )
        : null
      const loadingBlock = initialLoading
        ? h(
            'div',
            { className: 'wss-loading' },
            h('span', { className: 'wss-loading-icon', 'aria-hidden': true }, h(ImportIcon, { size: 26, spinning: true })),
            h('span', null, t('import.loading')),
          )
        : null
      const errorBlock = phase === 'error'
        ? h(
            'div',
            { className: 'wss-banner wss-banner-error', role: 'alert' },
            error,
            h(
              'span',
              null,
              ' ',
              h('button', { type: 'button', className: 'wss-link-btn', onClick: onRetry }, t('import.retry')),
            ),
          )
        : null
      const disabledBlock = phase === 'disabled'
        ? h(
            'div',
            { className: 'wss-banner wss-banner-info', role: 'status' },
            t('import.error.disabled'),
            ' ',
            h('button', { type: 'button', className: 'wss-link-btn', onClick: onRetry }, t('import.retry')),
          )
        : null
      const liveText = importing
        ? t('import.status.importing')
        : scanning
          ? t('import.status.scanning')
          : notice !== ''
            ? notice
            : selectedCount > 0
              ? t('import.selected', { count: selectedCount })
              : t('import.footer.idle')
      return portal(
        h(
          'div',
          { className: 'wss-overlay' },
          h('div', { key: 'mask', className: 'wss-mask', 'aria-hidden': true, onClick: onClose }),
          h(
            'div',
            {
              key: 'panel',
              ref: panelRef,
              className: 'wss-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': titleId,
              'aria-busy': busy || undefined,
              'data-shortcut-modal': 'session-import',
              tabIndex: -1,
            },
            h(
              'header',
              { className: 'wss-dialog-header' },
              h(
                'div',
                { className: 'wss-dialog-titles' },
                h(
                  'h2',
                  { className: 'wss-dialog-title', id: titleId, tabIndex: -1, 'data-modal-autofocus': true },
                  t('import.dialog.title'),
                ),
                h('p', { className: 'wss-dialog-subtitle' }, t('import.dialog.subtitle')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wss-icon-btn',
                  onClick: onClose,
                  'aria-label': t('import.dialog.close'),
                  title: t('import.dialog.close'),
                },
                h(CloseIcon, { size: 16 }),
              ),
            ),
            h(
              'div',
              { className: 'wss-dialog-body' },
              banners,
              disabledBlock,
              errorBlock,
              adaptersLine,
              loadingBlock,
              toolbar,
              truncated
                ? h(
                    'p',
                    { className: 'wss-note' },
                    t('import.summary.truncated', { shown: candidates.length, total: summaryCount }),
                  )
                : null,
              partialErrors.length > 0
                ? h(
                    'p',
                    {
                      className: 'wss-note',
                      title: partialErrors
                        .map((failure) => `${failure.adapterId}: ${failure.message}`)
                        .join('\n'),
                    },
                    t('import.partial', { count: partialErrors.length }),
                  )
                : null,
              list,
            ),
            h(
              'footer',
              { className: 'wss-dialog-footer' },
              h(
                'span',
                { className: 'wss-footer-status' },
                importing
                  ? t('import.status.importing')
                  : selectedCount > 0
                    ? t('import.selected', { count: selectedCount })
                    : t('import.footer.idle'),
              ),
              h(
                'span',
                { className: 'wss-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
                liveText,
              ),
              h('button', { type: 'button', className: 'wss-btn', onClick: onClose }, t('import.dialog.closeAction')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wss-btn wss-btn-primary',
                  disabled: importing || selectedCount === 0 || phase !== 'ready',
                  'aria-busy': importing || undefined,
                  onClick: onImport,
                },
                importing ? h(ImportIcon, { size: 14, spinning: true }) : null,
                importing ? t('import.status.importing') : t('import.submit', { count: selectedCount }),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * Update scanned workspace hints after an import created Workspaces, so the
     * list immediately says "→ title" instead of waiting for a rescan.
     * @param {object | null} scan last scan summary.
     * @param {Array<{ workspaceId?: string, title?: string, path?: string }>} createdWorkspaces import result's created Workspaces.
     * @returns {object | null} patched scan summary (same reference when nothing changes).
     */
    function patchWorkspaceHints(scan, createdWorkspaces) {
      if (scan === null || scan === undefined) return scan
      if (!Array.isArray(createdWorkspaces) || createdWorkspaces.length === 0) return scan
      const byPath = new Map()
      for (const workspace of createdWorkspaces) {
        if (workspace !== null && typeof workspace === 'object' && typeof workspace.path === 'string') {
          byPath.set(workspace.path, workspace)
        }
      }
      if (byPath.size === 0) return scan
      return {
        ...scan,
        candidates: scan.candidates.map((candidate) => {
          const hint = candidate.workspaceHint
          if (hint === null || typeof hint !== 'object' || hint.kind !== 'new') return candidate
          const created = byPath.get(hint.path)
          if (created === undefined) return candidate
          return {
            ...candidate,
            workspaceHint: {
              kind: 'existing',
              workspaceId: String(created.workspaceId ?? ''),
              title: String(created.title ?? hint.title ?? ''),
              path: String(created.path ?? hint.path),
            },
          }
        }),
      }
    }

    /**
     * Sidebar-foot action for cross-harness import. Owns all dialog state so a
     * dismiss during a slow scan (or even during an import) never loses the
     * request: the dialog is unmounted entirely on close, while the action stays
     * mounted in the sidebar and continues the in-flight import + catalog refresh.
     * @param {object} props slot props plus the plugin's translate and context.
     * @returns {import('react').ReactElement} footer action and its dialog.
     */
    function ImportAction(props) {
      const { wide = false, t, importCtx } = props
      const [open, setOpen] = React.useState(false)
      const [phase, setPhase] = React.useState('idle')
      const [sources, setSources] = React.useState(null)
      const [scan, setScan] = React.useState(null)
      const [error, setError] = React.useState('')
      const [scanError, setScanError] = React.useState('')
      const [selected, setSelected] = React.useState([])
      const [scanning, setScanning] = React.useState(false)
      const [importing, setImporting] = React.useState(false)
      const [importError, setImportError] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [outcomes, setOutcomes] = React.useState({})
      const [catalogFailed, setCatalogFailed] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const requestRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const importingRef = React.useRef(false)
      const phaseRef = React.useRef(phase)
      phaseRef.current = phase
      const mountedRef = React.useRef(true)

      /** Drop the in-flight scan/sources request, if any. */
      const abortRequest = React.useCallback(() => {
        const active = requestRef.current
        if (active === null) return
        requestRef.current = null
        active.abort()
      }, [])

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          abortRequest()
        }
      }, [abortRequest])

      /**
       * Load adapter availability + run one scan. Re-entrant calls share the
       * existing request; an aborted request never publishes state.
       */
      const load = React.useCallback(async () => {
        if (requestRef.current !== null || importingRef.current) return
        const controller = new AbortController()
        requestRef.current = controller
        setScanning(true)
        setScanError('')
        setError('')
        if (phaseRef.current !== 'ready') setPhase('loading')
        try {
          const [statusResult, sourcesResult] = await Promise.allSettled([
            requestJson(IMPORT_STATUS_ROUTE, { signal: controller.signal }),
            requestJson(IMPORT_SOURCES_ROUTE, { signal: controller.signal }),
          ])
          if (controller.signal.aborted) return
          const statusPayload = statusResult.status === 'fulfilled' ? statusResult.value : null
          const statusDisabled =
            statusPayload !== null && statusPayload.enabled === false
          const sourcesFailure = sourcesResult.status === 'rejected' ? sourcesResult.reason : null
          const sourcesDisabled =
            statusResult.status === 'rejected' &&
            statusResult.reason instanceof ImportRequestError &&
            statusResult.reason.code === 'disabled'
          if (
            statusDisabled ||
            sourcesDisabled ||
            (sourcesFailure instanceof ImportRequestError && sourcesFailure.code === 'disabled')
          ) {
            setPhase('disabled')
            return
          }
          if (sourcesResult.status === 'fulfilled') {
            setSources(sourcesResult.value)
          } else if (phaseRef.current !== 'ready') {
            setPhase('error')
            setError(describeFailure(sourcesFailure, t))
            return
          } else {
            setScanError(describeFailure(sourcesFailure, t))
            return
          }
          const scanPayload = await requestJson(IMPORT_SCAN_ROUTE, {
            method: 'POST',
            body: {},
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          const nextScan = scanPayload.scan ?? null
          setScan(nextScan)
          // Drop selections for candidates a rescan no longer offers.
          const nextImportable = new Set(
            (Array.isArray(nextScan?.candidates) ? nextScan.candidates : [])
              .filter((candidate) => candidate !== null && typeof candidate === 'object' && candidate.importable !== false)
              .map((candidate) => candidate.key),
          )
          setSelected((previous) => previous.filter((key) => nextImportable.has(key)))
          setPhase('ready')
          setNotice('')
        } catch (failure) {
          if (isAbortError(failure) || controller.signal.aborted) return
          const message = describeFailure(failure, t)
          if (phaseRef.current === 'ready') setScanError(message)
          else {
            setPhase('error')
            setError(message)
          }
        } finally {
          const current = requestRef.current === controller
          if (current) requestRef.current = null
          // A reopened dialog may already have started a newer request; only the
          // owner (or the aborted, now-empty slot) may clear the scanning flag.
          if (mountedRef.current && (current || requestRef.current === null)) setScanning(false)
        }
      }, [t])

      /** Open the dialog and refresh the candidate list. */
      const openDialog = React.useCallback(() => {
        setOpen(true)
        setImportError('')
        load().catch(() => {})
      }, [load])

      /**
       * Dismiss the dialog. A slow scan is aborted (the Host keeps its own scan
       * running); an in-flight import is NOT aborted because its result and the
       * session-catalog refresh are still useful and its state lives here.
       */
      const closeDialog = React.useCallback(() => {
        abortRequest()
        setScanning(false)
        setOpen(false)
        if (phaseRef.current === 'loading') setPhase('idle')
      }, [abortRequest])

      /** Apply one import result: per-row outcomes, hint patch, catalog refresh. */
      const applyResult = React.useCallback(
        async (payload) => {
          const summary = payload?.result
          if (summary === null || summary === undefined) throw new ImportRequestError(200, 'invalid-response', '')
          setResult(summary)
          const nextOutcomes = {}
          if (Array.isArray(summary.imported)) {
            for (const item of summary.imported) {
              if (item !== null && typeof item === 'object' && typeof item.candidateKey === 'string') {
                nextOutcomes[item.candidateKey] = { status: 'imported', ...item }
              }
            }
          }
          if (Array.isArray(summary.skipped)) {
            for (const item of summary.skipped) {
              if (item !== null && typeof item === 'object' && typeof item.candidateKey === 'string') {
                nextOutcomes[item.candidateKey] = { status: 'skipped', ...item }
              }
            }
          }
          const failedKeys = new Set()
          if (Array.isArray(summary.errors)) {
            for (const item of summary.errors) {
              if (item === null || typeof item !== 'object' || typeof item.candidateKey !== 'string') continue
              failedKeys.add(item.candidateKey)
              nextOutcomes[item.candidateKey] = {
                status: 'error',
                message: typeof item.message === 'string' ? item.message : '',
              }
            }
          }
          setOutcomes((previous) => ({ ...previous, ...nextOutcomes }))
          setScan((previous) => patchWorkspaceHints(previous, summary.createdWorkspaces))
          setSelected((previous) => previous.filter((key) => failedKeys.has(key)))
          const importedCount = Array.isArray(summary.imported) ? summary.imported.length : 0
          const skippedCount = Array.isArray(summary.skipped) ? summary.skipped.length : 0
          const failedCount = failedKeys.size
          if (importedCount > 0) {
            try {
              await refreshSessions(importCtx)
              if (mountedRef.current) setCatalogFailed(false)
            } catch {
              if (mountedRef.current) setCatalogFailed(true)
            }
          }
          if (mountedRef.current) {
            setNotice(t('import.result.summary', {
              imported: importedCount,
              skipped: skippedCount,
              failed: failedCount,
            }))
          }
        },
        [importCtx, t],
      )

      /** Import every selected candidate through the Host route. */
      const runImport = React.useCallback(async () => {
        if (importingRef.current) return
        const candidates = Array.isArray(scan?.candidates) ? scan.candidates : []
        const importable = new Set(
          candidates.filter((candidate) => candidate.importable !== false).map((candidate) => candidate.key),
        )
        const keys = selected.filter((key) => {
          if (!importable.has(key)) return false
          const outcome = outcomes[key]
          return outcome === undefined || outcome.status === 'error'
        })
        if (keys.length === 0) return
        importingRef.current = true
        setImporting(true)
        setImportError('')
        setNotice(t('import.status.importing'))
        try {
          const payload = await requestJson(IMPORT_IMPORT_ROUTE, {
            method: 'POST',
            body: { selections: keys },
          })
          await applyResult(payload)
        } catch (failure) {
          if (mountedRef.current) {
            setImportError(describeFailure(failure, t))
            setNotice('')
          }
        } finally {
          importingRef.current = false
          if (mountedRef.current) setImporting(false)
        }
      }, [applyResult, outcomes, scan, selected, t])

      /** Toggle one candidate checkbox. */
      const toggleCandidate = React.useCallback((key, checked) => {
        setSelected((previous) => {
          const present = previous.includes(key)
          if (checked === present) return previous
          return checked ? [...previous, key] : previous.filter((candidateKey) => candidateKey !== key)
        })
      }, [])

      const candidates = Array.isArray(scan?.candidates) ? scan.candidates : []
      const adapters = Array.isArray(scan?.adapters)
        ? scan.adapters
        : Array.isArray(sources?.adapters)
          ? sources.adapters
          : []
      const selectable = candidates.filter((candidate) => {
        if (candidate.importable === false) return false
        const outcome = outcomes[candidate.key]
        return outcome === undefined || outcome.status === 'error'
      })
      const allSelected = selectable.length > 0 && selectable.every((candidate) => selected.includes(candidate.key))
      const selectedCount = selected.length
      const lang = activeLocale(importCtx)
      const dialog = open
        ? h(ImportDialog, {
            phase,
            scanning,
            importing,
            scan,
            error,
            scanError,
            importError,
            result,
            catalogFailed,
            selected,
            adapters,
            candidates,
            selectable,
            allSelected,
            selectedCount,
            outcomes,
            notice,
            lang,
            t,
            onClose: closeDialog,
            onRetry: () => {
              load().catch(() => {})
            },
            onRescan: () => {
              load().catch(() => {})
            },
            onToggle: toggleCandidate,
            onSelectAll: () => setSelected(selectable.map((candidate) => candidate.key)),
            onClear: () => setSelected([]),
            onImport: () => {
              runImport().catch(() => {})
            },
            returnFocusRef: triggerRef,
          })
        : null
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wss-root', 'data-session-adopt': 'import-action' },
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: wide ? 'wss-button' : 'wss-button wss-button-rail',
              'data-busy': scanning || importing || undefined,
              'aria-label': t('import.action.label'),
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              title: t('import.action.title'),
              onClick: openDialog,
            },
            h(ImportIcon, { size: wide ? 16 : 18, spinning: scanning || importing }),
            wide ? h('span', { className: 'wss-label' }, t('import.action.label')) : null,
          ),
        ),
        dialog,
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries, the stylesheet, and the two sidebar-foot
       * actions.
       * @param {import('@deepseek-ai/cordis').Context} ctx Client root context.
       */
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: EN, zh: ZH }),
          'session-adopt: dictionaries',
        )
        ctx.effect(() => injectStyles(), 'session-adopt: styles')
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
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'session-import',
            order: 21,
            locale: NS,
          },
          (props) => h(ImportAction, { ...props, t, importCtx: ctx }),
        ))
      },
    }
  },
})
