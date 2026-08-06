'use strict'
// Integração com o serviço "Wuzapi" (asternic/wuzapi, biblioteca whatsmeow),
// usada em BETA como teste de entrega de mensagens com botão nativo. Imagem
// oficial do Docker Hub, sem build próprio. O wuzapi modela cada número
// conectado como um "usuário" com um token próprio — mantemos um registro
// local (nome amigável -> token/id) pra expor uma interface simples de
// instâncias.
const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const WUZAPI_URL = process.env.WUZAPI_URL || 'http://wuzapi:8080'
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN || ''
// URL que o próprio wuzapi chama quando chega mensagem — precisa ser
// alcançável a partir do container do wuzapi (rede crm-internal).
const WUZAPI_WEBHOOK_URL = process.env.WUZAPI_WEBHOOK_URL || 'http://backend:3001/api/wuzapi/webhook'

const DATA_DIR = path.join(__dirname, 'data')
const INSTANCES_FILE = path.join(DATA_DIR, 'wuzapi_instances.json')
const HISTORY_FILE = path.join(DATA_DIR, 'wuzapi_campaigns_history.json')

let _broadcast = () => {}
let _getConvId = (channel, contact) => `${channel}:${contact}`

function init({ broadcast, getConvId }) {
  if (broadcast) _broadcast = broadcast
  if (getConvId) _getConvId = getConvId
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function admin() {
  return axios.create({ baseURL: WUZAPI_URL, timeout: 15000, headers: { Authorization: WUZAPI_ADMIN_TOKEN } })
}

function userClient(token) {
  return axios.create({ baseURL: WUZAPI_URL, timeout: 20000, headers: { Token: token } })
}

// ── Registro local (nome amigável -> token/id do wuzapi) ────────────────────

function loadRegistry() {
  try {
    if (fs.existsSync(INSTANCES_FILE)) return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'))
  } catch (e) {}
  return {}
}

function saveRegistry(reg) {
  try {
    ensureDataDir()
    fs.writeFileSync(INSTANCES_FILE, JSON.stringify(reg, null, 2))
  } catch (e) { console.error('[Wuzapi] Erro ao salvar registro:', e.message) }
}

// ── Instâncias ──────────────────────────────────────────────────────────────

async function listInstances() {
  const registry = loadRegistry()
  const names = Object.keys(registry)
  if (names.length === 0) return []

  let remoteUsers = []
  try {
    const { data } = await admin().get('/admin/users')
    // Respostas do wuzapi vêm envelopadas em {code, data, success}, não no
    // formato plano documentado — confirmado testando direto contra o serviço.
    remoteUsers = Array.isArray(data?.data) ? data.data : []
  } catch (e) {
    // Sem conseguir falar com o wuzapi, ainda mostra as instâncias salvas como desconectadas
    return names.map(name => ({ name, label: registry[name].label || null, status: 'disconnected', hasQr: false, qr: null }))
  }

  return names.map(name => {
    const entry = registry[name]
    const remote = remoteUsers.find(u => u.token === entry.token)
    if (!remote) return { name, label: entry.label || null, status: 'disconnected', hasQr: false, qr: null }
    const hasQr = Boolean(remote.qrcode)
    // "connected" no wuzapi só indica que o socket com o WhatsApp está aberto
    // — fica true mesmo antes de escanear o QR. "loggedIn" é quem confirma
    // que o número está de fato pareado/autenticado.
    const status = remote.loggedIn ? 'connected' : (hasQr ? 'qr' : (remote.connected ? 'connecting' : 'disconnected'))
    return {
      name,
      label: entry.label || null,
      status,
      hasQr,
      qr: hasQr ? remote.qrcode : null,
      jid: remote.jid || null,
      proxyUrl: remote.proxy_config?.proxy_url || remote.proxy_url || null,
      proxyEnabled: Boolean(remote.proxy_config?.enabled),
    }
  })
}

async function createInstance(name, label) {
  const registry = loadRegistry()
  let entry = registry[name]

  if (!entry) {
    const token = crypto.randomBytes(20).toString('hex')
    const { data } = await admin().post('/admin/users', {
      name,
      token,
      webhook: WUZAPI_WEBHOOK_URL,
      events: 'Message,ReadReceipt',
    })
    entry = { token, userId: data?.data?.id ?? null, label: label || null }
    registry[name] = entry
    saveRegistry(registry)
  } else if (label && label !== entry.label) {
    entry.label = label
    registry[name] = entry
    saveRegistry(registry)
  }

  // Garante o webhook configurado mesmo pra instâncias criadas antes dessa
  // funcionalidade existir (o registro local não muda, então precisa
  // reconfirmar do lado do wuzapi a cada (re)conexão).
  try {
    await userClient(entry.token).post('/webhook', { webhookurl: WUZAPI_WEBHOOK_URL, events: ['Message', 'ReadReceipt'] })
  } catch (e) { console.error('[Wuzapi] Falha ao configurar webhook:', e.message) }

  try {
    await userClient(entry.token).post('/session/connect', { Subscribe: ['Message'], Immediate: false })
  } catch (e) {
    // whatsmeow reconecta sessões salvas sozinho ao subir o container — se a
    // gente chamar /session/connect de novo nesse meio tempo, o wuzapi
    // responde erro "already connected". Não é falha, é o estado que já
    // queríamos alcançar.
    if (!/already connected/i.test(e?.response?.data?.error || e.message || '')) throw e
  }

  let qr = null
  try {
    const { data } = await userClient(entry.token).get('/session/qr')
    qr = data?.data?.QRCode || null
  } catch (e) { /* pode não ter QR ainda (sessão já pareada) */ }

  return { ok: true, instance: name, status: qr ? 'qr' : 'connecting', qr }
}

async function getInstanceStatus(name) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')
  const { data } = await userClient(entry.token).get('/session/status')
  const d = data?.data || {}
  const loggedIn = Boolean(d.LoggedIn ?? d.loggedIn)
  return { instance: name, status: loggedIn ? 'connected' : 'disconnected' }
}

async function getInstanceQr(name) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')
  const { data } = await userClient(entry.token).get('/session/qr')
  return { qr: data?.data?.QRCode || null }
}

async function disconnectInstance(name) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')
  await userClient(entry.token).post('/session/disconnect')
  return { ok: true }
}

async function logoutInstance(name) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')
  await userClient(entry.token).post('/session/logout')
  return { ok: true }
}

async function removeInstance(name) {
  const registry = loadRegistry()
  const entry = registry[name]
  if (!entry) throw new Error('Instância não encontrada')
  if (entry.userId) {
    try { await admin().delete(`/admin/users/${entry.userId}/full`) } catch (e) { /* segue removendo local mesmo se já não existir */ }
  }
  delete registry[name]
  saveRegistry(registry)
  return { ok: true }
}

function setLabel(name, label) {
  const registry = loadRegistry()
  if (!registry[name]) return
  registry[name].label = label
  saveRegistry(registry)
}

// O wuzapi recusa mudar o proxy enquanto a sessão está conectada ("cannot
// set proxy while connected") — o erro sobe pra quem chamou decidir
// desconectar antes.
async function setProxy(name, proxyUrl, enabled) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')
  await userClient(entry.token).post('/session/proxy', {
    proxy_url: enabled ? String(proxyUrl || '').trim() : '',
    enable: !!enabled,
  })
  return { ok: true }
}

// ── Envio de botões ───────────────────────────────────────────────────────────

function cleanPhone(number) {
  return String(number || '').replace(/\D/g, '')
}

// Texto simples — usado pra responder pelo Mensagens (equivalente ao envio
// normal de um chip comum).
async function sendText(instanceName, to, text) {
  const entry = loadRegistry()[instanceName]
  if (!entry) throw new Error('Instância não encontrada')
  const phone = cleanPhone(to)
  if (phone.length < 10) throw new Error('Número inválido')

  const { data } = await userClient(entry.token).post('/chat/send/text', {
    Phone: phone,
    Body: text || '',
  })
  if (!data) throw new Error('Falha ao enviar')
  return { ok: true, messageId: data?.Id || data?.data?.Id || null }
}

// payload: { text, footer, image?, buttons: [{ id, text, type?: 'reply'|'url', url? }] }
// Um único endpoint (/chat/send/buttons) cobre os 4 formatos do wizard —
// botões simples, link no botão (cta_url), imagem+botões e imagem+link —
// a única diferença é presença de Image e o "type" de cada botão.
async function sendButtons(instanceName, to, payload = {}) {
  const entry = loadRegistry()[instanceName]
  if (!entry) throw new Error('Instância não encontrada')
  const phone = cleanPhone(to)
  if (phone.length < 10) throw new Error('Número inválido')

  const buttons = (payload.buttons || []).filter(b => b?.text?.trim()).slice(0, 3).map((b, idx) => {
    if (b.type === 'url' && b.url?.trim()) {
      return { type: 'cta_url', title: String(b.text).slice(0, 20), id: b.id || `btn_${idx}`, url: b.url.trim() }
    }
    return { type: 'reply', title: String(b.text).slice(0, 20), id: b.id || `btn_${idx}` }
  })
  if (buttons.length === 0) throw new Error('Adicione ao menos um botão')

  const { data } = await userClient(entry.token).post('/chat/send/buttons', {
    Phone: phone,
    Body: payload.text || '',
    Footer: payload.footer || undefined,
    Image: payload.image || undefined,
    Buttons: buttons,
  })
  if (!data) throw new Error('Falha ao enviar')
  return { ok: true, messageId: data?.Id || data?.data?.Id || null }
}

// ── Mensagens recebidas (webhook do wuzapi) ──────────────────────────────────
//
// O wuzapi manda o evento cru do whatsmeow: postmap.event.Info (struct Go
// sem json tag — chaves em PascalCase) e postmap.event.Message (proto com
// tags camelCase). "instanceName" e "userID" vêm no nível raiz do payload
// porque o container está configurado com WEBHOOK_FORMAT=json. Confirmado
// testando direto contra o serviço (a documentação pública está incompleta
// nesse ponto): Chat/Sender/SenderAlt já vêm como STRING pronta
// "numero@servidor" (não um struct {User,Server} como o código-fonte do
// whatsmeow sugeria) — e contatos com "LID" (endereçamento novo e mais
// privado do WhatsApp) mandam o Chat/Sender como "id@lid", com o número de
// telefone de verdade só disponível em SenderAlt.
function preferPhoneJid(primary, alt) {
  if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) return alt
  return primary || null
}

// Resposta de botão nativo (o formato que o wuzapi usa pra enviar botões) —
// o proto marca esse campo como "oneof" no Go, então pode vir aninhado de
// mais de um jeito dependendo de como o encoding/json padrão (não o
// protojson) serializa a interface. Tenta os caminhos plausíveis; se nenhum
// bater, cai no log de depuração em handleWebhookMessage pra descobrir o
// formato real no próximo teste.
function extractNativeFlowResponse(msg) {
  const candidates = [
    msg?.interactiveResponseMessage?.nativeFlowResponseMessage,
    msg?.interactiveResponseMessage?.NativeFlowResponseMessage,
    msg?.interactiveResponseMessage?.InteractiveResponseMessage?.NativeFlowResponseMessage,
    msg?.interactiveResponseMessage?.InteractiveResponseMessage?.nativeFlowResponseMessage,
  ]
  const flow = candidates.find(Boolean)
  if (!flow) return null

  const paramsRaw = flow.paramsJSON || flow.paramsJson || flow.ParamsJSON
  if (typeof paramsRaw === 'string') {
    try {
      const parsed = JSON.parse(paramsRaw)
      return parsed.display_text || parsed.id || paramsRaw
    } catch {
      return paramsRaw
    }
  }
  return flow.name || flow.Name || null
}

function extractText(msg) {
  if (!msg) return ''
  if (typeof msg.conversation === 'string') return msg.conversation
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text
  if (msg.imageMessage?.caption) return msg.imageMessage.caption
  if (msg.videoMessage?.caption) return msg.videoMessage.caption
  if (msg.documentMessage?.caption) return msg.documentMessage.caption
  if (msg.buttonsResponseMessage?.selectedDisplayText) return msg.buttonsResponseMessage.selectedDisplayText
  if (msg.listResponseMessage?.title) return msg.listResponseMessage.title
  const nativeFlow = extractNativeFlowResponse(msg)
  if (nativeFlow) return nativeFlow
  return ''
}

function detectMedia(msg) {
  if (!msg) return null
  if (msg.imageMessage) return { type: 'image', mimetype: msg.imageMessage.mimetype || null }
  if (msg.videoMessage) return { type: 'video', mimetype: msg.videoMessage.mimetype || null }
  if (msg.audioMessage) return { type: 'audio', mimetype: msg.audioMessage.mimetype || null }
  if (msg.documentMessage) return { type: 'document', mimetype: msg.documentMessage.mimetype || null }
  if (msg.stickerMessage) return { type: 'image', mimetype: msg.stickerMessage.mimetype || null }
  return null
}

function handleWebhookMessage(body) {
  if (body?.type !== 'Message') return
  const instanceName = body.instanceName
  const info = body.event?.Info
  const msg = body.event?.Message
  if (!instanceName || !info || info.IsFromMe) return
  if (!info.Chat) return

  const isGroup = !!info.IsGroup
  // Em DM, Chat e Sender são o mesmo contato — resolve pro JID de telefone
  // real quando o WhatsApp endereçou por LID. Em grupo, o Chat (grupo em si)
  // não tem ambiguidade; só o autor (Sender) pode vir como LID.
  const chat = isGroup ? info.Chat : preferPhoneJid(info.Chat, info.SenderAlt)
  const author = isGroup ? preferPhoneJid(info.Sender, info.SenderAlt) : chat
  if (!chat) return

  const text = extractText(msg)
  const media = detectMedia(msg)
  if (!text && !media) {
    // Provavelmente reação/recibo (ignorado de propósito) — ou um formato de
    // resposta de botão que a extração ainda não reconhece. Loga a forma
    // crua pra descobrir rápido no próximo teste real, sem precisar
    // adivinhar de novo.
    if (msg && Object.keys(msg).length > 0) {
      console.log('[Wuzapi] mensagem sem texto/mídia reconhecidos, chaves:', JSON.stringify(Object.keys(msg)), JSON.stringify(msg).slice(0, 1000))
    }
    return
  }

  console.log('[Wuzapi] mensagem recebida:', JSON.stringify({ instanceName, chat, author, isGroup, text }))

  _broadcast('chip_message', {
    chipId: `wuzapi:${instanceName}`,
    from: chat,
    author,
    body: text || '',
    timestamp: info.Timestamp ? Math.floor(new Date(info.Timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000),
    isGroup,
    groupName: null,
    pushname: info.PushName || null,
    contactNumber: isGroup ? null : chat.split('@')[0],
    msgType: media?.type || 'text',
    mediaUrl: null,
    mediaFileName: null,
    conversationId: _getConvId(`wuzapi:${instanceName}`, chat),
  })
}

function handleWebhook(body) {
  try {
    handleWebhookMessage(body)
  } catch (e) {
    console.error('[Wuzapi] Erro processando webhook:', e.message)
  }
}

// ── Campanha (só tipo "buttons" por enquanto — é o único motivo do teste) ────

const sleep = ms => new Promise(r => setTimeout(r, ms))

const campaignState = {
  running: false,
  paused: false,
  stopped: false,
  sentNumbers: new Set(),
  results: [],
  current: null,
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  } catch (e) {}
  return []
}

function saveHistoryRecord(record) {
  try {
    ensureDataDir()
    const list = loadHistory()
    list.unshift(record)
    if (list.length > 100) list.splice(100)
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2))
  } catch (e) { console.error('[Wuzapi] Erro ao salvar histórico:', e.message) }
}

function deleteHistoryRecord(id) {
  const list = loadHistory().filter(c => c.id !== id)
  ensureDataDir()
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2))
}

function applyVars(text, contact) {
  if (typeof text !== 'string') return text
  const name = contact?.name || ''
  const vars = contact?.vars || {}
  let msg = text
  if (name) msg = msg.replace(/\{\{name\}\}/gi, name).replace(/\{name\}/gi, name)
  for (const [k, v] of Object.entries(vars)) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    msg = msg.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'gi'), String(v ?? ''))
  }
  return msg
}

function resolvePayload(payload, contact) {
  if (typeof payload === 'string') return applyVars(payload, contact)
  if (Array.isArray(payload)) return payload.map(v => resolvePayload(v, contact))
  if (payload && typeof payload === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(payload)) out[k] = resolvePayload(v, contact)
    return out
  }
  return payload
}

// Campanha roda inteira no servidor — sem isso, a mensagem enviada nunca
// aparecia na conversa em Mensagens, então quando a resposta do botão
// chegava não tinha nenhum contexto do que foi mandado (igual abrir uma
// conversa do zero com só a resposta, sem a pergunta). Reaproveita o mesmo
// evento "chip_outbound" que os chips normais já usam pra ecoar mensagem
// enviada por fora da UI (envio via API/campanha).
function describeButtonPayload(payload) {
  const lines = [payload?.text || '']
  const buttons = payload?.buttons || []
  if (buttons.length) {
    lines.push(buttons.map(b => (b.type === 'url' ? `🔗 ${b.text}` : `▫️ ${b.text}`)).join('   '))
  }
  return lines.filter(Boolean).join('\n')
}

function broadcastOutboundEcho(instanceName, to, payload, messageId) {
  const phone = cleanPhone(to)
  if (phone.length < 10) return
  const chat = `${phone}@s.whatsapp.net`
  const chipId = `wuzapi:${instanceName}`
  _broadcast('chip_outbound', {
    chipId,
    to: chat,
    message: describeButtonPayload(payload),
    msgId: messageId || undefined,
    type: 'text',
    timestamp: Date.now(),
    conversationId: _getConvId(chipId, chat),
  })
}

async function runCampaign(data) {
  const { name, payload, instanceNames, contacts, delayMin = 5, delayMax = 15 } = data
  campaignState.results = []
  campaignState.paused = false
  campaignState.stopped = false
  campaignState.running = true
  campaignState.current = data
  let success = 0, failed = 0
  const startedAt = Date.now()
  let rrIndex = 0

  _broadcast('wuzapi_campaign', { type: 'started', instances: instanceNames, total: contacts.length })

  for (let i = 0; i < contacts.length; i++) {
    if (campaignState.stopped) break
    while (campaignState.paused) await sleep(500)

    const contact = contacts[i]

    if (campaignState.sentNumbers.has(contact.number)) {
      _broadcast('wuzapi_campaign', { type: 'skipped', number: contact.number, current: i + 1, total: contacts.length })
      continue
    }

    const result = { index: i, number: contact.number, name: contact.name || contact.number, status: 'sending' }
    campaignState.results.push(result)
    _broadcast('wuzapi_campaign', { type: 'progress', contact: result, success, failed, total: contacts.length, current: i + 1 })

    try {
      const instanceName = instanceNames[rrIndex % instanceNames.length]
      rrIndex++
      const resolved = resolvePayload(payload, contact)
      const sent = await sendButtons(instanceName, contact.number, resolved)
      result.status = 'success'
      result.via = instanceName
      result.sentAt = Date.now()
      if (sent?.messageId) result.messageId = sent.messageId
      success++
      campaignState.sentNumbers.add(contact.number)
      _broadcast('wuzapi_campaign', { type: 'result', contact: result, success, failed })
      broadcastOutboundEcho(instanceName, contact.number, resolved, sent?.messageId)
    } catch (e) {
      result.status = 'failed'
      result.error = e?.response?.data?.error || e.message || 'Erro desconhecido'
      failed++
      _broadcast('wuzapi_campaign', { type: 'result', contact: result, success, failed })
    }

    if (i < contacts.length - 1 && !campaignState.stopped) {
      const delay = Math.floor(Math.random() * (Math.max(delayMax, delayMin) - delayMin + 1)) + delayMin
      _broadcast('wuzapi_campaign', { type: 'waiting', delay, next: i + 2 })
      await sleep(delay * 1000)
    }
  }

  _broadcast('wuzapi_campaign', { type: 'done', success, failed, total: contacts.length, results: campaignState.results })

  saveHistoryRecord({
    id: startedAt.toString(),
    name: name || 'Campanha Wuzapi',
    messageType: 'buttons',
    payload,
    startedAt,
    endedAt: Date.now(),
    total: contacts.length,
    success,
    failed,
    skipped: contacts.length - success - failed,
    results: campaignState.results.map(r => ({ ...r })),
  })

  campaignState.running = false
  campaignState.current = null
}

module.exports = {
  init,
  listInstances,
  createInstance,
  getInstanceStatus,
  getInstanceQr,
  disconnectInstance,
  logoutInstance,
  removeInstance,
  setLabel,
  setProxy,
  sendText,
  sendButtons,
  handleWebhook,
  runCampaign,
  campaignState,
  loadHistory,
  deleteHistoryRecord,
}
