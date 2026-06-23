type Handler = (data: any) => void

let ws: WebSocket | null = null
const handlers: Map<string, Handler[]> = new Map()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${protocol}://${window.location.host}/ws`)

  ws.onmessage = (event) => {
    try {
      const { type, payload } = JSON.parse(event.data)
      handlers.get(type)?.forEach((fn) => fn(payload))
      handlers.get('*')?.forEach((fn) => fn({ type, payload }))
    } catch {}
  }

  ws.onclose = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connectWS, 3000)
  }

  ws.onerror = () => ws?.close()
}

export function onWSMessage(type: string, handler: Handler) {
  if (!handlers.has(type)) handlers.set(type, [])
  handlers.get(type)!.push(handler)
  return () => {
    const list = handlers.get(type) ?? []
    handlers.set(type, list.filter((h) => h !== handler))
  }
}

export function disconnectWS() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close()
  ws = null
}

export function isConnected() {
  return ws?.readyState === WebSocket.OPEN
}
