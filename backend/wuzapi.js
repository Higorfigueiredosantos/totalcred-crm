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
const MATURADOR_JOURNEY_FILE = path.join(DATA_DIR, 'wuzapi_maturador_journey.json')
const MATURADOR_SETTINGS_FILE = path.join(DATA_DIR, 'wuzapi_maturador_settings.json')

// Mesma biblioteca de fotos/áudios usada pelo maturador dos chips (whatsapp-web.js)
// — um único lugar pra gerenciar mídia, reaproveitado pelos dois maturadores.
const MATURADOR_MEDIA_DIR = path.join(DATA_DIR, 'maturador_media')
const MATURADOR_IMAGES_DIR = path.join(MATURADOR_MEDIA_DIR, 'images')
const MATURADOR_AUDIOS_DIR = path.join(MATURADOR_MEDIA_DIR, 'audios')

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
  // reconfirmar do lado do wuzapi a cada (re)conexão). Pra instância recém
  // criada, o usuário pode não estar imediatamente disponível pro wuzapi
  // aceitar chamadas autenticadas com o token — sem retry, essa chamada
  // falhava silenciosamente logo após criar e a instância nunca recebia
  // mensagens no CRM (o próximo reconectar já funcionava, porque por aí o
  // wuzapi já tinha processado o usuário novo).
  await ensureWuzapiWebhook(entry.token)

  await connectSession(entry.token)

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

// Tenta configurar o webhook algumas vezes antes de desistir — cobre o caso
// de instância recém criada, onde o wuzapi pode levar um instante pra aceitar
// chamadas autenticadas com o token novo. Não lança erro no final: falha de
// webhook não deve impedir a instância de existir, só fica sem receber
// mensagens no CRM até o próximo reconectar tentar de novo.
async function ensureWuzapiWebhook(token) {
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await userClient(token).post('/webhook', { webhookurl: WUZAPI_WEBHOOK_URL, events: ['Message', 'ReadReceipt'] })
      return
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error('[Wuzapi] Falha ao configurar webhook após tentativas:', e.message)
        return
      }
      await new Promise(r => setTimeout(r, 400))
    }
  }
}

async function connectSession(token) {
  try {
    await userClient(token).post('/session/connect', { Subscribe: ['Message'], Immediate: false })
  } catch (e) {
    // whatsmeow reconecta sessões salvas sozinho ao subir o container — se a
    // gente chamar /session/connect de novo nesse meio tempo, o wuzapi
    // responde erro "already connected". Não é falha, é o estado que já
    // queríamos alcançar.
    if (!/already connected/i.test(e?.response?.data?.error || e.message || '')) throw e
  }
}

// O wuzapi recusa mudar o proxy enquanto a sessão está conectada ("cannot
// set proxy while connected") — o /session/disconnect não garante que o
// estado interno já reflete a desconexão no exato instante em que retorna,
// então tenta de novo algumas vezes com um intervalo curto antes de desistir,
// em vez de expor esse detalhe de timing pra quem chama.
async function setProxy(name, proxyUrl, enabled) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')
  const payload = { proxy_url: enabled ? String(proxyUrl || '').trim() : '', enable: !!enabled }

  const MAX_ATTEMPTS = 6
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await userClient(entry.token).post('/session/proxy', payload)
      return { ok: true }
    } catch (e) {
      const msg = e?.response?.data?.error || e.message || ''
      if (attempt >= MAX_ATTEMPTS || !/connect/i.test(msg)) throw e
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

// Desconecta (se estiver conectada), aplica o proxy e reconecta sozinho —
// fluxo padrão usado pela tela de configuração da instância pra trocar o
// proxy sem exigir passos manuais do usuário. O mesmo proxy fica valendo
// pra qualquer coisa que use essa sessão depois, maturador incluso (é a
// mesma sessão do wuzapi por trás do envio manual e do maturador).
async function setProxyAndReconnect(name, proxyUrl, enabled) {
  const entry = loadRegistry()[name]
  if (!entry) throw new Error('Instância não encontrada')

  try { await userClient(entry.token).post('/session/disconnect') } catch (e) { /* pode já estar desconectada */ }
  await setProxy(name, proxyUrl, enabled)
  await connectSession(entry.token)
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

// Imagem/áudio avulsos — usados pelo maturador. O wuzapi aceita o mesmo
// formato de data URI base64 já usado no campo "Image" de /chat/send/buttons.
async function sendImage(instanceName, to, imageDataUri, caption) {
  const entry = loadRegistry()[instanceName]
  if (!entry) throw new Error('Instância não encontrada')
  const phone = cleanPhone(to)
  if (phone.length < 10) throw new Error('Número inválido')

  const { data } = await userClient(entry.token).post('/chat/send/image', {
    Phone: phone,
    Image: imageDataUri,
    Caption: caption || undefined,
  })
  if (!data) throw new Error('Falha ao enviar')
  return { ok: true, messageId: data?.Id || data?.data?.Id || null }
}

async function sendAudio(instanceName, to, audioDataUri) {
  const entry = loadRegistry()[instanceName]
  if (!entry) throw new Error('Instância não encontrada')
  const phone = cleanPhone(to)
  if (phone.length < 10) throw new Error('Número inválido')

  const { data } = await userClient(entry.token).post('/chat/send/audio', {
    Phone: phone,
    Audio: audioDataUri,
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

// ── Maturador (BETA) ──────────────────────────────────────────────────────────
// Mesma lógica do maturador dos chips (whatsapp-web.js): duas ou mais
// instâncias trocam mensagens (texto/foto/áudio) entre si em intervalos
// aleatórios pra simular uso humano e "aquecer" o número. Aqui o "número do
// destinatário" não é algo que a gente já tenha salvo localmente — vem do JID
// que o próprio wuzapi devolve em /admin/users, então cada ciclo resolve as
// instâncias prontas na hora (listInstances já cobre isso).

const maturadorPhrases = require('./maturadorPhrases')

const MATURADOR_AUDIO_CHANCE = 0.15
const MATURADOR_IMAGE_CHANCE = 0.20

// Intervalo (segundos) entre mensagens dentro de uma mesma rajada — bem mais
// curto que o delay normal entre rajadas (minDelay/maxDelay), simulando
// alguém mandando várias mensagens rápidas seguidas.
const MATURADOR_BURST_GAP_MIN = 4
const MATURADOR_BURST_GAP_MAX = 15

// ── Configurações da jornada de aquecimento (editáveis pelo usuário, via
// engrenagem na tela) ───────────────────────────────────────────────────────
// Cada número tem sua própria jornada de 10 dias (ver maturadorData.journeys
// abaixo) — o dia 1 começa na primeira vez que o número participa, então
// números adicionados depois começam do zero mesmo que os outros já estejam
// mais avançados. Por dia: sendMin/sendMax — quantas mensagens esse número
// deve enviar; receiveMin/receiveMax — quantas mensagens esse número deve
// *receber* no dia (o maturador prioriza como destinatário quem ainda não
// bateu o mínimo, depois quem ainda não bateu o máximo, e só ignora a cota se
// todo mundo já bateu o máximo, pra não travar o envio); partners — quantos
// parceiros fixos esse número deve ter até esse dia (ver growMaturadorPartners
// abaixo). participantInstances (fora do array de dias): nomes das instâncias
// que participam da jornada — vazio usa todas as conectadas/selecionadas ao
// iniciar o maturador.
const MATURADOR_JOURNEY_DAYS = 10
const DEFAULT_MATURADOR_DAYS = [
  { sendMin: 5, sendMax: 10, receiveMin: 3, receiveMax: 6, partners: 1 },
  { sendMin: 7, sendMax: 13, receiveMin: 4, receiveMax: 8, partners: 1 },
  { sendMin: 10, sendMax: 16, receiveMin: 5, receiveMax: 10, partners: 2 },
  { sendMin: 12, sendMax: 18, receiveMin: 6, receiveMax: 12, partners: 2 },
  { sendMin: 15, sendMax: 22, receiveMin: 8, receiveMax: 14, partners: 3 },
  { sendMin: 18, sendMax: 25, receiveMin: 10, receiveMax: 16, partners: 3 },
  { sendMin: 20, sendMax: 28, receiveMin: 12, receiveMax: 18, partners: 4 },
  { sendMin: 23, sendMax: 30, receiveMin: 14, receiveMax: 20, partners: 4 },
  { sendMin: 25, sendMax: 33, receiveMin: 16, receiveMax: 22, partners: 5 },
  { sendMin: 25, sendMax: 35, receiveMin: 18, receiveMax: 25, partners: 5 },
]
const DEFAULT_MATURADOR_SETTINGS = { days: DEFAULT_MATURADOR_DAYS.map(d => ({ ...d })), participantInstances: [] }

function numOr(val, fallback) {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

function sanitizeMaturadorDay(day, fallback) {
  const sendMin = Math.max(1, Math.round(numOr(day?.sendMin, fallback.sendMin)))
  const sendMax = Math.max(sendMin, Math.round(numOr(day?.sendMax, fallback.sendMax)))
  const receiveMin = Math.max(0, Math.round(numOr(day?.receiveMin, fallback.receiveMin)))
  const receiveMax = Math.max(receiveMin, Math.round(numOr(day?.receiveMax, fallback.receiveMax)))
  const partners = Math.max(1, Math.round(numOr(day?.partners, fallback.partners)))
  return { sendMin, sendMax, receiveMin, receiveMax, partners }
}

function sanitizeMaturadorDays(days, fallbackDays) {
  return Array.from({ length: MATURADOR_JOURNEY_DAYS }, (_, i) => sanitizeMaturadorDay(days?.[i], fallbackDays[i]))
}

function sanitizeParticipantInstances(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter(n => typeof n === 'string' && n))]
}

function loadMaturadorSettings() {
  try {
    if (fs.existsSync(MATURADOR_SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MATURADOR_SETTINGS_FILE, 'utf8'))
      // Compatibilidade com o formato antigo (sem array de dias — uma meta
      // única pra jornada toda): usa os valores antigos como base do dia 1 e
      // deixa o crescimento padrão nos demais dias. O antigo participantsCount
      // (quantidade aleatória) não tem equivalente direto na seleção nomeada,
      // então vira lista vazia (= todas participam).
      const legacyDay = ('sendMin' in raw && !raw.days) ? { ...DEFAULT_MATURADOR_DAYS[0], ...raw } : null
      const days = sanitizeMaturadorDays(raw.days, legacyDay ? [legacyDay, ...DEFAULT_MATURADOR_DAYS.slice(1)] : DEFAULT_MATURADOR_DAYS)
      const participantInstances = sanitizeParticipantInstances(raw.participantInstances)
      return { days, participantInstances }
    }
  } catch (e) {}
  return { days: DEFAULT_MATURADOR_DAYS.map(d => ({ ...d })), participantInstances: [] }
}

function saveMaturadorSettingsFile() {
  try {
    ensureDataDir()
    fs.writeFileSync(MATURADOR_SETTINGS_FILE, JSON.stringify(maturadorSettings, null, 2))
  } catch (e) { console.error('[Wuzapi] Erro ao salvar configurações do maturador:', e.message) }
}

let maturadorSettings = loadMaturadorSettings()

function getMaturadorSettings() {
  return maturadorSettings
}

// Retorna a meta configurada para um dia da jornada (1-indexado); dia 11+
// repete a meta do último dia configurado.
function getMaturadorDaySettings(dayIndex) {
  const idx = Math.min(Math.max(Math.round(dayIndex) || 1, 1), MATURADOR_JOURNEY_DAYS) - 1
  return maturadorSettings.days[idx]
}

function setMaturadorSettings(patch = {}) {
  const days = patch.days ? sanitizeMaturadorDays(patch.days, maturadorSettings.days) : maturadorSettings.days
  const participantInstances = patch.participantInstances !== undefined
    ? sanitizeParticipantInstances(patch.participantInstances)
    : maturadorSettings.participantInstances
  maturadorSettings = { days, participantInstances }
  saveMaturadorSettingsFile()
  return maturadorSettings
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function loadMaturadorJourney() {
  try {
    if (fs.existsSync(MATURADOR_JOURNEY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MATURADOR_JOURNEY_FILE, 'utf8'))
      // Formato antigo era uma única jornada pro pool todo (tinha "dayIndex"
      // na raiz) — não dá pra migrar 1:1 pra jornada por número, então cada
      // instância recomeça do dia 1 (só os parceiros fixos já formados são
      // preservados, se existirem).
      if ('dayIndex' in raw) return { journeys: {}, partners: raw.partners || {} }
      return { journeys: raw.journeys || {}, partners: raw.partners || {} }
    }
  } catch (e) {}
  return { journeys: {}, partners: {} }
}

function saveMaturadorJourney() {
  try {
    ensureDataDir()
    fs.writeFileSync(MATURADOR_JOURNEY_FILE, JSON.stringify(maturadorData, null, 2))
  } catch (e) { console.error('[Wuzapi] Erro ao salvar jornada do maturador:', e.message) }
}

// maturadorData.journeys: uma jornada de aquecimento independente por número
// (nome da instância) — cada uma com seu próprio dia 1..10, criada na
// primeira vez que o número participa. maturadorData.partners: grafo de
// parceiros fixos entre números, compartilhado por todos.
let maturadorData = loadMaturadorJourney()

// Garante a jornada do dia pra uma instância: cria na primeira vez, ou avança
// pro próximo dia se a data mudou desde a última vez que essa instância
// participou. Idempotente dentro do mesmo dia calendário.
function ensureInstanceJourneyDay(name) {
  const today = todayKey()
  let j = maturadorData.journeys[name]
  if (j && j.lastActiveDate === today) return { journey: j, isNewDay: false }

  if (!j) j = maturadorData.journeys[name] = { dayIndex: 0, dailyTarget: 0, dailySent: 0, dailyReceived: 0, lastActiveDate: null, startDate: null, history: {} }
  j.dayIndex = j.lastActiveDate ? j.dayIndex + 1 : 1
  const daySettings = getMaturadorDaySettings(j.dayIndex)
  j.dailyTarget = randomInt(daySettings.sendMin, daySettings.sendMax)
  j.dailySent = 0
  j.dailyReceived = 0
  j.lastActiveDate = today
  if (!j.startDate) j.startDate = today
  j.history[today] = { day: j.dayIndex, target: j.dailyTarget, sent: 0, received: 0 }
  return { journey: j, isNewDay: true }
}

// Forma/cresce os pares fixos entre os participantes: cada canal só troca
// mensagens com os parceiros que já tem (nunca perde um parceiro antigo), e
// ganha parceiros novos aos poucos até atingir a meta de parceiros do seu
// próprio dia (targetDegreeByName) — assim "o número que um canal chama" é
// sempre o mesmo que troca mensagens com ele, o que deixa o padrão de
// conversa mais parecido com uso real. Como cada número tem sua própria
// jornada, a meta de parceiros pode ser diferente pra cada lado do par.
function growMaturadorPartners(participants, targetDegreeByName) {
  const partners = maturadorData.partners || (maturadorData.partners = {})
  participants.forEach(p => { if (!partners[p]) partners[p] = [] })

  let needMore = participants.filter(p => partners[p].length < targetDegreeByName[p])
  let guard = 0
  while (needMore.length >= 2 && guard < 1000) {
    guard++
    const aIdx = Math.floor(Math.random() * needMore.length)
    const a = needMore[aIdx]
    const candidates = participants.filter(b => b !== a && !partners[a].includes(b) && partners[b].length < targetDegreeByName[b])
    if (!candidates.length) { needMore.splice(aIdx, 1); continue }
    const b = candidates[Math.floor(Math.random() * candidates.length)]
    partners[a].push(b)
    partners[b].push(a)
    needMore = participants.filter(p => partners[p].length < targetDegreeByName[p])
  }
}

// Enquanto a meta do dia já foi batida, só verifica de tempos em tempos se
// virou o dia — sem chamar a API do wuzapi à toa nesse meio tempo.
const MATURADOR_DAY_CHECK_MS = 20 * 60 * 1000

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }

function safeReadDir(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')) } catch { return [] }
}

function fileToDataUri(filePath, mimetype) {
  const buffer = fs.readFileSync(filePath)
  return `data:${mimetype};base64,${buffer.toString('base64')}`
}

// JID pode vir como "5511999999999@s.whatsapp.net" ou com device id
// ("5511999999999:12@s.whatsapp.net") — só interessa o número.
function phoneFromJid(jid) {
  if (!jid) return null
  return String(jid).split('@')[0].split(':')[0] || null
}

const maturadorState = { running: false, timer: null, instanceNames: [], minDelay: 60, maxDelay: 300, mediaEnabled: true, msgCount: 0, dayQuotaReached: false }

async function getReadyMaturadorInstances(names) {
  let all
  try { all = await listInstances() } catch (e) { return [] }
  const filtered = names && names.length ? all.filter(i => names.includes(i.name)) : all
  return filtered
    .filter(i => i.status === 'connected' && i.jid)
    .map(i => ({ name: i.name, phone: phoneFromJid(i.jid) }))
    .filter(i => i.phone)
}

// Dos números prontos (conectados e dentro do pool escolhido ao iniciar),
// filtra pra quem está marcado em participantInstances — vazio usa todos.
function selectJourneyParticipants(readyAll) {
  const selected = maturadorSettings.participantInstances
  if (!selected || !selected.length) return readyAll
  return readyAll.filter(r => selected.includes(r.name))
}

async function runMaturadorLoop(minDelay, maxDelay) {
  if (!maturadorState.running) return

  const readyAll = await getReadyMaturadorInstances(maturadorState.instanceNames)
  const ready = selectJourneyParticipants(readyAll)

  if (ready.length < 2) {
    _broadcast('wuzapi_maturador', { type: 'waiting', message: '⚠️ Aguardando pelo menos 2 instâncias Wuzapi conectadas...' })
    if (!maturadorState.running) return
    const waitDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay
    maturadorState.timer = setTimeout(() => runMaturadorLoop(minDelay, maxDelay), waitDelay * 1000)
    return
  }

  // Garante (cria ou avança) a jornada de hoje de cada número pronto — cada
  // um no seu próprio ritmo, começando do dia 1 na primeira vez que participa.
  const journeysByName = {}
  ready.forEach(r => {
    const { journey, isNewDay } = ensureInstanceJourneyDay(r.name)
    journeysByName[r.name] = journey
    if (isNewDay) _broadcast('wuzapi_maturador', { type: 'day_started', instanceName: r.name, day: journey.dayIndex, target: journey.dailyTarget })
  })

  // Cresce os pares fixos conforme a meta de parceiros do dia de cada número
  // (pode ser diferente pra cada lado, já que cada um tem sua própria jornada).
  const targetDegreeByName = {}
  ready.forEach(r => { targetDegreeByName[r.name] = getMaturadorDaySettings(journeysByName[r.name].dayIndex).partners })
  growMaturadorPartners(ready.map(r => r.name), targetDegreeByName)
  saveMaturadorJourney()

  const readyNames = new Set(ready.map(r => r.name))
  const eligibleSenders = ready.filter(r => {
    if (journeysByName[r.name].dailySent >= journeysByName[r.name].dailyTarget) return false
    return (maturadorData.partners[r.name] || []).some(p => readyNames.has(p))
  })

  if (!eligibleSenders.length) {
    const allDone = ready.every(r => journeysByName[r.name].dailySent >= journeysByName[r.name].dailyTarget)
    if (allDone) {
      if (!maturadorState.dayQuotaReached) {
        maturadorState.dayQuotaReached = true
        _broadcast('wuzapi_maturador', { type: 'day_complete' })
      }
      maturadorState.timer = setTimeout(() => runMaturadorLoop(minDelay, maxDelay), MATURADOR_DAY_CHECK_MS)
      return
    }
    maturadorState.dayQuotaReached = false
    _broadcast('wuzapi_maturador', { type: 'waiting', message: '⚠️ Nenhum parceiro fixo conectado hoje ainda — aguardando.' })
  } else {
    maturadorState.dayQuotaReached = false
    const sender = eligibleSenders[Math.floor(Math.random() * eligibleSenders.length)]
    const senderJourney = journeysByName[sender.name]

    // A primeira mensagem do dia de cada canal sai sozinha — só depois disso
    // o maturador passa a poder mandar de 1 a 3 mensagens seguidas do mesmo
    // remetente (com um intervalo curto entre elas), parecido com alguém
    // digitando várias mensagens rápidas de verdade.
    const remainingQuota = senderJourney.dailyTarget - senderJourney.dailySent
    const burstSize = senderJourney.dailySent === 0 ? 1 : Math.min(randomInt(1, 3), remainingQuota)

    for (let i = 0; i < burstSize; i++) {
      if (!maturadorState.running) return

      // Escolhe o destinatário (sempre um dos parceiros fixos do remetente)
      // priorizando quem ainda não bateu a cota mínima de recebimento do
      // *próprio dia dele*, depois quem ainda não bateu a cota máxima, e só
      // ignora a cota se todo mundo já estiver no máximo (não trava o envio).
      const partnerNames = (maturadorData.partners[sender.name] || []).filter(p => readyNames.has(p))
      if (!partnerNames.length) break
      const others = ready.filter(r => partnerNames.includes(r.name))
      const belowMin = (r) => journeysByName[r.name].dailyReceived < getMaturadorDaySettings(journeysByName[r.name].dayIndex).receiveMin
      const belowMax = (r) => journeysByName[r.name].dailyReceived < getMaturadorDaySettings(journeysByName[r.name].dayIndex).receiveMax
      let candidates = others.filter(belowMin)
      if (!candidates.length) candidates = others.filter(belowMax)
      if (!candidates.length) candidates = others
      const receiver = candidates[Math.floor(Math.random() * candidates.length)]
      const receiverJourney = journeysByName[receiver.name]

      try {
        const images = maturadorState.mediaEnabled ? safeReadDir(MATURADOR_IMAGES_DIR) : []
        const audios = maturadorState.mediaEnabled ? safeReadDir(MATURADOR_AUDIOS_DIR) : []
        const roll = Math.random()

        let msgType = 'text'
        let message
        let fileName

        if (roll < MATURADOR_AUDIO_CHANCE && audios.length) {
          fileName = audios[Math.floor(Math.random() * audios.length)]
          const dataUri = fileToDataUri(path.join(MATURADOR_AUDIOS_DIR, fileName), 'audio/ogg; codecs=opus')
          await sendAudio(sender.name, receiver.phone, dataUri)
          msgType = 'audio'
        } else if (roll < MATURADOR_AUDIO_CHANCE + MATURADOR_IMAGE_CHANCE && images.length) {
          fileName = images[Math.floor(Math.random() * images.length)]
          const ext = path.extname(fileName).toLowerCase()
          const dataUri = fileToDataUri(path.join(MATURADOR_IMAGES_DIR, fileName), MIME_BY_EXT[ext] || 'image/jpeg')
          message = Math.random() < 0.5 ? maturadorPhrases.pickShort() : undefined
          await sendImage(sender.name, receiver.phone, dataUri, message)
          msgType = 'image'
        } else {
          message = maturadorPhrases.pick(maturadorState.msgCount)
          await sendText(sender.name, receiver.phone, message)
        }

        maturadorState.msgCount++
        senderJourney.dailySent++
        receiverJourney.dailyReceived++
        senderJourney.history[senderJourney.lastActiveDate].sent = senderJourney.dailySent
        receiverJourney.history[receiverJourney.lastActiveDate].received = receiverJourney.dailyReceived
        saveMaturadorJourney()
        _broadcast('wuzapi_maturador', {
          type: 'log', from: sender.name, to: receiver.name, toNumber: receiver.phone, msgType, message, fileName, ts: Date.now(),
          senderDay: senderJourney.dayIndex, senderTarget: senderJourney.dailyTarget, senderSent: senderJourney.dailySent,
          receiverDay: receiverJourney.dayIndex, receiverReceived: receiverJourney.dailyReceived,
        })
      } catch (e) {
        _broadcast('wuzapi_maturador', { type: 'error', instanceName: sender.name, error: e?.response?.data?.error || e.message })
        break
      }

      if (senderJourney.dailySent >= senderJourney.dailyTarget) break
      if (i < burstSize - 1) {
        const gap = randomInt(MATURADOR_BURST_GAP_MIN, MATURADOR_BURST_GAP_MAX)
        await new Promise(r => setTimeout(r, gap * 1000))
      }
    }
  }

  if (!maturadorState.running) return
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay
  _broadcast('wuzapi_maturador', { type: 'delay', seconds: delay })
  maturadorState.timer = setTimeout(() => runMaturadorLoop(minDelay, maxDelay), delay * 1000)
}

async function startMaturador({ instanceNames, minDelay, maxDelay, mediaEnabled } = {}) {
  const ready = await getReadyMaturadorInstances(instanceNames)
  if (ready.length < 2) throw new Error('Você precisa de pelo menos 2 instâncias Wuzapi conectadas para o maturador.')

  const min = Number(minDelay) || 60
  const max = Number(maxDelay) || 300
  maturadorState.running = true
  maturadorState.instanceNames = instanceNames && instanceNames.length ? instanceNames : ready.map(r => r.name)
  maturadorState.minDelay = min
  maturadorState.maxDelay = max
  maturadorState.mediaEnabled = mediaEnabled !== false
  maturadorState.msgCount = 0

  _broadcast('wuzapi_maturador', { type: 'started' })
  runMaturadorLoop(min, max)
}

function stopMaturador() {
  maturadorState.running = false
  if (maturadorState.timer) clearTimeout(maturadorState.timer)
  _broadcast('wuzapi_maturador', { type: 'stopped' })
}

// Apaga a jornada de um número (volta pro zero — a próxima participação
// começa de novo no dia 1) e também o tira do grafo de parceiros fixos, já
// que os parceiros que ele tinha foram formados em função do progresso que
// está sendo apagado.
function deleteMaturadorJourney(name) {
  delete maturadorData.journeys[name]
  const myPartners = maturadorData.partners[name]
  if (myPartners) {
    myPartners.forEach(other => {
      if (maturadorData.partners[other]) {
        maturadorData.partners[other] = maturadorData.partners[other].filter(n => n !== name)
      }
    })
    delete maturadorData.partners[name]
  }
  saveMaturadorJourney()
  return { ok: true }
}

function getMaturadorStatus() {
  return {
    running: maturadorState.running,
    instanceNames: maturadorState.instanceNames,
    minDelay: maturadorState.minDelay,
    maxDelay: maturadorState.maxDelay,
    mediaEnabled: maturadorState.mediaEnabled,
    dayQuotaReached: maturadorState.dayQuotaReached,
    settings: maturadorSettings,
    // Uma jornada por número (nome da instância) + o grafo de parceiros
    // fixos, compartilhado entre todas.
    journeys: maturadorData.journeys,
    partners: maturadorData.partners,
  }
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
  setProxyAndReconnect,
  sendText,
  sendButtons,
  sendImage,
  sendAudio,
  handleWebhook,
  runCampaign,
  campaignState,
  loadHistory,
  deleteHistoryRecord,
  startMaturador,
  stopMaturador,
  getMaturadorStatus,
  getMaturadorSettings,
  setMaturadorSettings,
  deleteMaturadorJourney,
}
