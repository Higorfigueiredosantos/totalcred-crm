require('dotenv').config()

// Previne que erros async não tratados (ex: puppeteer) derrubem o servidor
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection (servidor continua rodando):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (servidor continua rodando):', err.message)
})

const express = require('express')
const { WebSocketServer } = require('ws')
const http = require('http')
const net = require('net')
const cors = require('cors')
const axios = require('axios')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { SocksProxyAgent } = require('socks-proxy-agent')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? true : ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json({ limit: '50mb' }))

// ── API Key persistida em arquivo ─────────────────────────────────────────────
const API_KEY_FILE = path.join(__dirname, 'data', 'apikey.json')

function loadStoredApiKey() {
  try {
    if (!fs.existsSync(API_KEY_FILE)) return null
    return JSON.parse(fs.readFileSync(API_KEY_FILE, 'utf8')).key || null
  } catch { return null }
}

function saveStoredApiKey(key) {
  try {
    const dir = path.dirname(API_KEY_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(API_KEY_FILE, JSON.stringify({ key, createdAt: new Date().toISOString() }))
  } catch (e) { console.error('[ApiKey] Erro ao salvar:', e.message) }
}

// ── Conversation map: conversaId estável por canal+contato ────────────────────
const CONV_MAP_FILE = path.join(__dirname, 'data', 'conv_map.json')
let convMap = {}
try { convMap = JSON.parse(fs.readFileSync(CONV_MAP_FILE, 'utf8')) } catch {}

function getConvId(channel, contact) {
  const id = crypto.createHash('md5').update(`${channel}:${contact}`).digest('hex').slice(0, 16)
  if (!convMap[id]) {
    convMap[id] = { channel, contact }
    try { fs.writeFileSync(CONV_MAP_FILE, JSON.stringify(convMap, null, 2)) } catch {}
  }
  return id
}

function generateApiKey() {
  return 'crm_' + crypto.randomBytes(32).toString('hex')
}

// Garante que sempre exista uma chave gerada
let storedApiKey = loadStoredApiKey()
if (!storedApiKey) {
  storedApiKey = generateApiKey()
  saveStoredApiKey(storedApiKey)
  console.log('[ApiKey] Chave gerada automaticamente.')
}

// ── API Key auth ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Chave ativa: arquivo local (prioritário) ou variável de ambiente
  const configured = storedApiKey || process.env.API_KEY
  if (!configured) return next()
  const protectedPrefixes = ['/api/chips/send', '/api/send-message', '/api/crm/']
  if (!protectedPrefixes.some(p => req.path.startsWith(p))) return next()
  const token = req.headers['x-api-token']
    || req.headers['apikey']
    || (String(req.headers['authorization'] || '')).replace(/^Bearer\s+/i, '').trim()
  if (token === configured) return next()
  return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' })
})

// ── Rotas de gerenciamento da API Key ─────────────────────────────────────────
app.get('/api/settings/apikey', (_req, res) => {
  res.json({ key: storedApiKey })
})

app.post('/api/settings/apikey/regenerate', (_req, res) => {
  storedApiKey = generateApiKey()
  saveStoredApiKey(storedApiKey)
  console.log('[ApiKey] Chave regenerada.')
  res.json({ key: storedApiKey })
})

// ── Media storage ─────────────────────────────────────────────────────────────
const MEDIA_DIR = path.join(__dirname, 'data', 'media')
try { if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true }) } catch {}
app.use('/api/media/files', express.static(MEDIA_DIR, { maxAge: '1d' }))

// Converte audio/webm → audio/ogg (Opus) para compatibilidade com Meta API
app.post('/api/media/convert-audio', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo ausente' })
  const { execFile } = require('child_process')
  const os = require('os')
  const inPath  = path.join(os.tmpdir(), `in_${Date.now()}.webm`)
  const outPath = path.join(os.tmpdir(), `out_${Date.now()}.ogg`)
  try {
    fs.writeFileSync(inPath, req.file.buffer)
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', inPath, '-c:a', 'libopus', '-b:a', '64k', outPath], (err) => {
        if (err) reject(err); else resolve(null)
      })
    })
    const converted = fs.readFileSync(outPath)
    res.setHeader('Content-Type', 'audio/ogg')
    res.setHeader('Content-Disposition', 'attachment; filename="audio.ogg"')
    res.end(converted)
  } catch (e) {
    console.error('[ConvertAudio]', e.message)
    res.status(500).json({ error: 'Falha na conversão de áudio: ' + e.message })
  } finally {
    try { fs.unlinkSync(inPath) } catch (_) {}
    try { fs.unlinkSync(outPath) } catch (_) {}
  }
})

// Proxy para mídia da Meta API (images/audio/video recebidos nos canais oficiais)
app.get('/api/media/meta', async (req, res) => {
  const { id, token, phoneId } = req.query
  if (!id || !token) return res.status(400).end()
  try {
    const infoRes = await axios.get(`https://graph.facebook.com/v20.0/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: phoneId ? { phone_number_id: phoneId } : {},
      timeout: 10000,
    })
    const dlUrl = infoRes.data.url
    const mime  = infoRes.data.mime_type || 'application/octet-stream'
    const dlRes = await axios.get(dlUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    })
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.end(Buffer.from(dlRes.data))
  } catch (e) {
    console.error('[Meta Media Proxy]', e.message)
    res.status(502).end()
  }
})

// ── WebSocket broadcast + fila offline ───────────────────────────────────────
const wsClients = new Set()

const OFFLINE_QUEUE_FILE = path.join(__dirname, 'data', 'offline_queue.json')
let offlineQueue = []
try {
  if (fs.existsSync(OFFLINE_QUEUE_FILE))
    offlineQueue = JSON.parse(fs.readFileSync(OFFLINE_QUEUE_FILE, 'utf8')) || []
} catch (_) { offlineQueue = [] }

function saveOfflineQueue() {
  try { fs.writeFileSync(OFFLINE_QUEUE_FILE, JSON.stringify(offlineQueue)) } catch (_) {}
}

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  wsClients.add(ws)
  ws.on('close', () => { wsClients.delete(ws); console.log(`[WS] Client desconectado (${wsClients.size} restantes)`) })
  ws.on('error', () => { wsClients.delete(ws) })
  console.log(`[WS] Client conectado (${wsClients.size} total)`)
  ws.send(JSON.stringify({ type: 'chips_status', payload: getChipsList() }))
})

// Detecta conexões mortas a cada 20s e remove do Set
const wsHeartbeat = setInterval(() => {
  wsClients.forEach((ws) => {
    if (!ws.isAlive) { console.log('[WS] Removendo conexão morta'); ws.terminate(); return }
    ws.isAlive = false
    ws.ping()
  })
}, 20000)
wss.on('close', () => clearInterval(wsHeartbeat))

// Endpoint HTTP para o frontend buscar a fila offline após montar
app.get('/api/offline_queue', (_req, res) => {
  const queue = [...offlineQueue]
  offlineQueue = []
  saveOfflineQueue()
  if (queue.length > 0) console.log(`[OfflineQueue] Entregue ${queue.length} msgs pendentes`)
  res.json(queue)
})

// Webhook da Meta dispara tanto para mensagens recebidas quanto para status
// (enviado/entregue/lido) de mensagens enviadas. Só nos interessa reter na
// fila offline quando há mensagem de fato — status puro não deve competir
// por espaço com conteúdo real.
function metaWebhookHasInboundMessage(body) {
  return (body?.entry || []).some(entry =>
    (entry.changes || []).some(change => (change.value?.messages || []).length > 0)
  )
}

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload })
  let sent = false
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) { ws.send(msg); sent = true }
  })
  // Nenhum browser conectado: guarda na fila (apenas mensagens, não status/ack —
  // chip_ack não tem consumidor no processamento da fila offline no frontend, e
  // webhooks da Meta que são só status também não devem ocupar espaço da fila,
  // já que enfileirá-los só expulsava mensagens reais do limite)
  const shouldQueue =
    type === 'chip_message' ||
    (type === 'whatsapp' && metaWebhookHasInboundMessage(payload))
  if (!sent && shouldQueue) {
    offlineQueue.push({ type, payload })
    if (offlineQueue.length > 3000) offlineQueue = offlineQueue.slice(-3000)
    saveOfflineQueue()
  }
}

// ── Webhook storage & fire ────────────────────────────────────────────────────
const WEBHOOKS_FILE = path.join(__dirname, 'data', 'webhooks.json')

function loadWebhooks() {
  try {
    const dir = path.dirname(WEBHOOKS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(WEBHOOKS_FILE)) return []
    return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8')) || []
  } catch (_) { return [] }
}

function saveWebhooks(list) {
  try {
    const dir = path.dirname(WEBHOOKS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(list, null, 2))
  } catch (e) { console.error('[Webhooks] Save error:', e.message) }
}

function fireWebhooks(event, data) {
  const hooks = loadWebhooks().filter(w => w.url && Array.isArray(w.events) && w.events.includes(event))
  if (!hooks.length) return
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data })
  for (const wh of hooks) {
    axios.post(wh.url, JSON.parse(body), {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'x-crm-event': event, 'x-crm-webhook-id': wh.id },
    }).catch(e => console.error(`[Webhook] ${event} → ${wh.url} falhou: ${e.message}`))
  }
}

// ── META API WEBHOOK ─────────────────────────────────────────────────────────

app.get('/api/webhook', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode !== 'subscribe' || !token || !challenge) {
    console.warn('[Webhook] Verificação inválida — parâmetros ausentes')
    return res.sendStatus(403)
  }

  // Aceita se bater com o env, com qualquer canal cadastrado, ou como fallback permissivo
  const envToken = process.env.WEBHOOK_VERIFY_TOKEN
  const channels = loadChannels()
  const validTokens = new Set([
    ...(envToken ? [envToken] : []),
    ...channels.map(c => c.webhookVerifyToken).filter(Boolean),
  ])

  const isValid = validTokens.size === 0 || validTokens.has(token)
  if (isValid) {
    console.log(`[Webhook] Verificado com sucesso — token OK`)
    return res.status(200).send(String(challenge))
  }
  console.warn(`[Webhook] Token inválido: ${token}`)
  res.sendStatus(403)
})

app.post('/api/webhook', (req, res) => {
  const body = req.body
  if (body.object !== 'whatsapp_business_account') return res.sendStatus(404)
  console.log('[Webhook] Event received:', JSON.stringify(body, null, 2).slice(0, 500))
  broadcast('whatsapp', body)

  // Disparo de webhook IA e fireWebhooks para canais Meta
  try {
    const fgts = (loadIAConfig().fgts) || {}
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value
        const phoneNumberId = value?.metadata?.phone_number_id
        if (!phoneNumberId) continue
        for (const msg of value.messages || []) {
          const from = String(msg.from || '')
          const message = msg.text?.body || msg.type || ''
          const name = value.contacts?.[0]?.profile?.name || from
          const convId = getConvId(phoneNumberId, from)
          // Track Meta inbound for blast engagement (text + button replies + any type)
          metaResponseStats.responses.push({ from, timestamp: Date.now(), type: msg.type || 'text' })
          if (metaResponseStats.responses.length > 5000) metaResponseStats.responses.shift()
          // fireWebhooks para sistemas externos
          fireWebhooks('message_created', {
            channelId: phoneNumberId, from, body: message,
            timestamp: msg.timestamp, pushname: name,
            msgType: msg.type || 'text',
            conversationId: convId,
          })
          // IA webhook (apenas canais configurados)
          if (fgts.webhookEnabled && fgts.webhookUrl && Array.isArray(fgts.channelIds) && fgts.channelIds.includes(phoneNumberId)) {
            axios.post(fgts.webhookUrl, { chipId: phoneNumberId, from, message, name, conversationId: convId },
              { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
            ).catch(e => console.error('[IA Webhook Meta]', e.message))
          }
        }
      }
    }
  } catch (e) { console.error('[IA Webhook Meta] Erro:', e.message) }

  res.sendStatus(200)
})

// ── PROXY HELPER ─────────────────────────────────────────────────────────────

function buildProxyAgent(proxy) {
  if (!proxy || !proxy.enabled || !proxy.host || !proxy.port) return null
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@` : ''
  const url = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`
  if (proxy.type === 'socks5') return new SocksProxyAgent(url)
  return new HttpsProxyAgent(url)
}

function axiosConfig(accessToken, proxy) {
  const cfg = { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  const agent = buildProxyAgent(proxy)
  if (agent) { cfg.httpsAgent = agent; cfg.httpAgent = agent; cfg.proxy = false }
  return cfg
}

// ── META GRAPH API PROXY ──────────────────────────────────────────────────────

app.post('/api/send', async (req, res) => {
  const { phoneNumberId, accessToken, payload, proxy } = req.body
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      payload,
      axiosConfig(accessToken, proxy)
    )
    res.json(resp.data)
  } catch (e) {
    console.error('[Send] Error:', e.response?.data ?? e.message)
    res.status(e.response?.status ?? 500).json(e.response?.data ?? { error: e.message })
  }
})

app.post('/api/templates', async (req, res) => {
  const { wabaId, accessToken, proxy } = req.body
  try {
    const cfg = axiosConfig(accessToken, proxy)
    cfg.params = { fields: 'name,language,status,category,components', limit: 100 }
    const resp = await axios.get(`https://graph.facebook.com/v20.0/${wabaId}/message_templates`, cfg)
    res.json(resp.data)
  } catch (e) {
    res.status(e.response?.status ?? 500).json(e.response?.data ?? { error: e.message })
  }
})

app.post('/api/graph', async (req, res) => {
  const { method = 'GET', path: apiPath, payload, params, accessToken, proxy } = req.body
  try {
    const cfg = axiosConfig(accessToken, proxy)
    if (params) cfg.params = params
    const url = `https://graph.facebook.com/v20.0${apiPath}`
    const resp = method === 'POST' ? await axios.post(url, payload, cfg) : await axios.get(url, cfg)
    res.json(resp.data)
  } catch (e) {
    res.status(e.response?.status ?? 500).json(e.response?.data ?? { error: e.message })
  }
})

app.get('/api/templates/:wabaId', async (req, res) => {
  const { wabaId } = req.params
  const accessToken = req.headers.authorization?.replace('Bearer ', '')
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/v20.0/${wabaId}/message_templates`,
      { headers: { Authorization: `Bearer ${accessToken}` }, params: { fields: 'name,language,status,category,components', limit: 100 } }
    )
    res.json(resp.data)
  } catch (e) {
    res.status(e.response?.status ?? 500).json(e.response?.data ?? { error: e.message })
  }
})

app.get('/api/health', (_req, res) => res.json({ ok: true, clients: wsClients.size }))

// ═══════════════════════════════════════════════════════════════════════════════
// CHIPS MODULE — whatsapp-web.js multi-session management
// ═══════════════════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Anti-ban monitoring ───────────────────────────────────────────────────────

class TickMonitor {
  constructor() {
    this.stats = { sent: 0, delivered: 0, read: 0, failed: 0 }
    this.recentAcks = []
  }
  recordAck(ack) {
    this.stats.sent++
    if (ack >= 2) this.stats.delivered++
    if (ack >= 3) this.stats.read++
    if (ack < 1) this.stats.failed++
    this.recentAcks.push(ack)
    if (this.recentAcks.length > 20) this.recentAcks.shift()
  }
  getDeliveryRate() {
    if (this.recentAcks.length === 0) return 1
    return this.recentAcks.filter(a => a >= 2).length / this.recentAcks.length
  }
  getBanRiskLevel() {
    const rate = this.getDeliveryRate()
    if (rate < 0.3) return 'CRITICO'
    if (rate < 0.6) return 'ALTO'
    if (rate < 0.85) return 'MEDIO'
    return 'BAIXO'
  }
  getSummary() {
    return { ...this.stats, deliveryRate: (this.getDeliveryRate() * 100).toFixed(1) + '%', riskLevel: this.getBanRiskLevel(), recent: this.recentAcks.slice(-10) }
  }
}

class AntiBanDelayCalculator {
  constructor() {
    this.messagesSentInHour = 0
    this.hourStart = Date.now()
    this.consecutiveFails = 0
  }
  reset() {
    if (Date.now() - this.hourStart > 3600000) { this.messagesSentInHour = 0; this.hourStart = Date.now() }
  }
  getDelay(riskLevel, baseMin = 3, baseMax = 8) {
    this.reset()
    this.messagesSentInHour++
    let m = 1
    if (riskLevel === 'CRITICO') m = 5
    else if (riskLevel === 'ALTO') m = 3
    else if (riskLevel === 'MEDIO') m = 1.8
    if (this.messagesSentInHour > 80) m *= 3
    else if (this.messagesSentInHour > 50) m *= 2
    else if (this.messagesSentInHour > 30) m *= 1.5
    const min = Math.round(baseMin * m), max = Math.round(baseMax * m)
    return Math.floor(Math.random() * (max - min + 1)) + min
  }
  recordFail() { this.consecutiveFails++ }
  recordSuccess() { this.consecutiveFails = 0 }
  getCooldown() {
    if (this.consecutiveFails >= 5) return 120
    if (this.consecutiveFails >= 3) return 60
    return 0
  }
}

// ── Chip sessions store ───────────────────────────────────────────────────────

const chipSessions = {}

const chipCampaignState = {
  results: [],
  paused: false,
  stopped: false,
  currentCampaign: null,
  sentNumbers: new Set(),
  tickMonitor: new TickMonitor(),
  delayCalc: new AntiBanDelayCalculator(),
  rrIndex: 0,
}

const maturadorState = { running: false, timer: null, chipIds: [], minDelay: 60, maxDelay: 300 }

// ── Chip registry (persist chip IDs across restarts) ──────────────────────────

const REGISTRY_FILE = path.join(__dirname, 'chips_registry.json')
const CAMPAIGNS_FILE = path.join(__dirname, 'campaigns_history.json')
const PROXIES_FILE = path.join(__dirname, 'proxies.json')

// ── Proxy storage ─────────────────────────────────────────────────────────────

function loadProxies() {
  try { if (fs.existsSync(PROXIES_FILE)) return JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf8')) } catch (e) {}
  return []
}

function saveProxies(list) {
  try { fs.writeFileSync(PROXIES_FILE, JSON.stringify(list, null, 2)) } catch (e) {}
}

// ── Proxy Rotator ─────────────────────────────────────────────────────────────
// Servidor HTTP CONNECT local que distribui requisições pelos proxies do pool,
// garantindo exclusividade simultânea e ordem aleatória (sem repetição sequencial).

const ROTATOR_PORT = 9991

const rotatorState = {
  active: new Map(),   // connId -> proxyUrl  (túneis CONNECT abertos)
  history: [],         // proxies usados recentemente (evita repetição sequencial)
  counter: 0,
}

function pickRotatedProxy() {
  const proxies = loadProxies()
  if (!proxies.length) return null

  const activeSet  = new Set(rotatorState.active.values())
  const window     = Math.max(1, Math.floor(proxies.length / 2))
  const recentSet  = new Set(rotatorState.history.slice(-window))

  // Prioridade 1: não está ativo E não foi usado recentemente
  let pool = proxies.filter(p => !activeSet.has(p) && !recentSet.has(p))
  // Prioridade 2: não está ativo (ignora histórico)
  if (!pool.length) pool = proxies.filter(p => !activeSet.has(p))
  // Fallback: todos estão ativos — pega qualquer um aleatório
  if (!pool.length) pool = [...proxies]

  // Fisher-Yates shuffle → evita padrão sequencial
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const chosen = pool[0]

  rotatorState.history.push(chosen)
  if (rotatorState.history.length > proxies.length * 4) {
    rotatorState.history.splice(0, proxies.length)
  }
  return chosen
}

let proxyRotatorServer = null

function startProxyRotator() {
  if (proxyRotatorServer) return

  const rotator = http.createServer()

  rotator.on('connect', (req, clientSocket, head) => {
    const connId = ++rotatorState.counter
    const cleanup = () => rotatorState.active.delete(connId)

    // ── Sem proxy: conexão direta ────────────────────────────────────────────
    function directConnect() {
      const [host, portStr] = req.url.split(':')
      const port = parseInt(portStr) || 443
      const srv = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: CRM-Rotator/1.0\r\n\r\n')
        if (head?.length) srv.write(head)
        srv.pipe(clientSocket, { end: false })
        clientSocket.pipe(srv, { end: false })
      })
      srv.on('error', () => { try { clientSocket.destroy() } catch (_) {} })
      clientSocket.on('error', () => { try { srv.destroy() } catch (_) {} })
      clientSocket.on('close', cleanup)
    }

    const proxy = pickRotatedProxy()
    if (!proxy) { directConnect(); return }

    const parsed = parseProxy(proxy)
    // SOCKS não suportado no modo CONNECT (Chrome passa o protocolo via --proxy-server)
    if (!parsed || parsed.server.match(/^socks/i)) {
      directConnect(); return
    }

    rotatorState.active.set(connId, proxy)
    console.log(`[Rotator] #${connId} → ${req.url} via ${proxy}`)

    const upUrl  = new URL(parsed.server)
    const upPort = parseInt(upUrl.port) || 8080
    const upHost = upUrl.hostname

    // ── Conecta ao proxy upstream ────────────────────────────────────────────
    const upstream = net.connect(upPort, upHost)

    upstream.on('connect', () => {
      let cmd = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n`
      if (parsed.auth) {
        const b64 = Buffer.from(`${parsed.auth.username}:${parsed.auth.password}`).toString('base64')
        cmd += `Proxy-Authorization: Basic ${b64}\r\n`
      }
      cmd += '\r\n'
      upstream.write(cmd)

      // Lê a resposta do upstream (até \r\n\r\n)
      let headerBuf = Buffer.alloc(0)
      const onData = (chunk) => {
        headerBuf = Buffer.concat([headerBuf, chunk])
        const end = headerBuf.indexOf('\r\n\r\n')
        if (end === -1) return
        upstream.removeListener('data', onData)

        const headerStr  = headerBuf.slice(0, end).toString()
        const remainder  = headerBuf.slice(end + 4)

        if (headerStr.includes(' 200 ')) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: CRM-Rotator/1.0\r\n\r\n')
          if (head?.length) upstream.write(head)
          if (remainder.length) clientSocket.write(remainder)
          upstream.pipe(clientSocket, { end: false })
          clientSocket.pipe(upstream, { end: false })
          upstream.on('close', cleanup); upstream.on('error', cleanup)
          clientSocket.on('close', cleanup); clientSocket.on('error', cleanup)
        } else {
          cleanup()
          console.warn(`[Rotator] #${connId} rejeitado: ${headerStr.split('\r\n')[0]}`)
          try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.destroy() } catch (_) {}
          upstream.destroy()
        }
      }
      upstream.on('data', onData)
    })

    upstream.on('error', (e) => {
      cleanup()
      console.error(`[Rotator] #${connId} erro upstream (${proxy}): ${e.message}`)
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.destroy() } catch (_) {}
    })
    clientSocket.on('error', () => { cleanup(); try { upstream.destroy() } catch (_) {} })
    clientSocket.on('close', () => { cleanup(); try { upstream.destroy() } catch (_) {} })
  })

  rotator.on('request', (_req, res) => {
    res.writeHead(405); res.end('Use HTTPS/CONNECT')
  })

  rotator.listen(ROTATOR_PORT, '127.0.0.1', () => {
    console.log(`[ProxyRotator] Rotador em 127.0.0.1:${ROTATOR_PORT} — ${loadProxies().length} proxies no pool`)
  })
  rotator.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.warn(`[ProxyRotator] Porta ${ROTATOR_PORT} já em uso.`)
    else console.error('[ProxyRotator]', e.message)
  })

  proxyRotatorServer = rotator
}

// Converte proxy string para URL Chrome + credenciais separadas
function parseProxy(proxyStr) {
  if (!proxyStr) return null
  let url = proxyStr.trim()
  if (!url.match(/^(http|https|socks4|socks5):\/\//i)) url = 'http://' + url
  try {
    const parsed = new URL(url)
    const server = `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
    const auth = parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password || '') } : null
    return { server, auth, raw: url }
  } catch (e) { return { server: url, auth: null, raw: url } }
}

// ── Chip registry ─────────────────────────────────────────────────────────────

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
      return raw.map(item => typeof item === 'string' ? { id: item, temperature: 'frio', proxy: null } : item)
    }
  } catch (e) {}
  return []
}

function saveRegistry() {
  const data = Object.entries(chipSessions).map(([id, s]) => ({
    id, temperature: s.temperature || 'frio', proxy: s.proxy || null
  }))
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2)) } catch (e) {}
}

function loadCampaigns() {
  try { if (fs.existsSync(CAMPAIGNS_FILE)) return JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8')) } catch (e) {}
  return []
}

function saveCampaign(record) {
  try {
    const list = loadCampaigns()
    list.unshift(record)           // newest first
    if (list.length > 100) list.splice(100) // keep last 100
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(list, null, 2))
  } catch (e) { console.error('[Campaigns] Save error:', e.message) }
}

// ── Autobot persistence ───────────────────────────────────────────────────────

const AUTOBOT_FILE = path.join(__dirname, 'autobot_rules.json')
const DEFAULT_AUTOBOT = {
  active: false, rules: [],
  workingHours: { enabled: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  antiSpamMinutes: 60, aiEnabled: false, escalationWord: 'atendente', pausedContacts: []
}

function loadAutoBotData() {
  try { if (fs.existsSync(AUTOBOT_FILE)) return { ...DEFAULT_AUTOBOT, ...JSON.parse(fs.readFileSync(AUTOBOT_FILE, 'utf8')) } } catch (e) {}
  return { ...DEFAULT_AUTOBOT }
}

function saveAutoBotData(data) {
  try { fs.writeFileSync(AUTOBOT_FILE, JSON.stringify(data, null, 2)) } catch (e) {}
}

let autoBotData = loadAutoBotData()
const contactBotState = {}
const responseStats = { totalResponses: 0, responses: [], lastResponseAt: null }
const metaResponseStats = { responses: [] }  // Meta inbound msgs for blast engagement

// ── Helpers ───────────────────────────────────────────────────────────────────

function getChipsList() {
  return Object.entries(chipSessions).map(([id, c]) => ({
    id, status: c.status, number: c.number || null,
    isReady: c.isReady || false, reconnectAttempts: c.reconnectAttempts || 0,
    qr: c.qr || null, errorMsg: c.errorMsg || null,
    temperature: c.temperature || 'frio',
    proxy: c.proxy || null,
  }))
}

function broadcastChipsStatus() {
  broadcast('chips_status', getChipsList())
}

function formatNumber(num) {
  let n = String(num).replace(/\D/g, '')
  if (!n.startsWith('55') && n.length <= 11) n = '55' + n
  if (!n.endsWith('@c.us') && !n.endsWith('@g.us')) n += '@c.us'
  return n
}

// ── Chip initialization ───────────────────────────────────────────────────────

function findChromePath() {
  const candidates = [
    // Variável de ambiente (Docker/servidor)
    process.env.PUPPETEER_EXECUTABLE_PATH,
    // Linux (Docker/servidor)
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe' : null,
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p } catch (e) {}
  }
  return null
}

async function initChip(chipId) {
  let Client, LocalAuth
  try {
    const wa = require('whatsapp-web.js')
    Client = wa.Client
    LocalAuth = wa.LocalAuth
  } catch (e) {
    console.warn('[Chips] whatsapp-web.js não instalado. Execute npm install no backend.')
    if (chipSessions[chipId]) {
      chipSessions[chipId].status = 'error'
      chipSessions[chipId].errorMsg = 'whatsapp-web.js não instalado'
      broadcastChipsStatus()
    }
    return
  }

  let qrcode
  try { qrcode = require('qrcode') } catch (e) { qrcode = null }

  if (!chipSessions[chipId]) {
    chipSessions[chipId] = { client: null, status: 'connecting', number: null, isReady: false, reconnectAttempts: 0, qr: null }
  } else {
    chipSessions[chipId].status = 'connecting'
    chipSessions[chipId].isReady = false
    chipSessions[chipId].qr = null
  }
  broadcastChipsStatus()

  // Remove TODOS os locks do Chrome antes de iniciar (evita erro de singleton após reinício)
  try {
    const { execSync } = require('child_process')
    execSync('find /app/.wwa_sessions -name "Singleton*" -delete 2>/dev/null || true', { stdio: 'ignore' })
    console.log(`[Chip ${chipId}] Locks do Chrome removidos`)
  } catch (_) {}

  const chromePath = findChromePath()
  const puppeteerArgs = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-single-instance',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=site-per-process',
      '--window-size=1280,720',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  }
  if (chromePath) {
    puppeteerArgs.executablePath = chromePath
    console.log(`[Chip ${chipId}] Usando Chrome em: ${chromePath}`)
  }

  // Rotação de proxies via servidor local (9991) — cada requisição recebe proxy diferente
  if (loadProxies().length > 0) {
    puppeteerArgs.args.push(`--proxy-server=http://127.0.0.1:${ROTATOR_PORT}`)
    chipSessions[chipId].proxy = `rotador:${ROTATOR_PORT}`
    console.log(`[Chip ${chipId}] Usando rotador de proxies (porta ${ROTATOR_PORT})`)
  } else {
    chipSessions[chipId].proxy = null
  }

  try {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: chipId, dataPath: path.join(__dirname, '.wwa_sessions') }),
      puppeteer: puppeteerArgs,
    })

    chipSessions[chipId].client = client

    client.on('qr', async (qr) => {
      let qrUrl = `data:text/plain,${qr}`
      if (qrcode) {
        try { qrUrl = await qrcode.toDataURL(qr) } catch (e) {}
      }
      chipSessions[chipId].status = 'qr'
      chipSessions[chipId].qr = qrUrl  // ← persiste o QR no estado
      broadcast('chip_qr', { chipId, qr: qrUrl })
      broadcastChipsStatus()
    })

    client.on('ready', async () => {
      chipSessions[chipId].isReady = true
      chipSessions[chipId].status = 'connected'
      chipSessions[chipId].reconnectAttempts = 0
      chipSessions[chipId].qr = null  // limpa QR após autenticação
      try { chipSessions[chipId].number = client.info?.wid?.user || null } catch (e) {}
      broadcastChipsStatus()
      broadcast('chip_ready', { chipId, number: chipSessions[chipId].number })
      console.log(`[Chip ${chipId}] Ready — ${chipSessions[chipId].number}`)
    })

    client.on('disconnected', (reason) => {
      chipSessions[chipId].isReady = false
      chipSessions[chipId].status = 'disconnected'
      broadcastChipsStatus()
      broadcast('chip_disconnected', { chipId, reason })
      scheduleChipReconnect(chipId)
    })

    client.on('auth_failure', () => {
      chipSessions[chipId].status = 'auth_failure'
      chipSessions[chipId].isReady = false
      broadcastChipsStatus()
    })

    client.on('message_ack', (msg, ack) => {
      const msgId = extractMsgId(msg)

      chipCampaignState.tickMonitor.recordAck(ack)
      const summary = chipCampaignState.tickMonitor.getSummary()
      broadcast('tick_update', { ack, msgId, ...summary })
      if (summary.riskLevel === 'CRITICO') {
        broadcast('ban_alert', { level: 'CRITICO', message: '⚠️ RISCO CRÍTICO! Taxa de entrega baixíssima. Pause a campanha!' })
      }
      // Atualiza status visual da mensagem no CRM
      const ackStatusMap = { '-1': 'failed', '1': 'sent', '2': 'delivered', '3': 'read' }
      const status = ackStatusMap[String(ack)]
      console.log(`[Chip ${chipId}] message_ack ack=${ack} status=${status} id=${msgId}`)
      if (status && msgId) broadcast('chip_ack', { msgId, status })
    })

    client.on('message', (msg) => {
      handleIncomingChipMessage(client, msg, chipId).catch(e => console.error('[Autobot] Error:', e.message))
    })

    // Se proxy tem autenticação, aplica antes da navegação
    if (chipSessions[chipId]?.proxyAuth) {
      const auth = chipSessions[chipId].proxyAuth
      client.on('browser_created', async () => {
        try {
          const pages = await client.pupBrowser.pages()
          for (const page of pages) await page.authenticate(auth).catch(() => {})
        } catch (e) {}
      })
    }

    console.log(`[Chip ${chipId}] Inicializando Chrome...`)

    // Timeout: se demorar mais de 90s sem QR/ready → erro visível
    const initTimeout = setTimeout(() => {
      if (chipSessions[chipId] && (chipSessions[chipId].status === 'connecting' || chipSessions[chipId].status === 'init')) {
        console.warn(`[Chip ${chipId}] Timeout na inicialização (90s)`)
        chipSessions[chipId].status = 'error'
        chipSessions[chipId].errorMsg = 'Timeout (90s) — o WhatsApp Web não respondeu. Clique em Reconectar.'
        chipSessions[chipId].qr = null
        broadcastChipsStatus()
        try { client.destroy() } catch (_) {}
      }
    }, 90 * 1000)

    client.once('qr', () => { clearTimeout(initTimeout); console.log(`[Chip ${chipId}] QR gerado`) })
    client.once('ready', () => clearTimeout(initTimeout))
    client.once('auth_failure', () => clearTimeout(initTimeout))

    await client.initialize()
  } catch (e) {
    console.error(`[Chip ${chipId}] Error:`, e.message)
    if (chipSessions[chipId]) {
      chipSessions[chipId].status = 'error'
      chipSessions[chipId].errorMsg = e.message
      chipSessions[chipId].qr = null
    }
    broadcastChipsStatus()
    // Nunca reagenda aqui — só o evento 'disconnected' dispara reconexão.
  }
}

function scheduleChipReconnect(chipId) {
  if (!chipSessions[chipId]) return
  chipSessions[chipId].reconnectAttempts = (chipSessions[chipId].reconnectAttempts || 0) + 1
  const delay = Math.min(chipSessions[chipId].reconnectAttempts * 10000, 60000)
  console.log(`[Chip ${chipId}] Reconnecting in ${delay / 1000}s`)
  setTimeout(async () => {
    if (chipSessions[chipId] && !chipSessions[chipId].isReady) {
      try { if (chipSessions[chipId].client) await chipSessions[chipId].client.destroy() } catch (e) {}
      chipSessions[chipId].client = null
      initChip(chipId)
    }
  }, delay)
}

// ── Round-robin chip selector ─────────────────────────────────────────────────
// Rotação estrita: nunca usa o mesmo chip duas vezes seguidas.
// allowedIds: chips selecionados para esta campanha (em ordem fixa).
// lastUsedId: ID do chip usado no envio anterior — será pulado.

function getNextReadyChipFrom(allowedIds, lastUsedId) {
  // Filtra apenas chips prontos dentro da lista permitida
  const readyIds = allowedIds.filter(id => chipSessions[id]?.isReady && chipSessions[id]?.client)
  if (readyIds.length === 0) return null

  // Com apenas 1 chip disponível, usa ele independentemente
  if (readyIds.length === 1) {
    const id = readyIds[0]
    return { id, client: chipSessions[id].client, proxy: chipSessions[id].proxy || null }
  }

  // Avança para o próximo chip após o último usado (nunca repete)
  const lastIdx = lastUsedId != null ? readyIds.indexOf(lastUsedId) : -1
  const nextIdx = (lastIdx + 1) % readyIds.length
  const id = readyIds[nextIdx]
  return { id, client: chipSessions[id].client, proxy: chipSessions[id].proxy || null }
}

// ── Send helpers ──────────────────────────────────────────────────────────────

// Extrai o id serializado de uma mensagem do whatsapp-web.js. Em algumas
// versões/eventos da lib, msg.id já vem como a própria string serializada
// (sem o wrapper { _serialized }) — cobre os dois formatos.
function extractMsgId(msg) {
  const id = msg?.id
  if (typeof id === 'string') return id
  if (id?._serialized) return id._serialized
  const dataId = msg?._data?.id
  if (typeof dataId === 'string') return dataId
  if (dataId?._serialized) return dataId._serialized
  return null
}

async function sendChipText(client, chatId, text) {
  for (let i = 0; i < 3; i++) {
    try {
      return await client.sendMessage(chatId, text)
    } catch (e) {
      const msg = (e.message || '').toLowerCase()
      const retry = msg.includes('timeout') || msg.includes('detached frame') || msg.includes('target closed') || msg.includes('session closed') || msg === 't'
      if (retry && i < 2) { await sleep(4000); continue }
      throw e
    }
  }
}

// ── Humanization ──────────────────────────────────────────────────────────────

const openingPhrases = [
  'Oi, tudo bem?', 'Olá! Tudo certo?', 'E aí, como vai?', 'Oi! Espero que esteja bem.',
  'Bom dia! 😊', 'Boa tarde!', 'Boa noite!', 'Oi! 👋', 'Olá! 😊', 'E aí! Tudo na paz?'
]

// Substitui {{name}}, {{1}}, {{cidade}}, etc. no template
function applyVars(text, contact) {
  const name = typeof contact === 'string' ? contact : (contact?.name || '')
  const vars = (typeof contact === 'object' && contact?.vars) ? contact.vars : {}
  let msg = text
  if (name) msg = msg.replace(/\{\{name\}\}/gi, name).replace(/\{name\}/gi, name)
  for (const [k, v] of Object.entries(vars)) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    msg = msg.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'gi'), String(v ?? ''))
  }
  return msg
}

function humanizeBasic(text, contact, greetingPool) {
  if (!text) return 'Olá!'
  const pool = (Array.isArray(greetingPool) && greetingPool.length > 0) ? greetingPool : openingPhrases
  const msg = applyVars(text, contact)
  return `${pool[Math.floor(Math.random() * pool.length)]}\n\n${msg}`
}

async function humanizeWithAI(text, contact, tone = 'amigavel', greetingPool) {
  const resolved = applyVars(text, contact)
  const name = typeof contact === 'string' ? contact : (contact?.name || '')
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) return humanizeBasic(resolved, '', greetingPool)
  const baseURL = process.env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'
  const model = process.env.GROQ_API_KEY ? 'llama3-8b-8192' : 'gpt-3.5-turbo'
  try {
    const resp = await axios.post(`${baseURL}/chat/completions`, {
      model, max_tokens: 500, temperature: 0.8,
      messages: [
        { role: 'system', content: `Reescreva a mensagem de WhatsApp de forma ${tone} e natural. Use o nome ${name || 'cliente'}. Mantenha o conteúdo original.` },
        { role: 'user', content: resolved }
      ]
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } })
    return resp.data.choices[0].message.content.trim() || humanizeBasic(resolved, '', greetingPool)
  } catch (e) {
    return humanizeBasic(resolved, '', greetingPool)
  }
}

// ── Chip Campaign ─────────────────────────────────────────────────────────────

async function runChipCampaign(data) {
  const { contacts, messageTemplate, settings = {}, mediaData } = data
  chipCampaignState.results = []
  chipCampaignState.paused = false
  chipCampaignState.stopped = false
  chipCampaignState.currentCampaign = data
  let success = 0, failed = 0
  const campaignStartedAt = Date.now()

  // Chips selecionados para esta campanha (fallback: todos os chips)
  const allChipIds = Object.keys(chipSessions)
  const selectedChipIds = Array.isArray(settings.selectedChipIds) && settings.selectedChipIds.length > 0
    ? settings.selectedChipIds.filter(id => allChipIds.includes(id))
    : allChipIds
  let lastUsedChipId = null

  // Batch delay state
  const bd = settings.batchDelay
  const batchEnabled = bd?.enabled && bd.everyMin > 0 && bd.pauseMin > 0
  let batchCount = 0
  let nextBatchAt = batchEnabled
    ? Math.floor(Math.random() * (Math.max(bd.everyMax, bd.everyMin) - bd.everyMin + 1)) + bd.everyMin
    : Infinity

  // Informa quais chips serão usados
  const readySelected = selectedChipIds.filter(id => chipSessions[id]?.isReady && chipSessions[id]?.client)
  broadcast('chip_campaign', {
    type: 'started',
    chips: readySelected,
    total: contacts.length,
  })

  for (let i = 0; i < contacts.length; i++) {
    if (chipCampaignState.stopped) break
    while (chipCampaignState.paused) await sleep(500)

    const contact = contacts[i]

    if (chipCampaignState.sentNumbers.has(contact.number)) {
      broadcast('chip_campaign', { type: 'skipped', number: contact.number, current: i + 1, total: contacts.length })
      continue
    }

    const result = { index: i, number: contact.number, name: contact.name || contact.number, status: 'sending', via: '' }
    chipCampaignState.results.push(result)
    broadcast('chip_campaign', { type: 'progress', contact: result, success, failed, total: contacts.length, current: i + 1 })

    const cooldown = chipCampaignState.delayCalc.getCooldown()
    if (cooldown > 0) {
      broadcast('chip_campaign', { type: 'cooldown', seconds: cooldown })
      await sleep(cooldown * 1000)
    }

    try {
      // Circuit breaker: stop if critical ban risk detected after 15 msgs
      if (i > 15 && chipCampaignState.tickMonitor.getBanRiskLevel() === 'CRITICO') {
        chipCampaignState.paused = true
        broadcast('chip_campaign', { type: 'paused', reason: '⚠️ Risco crítico de ban detectado! As mensagens não estão sendo entregues. Campanha pausada automaticamente.' })
        throw new Error('Pausa protetiva: risco crítico de ban')
      }

      // Rotação estrita: nunca repete o mesmo chip em disparos consecutivos
      const activeChip = getNextReadyChipFrom(selectedChipIds, lastUsedChipId)
      if (!activeChip) throw new Error('Nenhum chip selecionado disponível')
      lastUsedChipId = activeChip.id
      result.via = activeChip.id

      let text = settings.useAIHumanize
        ? await humanizeWithAI(messageTemplate, contact, settings.tone || 'amigavel', settings.greetings)
        : humanizeBasic(messageTemplate, contact, settings.greetings)

      // Resolve Brazilian number format
      let formatted = formatNumber(contact.number)
      try {
        const vid = await activeChip.client.getNumberId(formatted)
        if (vid) formatted = vid._serialized
      } catch (e) {}

      let msg
      if (mediaData?.type === 'image') {
        let MessageMedia
        try { ({ MessageMedia } = require('whatsapp-web.js')) } catch (e) {}
        if (MessageMedia) {
          const base64 = mediaData.base64.includes(',') ? mediaData.base64.split(',')[1] : mediaData.base64
          const media = new MessageMedia('image/jpeg', base64, 'imagem.jpg')
          msg = await activeChip.client.sendMessage(formatted, media, { caption: text })
        } else {
          msg = await sendChipText(activeChip.client, formatted, text)
        }
      } else {
        msg = await sendChipText(activeChip.client, formatted, text)
      }

      result.status = 'success'
      result.message = text
      result.ack = msg?.ack || 1
      result.sentAt = Date.now()
      success++
      batchCount++
      chipCampaignState.sentNumbers.add(contact.number)
      chipCampaignState.delayCalc.recordSuccess()
      broadcast('chip_campaign', { type: 'result', contact: result, success, failed })
    } catch (e) {
      result.status = 'failed'
      result.error = e.message || 'Erro desconhecido'
      failed++
      chipCampaignState.delayCalc.recordFail()
      broadcast('chip_campaign', { type: 'result', contact: result, success, failed })
    }

    if (i < contacts.length - 1 && !chipCampaignState.stopped) {
      // Batch pause: após N envios bem-sucedidos, pausa longa
      if (batchEnabled && batchCount >= nextBatchAt) {
        const pause = Math.floor(Math.random() * (Math.max(bd.pauseMax, bd.pauseMin) - bd.pauseMin + 1)) + bd.pauseMin
        broadcast('chip_campaign', { type: 'batch_pause', seconds: pause, batchCount })
        await sleep(pause * 1000)
        batchCount = 0
        nextBatchAt = Math.floor(Math.random() * (Math.max(bd.everyMax, bd.everyMin) - bd.everyMin + 1)) + bd.everyMin
      }
      // Delay regular entre mensagens
      const risk = chipCampaignState.tickMonitor.getBanRiskLevel()
      const delay = chipCampaignState.delayCalc.getDelay(risk, settings.delayMin || 3, settings.delayMax || 8)
      // Próximo chip na rotação (apenas para preview no log, não altera lastUsedChipId ainda)
      const nextChipPreview = getNextReadyChipFrom(selectedChipIds, lastUsedChipId)
      broadcast('chip_campaign', { type: 'waiting', delay, risk, next: i + 2, nextChip: nextChipPreview?.id || null })
      await sleep(delay * 1000)
    }
  }

  const campaignEndedAt = Date.now()
  broadcast('chip_campaign', {
    type: 'done', success, failed, total: contacts.length,
    results: chipCampaignState.results, stats: chipCampaignState.tickMonitor.getSummary()
  })

  saveCampaign({
    id: campaignStartedAt.toString(),
    startedAt: campaignStartedAt,
    endedAt: campaignEndedAt,
    total: contacts.length,
    success,
    failed,
    skipped: contacts.length - success - failed,
    results: chipCampaignState.results.map(r => ({ ...r })),
  })

  chipCampaignState.currentCampaign = null
}

// ── Maturador ─────────────────────────────────────────────────────────────────

const maturadorPhrases = [
  'Oi! 👋', 'Tudo bem?', 'Boa tarde!', 'Oi tudo bem?', 'Olá! 😊', 'E aí!',
  'Boa noite!', 'Como vai?', 'Tudo certo?', 'Oi!', 'Olá!', 'E aí, tudo na paz?'
]

async function runMaturadorLoop(minDelay, maxDelay) {
  if (!maturadorState.running) return
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady && chipSessions[id].client)

  if (readyIds.length >= 2) {
    const senderId = readyIds[Math.floor(Math.random() * readyIds.length)]
    let receiverId
    do { receiverId = readyIds[Math.floor(Math.random() * readyIds.length)] } while (senderId === receiverId)

    const receiverNumber = chipSessions[receiverId].number
    try {
      if (!receiverNumber) throw new Error(`Chip ${receiverId} sem número registrado`)
      const msg = maturadorPhrases[Math.floor(Math.random() * maturadorPhrases.length)]
      await sendChipText(chipSessions[senderId].client, formatNumber(receiverNumber), msg)
      broadcast('maturador', { type: 'log', from: senderId, to: receiverId, toNumber: receiverNumber, message: msg, ts: Date.now() })
    } catch (e) {
      broadcast('maturador', { type: 'error', chipId: senderId, error: e.message })
    }
  } else {
    broadcast('maturador', { type: 'waiting', message: '⚠️ Aguardando pelo menos 2 chips conectados...' })
  }

  if (!maturadorState.running) return
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay
  broadcast('maturador', { type: 'delay', seconds: delay })
  maturadorState.timer = setTimeout(() => runMaturadorLoop(minDelay, maxDelay), delay * 1000)
}

// ── Autobot ───────────────────────────────────────────────────────────────────

function isInWorkingHours() {
  const wh = autoBotData.workingHours
  if (!wh?.enabled) return true
  const now = new Date()
  const day = now.getDay() === 0 ? 7 : now.getDay()
  if (!wh.days.includes(day)) return false
  const [sh, sm] = wh.start.split(':').map(Number)
  const [eh, em] = wh.end.split(':').map(Number)
  const cur = now.getHours() * 60 + now.getMinutes()
  return cur >= sh * 60 + sm && cur <= eh * 60 + em
}

function isAntiSpam(contactId) {
  const st = contactBotState[contactId]
  if (!st?.lastSeen) return false
  return (Date.now() - st.lastSeen) / 60000 < (autoBotData.antiSpamMinutes || 60)
}

async function handleIncomingChipMessage(client, msg, chipId) {
  if (!msg.from || msg.fromMe) return

  const isGroup = msg.from.endsWith('@g.us')
    || (msg.id?.remote ?? '').endsWith('@g.us')
    || !!(msg.author && msg.author !== msg.from)
  const chatId = isGroup ? (msg.id?.remote || msg.from) : msg.from
  const author = isGroup ? (msg.author || msg.from) : msg.from

  // Track response stats
  responseStats.totalResponses++
  responseStats.lastResponseAt = Date.now()
  responseStats.responses.push({ from: msg.from, author, body: msg.body, timestamp: Date.now(), chipId, chipNumber: chipSessions[chipId]?.number })
  if (responseStats.responses.length > 500) responseStats.responses.shift()

  // Get group name and contact pushname asynchronously
  let groupName = null
  let pushname = null
  let contactNumber = null
  if (isGroup) {
    try {
      const chat = await client.getChatById(msg.from)
      groupName = chat?.name || null
    } catch (_) {}
  } else {
    // Real phone numbers have at most 13 digits (E.164). 14+ digits = WhatsApp LID — ignore.
    const looksLikePhone = (num) => num && /^\d+$/.test(num) && num.length <= 13

    if (msg.from.endsWith('@c.us')) {
      const candidate = msg.from.split('@')[0]
      if (looksLikePhone(candidate)) contactNumber = candidate
    }
    try {
      const contact = await msg.getContact()
      pushname = contact.pushname || contact.name || null

      // Collect every candidate field that might hold the real phone number
      const candidates = [
        contact.number,
        // id.user when server is c.us (not lid) is the real phone
        contact.id?.server === 'c.us' ? contact.id?.user : null,
        // _serialized like "553598722790@c.us" → extract user part
        contact.id?._serialized?.endsWith('@c.us')
          ? contact.id._serialized.split('@')[0]
          : null,
        // Some versions expose verifiedName or formattedNumber
        contact.formattedNumber?.replace(/\D/g, ''),
      ]
      const resolved = candidates.find(looksLikePhone)
      if (resolved) contactNumber = resolved
    } catch (_) {}
  }

  // ── Mídia recebida (imagem, áudio, vídeo, documento, sticker) ──────────────
  // Mapeamento do tipo whatsapp-web.js → tipo interno
  const wwjsTypeMap = { image:'image', video:'video', audio:'audio', ptt:'audio', document:'document', sticker:'image' }
  let msgType = msg.hasMedia ? (wwjsTypeMap[msg.type] || 'document') : 'text'
  let mediaUrl = null
  let mediaFileName = null

  if (msg.hasMedia) {
    try {
      const mediaData = await msg.downloadMedia()
      if (mediaData?.data) {
        const rawMime = mediaData.mimetype || 'application/octet-stream'
        const mime    = rawMime.split(';')[0].trim()

        // Refine type from actual mimetype
        if      (mime.startsWith('image/'))  msgType = 'image'
        else if (mime.startsWith('audio/') || msg.type === 'ptt') msgType = 'audio'
        else if (mime.startsWith('video/'))  msgType = 'video'
        else                                 msgType = 'document'

        const extMap = {
          'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
          'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/webm':'webm','audio/aac':'aac',
          'video/mp4':'mp4','video/webm':'webm','video/3gpp':'3gp',
          'application/pdf':'pdf',
        }
        const ext   = extMap[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi,'')
        const fname = `${chipId}_${Date.now()}.${ext}`
        fs.writeFileSync(path.join(MEDIA_DIR, fname), Buffer.from(mediaData.data, 'base64'))
        mediaUrl      = `/api/media/files/${fname}`
        mediaFileName = mediaData.filename || fname
        console.log(`[Chip] Mídia salva: ${fname} (${msgType})`)
      }
    } catch (e) {
      console.error('[Chip] Erro ao baixar mídia:', e.message)
    }
  }

  const convId = getConvId(chipId, chatId)
  broadcast('chip_message', {
    chipId,
    from: chatId,
    author,
    body: msg.body || '',
    timestamp: msg.timestamp,
    isGroup,
    groupName,
    pushname,
    contactNumber,
    msgType,
    mediaUrl,
    mediaFileName,
    conversationId: convId,
  })
  fireWebhooks('message_created', {
    chipId, from: msg.from, body: msg.body,
    timestamp: msg.timestamp, isGroup, groupName, pushname, contactNumber,
    msgType, mediaUrl, mediaFileName,
    conversationId: convId,
  })

  // Disparo de webhook IA para chips conectados à IA
  try {
    const fgts = (loadIAConfig().fgts) || {}
    if (fgts.webhookEnabled && fgts.webhookUrl && Array.isArray(fgts.chipIds) && fgts.chipIds.includes(chipId)) {
      const from = String(msg.from || '').replace(/@.*$/, '')
      const name = pushname || contactNumber || from
      const message = msg.body || ''
      axios.post(fgts.webhookUrl, { chipId, from, message, name },
        { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
      ).catch(e => console.error('[IA Webhook Chip]', e.message))
    }
  } catch (e) { console.error('[IA Webhook Chip] Erro:', e.message) }

  if (!autoBotData.active) return
  if (!isInWorkingHours()) return
  if (isAntiSpam(msg.from)) return
  if ((autoBotData.pausedContacts || []).includes(msg.from)) return

  const text = (msg.body || '').toLowerCase().trim()

  // Escalation to human
  if (autoBotData.escalationWord && text.includes(autoBotData.escalationWord.toLowerCase())) {
    autoBotData.pausedContacts = [...(autoBotData.pausedContacts || []), msg.from]
    saveAutoBotData(autoBotData)
    broadcast('autobot', { type: 'escalation', contact: msg.from })
    return
  }

  // Match rules
  let matchedRule = null
  for (const rule of (autoBotData.rules || [])) {
    if (!rule.trigger || !rule.response) continue
    const triggers = rule.trigger.toLowerCase().split('|').map(t => t.trim())
    const matched = triggers.some(t => {
      if (t === '*') return true
      if (rule.matchType === 'exact') return text === t
      return text.includes(t)
    })
    if (matched) { matchedRule = rule; break }
  }
  if (!matchedRule) return

  if (!contactBotState[msg.from]) contactBotState[msg.from] = {}
  contactBotState[msg.from].lastSeen = Date.now()

  try {
    const chat = await client.getChatById(msg.from)
    await chat.sendStateTyping()
    await sleep(1000 + Math.random() * 2000)
    await chat.clearState()

    const now = new Date()
    let response = matchedRule.response
      .replace('{{hora}}', now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
      .replace('{{data}}', now.toLocaleDateString('pt-BR'))

    await client.sendMessage(msg.from, response)
    broadcast('autobot', { type: 'sent', contact: msg.from, rule: matchedRule.trigger, response })
  } catch (e) {
    console.error('[Autobot] Send error:', e.message)
  }
}

// ── Number filter ─────────────────────────────────────────────────────────────

async function checkNumberWa(client, raw) {
  // Tenta o número direto + variantes brasileiras (8/9 dígitos)
  if (await client.isRegisteredUser(`${raw}@c.us`)) return true
  if (raw.startsWith('55') && raw.length === 12) { // sem o 9 → tenta com 9
    if (await client.isRegisteredUser(`55${raw.slice(2,4)}9${raw.slice(4)}@c.us`)) return true
  } else if (raw.startsWith('55') && raw.length === 13) { // com o 9 → tenta sem 9
    if (await client.isRegisteredUser(`55${raw.slice(2,4)}${raw.slice(5)}@c.us`)) return true
  }
  return false
}

async function filterNumbersBulk(numbers) {
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady && chipSessions[id].client)
  if (readyIds.length === 0) return numbers.map(n => ({ number: String(n).replace(/\D/g,''), hasWhatsapp: null, error: 'Nenhum chip conectado' }))
  const client = chipSessions[readyIds[0]].client
  const results = []
  for (const number of numbers) {
    const raw = String(number).replace(/\D/g, '')
    let hasWhatsapp = false
    try { hasWhatsapp = await checkNumberWa(client, raw) } catch (_) {}
    results.push({ number: raw, hasWhatsapp })
    await sleep(250)
  }
  return results
}

// Filtro assíncrono com progresso via WebSocket
let waFilterRunning = false

async function runWaFilterAsync(numbers) {
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady && chipSessions[id].client)
  if (readyIds.length === 0) {
    broadcast('wa_filter_done', { error: 'Nenhum chip conectado. Conecte pelo menos um chip antes de filtrar.', results: [] })
    return
  }
  const client = chipSessions[readyIds[0]].client
  const results = []
  let hasWa = 0, noWa = 0

  broadcast('wa_filter_progress', { checked: 0, total: numbers.length, hasWa: 0, noWa: 0 })

  for (let i = 0; i < numbers.length; i++) {
    const raw = String(numbers[i]).replace(/\D/g, '')
    let found = false
    try { found = await checkNumberWa(client, raw) } catch (_) {}
    results.push({ number: raw, hasWhatsapp: found })
    found ? hasWa++ : noWa++
    // Envia progresso a cada 5 verificações ou no final
    if ((i + 1) % 5 === 0 || i === numbers.length - 1)
      broadcast('wa_filter_progress', { checked: i + 1, total: numbers.length, hasWa, noWa })
    await sleep(250)
  }

  broadcast('wa_filter_done', { results, hasWa, noWa, total: numbers.length })
}

app.post('/api/tools/wa-filter', (req, res) => {
  const { numbers } = req.body
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'numbers obrigatório' })
  if (waFilterRunning) return res.status(409).json({ error: 'Filtro já em andamento. Aguarde terminar.' })
  waFilterRunning = true
  runWaFilterAsync(numbers)
    .catch(e => broadcast('wa_filter_done', { error: e.message, results: [] }))
    .finally(() => { waFilterRunning = false })
  res.json({ ok: true, total: numbers.length })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CHIP API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/chips', (_req, res) => res.json(getChipsList()))

app.post('/api/chips/connect', (req, res) => {
  const { chipId } = req.body
  if (!chipId) return res.status(400).json({ error: 'chipId obrigatório' })
  if (!chipSessions[chipId]) chipSessions[chipId] = { client: null, status: 'init', number: null, isReady: false, reconnectAttempts: 0, temperature: 'frio' }
  saveRegistry()
  initChip(chipId)
  res.json({ ok: true, chipId })
})

app.post('/api/chips/:chipId/temperature', (req, res) => {
  const { chipId } = req.params
  const { temperature } = req.body
  if (!['frio', 'morno', 'quente'].includes(temperature)) return res.status(400).json({ error: 'Valor inválido' })
  if (!chipSessions[chipId]) return res.status(404).json({ error: 'Chip não encontrado' })
  chipSessions[chipId].temperature = temperature
  saveRegistry()
  // Envia apenas a temperatura — não reenvia o estado completo para evitar
  // sobrescrever status de conexão com valores transitórios
  broadcast('chip_temperature', { chipId, temperature })
  res.json({ ok: true })
})

// ── Proxy Routes ──────────────────────────────────────────────────────────────

app.get('/api/proxies', (_req, res) => res.json(loadProxies()))

app.get('/api/proxies/rotator/status', (_req, res) => {
  const proxies = loadProxies()
  const usageCounts = [...rotatorState.active.values()].reduce((acc, p) => {
    acc[p] = (acc[p] || 0) + 1; return acc
  }, {})
  res.json({
    port: ROTATOR_PORT,
    total: proxies.length,
    activeConnections: rotatorState.active.size,
    inUseNow: usageCounts,
    recentHistory: rotatorState.history.slice(-proxies.length * 2),
  })
})

app.post('/api/proxies', (req, res) => {
  const { proxy } = req.body
  if (!proxy || !proxy.trim()) return res.status(400).json({ error: 'proxy obrigatório' })
  const list = loadProxies()
  const entry = proxy.trim()
  if (list.includes(entry)) return res.status(400).json({ error: 'Proxy já existe' })
  list.push(entry)
  saveProxies(list)
  // Reinicia chips sem proxy para que peguem o rotador
  Object.entries(chipSessions).forEach(([id, s]) => {
    if (!s.proxy || s.proxy === null) {
      console.log(`[Rotator] Proxy adicionado — reconectando chip ${id} com rotador`)
      if (s.client) try { s.client.destroy() } catch (_) {}
      setTimeout(() => initChip(id), 1000)
    }
  })
  res.json({ ok: true, list })
})

app.delete('/api/proxies/:index', (req, res) => {
  const idx = parseInt(req.params.index)
  const list = loadProxies()
  if (idx < 0 || idx >= list.length) return res.status(404).json({ error: 'Índice inválido' })
  list.splice(idx, 1)
  saveProxies(list)
  // Limpa histórico do rotador para recalibrar
  rotatorState.history = []
  if (list.length === 0) {
    // Sem proxies: reconecta chips diretamente
    Object.entries(chipSessions).forEach(([id, s]) => {
      if (s.proxy?.startsWith('rotador:')) {
        s.proxy = null
        if (s.client) try { s.client.destroy() } catch (_) {}
        setTimeout(() => initChip(id), 1000)
      }
    })
  }
  res.json({ ok: true, list })
})

app.post('/api/chips/disconnect', async (req, res) => {
  const { chipId } = req.body
  if (!chipSessions[chipId]) return res.status(404).json({ error: 'Chip não encontrado' })
  const s = chipSessions[chipId]
  try {
    if (s.client) { await s.client.logout().catch(() => {}); await s.client.destroy().catch(() => {}) }
  } catch (e) {}
  delete chipSessions[chipId]
  saveRegistry()
  // Remove session folder
  const folder = path.join(__dirname, '.wwa_sessions', chipId)
  if (fs.existsSync(folder)) try { fs.rmSync(folder, { recursive: true, force: true }) } catch (e) {}
  broadcastChipsStatus()
  res.json({ ok: true })
})

app.post('/api/chips/reconnect', async (req, res) => {
  const { chipId } = req.body
  if (!chipId) return res.status(400).json({ error: 'chipId obrigatório' })
  if (chipSessions[chipId]?.client) {
    try { await chipSessions[chipId].client.destroy() } catch (e) {}
    chipSessions[chipId].client = null
    chipSessions[chipId].isReady = false
  }
  setTimeout(() => initChip(chipId), 500)
  res.json({ ok: true })
})

// ── Chip Campaign Routes ──────────────────────────────────────────────────────

app.post('/api/chip-campaign/start', (req, res) => {
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady)
  if (readyIds.length === 0) return res.status(400).json({ error: 'Nenhum chip conectado' })
  if (chipCampaignState.currentCampaign) return res.status(400).json({ error: 'Campanha já em andamento' })
  const data = req.body
  if (!data.force) {
    const h = new Date().getHours()
    if (h >= 20 || h < 8) return res.status(400).json({
      error: 'RISK_TIME',
      message: '⚠️ Disparos fora do horário comercial (08h-20h) têm maior risco de ban. Deseja continuar mesmo assim?'
    })
  }
  res.json({ ok: true, count: data.contacts?.length || 0 })
  runChipCampaign(data)
})

app.post('/api/chip-campaign/pause', (_req, res) => {
  chipCampaignState.paused = !chipCampaignState.paused
  broadcast('chip_campaign', { type: 'paused', paused: chipCampaignState.paused })
  res.json({ paused: chipCampaignState.paused })
})

app.post('/api/chip-campaign/stop', (_req, res) => {
  chipCampaignState.stopped = true
  broadcast('chip_campaign', { type: 'stopped' })
  res.json({ ok: true })
})

app.post('/api/chip-campaign/reset-sent', (_req, res) => {
  const count = chipCampaignState.sentNumbers.size
  chipCampaignState.sentNumbers.clear()
  res.json({ ok: true, cleared: count })
})

app.get('/api/chip-campaign/results', (_req, res) => res.json(chipCampaignState.results))

app.get('/api/chip-campaign/stats', (_req, res) => res.json({
  running: !!chipCampaignState.currentCampaign,
  paused: chipCampaignState.paused,
  tickStats: chipCampaignState.tickMonitor.getSummary(),
  riskLevel: chipCampaignState.tickMonitor.getBanRiskLevel(),
}))

// ── Maturador Routes ──────────────────────────────────────────────────────────

app.get('/api/maturador/status', (_req, res) => {
  res.json({
    running: maturadorState.running,
    chipIds: maturadorState.chipIds,
    minDelay: maturadorState.minDelay,
    maxDelay: maturadorState.maxDelay,
  })
})

app.post('/api/maturador/start', (req, res) => {
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady)
  if (readyIds.length < 2) return res.status(400).json({ error: 'Você precisa de pelo menos 2 chips conectados para o maturador.' })
  const min = Number(req.body.minDelay) || 60
  const max = Number(req.body.maxDelay) || 300
  maturadorState.running = true
  maturadorState.chipIds = req.body.chipIds || readyIds
  maturadorState.minDelay = min
  maturadorState.maxDelay = max
  res.json({ ok: true })
  broadcast('maturador', { type: 'started' })
  runMaturadorLoop(min, max)
})

app.post('/api/maturador/stop', (_req, res) => {
  maturadorState.running = false
  if (maturadorState.timer) clearTimeout(maturadorState.timer)
  broadcast('maturador', { type: 'stopped' })
  res.json({ ok: true })
})

// ── Tool Routes ───────────────────────────────────────────────────────────────

app.post('/api/tools/filter', async (req, res) => {
  const { numbers } = req.body
  if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'Envie um array de números.' })
  if (numbers.length > 500) return res.status(400).json({ error: 'Máximo de 500 números por vez.' })
  try {
    const results = await filterNumbersBulk(numbers)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/tools/groups/list', async (_req, res) => {
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady)
  if (readyIds.length === 0) return res.json({ groups: [], error: 'Nenhum chip conectado' })
  try {
    const client = chipSessions[readyIds[0]].client
    const chats = await client.getChats()
    const groups = chats.filter(c => c.isGroup && c.name).map(g => ({
      id: g.id._serialized, name: g.name,
      memberCount: Array.isArray(g.participants) ? g.participants.length : '?'
    }))
    res.json({ groups })
  } catch (e) {
    res.status(500).json({ groups: [], error: e.message })
  }
})

app.post('/api/tools/groups/members', async (req, res) => {
  const { groupId } = req.body
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady)
  if (readyIds.length === 0) return res.json({ members: [] })
  try {
    const client = chipSessions[readyIds[0]].client
    const chat = await client.getChatById(groupId)
    if (!chat || !Array.isArray(chat.participants)) return res.json({ members: [] })
    const members = chat.participants.filter(p => p.id?.user).map(p => ({ number: p.id.user, name: p.id.user }))
    res.json({ members })
  } catch (e) {
    res.status(500).json({ members: [], error: e.message })
  }
})

app.post('/api/tools/groups/search', async (req, res) => {
  const { query, pages = 3 } = req.body
  if (!query) return res.status(400).json({ error: 'query é obrigatório' })
  let browser = null
  try {
    const fse = require('fs')

    function findChrome() {
      const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
      ].filter(Boolean)
      for (const p of candidates) {
        try { if (fse.existsSync(p)) return p } catch (_) {}
      }
      return null
    }

    let puppeteerModule
    try {
      puppeteerModule = require('puppeteer-extra')
      const StealthPlugin = require('puppeteer-extra-plugin-stealth')
      puppeteerModule.use(StealthPlugin())
    } catch (_) {
      puppeteerModule = require('puppeteer')
    }

    const chromePath = findChrome()
    browser = await puppeteerModule.launch({
      headless: 'new',
      executablePath: chromePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--lang=pt-BR,pt',
        '--window-size=1366,768',
        '--window-position=-9999,-9999',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    })

    const page = await browser.newPage()
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1366, height: 768 })

    const links = new Set()
    const maxPages = Math.min(parseInt(pages) || 3, 5)

    const extractFromPage = async () => {
      return page.evaluate(function() {
        var waRe = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/g
        var results = new Set()
        var pageText = document.body ? document.body.innerText : ''
        var pageHtml = document.documentElement.innerHTML
        var fromText = pageText.match(waRe) || []
        var fromHtml = pageHtml.match(waRe) || []
        fromText.forEach(function(m) { results.add(m) })
        fromHtml.forEach(function(m) { results.add(m) })
        return Array.from(results)
      })
    }

    for (let p = 0; p < maxPages && links.size < 100; p++) {
      const start = p * 10
      const searchUrl = `https://www.google.com.br/search?q=${encodeURIComponent(`"chat.whatsapp.com" ${query}`)}&start=${start}&hl=pt-BR&num=10`
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })

      // Aguarda a página ter conteúdo real (pode demorar até 12s com JS assíncrono)
      try {
        await page.waitForFunction(function() {
          return document.body && document.body.innerText.length > 3000
        }, { timeout: 12000 })
      } catch (_) {}

      // Verifica se o Google bloqueou (página mínima de redirecionamento)
      const textLen = await page.evaluate(function() {
        return document.body ? document.body.innerText.length : 0
      })
      if (textLen < 1000) {
        // Google detectou automação — informa ao usuário
        await browser.close(); browser = null
        return res.json({ links: [], blocked: true, message: 'O Google limitou as buscas automatizadas. Aguarde 2-3 minutos e tente novamente.' })
      }

      const found = await extractFromPage()
      found.forEach(l => links.add(l))
      if (p < maxPages - 1) await sleep(2000 + Math.random() * 1000)
    }

    await browser.close()
    browser = null
    res.json({ links: [...links] })
  } catch (e) {
    console.error('[Groups] ERRO:', e.message)
    if (browser) browser.close().catch(() => {})
    res.status(500).json({ links: [], error: e.message })
  }
})

app.get('/api/tools/contacts/export', async (_req, res) => {
  const readyIds = Object.keys(chipSessions).filter(id => chipSessions[id].isReady)
  if (readyIds.length === 0) return res.json({ contacts: [] })
  try {
    const client = chipSessions[readyIds[0]].client
    const allContacts = await client.getContacts()
    const contacts = allContacts.filter(c => c.isMyContact && !c.isGroup && c.id?.user).map(c => ({
      number: c.id.user, name: c.pushname || c.name || c.notify || ''
    }))
    res.json({ contacts })
  } catch (e) {
    res.status(500).json({ contacts: [], error: e.message })
  }
})

// ── GMaps Routes ──────────────────────────────────────────────────────────────

app.post('/api/tools/gmaps/start', (req, res) => {
  const { query, limit } = req.body
  if (!query) return res.status(400).json({ error: 'query é obrigatório' })
  try {
    const { startGmapsScraper } = require('./tools/gmaps_scraper')
    startGmapsScraper(query, parseInt(limit) || 50, (msg) => {
      try { broadcast(msg.type || 'gmaps', msg) } catch {}
    }).catch(e => {
      console.error('[GMaps] Erro não tratado:', e.message)
      try { broadcast('gmaps_log', { type: 'gmaps_log', message: 'Erro: ' + e.message }) } catch {}
      try { broadcast('gmaps_done', { type: 'gmaps_done' }) } catch {}
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Erro ao iniciar GMaps: ' + e.message })
  }
})

app.post('/api/tools/gmaps/stop', (_req, res) => {
  try {
    const { stopGmapsScraper } = require('./tools/gmaps_scraper')
    stopGmapsScraper()
  } catch (e) {}
  res.json({ ok: true })
})

app.get('/api/tools/gmaps/status', (_req, res) => {
  try {
    const { getScrapingStatus } = require('./tools/gmaps_scraper')
    res.json(getScrapingStatus())
  } catch (e) {
    res.json({ isScraping: false })
  }
})

// ── Auth ──────────────────────────────────────────────────────────────────────
const auth = require('./auth')
const bcrypt = require('bcryptjs')
auth.initAdmin()

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' })
  const users = auth.getUsers()
  const user = users.find(u => u.email === email)
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Email ou senha inválidos' })
  }
  const token = auth.signToken(user)
  const { passwordHash: _, ...safeUser } = user
  res.json({ token, user: safeUser })
})

app.get('/api/auth/me', auth.authMiddleware, (req, res) => {
  const users = auth.getUsers()
  const user = users.find(u => u.id === req.user.id)
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })
  const { passwordHash: _, ...safeUser } = user
  res.json(safeUser)
})

app.get('/api/users', auth.authMiddleware, auth.adminMiddleware, (_req, res) => {
  const users = auth.getUsers().map(({ passwordHash: _, ...u }) => u)
  res.json(users)
})

app.post('/api/users', auth.authMiddleware, auth.adminMiddleware, (req, res) => {
  const { name, email, password, permissions } = req.body || {}
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios: name, email, password' })
  const users = auth.getUsers()
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'Email já cadastrado' })
  const newUser = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'user',
    permissions: permissions || { dispatcher: false, chips: false, settings: false, channelIds: [] },
    createdAt: new Date().toISOString(),
  }
  users.push(newUser)
  auth.saveUsers(users)
  const { passwordHash: _, ...safeUser } = newUser
  res.json(safeUser)
})

app.put('/api/users/:id', auth.authMiddleware, auth.adminMiddleware, (req, res) => {
  const users = auth.getUsers()
  const idx = users.findIndex(u => u.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' })
  const { password, ...updates } = req.body || {}
  if (password) updates.passwordHash = bcrypt.hashSync(password, 10)
  users[idx] = { ...users[idx], ...updates }
  auth.saveUsers(users)
  const { passwordHash: _, ...safeUser } = users[idx]
  res.json(safeUser)
})

app.delete('/api/users/:id', auth.authMiddleware, auth.adminMiddleware, (req, res) => {
  const users = auth.getUsers()
  const user = users.find(u => u.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })
  if (user.role === 'admin') return res.status(403).json({ error: 'Não é possível excluir o admin' })
  auth.saveUsers(users.filter(u => u.id !== req.params.id))
  res.json({ ok: true })
})

// ── CRM Database ──────────────────────────────────────────────────────────────
const crmDb = require('./db')

app.get('/api/db/state', (_req, res) => {
  try {
    const v = crmDb.getState('crm-store')
    res.json(v ? JSON.parse(v) : null)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/db/state', (req, res) => {
  try {
    crmDb.setState('crm-store', JSON.stringify(req.body))
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/db/state', (_req, res) => {
  try {
    crmDb.deleteState('crm-store')
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Channels (sync from frontend) ─────────────────────────────────────────────
const CHANNELS_FILE = path.join(__dirname, 'data', 'channels.json')
function loadChannels() { try { return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')) } catch { return [] } }
function saveChannels(list) {
  try {
    const dir = path.dirname(CHANNELS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(list, null, 2))
  } catch (e) { console.error('[Channels] Erro ao salvar:', e.message) }
}

app.get('/api/channels', (_req, res) => res.json(loadChannels()))
app.post('/api/channels', (req, res) => {
  const list = req.body
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected array' })
  saveChannels(list)
  res.json({ ok: true })
})

// ── IA Config ─────────────────────────────────────────────────────────────────
const IA_CONFIG_FILE = path.join(__dirname, 'data', 'ia_config.json')

function loadIAConfig() {
  try { return JSON.parse(fs.readFileSync(IA_CONFIG_FILE, 'utf8')) } catch { return {} }
}

function saveIAConfig(config) {
  try {
    const dir = path.dirname(IA_CONFIG_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(IA_CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch (e) { console.error('[IA] Erro ao salvar:', e.message) }
}

app.get('/api/ia/fgts', (_req, res) => {
  const config = loadIAConfig()
  res.json(config.fgts || { enabled: false, chipIds: [], channelIds: [], webhookEnabled: false, webhookUrl: '' })
})

app.post('/api/ia/fgts', (req, res) => {
  const { enabled, chipIds, channelIds, webhookEnabled, webhookUrl } = req.body
  const config = loadIAConfig()
  config.fgts = {
    enabled: !!enabled,
    chipIds: chipIds || [],
    channelIds: channelIds || [],
    webhookEnabled: !!webhookEnabled,
    webhookUrl: typeof webhookUrl === 'string' ? webhookUrl.trim() : '',
  }
  saveIAConfig(config)
  res.json({ ok: true })
})

app.get('/api/ia/fgts/phones', (_req, res) => {
  const config = loadIAConfig()
  const fgts = config.fgts || { enabled: false, chipIds: [], channelIds: [] }
  const phones = fgts.chipIds.map(chipId => {
    const session = chipSessions[chipId]
    return { type: 'chip', id: chipId, phone: session?.number || null, status: session?.status || 'unknown', ready: session?.isReady || false }
  })
  res.json({ enabled: fgts.enabled, phones })
})

// ── CRM External API ──────────────────────────────────────────────────────────

app.post('/api/crm/contacts/:phone/labels', (req, res) => {
  const { phone } = req.params
  const { label } = req.body
  if (!label) return res.status(400).json({ error: 'label é obrigatório' })
  const cleanPhone = String(phone).replace(/\D/g, '')
  broadcast('crm_label_add', { phone: cleanPhone, label })
  fireWebhooks('contact_updated', { phone: cleanPhone, action: 'label_add', label })
  res.json({ ok: true })
})

app.delete('/api/crm/contacts/:phone/labels/:label', (req, res) => {
  const { phone, label } = req.params
  const cleanPhone = String(phone).replace(/\D/g, '')
  const decodedLabel = decodeURIComponent(label)
  broadcast('crm_label_remove', { phone: cleanPhone, label: decodedLabel })
  fireWebhooks('contact_updated', { phone: cleanPhone, action: 'label_remove', label: decodedLabel })
  res.json({ ok: true })
})

app.put('/api/crm/conversations/:phone/pipeline', (req, res) => {
  const { phone } = req.params
  const { columnId } = req.body
  if (!columnId) return res.status(400).json({ error: 'columnId é obrigatório' })
  const cleanPhone = String(phone).replace(/\D/g, '')
  broadcast('crm_pipeline_transfer', { phone: cleanPhone, columnId })
  fireWebhooks('conversation_status_changed', { phone: cleanPhone, columnId })
  res.json({ ok: true })
})

// ── Webhook CRUD ─────────────────────────────────────────────────────────────

app.get('/api/webhooks', (_req, res) => res.json(loadWebhooks()))

app.post('/api/webhooks', (req, res) => {
  const { url, events } = req.body
  if (!url || !Array.isArray(events) || events.length === 0)
    return res.status(400).json({ error: 'url e events são obrigatórios' })
  try { new URL(url) } catch (_) { return res.status(400).json({ error: 'URL inválida' }) }
  const list = loadWebhooks()
  const wh = { id: `wh_${Date.now()}`, url, events, createdAt: new Date().toISOString() }
  list.push(wh)
  saveWebhooks(list)
  res.status(201).json(wh)
})

app.patch('/api/webhooks/:id', (req, res) => {
  const list = loadWebhooks()
  const idx = list.findIndex(w => w.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'Webhook não encontrado' })
  const { url, events } = req.body
  if (url !== undefined) {
    try { new URL(url) } catch (_) { return res.status(400).json({ error: 'URL inválida' }) }
    list[idx].url = url
  }
  if (Array.isArray(events)) list[idx].events = events
  saveWebhooks(list)
  res.json(list[idx])
})

app.delete('/api/webhooks/:id', (req, res) => {
  const list = loadWebhooks().filter(w => w.id !== req.params.id)
  saveWebhooks(list)
  res.json({ ok: true })
})

// Teste manual de disparo
app.post('/api/webhooks/:id/test', (req, res) => {
  const wh = loadWebhooks().find(w => w.id === req.params.id)
  if (!wh) return res.status(404).json({ error: 'Webhook não encontrado' })
  axios.post(wh.url, {
    event: 'test',
    timestamp: new Date().toISOString(),
    data: { message: 'Teste de webhook do CRM WhatsApp', webhookId: wh.id },
  }, {
    timeout: 8000,
    headers: { 'Content-Type': 'application/json', 'x-crm-event': 'test', 'x-crm-webhook-id': wh.id },
  }).then(() => res.json({ ok: true }))
    .catch(e => res.status(502).json({ error: e.message }))
})

// ── Lista de conversas com seus conversationIds ───────────────────────────────

app.get('/api/conversations', (req, res) => {
  const list = Object.entries(convMap).map(([conversationId, { channel, contact }]) => ({
    conversationId,
    channel,
    contact,
  }))
  res.json(list)
})

// ── Envio unificado (chip ou canal oficial Meta) ──────────────────────────────

app.post('/api/send-message', async (req, res) => {
  let { chipId, channelId, to, message, conversationId } = req.body

  // conversationId recebido do webhook → resolve canal e contato
  if (conversationId && !to) {
    const entry = convMap[conversationId]
    if (!entry) return res.status(404).json({ error: `conversaId "${conversationId}" não encontrado. O ID deve vir do payload do webhook (campo data.conversationId) de uma mensagem recebida.` })
    chipId = chipId || entry.channel
    to = entry.contact
  }

  const id = chipId || channelId
  if (!id || !to || !message) return res.status(400).json({ error: 'Informe conversationId+message (para responder) ou chipId+to+message (para nova conversa)' })

  // 1. Tenta como chip
  const session = chipSessions[id]
  if (session?.isReady && session.client) {
    try {
      let chatId = to.includes('@') ? to : formatNumber(to)
      const convId = conversationId || getConvId(id, chatId)
      const msg = await sendChipText(session.client, chatId, message)
      const msgId = extractMsgId(msg)
      fireWebhooks('message_sent', { chipId: id, to: chatId, message, msgId, conversationId: convId })
      res.json({ ok: true, msgId })
      setTimeout(() => broadcast('chip_outbound', { chipId: id, to: chatId, message, msgId, type: 'text', timestamp: Date.now(), conversationId: convId }), 300)
    } catch (e) { res.status(500).json({ error: e.message }) }
    return
  }

  // 2. Tenta como canal oficial (busca credenciais salvas no backend)
  const channels = loadChannels()
  const channel = channels.find(c =>
    c.id === id || c.name === id || String(c.phoneNumberId) === String(id)
  )
  if (!channel) return res.status(404).json({ error: `Canal ou chip "${id}" não encontrado. Verifique o nome em Configurações.` })

  try {
    const toDigits = String(to).replace(/\D/g, '')
    const convId = conversationId || getConvId(channel.phoneNumberId, toDigits)
    const resp = await axios.post(
      `https://graph.facebook.com/v20.0/${channel.phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: toDigits, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${channel.accessToken}`, 'Content-Type': 'application/json' } }
    )
    const msgId = resp.data?.messages?.[0]?.id || null
    fireWebhooks('message_sent', { channelId: channel.id, channelName: channel.name, to: toDigits, message, msgId, conversationId: convId })
    res.json({ ok: true, msgId })
  } catch (e) {
    const apiErr = e?.response?.data?.error
    res.status(500).json({ error: apiErr?.message || e.message })
  }
})

// ── Chip direct send ─────────────────────────────────────────────────────────

app.post('/api/chips/send', async (req, res) => {
  const { chipId, to, message } = req.body
  if (!chipId || !to || !message) return res.status(400).json({ error: 'chipId, to e message são obrigatórios' })
  const session = chipSessions[chipId]
  if (!session?.isReady || !session.client) return res.status(400).json({ error: `Chip "${chipId}" não está conectado` })
  try {
    // If 'to' already contains '@' (e.g. '5511@c.us' or '123@lid'), use it directly.
    // Only reformat if it's a plain phone number without domain.
    let chatId = to.includes('@') ? to : formatNumber(to)
    const convId = getConvId(chipId, chatId)
    const msg = await sendChipText(session.client, chatId, message)
    const msgId = extractMsgId(msg)
    fireWebhooks('message_sent', { chipId, to: chatId, message, msgId, conversationId: convId })
    res.json({ ok: true, msgId })
    // Broadcast após resposta HTTP para o frontend exibir a mensagem enviada externamente
    setTimeout(() => broadcast('chip_outbound', { chipId, to: chatId, message, msgId, type: 'text', timestamp: Date.now(), conversationId: convId }), 300)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Chip send media ───────────────────────────────────────────────────────────

app.post('/api/chips/send-media', upload.single('file'), async (req, res) => {
  const { chipId, to, caption } = req.body
  if (!chipId || !to || !req.file) return res.status(400).json({ error: 'chipId, to e file são obrigatórios' })
  const session = chipSessions[chipId]
  if (!session?.isReady || !session.client) return res.status(400).json({ error: `Chip "${chipId}" não está conectado` })
  try {
    let chatId = to.includes('@') ? to : formatNumber(to)
    const { MessageMedia } = require('whatsapp-web.js')
    const base64  = req.file.buffer.toString('base64')
    const isAudio = req.file.mimetype.startsWith('audio/')
    const media   = new MessageMedia(
      req.file.mimetype,
      base64,
      req.file.originalname || (isAudio ? 'audio.webm' : 'arquivo')
    )
    let msg
    if (isAudio) {
      // Converte WebM para OGG Opus (formato nativo do WhatsApp PTT) usando ffmpeg do sistema
      const { execFileSync } = require('child_process')
      const os = require('os')
      const tmpIn  = path.join(os.tmpdir(), `crm_in_${Date.now()}.webm`)
      const tmpOut = path.join(os.tmpdir(), `crm_out_${Date.now()}.ogg`)
      let sentAsPtt = false
      try {
        fs.writeFileSync(tmpIn, req.file.buffer)
        execFileSync('ffmpeg', ['-y', '-i', tmpIn, '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', tmpOut], { timeout: 15000 })
        if (fs.existsSync(tmpOut)) {
          const oggBase64 = fs.readFileSync(tmpOut).toString('base64')
          const pttMedia  = new MessageMedia('audio/ogg; codecs=opus', oggBase64, 'audio.ogg')
          msg = await session.client.sendMessage(chatId, pttMedia, { sendAudioAsVoice: true })
          sentAsPtt = true
          console.log('[Chip] Áudio enviado como nota de voz PTT (OGG Opus)')
        }
      } catch (convErr) {
        console.warn('[Chip] Conversão OGG falhou:', convErr.message)
      } finally {
        try { fs.unlinkSync(tmpIn) } catch {}
        try { fs.unlinkSync(tmpOut) } catch {}
      }
      if (!sentAsPtt) {
        msg = await session.client.sendMessage(chatId, media, { sendAudioAsVoice: true })
        console.log('[Chip] Áudio enviado sem conversão')
      }
    } else {
      const opts = {}
      if (caption) opts.caption = caption
      msg = await session.client.sendMessage(chatId, media, opts)
    }
    const msgId = extractMsgId(msg)
    const outType = isAudio ? 'audio' : req.file.mimetype.startsWith('image/') ? 'image' : req.file.mimetype.startsWith('video/') ? 'video' : 'document'
    const convId = getConvId(chipId, chatId)
    fireWebhooks('message_sent', { chipId, to: chatId, msgId, conversationId: convId })
    res.json({ ok: true, msgId })
    setTimeout(() => broadcast('chip_outbound', { chipId, to: chatId, msgId, type: outType, mediaFileName: req.file.originalname || null, caption: caption || null, timestamp: Date.now(), conversationId: convId }), 300)
  } catch (e) {
    console.error('[Chip send-media]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Response Stats ────────────────────────────────────────────────────────────

app.get('/api/responses/stats', (_req, res) => {
  const totalSent = chipCampaignState.sentNumbers.size
  const now = Date.now()
  res.json({
    totalSent,
    totalResponses: responseStats.totalResponses,
    responseRate: totalSent > 0 ? ((responseStats.totalResponses / totalSent) * 100).toFixed(2) : 0,
    last24h: responseStats.responses.filter(r => now - r.timestamp < 86400000).length,
    last7d: responseStats.responses.filter(r => now - r.timestamp < 604800000).length,
    lastResponseAt: responseStats.lastResponseAt,
    recent: responseStats.responses.slice(-20)
  })
})

// ── Interaction rate — cross-reference sent numbers with responders ───────────

app.post('/api/chip-campaign/interaction-rate', (req, res) => {
  // sentContacts: [{number, sentAt}] — sentAt is ms timestamp of when dispatch occurred
  // falls back to sentNumbers (legacy) for backwards compat
  const { sentContacts, sentNumbers } = req.body

  let contacts = []
  if (Array.isArray(sentContacts) && sentContacts.length > 0) {
    contacts = sentContacts  // preferred: [{number, sentAt}]
  } else if (Array.isArray(sentNumbers) && sentNumbers.length > 0) {
    contacts = sentNumbers.map(n => ({ number: n, sentAt: 0 }))  // legacy: no timestamp filter
  }

  if (contacts.length === 0) {
    return res.json({ sent: 0, interacted: 0, rate: '0%', interactedNumbers: [] })
  }

  const interactedNumbers = []
  for (const { number, sentAt } of contacts) {
    const clean = String(number).replace(/\D/g, '')
    const short = clean.startsWith('55') ? clean.slice(2) : clean

    // Only count responses received AFTER the dispatch timestamp for this contact
    const responded = responseStats.responses.some(r => {
      if (sentAt && r.timestamp && r.timestamp * 1000 < sentAt) return false  // response before dispatch
      const rClean = String(r.from || '').replace(/\D/g, '').replace(/^55/, '')
      return rClean === clean || rClean === short || rClean.endsWith(short) || short.endsWith(rClean)
    })

    if (responded) interactedNumbers.push(number)
  }

  const sent = contacts.length
  const interacted = interactedNumbers.length
  res.json({
    sent,
    interacted,
    notInteracted: sent - interacted,
    rate: sent > 0 ? ((interacted / sent) * 100).toFixed(1) + '%' : '0%',
    interactedNumbers,
  })
})

// ── Blast engagement — cross-reference Meta inbound msgs with recipient list ────
app.post('/api/blast/engagement', (req, res) => {
  const { recipients, sentAt: blastSentAt } = req.body
  // recipients: [{phone, sentAt?}]  sentAt in ms
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.json({ engaged: 0, total: 0, rate: '0%', engagedPhones: [] })
  }
  const engagedPhones = []
  for (const { phone, sentAt } of recipients) {
    const threshold = sentAt || blastSentAt || 0
    const clean = String(phone).replace(/\D/g, '')
    const short = clean.startsWith('55') ? clean.slice(2) : clean
    const responded = metaResponseStats.responses.some(r => {
      if (threshold && r.timestamp < threshold) return false
      const rClean = String(r.from || '').replace(/\D/g, '').replace(/^55/, '')
      return rClean === clean || rClean === short || rClean.endsWith(short) || short.endsWith(rClean)
    })
    if (responded) engagedPhones.push(phone)
  }
  const total = recipients.length
  const engaged = engagedPhones.length
  res.json({ engaged, total, rate: total > 0 ? ((engaged / total) * 100).toFixed(1) + '%' : '0%', engagedPhones })
})

app.get('/api/chip-campaign/history', (_req, res) => {
  res.json(loadCampaigns())
})

app.delete('/api/chip-campaign/history/:id', (req, res) => {
  const { id } = req.params
  const list = loadCampaigns().filter(c => c.id !== id)
  try {
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(list, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Autobot Routes ────────────────────────────────────────────────────────────

app.get('/api/autobot/rules', (_req, res) => {
  res.json({ ...autoBotData, contactStates: Object.keys(contactBotState).length })
})

app.post('/api/autobot/rules', (req, res) => {
  const body = req.body
  if (body.rules !== undefined) autoBotData.rules = body.rules
  if (body.workingHours !== undefined) autoBotData.workingHours = body.workingHours
  if (body.antiSpamMinutes !== undefined) autoBotData.antiSpamMinutes = body.antiSpamMinutes
  if (body.aiEnabled !== undefined) autoBotData.aiEnabled = body.aiEnabled
  if (body.escalationWord !== undefined) autoBotData.escalationWord = body.escalationWord
  if (body.active !== undefined) autoBotData.active = body.active
  saveAutoBotData(autoBotData)
  res.json({ ok: true })
})

app.post('/api/autobot/toggle', (req, res) => {
  autoBotData.active = req.body.active !== undefined ? req.body.active : !autoBotData.active
  saveAutoBotData(autoBotData)
  broadcast('autobot', { type: 'status', active: autoBotData.active })
  res.json({ ok: true, active: autoBotData.active })
})

app.post('/api/autobot/unpause', (req, res) => {
  const { contact } = req.body
  autoBotData.pausedContacts = (autoBotData.pausedContacts || []).filter(c => c !== contact)
  saveAutoBotData(autoBotData)
  res.json({ ok: true })
})

// ── AI Routes ─────────────────────────────────────────────────────────────────

app.post('/api/ai/humanize', async (req, res) => {
  const { message, name, vars, tone, greetings } = req.body
  const contact = { name: name || '', vars: vars || {} }
  try {
    const result = await humanizeWithAI(message, contact, tone || 'amigavel', greetings)
    res.json({ humanized: result, original: message })
  } catch (e) {
    res.json({ humanized: humanizeBasic(message, contact, greetings), original: message })
  }
})

// ── FGTS Simulation Routes ────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hfgpwmgqtjjmbtpzbghs.supabase.co/rest/v1'
const SUPABASE_KEY = process.env.SUPABASE_KEY

let _v8TokenCache = null
let _v8TokenExpAt = 0

async function getV8Token() {
  if (_v8TokenCache && Date.now() / 1000 < _v8TokenExpAt - 300) return _v8TokenCache
  const res = await axios.get(`${SUPABASE_URL}/v8_TOKEN_duplicate?id=eq.1&limit=1`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    timeout: 10000,
  })
  const rows = res.data
  if (!rows?.length) throw new Error('Token V8 não encontrado no Supabase')
  const token = rows[0].token
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    _v8TokenExpAt = payload.exp || 0
  } catch { _v8TokenExpAt = 0 }
  _v8TokenCache = token
  console.log('[FGTS] Token V8 carregado do Supabase, exp:', new Date(_v8TokenExpAt * 1000).toISOString())
  return token
}

const FGTS_PROXIES = [
  '104.252.20.145:6077:wlzjsmwz:db8o122f230k',
  '104.252.92.91:6025:wlzjsmwz:db8o122f230k',
  '85.198.47.128:6396:wlzjsmwz:db8o122f230k',
  '108.165.53.166:6905:wlzjsmwz:db8o122f230k',
  '104.253.91.39:6472:wlzjsmwz:db8o122f230k',
  '85.198.47.215:6483:wlzjsmwz:db8o122f230k',
  '108.165.205.189:5426:wlzjsmwz:db8o122f230k',
  '92.112.171.67:6035:wlzjsmwz:db8o122f230k',
  '92.112.175.219:6492:wlzjsmwz:db8o122f230k',
  '92.112.171.228:6196:wlzjsmwz:db8o122f230k',
]
let fgtsProxyIdx = 0

function getFgtsProxyAgent() {
  const entry = FGTS_PROXIES[fgtsProxyIdx % FGTS_PROXIES.length]
  fgtsProxyIdx++
  const [host, port, user, pass] = entry.split(':')
  return new HttpsProxyAgent(`http://${user}:${pass}@${host}:${port}`)
}

const QUERYBUSCAS_COOKIE = 'auth_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MjU5LCJ1c2VybmFtZSI6Iml6YWx0aW5hMjAyNmZlcnJlaXJhQGdtYWlsLmNvbSIsInBsYW5vIjoibWVuc2FsIiwiZGlhcyI6MzAsInRpcG8iOiJjbGllbnRlIiwic2Vzc2lvblRva2VuIjoiZmE3NmEzYjZlNDlkODhiMjc4NThlMjQ1ODE2NjllZGQ2NTk1NzNjN2FhNTVjYjNkYWQ0YTg1NWEzMzI3MmEyNiIsImlhdCI6MTc4MjcwNTE0MiwiZXhwIjoxNzgzMzA5OTQyfQ.KmAvuxnrr1tRLuOcdPrYFZmdxjlrj38Of-b7CHLjIsY'

function padCpf(cpf) {
  return String(cpf).replace(/\D/g, '').padStart(11, '0')
}

// Faz UMA chamada ao balance bms. Retorna o rawData ou null.
async function callBalance(cpf, token) {
  const res = await axios.post('https://bff.v8sistema.com/fgts/balance', {
    documentNumber: padCpf(cpf), provider: 'bms',
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 25000 })
  console.log('[FGTS] balance status=', res.status, 'data=', JSON.stringify(res.data)?.slice(0, 400))
  return res.data ?? null
}

// Extrai item com id de várias estruturas de resposta
function extractBalanceItem(rawData) {
  if (!rawData) return null
  const candidates = [
    rawData,
    rawData?.data,
    Array.isArray(rawData?.data) ? rawData.data[0] : null,
    Array.isArray(rawData) ? rawData[0] : null,
  ]
  return candidates.find(c => c?.id) ?? null
}

// FASE 1 — CONSULTA SALDO: poll até null (autorizado) ou item com id
// FASE 2 — CONSULTA V8: quando null, tenta UMA vez mais para obter o item com id
async function queryFgtsBalance(cpf, token) {
  const docNumber = padCpf(cpf)

  // Fase 1: poll até não ser 400/429
  let gotNull = false
  for (let i = 0; i < 16; i++) {
    try {
      const raw = await callBalance(docNumber, token)
      if (raw === null) {
        console.log(`[FGTS] Fase1 t${i+1}: null → autorizado`)
        gotNull = true
        break
      }
      const item = extractBalanceItem(raw)
      if (item?.id) {
        console.log(`[FGTS] Fase1 t${i+1}: id=${item.id}`)
        return item
      }
      console.log(`[FGTS] Fase1 t${i+1}: sem id, aguardando...`)
      await new Promise(r => setTimeout(r, 5000))
    } catch (err) {
      const status = err.response?.status
      const detail = typeof err.response?.data === 'string' ? err.response.data
        : (err.response?.data?.detail || err.response?.data?.message || '')
      const retry = status === 400 || status === 429 ||
        (typeof detail === 'string' && (detail.includes('Tente novamente') || detail.includes('Try spacing')))
      if (!retry) throw err
      console.log(`[FGTS] Fase1 t${i+1}: retry status=${status}`)
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  if (!gotNull) throw new Error('Tempo limite excedido aguardando autorização FGTS')

  // Fase 2 (CONSULTA V8): null confirmou autorização — tenta de novo para pegar o item com id
  console.log('[FGTS] Fase2: null confirmado, aguardando 3s e consultando de novo...')
  await new Promise(r => setTimeout(r, 3000))
  for (let j = 0; j < 5; j++) {
    try {
      const raw2 = await callBalance(docNumber, token)
      if (raw2 !== null) {
        const item2 = extractBalanceItem(raw2)
        if (item2?.id) {
          console.log(`[FGTS] Fase2 t${j+1}: id=${item2.id}`)
          return item2
        }
      }
      console.log(`[FGTS] Fase2 t${j+1}: ainda null/sem id, aguardando 3s...`)
      await new Promise(r => setTimeout(r, 3000))
    } catch (err) {
      const status = err.response?.status
      const detail = typeof err.response?.data === 'string' ? err.response.data
        : (err.response?.data?.detail || err.response?.data?.message || '')
      const retry = status === 400 || status === 429 ||
        (typeof detail === 'string' && (detail.includes('Tente novamente') || detail.includes('Try spacing')))
      if (!retry) break
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  // Fase 2 também retornou null — retorna null mesmo (autorizado, sem registro)
  console.log('[FGTS] Fase2: sem id obtido, retornando null')
  return null
}

app.post('/api/fgts/consultar', async (req, res) => {
  const { cpf, tabelaId } = req.body
  if (!cpf || !tabelaId) return res.status(400).json({ error: 'CPF e tabela são obrigatórios' })
  const cpfPad = padCpf(cpf)
  let token
  try { token = await getV8Token() } catch (e) { return res.status(500).json({ error: `Erro ao obter token V8: ${e.message}` }) }

  // 1. DELETE cache
  try {
    await axios.delete(
      `https://v8-bff-prod.yellowisland-b252a8a0.eastus.azurecontainerapps.io/fgts/balance/cache/${cpfPad}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    )
    console.log('[FGTS] Cache deletado, aguardando 8s para V8 iniciar o fetch...')
  } catch (e) {
    console.log('[FGTS] Cache delete falhou (continuando):', e.response?.status, e.message)
  }
  // Aguarda V8 iniciar o processamento assíncrono antes de pollar
  await new Promise(r => setTimeout(r, 8000))

  // 2. Consulta balance (bms) — duas fases
  let balanceItem = null
  try {
    balanceItem = await queryFgtsBalance(cpfPad, token)
    console.log('[FGTS] balance final:', balanceItem ? `id=${balanceItem.id}` : 'null')
  } catch (e) {
    const msg = e.response?.data?.detail || e.response?.data?.message || e.message
    return res.status(e.response?.status || 500).json({ error: `Erro ao consultar saldo: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}` })
  }

  if (!balanceItem) {
    return res.status(422).json({ error: 'FGTS não encontrado para este CPF. Verifique se o CPF está no Saque-Aniversário.' })
  }

  // 3. Simulação
  const currentYear = new Date().getFullYear()
  const desiredInstallments = Array.from({ length: 10 }, (_, i) => {
    const y = currentYear + i
    return { year: y, totalAmount: 0, dueDate: `${y}-03-31` }
  })
  const balanceId = balanceItem.id
  const simBody = {
    simulationFeesId: tabelaId,
    balanceId,
    targetAmount: 0,
    documentNumber: balanceItem?.documentNumber || cpfPad,
    isInsured: true,
    desiredInstallments,
    provider: 'bms',
  }
  console.log('[FGTS] Simulação body:', JSON.stringify(simBody))
  try {
    const simRes = await axios.post('https://bff.v8sistema.com/fgts/simulations', simBody,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 })
    return res.json({ balance: balanceItem, simulation: simRes.data })
  } catch (e) {
    console.log('[FGTS] Simulação erro status=', e.response?.status, 'data=', JSON.stringify(e.response?.data)?.slice(0, 800))
    const d = e.response?.data
    const msg = (typeof d === 'string' ? d : d?.detail || d?.message || d?.error || JSON.stringify(d)) || e.message
    return res.status(e.response?.status || 500).json({ error: `Erro na simulação: ${msg}` })
  }
})

app.post('/api/fgts/proposta', async (req, res) => {
  const { cpf, tabelaId, pixKey, pixKeyType, simulationId, fgtsProposalsPeriods } = req.body
  if (!cpf || !pixKey || !simulationId) return res.status(400).json({ error: 'Campos obrigatórios ausentes' })
  const cpfPad = padCpf(cpf)
  let token
  try { token = await getV8Token() } catch (e) { return res.status(500).json({ error: `Erro ao obter token V8: ${e.message}` }) }

  // 1. Fetch CPF data from querybuscas
  let pessoaData = {}
  try {
    const proxyAgent = getFgtsProxyAgent()
    const r = await axios.get(`https://querybuscas.com/api/consultas/cpf/${cpfPad}`, {
      headers: { cookie: QUERYBUSCAS_COOKIE },
      httpsAgent: proxyAgent, httpAgent: proxyAgent,
      timeout: 20000
    })
    pessoaData = r.data || {}
    console.log('[FGTS] querybuscas OK para', cpfPad)
  } catch (e) {
    console.log('[FGTS] querybuscas falhou:', e.message)
  }

  // Extract pessoa fields
  const nome = pessoaData.nome || pessoaData.name || 'NOME NAO ENCONTRADO'
  const nomeMae = pessoaData.nomeMae || pessoaData.nome_mae || pessoaData.mother_name || 'MARINA DA SILVA'
  const dataNasc = (() => {
    const raw = pessoaData.dataNascimento || pessoaData.data_nascimento || pessoaData.nascimento || ''
    if (!raw) return ''
    const s = String(raw).trim()
    if (s.includes('T')) return s.split('T')[0]
    if (s.includes('/')) { const [d, m, y] = s.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` }
    return s
  })()
  const end = pessoaData.endereco || {}
  const cep = (pessoaData.cep || end.cep || '').replace(/\D/g, '') || '89240000'
  const estado = pessoaData.uf || pessoaData.estado || end.uf || end.estado || 'SP'
  const bairro = pessoaData.bairro || end.bairro || 'CENTRO'
  const numero = pessoaData.numero || end.numero || '1'
  const cidade = pessoaData.cidade || pessoaData.municipio || end.cidade || end.municipio || 'SAO PAULO'
  const rua = pessoaData.logradouro || pessoaData.endereco_rua || end.logradouro || 'RUA UM'
  const tel = String(pessoaData.telefone || pessoaData.celular || pessoaData.phone || '').replace(/\D/g, '')
  const ddd = tel.length >= 11 ? tel.slice(0, 2) : '11'
  const phoneNum = tel.length >= 9 ? tel.slice(-9) : '998765449'

  // Random email from name
  const parts = nome.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const emailBase = (parts[0] || '') + (parts[parts.length - 1] || '')
  const email = emailBase + (Math.floor(Math.random() * 1000) + 1) + (Math.random() > 0.5 ? '@gmail.com' : '@hotmail.com')

  // Shuffle first 6 digits of CPF → documentIdentificationNumber
  const cpfArr = cpfPad.slice(0, 6).split('')
  for (let i = cpfArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cpfArr[i], cpfArr[j]] = [cpfArr[j], cpfArr[i]]
  }

  try {
    const propRes = await axios.post('https://bff.v8sistema.com/fgts/proposal', {
      simulationFeesId: tabelaId,
      name: nome,
      individualDocumentNumber: cpfPad,
      documentIdentificationNumber: cpfArr.join(''),
      motherName: nomeMae,
      nationality: 'Brasileiro(a)',
      isPEP: false,
      email,
      birthDate: dataNasc,
      personType: 'natural',
      phone: phoneNum,
      phoneCountryCode: '55',
      phoneRegionCode: ddd,
      postalCode: cep,
      state: estado,
      neighborhood: bairro,
      addressNumber: numero,
      city: cidade,
      street: typeof rua === 'string' ? rua : 'RUA UM',
      complement: 'CASA',
      formalizationLink: '',
      maritalStatus: 'single',
      payment: { type: 'pix', data: { pix: pixKey, pix_key_type: pixKeyType } },
      fgtsProposalsPeriods: fgtsProposalsPeriods || [],
      fgtsSimulationId: simulationId,
      provider: 'bms'
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 })
    res.json({ ok: true, proposal: propRes.data, pessoa: { nome, nomeMae, dataNasc } })
  } catch (e) {
    const msg = e.response?.data?.detail || e.response?.data?.message || e.response?.data?.title || e.message
    res.status(e.response?.status || 500).json({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) })
  }
})

// ── Server startup: restore saved chip sessions ───────────────────────────────

function restoreChipSessions() {
  const saved = loadRegistry()
  if (saved.length > 0) {
    console.log(`[Chips] Restaurando ${saved.length} sessão(ões)...`)
    saved.forEach(({ id, temperature, proxy }) => {
      chipSessions[id] = { client: null, status: 'connecting', number: null, isReady: false, reconnectAttempts: 0, temperature: temperature || 'frio', proxy: proxy || null }
      setTimeout(() => initChip(id), 2000)
    })
  }
}

// Garante que qualquer erro não tratado retorne JSON, nunca HTML
app.use((err, req, res, next) => {
  console.error('[Express error]', err)
  if (!res.headersSent) res.status(500).json({ error: err?.message || 'Erro interno do servidor' })
})

const PORT = process.env.PORT ?? 3001
server.listen(PORT, () => {
  console.log(`✅ CRM Backend running on http://localhost:${PORT}`)
  console.log(`📡 WebSocket ready on ws://localhost:${PORT}/ws`)
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/api/webhook`)
  startProxyRotator()
  restoreChipSessions()
})
