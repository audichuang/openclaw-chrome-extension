const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

let globalEnabled = false
let retryTimer = null
const RETRY_INTERVAL = 3000

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => { })
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)

    // Install message handler BEFORE awaiting connection to avoid missing early messages.
    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    relayWs = ws
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  // Keep debuggers attached — only clear relay-specific session mappings.
  // Tabs stay in the `tabs` Map so we can re-announce them after reconnect.
  tabBySession.clear()
  childSessionToTab.clear()

  // Mark all tabs as needing re-announce (clear sessionId so reannounce assigns new ones).
  for (const tab of tabs.values()) {
    if (tab.state === 'connected') {
      tab.sessionId = undefined
    }
  }

  scheduleRetry()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => { })

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })
}

async function tryAttachTab(tabId) {
  if (tabs.has(tabId)) return
  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  try {
    await attachTab(tabId)
  } catch (err) {
    tabs.delete(tabId)
    try { await chrome.debugger.detach({ tabId }) } catch { /* ignore */ }
    setBadge(tabId, 'off')
    console.info('skip tab', tabId, err instanceof Error ? err.message : String(err))
  }
}

async function reannounceAllTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected') continue
    if (tab.sessionId) continue // already has a session, skip

    // Verify debugger is still attached by sending a harmless command.
    try {
      const info = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'))
      const targetInfo = info?.targetInfo
      const targetId = String(targetInfo?.targetId || '').trim()
      if (!targetId) throw new Error('no targetId')

      const sessionId = `cb-tab-${nextSession++}`
      tab.sessionId = sessionId
      tab.targetId = targetId
      tabBySession.set(sessionId, tabId)

      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, 'on')
    } catch {
      // Debugger was lost (e.g. tab closed or navigated to chrome://). Clean up.
      tabs.delete(tabId)
      setBadge(tabId, 'off')
    }
  }
}

async function attachAllTabs() {
  const allTabs = await chrome.tabs.query({})
  for (const tab of allTabs) {
    if (!tab.id) continue
    const url = tab.url || tab.pendingUrl || ''
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('devtools://') || url.startsWith('edge://')) continue
    await tryAttachTab(tab.id)
  }
}

async function detachAllTabs() {
  const tabIds = [...tabs.keys()]
  for (const tabId of tabIds) {
    await detachTab(tabId, 'global-off')
  }
}

async function toggleGlobal() {
  if (globalEnabled) {
    globalEnabled = false
    await chrome.storage.local.set({ globalEnabled: false })
    clearRetryTimer()
    await detachAllTabs()
    return
  }

  globalEnabled = true
  await chrome.storage.local.set({ globalEnabled: true })
  await enableGlobal()
}

async function enableGlobal() {
  try {
    await ensureRelayConnection()
    // Re-announce tabs whose debugger is still attached from before relay disconnect.
    await reannounceAllTabs()
    // Attach any new tabs that aren't tracked yet.
    await attachAllTabs()
  } catch (err) {
    console.warn('enableGlobal failed, will retry', err instanceof Error ? err.message : String(err))
    scheduleRetry()
  }
}

function scheduleRetry() {
  clearRetryTimer()
  if (!globalEnabled) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (!globalEnabled) return
    void enableGlobal()
  }, RETRY_INTERVAL)
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { })
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => { })
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const reattachTimers = new Map()

function scheduleReattach(tabId, delay = 1000) {
  cancelReattach(tabId)
  if (!globalEnabled) return
  const timer = setTimeout(async () => {
    reattachTimers.delete(tabId)
    if (!globalEnabled) return
    try {
      await chrome.tabs.get(tabId)
    } catch {
      return // tab was closed
    }
    if (tabs.has(tabId)) return // already re-attached
    try {
      await ensureRelayConnection()
    } catch {
      scheduleReattach(tabId, Math.min(delay * 2, 10000))
      return
    }
    await tryAttachTab(tabId)
    if (!tabs.has(tabId) || tabs.get(tabId)?.state !== 'connected') {
      scheduleReattach(tabId, Math.min(delay * 2, 10000))
    }
  }, delay)
  reattachTimers.set(tabId, timer)
}

function cancelReattach(tabId) {
  const timer = reattachTimers.get(tabId)
  if (timer) {
    clearTimeout(timer)
    reattachTimers.delete(tabId)
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  void detachTab(tabId, reason)
  // Auto re-attach with persistent retry (e.g. after DevTools closes).
  scheduleReattach(tabId)
}

chrome.action.onClicked.addListener(() => void toggleGlobal())

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!globalEnabled) return
  if (changeInfo.status !== 'complete') return
  const url = tab.url || tab.pendingUrl || ''
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('devtools://') || url.startsWith('edge://')) return
  if (tabs.has(tabId)) return
  void (async () => {
    try {
      await ensureRelayConnection()
      await tryAttachTab(tabId)
    } catch {
      // relay down — retry will handle it
    }
  })()
})

chrome.tabs.onCreated.addListener((tab) => {
  if (!globalEnabled) return
  if (!tab.id) return
  setTimeout(() => {
    if (!globalEnabled || !tab.id) return
    const url = tab.url || tab.pendingUrl || ''
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('devtools://') || url.startsWith('edge://')) return
    if (tabs.has(tab.id)) return
    void (async () => {
      try {
        await ensureRelayConnection()
        await tryAttachTab(tab.id)
      } catch {
        // ignore
      }
    })()
  }, 500)
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!globalEnabled) return
  const tabId = activeInfo.tabId
  if (tabs.has(tabId)) return
  void (async () => {
    try {
      const tab = await chrome.tabs.get(tabId)
      const url = tab.url || tab.pendingUrl || ''
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('devtools://') || url.startsWith('edge://')) return
      await ensureRelayConnection()
      await tryAttachTab(tabId)
    } catch {
      // ignore
    }
  })()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelReattach(tabId)
  if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
})

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ globalEnabled: true })
    globalEnabled = true
    void enableGlobal()
  }
})

void (async () => {
  const stored = await chrome.storage.local.get(['globalEnabled'])
  globalEnabled = stored.globalEnabled !== false
  if (globalEnabled) {
    void enableGlobal()
  }
})()
