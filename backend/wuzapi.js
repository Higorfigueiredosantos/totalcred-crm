'use strict'
// Integração com o serviço "Wuzapi" (asternic/wuzapi, biblioteca whatsmeow),
// usada em BETA só pra comparar a entrega de mensagens com botão nativo
// contra o que já temos no Infinite (Baileys). Imagem oficial do Docker Hub,
// sem build próprio. Diferente do Infinite, o wuzapi modela cada número
// conectado como um "usuário" com um token próprio — mantemos um registro
// local (nome amigável -> token/id) pra expor a mesma interface simples de
// instâncias que o resto do app já usa.
const axios = require('axios')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const WUZAPI_URL = process.env.WUZAPI_URL || 'http://wuzapi:8080'
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN || ''

const DATA_DIR = path.join(__dirname, 'data')
const INSTANCES_FILE = path.join(DATA_DIR, 'wuzapi_instances.json')
const HISTORY_FILE = path.join(DATA_DIR, 'wuzapi_campaigns_history.json')

let _broadcast = () => {}

function init({ broadcast }) {
  if (broadcast) _broadcast = broadcast
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

  await userClient(entry.token).post('/session/connect', { Subscribe: ['Message'], Immediate: false })

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

// ── Envio de botões ───────────────────────────────────────────────────────────

function cleanPhone(number) {
  return String(number || '').replace(/\D/g, '')
}

// payload: { text, footer, buttons: [{ id, text }] }
async function sendButtons(instanceName, to, payload = {}) {
  const entry = loadRegistry()[instanceName]
  if (!entry) throw new Error('Instância não encontrada')
  const phone = cleanPhone(to)
  if (phone.length < 10) throw new Error('Número inválido')

  const buttons = (payload.buttons || []).filter(b => b?.text?.trim()).slice(0, 3).map((b, idx) => ({
    type: 'reply',
    title: String(b.text).slice(0, 20),
    id: b.id || `btn_${idx}`,
  }))
  if (buttons.length === 0) throw new Error('Adicione ao menos um botão')

  const { data } = await userClient(entry.token).post('/chat/send/buttons', {
    Phone: phone,
    Body: payload.text || '',
    Footer: payload.footer || undefined,
    Buttons: buttons,
  })
  if (!data) throw new Error('Falha ao enviar')
  return { ok: true, messageId: data?.Id || data?.data?.Id || null }
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
  sendButtons,
  runCampaign,
  campaignState,
  loadHistory,
  deleteHistoryRecord,
}
