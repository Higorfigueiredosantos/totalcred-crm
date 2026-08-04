'use strict'
// Integração com o serviço "Infinite" (baileys_interactive), um microserviço
// REST separado (infinite-service/) que expõe conexões WhatsApp via Baileys
// com suporte a botões/listas/carrossel/enquete. Só envio — o serviço não tem
// webhook de mensagens recebidas, então não há nada a receber aqui.
const axios = require('axios')
const fs = require('fs')
const path = require('path')

const INFINITE_URL = process.env.INFINITE_URL || 'http://infinite:8787'
const INFINITE_API_KEY = process.env.INFINITE_API_KEY || ''

const DATA_DIR = path.join(__dirname, 'data')
const LABELS_FILE = path.join(DATA_DIR, 'infinite_instances.json')
const HISTORY_FILE = path.join(DATA_DIR, 'infinite_campaigns_history.json')

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function http() {
  return axios.create({
    baseURL: INFINITE_URL,
    timeout: 15000,
    headers: INFINITE_API_KEY ? { 'x-api-key': INFINITE_API_KEY } : {},
  })
}

function loadLabels() {
  try {
    if (fs.existsSync(LABELS_FILE)) return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'))
  } catch (e) {}
  return {}
}

function saveLabels(labels) {
  try {
    ensureDataDir()
    fs.writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2))
  } catch (e) { console.error('[Infinite] Erro ao salvar labels:', e.message) }
}

function setLabel(name, label) {
  const labels = loadLabels()
  labels[name] = { label }
  saveLabels(labels)
}

function removeLabel(name) {
  const labels = loadLabels()
  delete labels[name]
  saveLabels(labels)
}

// ── Instâncias ──────────────────────────────────────────────────────────────

async function listInstances() {
  const { data } = await http().get('/v1/instances')
  const labels = loadLabels()
  const active = await Promise.all((data.instances || []).map(async i => {
    const hasQr = Boolean(i.hasQr)
    let qr = null
    // GET /v1/instances só informa hasQr — a imagem do QR só vem do endpoint dedicado
    if (hasQr && i.status === 'qr') {
      try { qr = (await getInstanceQr(i.instance)).qr || null } catch (e) {}
    }
    return {
      name: i.instance,
      status: i.status,
      hasQr,
      qr,
      createdAt: i.createdAt,
      label: labels[i.instance]?.label || null,
    }
  }))
  const activeNames = new Set(active.map(i => i.name))
  const savedOnly = (data.saved || [])
    .filter(name => !activeNames.has(name))
    .map(name => ({ name, status: 'disconnected', hasQr: false, qr: null, createdAt: null, label: labels[name]?.label || null }))
  return [...active, ...savedOnly]
}

async function createInstance(name, label) {
  const { data } = await http().post('/v1/instances', { instance: name })
  if (label) setLabel(name, label)
  return data
}

async function getInstanceStatus(name) {
  const { data } = await http().get(`/v1/instances/${encodeURIComponent(name)}`)
  return data
}

async function getInstanceQr(name) {
  const { data } = await http().get(`/v1/instances/${encodeURIComponent(name)}/qr`)
  return data
}

async function disconnectInstance(name) {
  const { data } = await http().post(`/v1/instances/${encodeURIComponent(name)}/disconnect`)
  return data
}

async function logoutInstance(name) {
  const { data } = await http().post(`/v1/instances/${encodeURIComponent(name)}/logout`)
  removeLabel(name)
  return data
}

async function removeInstance(name) {
  const { data } = await http().delete(`/v1/instances/${encodeURIComponent(name)}`)
  return data
}

// ── Envio de mensagens ────────────────────────────────────────────────────────

const SEND_ENDPOINTS = {
  menu: '/v1/messages/send_menu',
  buttons: '/v1/messages/send_buttons_helpers',
  interactive: '/v1/messages/send_interactive_helpers',
  list: '/v1/messages/send_list_helpers',
  poll: '/v1/messages/send_poll',
  carousel: '/v1/messages/send_carousel_helpers',
}

function cleanPhone(number) {
  return String(number || '').replace(/\D/g, '')
}

async function sendMessage(type, instanceName, to, payload = {}) {
  const endpoint = SEND_ENDPOINTS[type]
  if (!endpoint) throw new Error(`Tipo de mensagem inválido: ${type}`)
  const phone = cleanPhone(to)
  if (phone.length < 10) throw new Error('Número inválido')
  const { data } = await http().post(endpoint, { instance: instanceName, to: phone, ...payload })
  if (!data?.ok) throw new Error(data?.error || 'Falha ao enviar')
  return data
}

// ── Campanha ──────────────────────────────────────────────────────────────────

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
  } catch (e) { console.error('[Infinite] Erro ao salvar histórico:', e.message) }
}

function deleteHistoryRecord(id) {
  const list = loadHistory().filter(c => c.id !== id)
  ensureDataDir()
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2))
}

// Substitui {{name}} e {{var}} no texto, igual à humanização de chips (sem o
// pool de saudações — botões/listas/enquetes não têm "abertura de conversa").
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

// Aplica applyVars recursivamente nos campos de texto do payload (text, title,
// footer, name, options[], buttons[].text, sections[].rows[].title/description, cards[]...)
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

async function runCampaign(data, broadcast) {
  const { name, messageType, payload, instanceNames, contacts, delayMin = 5, delayMax = 15 } = data
  campaignState.results = []
  campaignState.paused = false
  campaignState.stopped = false
  campaignState.running = true
  campaignState.current = data
  let success = 0, failed = 0
  const startedAt = Date.now()
  let rrIndex = 0

  broadcast('infinite_campaign', { type: 'started', instances: instanceNames, total: contacts.length })

  for (let i = 0; i < contacts.length; i++) {
    if (campaignState.stopped) break
    while (campaignState.paused) await sleep(500)

    const contact = contacts[i]

    if (campaignState.sentNumbers.has(contact.number)) {
      broadcast('infinite_campaign', { type: 'skipped', number: contact.number, current: i + 1, total: contacts.length })
      continue
    }

    const result = { index: i, number: contact.number, name: contact.name || contact.number, status: 'sending' }
    campaignState.results.push(result)
    broadcast('infinite_campaign', { type: 'progress', contact: result, success, failed, total: contacts.length, current: i + 1 })

    try {
      const instanceName = instanceNames[rrIndex % instanceNames.length]
      rrIndex++
      const resolved = resolvePayload(payload, contact)
      await sendMessage(messageType, instanceName, contact.number, resolved)
      result.status = 'success'
      result.via = instanceName
      result.sentAt = Date.now()
      success++
      campaignState.sentNumbers.add(contact.number)
      broadcast('infinite_campaign', { type: 'result', contact: result, success, failed })
    } catch (e) {
      result.status = 'failed'
      result.error = e?.response?.data?.error || e.message || 'Erro desconhecido'
      failed++
      broadcast('infinite_campaign', { type: 'result', contact: result, success, failed })
    }

    if (i < contacts.length - 1 && !campaignState.stopped) {
      const delay = Math.floor(Math.random() * (Math.max(delayMax, delayMin) - delayMin + 1)) + delayMin
      broadcast('infinite_campaign', { type: 'waiting', delay, next: i + 2 })
      await sleep(delay * 1000)
    }
  }

  const endedAt = Date.now()
  broadcast('infinite_campaign', { type: 'done', success, failed, total: contacts.length, results: campaignState.results })

  saveHistoryRecord({
    id: startedAt.toString(),
    name: name || 'Campanha Infinite',
    messageType,
    startedAt,
    endedAt,
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
  listInstances,
  createInstance,
  getInstanceStatus,
  getInstanceQr,
  disconnectInstance,
  logoutInstance,
  removeInstance,
  setLabel,
  sendMessage,
  runCampaign,
  campaignState,
  loadHistory,
  deleteHistoryRecord,
}
