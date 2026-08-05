'use strict'
// Integração com o serviço "Infinite" (baileys_interactive), um microserviço
// REST separado (infinite-service/) que expõe conexões WhatsApp via Baileys
// com suporte a botões/listas/carrossel/enquete. Disparo via REST (send*/
// campanha), recebimento via webhook (o próprio infinite-service nos chama em
// /api/infinite/webhook quando chega mensagem) e resposta de texto normal
// pelo Mensagens (envio de mídia avulsa pelo chat ainda não é suportado).
const axios = require('axios')
const fs = require('fs')
const path = require('path')

const INFINITE_URL = process.env.INFINITE_URL || 'http://infinite:8787'
const INFINITE_API_KEY = process.env.INFINITE_API_KEY || ''

const DATA_DIR = path.join(__dirname, 'data')
const LABELS_FILE = path.join(DATA_DIR, 'infinite_instances.json')
const HISTORY_FILE = path.join(DATA_DIR, 'infinite_campaigns_history.json')

// Injetado por server.js via init() — evita import circular (infinite.js é
// exigido antes de broadcast/getConvId/MEDIA_DIR existirem em server.js).
let _broadcast = () => {}
let _getConvId = (channel, contact) => `${channel}:${contact}`
let _mediaDir = DATA_DIR

function init({ broadcast, getConvId, mediaDir }) {
  if (broadcast) _broadcast = broadcast
  if (getConvId) _getConvId = getConvId
  if (mediaDir) _mediaDir = mediaDir
}

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
  text: '/v1/messages/send_text',
  menu: '/v1/messages/send_menu',
  buttons: '/v1/messages/send_buttons_helpers',
  imageButtons: '/v1/messages/send_image_buttons',
  imageLink: '/v1/messages/send_image_interactive',
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

// messageId (do WhatsApp) -> result object, pra correlacionar webhooks de ACK
// (entregue/lido) que chegam depois do envio. Cresce por campanha; limitado
// pra não vazar memória em uso prolongado do servidor.
const messageIdIndex = new Map()
function indexMessageId(messageId, result) {
  messageIdIndex.set(messageId, result)
  if (messageIdIndex.size > 5000) {
    const oldest = messageIdIndex.keys().next().value
    messageIdIndex.delete(oldest)
  }
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

async function runCampaign(data) {
  const { name, messageType, payload, instanceNames, contacts, delayMin = 5, delayMax = 15 } = data
  campaignState.results = []
  campaignState.paused = false
  campaignState.stopped = false
  campaignState.running = true
  campaignState.current = data
  let success = 0, failed = 0
  const startedAt = Date.now()
  let rrIndex = 0

  _broadcast('infinite_campaign', { type: 'started', instances: instanceNames, total: contacts.length })

  for (let i = 0; i < contacts.length; i++) {
    if (campaignState.stopped) break
    while (campaignState.paused) await sleep(500)

    const contact = contacts[i]

    if (campaignState.sentNumbers.has(contact.number)) {
      _broadcast('infinite_campaign', { type: 'skipped', number: contact.number, current: i + 1, total: contacts.length })
      continue
    }

    const result = { index: i, number: contact.number, name: contact.name || contact.number, status: 'sending' }
    campaignState.results.push(result)
    _broadcast('infinite_campaign', { type: 'progress', contact: result, success, failed, total: contacts.length, current: i + 1 })

    try {
      const instanceName = instanceNames[rrIndex % instanceNames.length]
      rrIndex++
      const resolved = resolvePayload(payload, contact)
      const sent = await sendMessage(messageType, instanceName, contact.number, resolved)
      result.status = 'success'
      result.via = instanceName
      result.sentAt = Date.now()
      if (sent?.messageId) {
        result.messageId = sent.messageId
        indexMessageId(sent.messageId, result)
      }
      success++
      campaignState.sentNumbers.add(contact.number)
      _broadcast('infinite_campaign', { type: 'result', contact: result, success, failed })
    } catch (e) {
      result.status = 'failed'
      result.error = e?.response?.data?.error || e.message || 'Erro desconhecido'
      failed++
      _broadcast('infinite_campaign', { type: 'result', contact: result, success, failed })
    }

    if (i < contacts.length - 1 && !campaignState.stopped) {
      const delay = Math.floor(Math.random() * (Math.max(delayMax, delayMin) - delayMin + 1)) + delayMin
      _broadcast('infinite_campaign', { type: 'waiting', delay, next: i + 2 })
      await sleep(delay * 1000)
    }
  }

  const endedAt = Date.now()
  _broadcast('infinite_campaign', { type: 'done', success, failed, total: contacts.length, results: campaignState.results })

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

// ── Mensagens recebidas (webhook do infinite-service) ─────────────────────────

const MEDIA_EXT_MAP = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/aac': 'aac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/3gpp': '3gp',
  'application/pdf': 'pdf',
}

// Chamado pela rota POST /api/infinite/webhook quando o infinite-service repassa
// uma mensagem recebida. Reaproveita o mesmo evento WS "chip_message" que
// Mensagens.tsx já consome (chipId prefixado com "infinite:" pra diferenciar
// visualmente sem duplicar toda a lógica de contato/conversa no frontend).
function handleWebhookMessage(body) {
  const {
    instance, from, author, isGroup, groupName, pushname, contactNumber,
    body: text, timestamp, msgType, mediaBase64, mediaMimetype,
  } = body || {}
  if (!instance || !from) return

  const chipId = `infinite:${instance}`
  let mediaUrl = null
  let mediaFileName = null

  if (mediaBase64) {
    try {
      const mime = (mediaMimetype || 'application/octet-stream').split(';')[0].trim()
      const ext = MEDIA_EXT_MAP[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')
      const fname = `infinite_${instance}_${Date.now()}.${ext}`
      fs.writeFileSync(path.join(_mediaDir, fname), Buffer.from(mediaBase64, 'base64'))
      mediaUrl = `/api/media/files/${fname}`
      mediaFileName = fname
    } catch (e) {
      console.error('[Infinite] Erro ao salvar mídia recebida:', e.message)
    }
  }

  const conversationId = _getConvId(chipId, from)
  _broadcast('chip_message', {
    chipId,
    from,
    author: author || from,
    body: text || '',
    timestamp,
    isGroup: !!isGroup,
    groupName: groupName || null,
    pushname: pushname || null,
    contactNumber: contactNumber || null,
    msgType: msgType || 'text',
    mediaUrl,
    mediaFileName,
    conversationId,
  })
}

// Chamado pra webhooks kind:'ack' — status 3=DELIVERY_ACK, 4=READ, 5=PLAYED
// (proto.WebMessageInfo.Status do Baileys, recibo real do WhatsApp). Atualiza
// o resultado da campanha (em memória, se ainda estiver na lista atual) e o
// histórico em disco (se a campanha já tiver sido salva), e avisa o frontend.
function handleAckWebhook(body) {
  const { messageId, status } = body || {}
  if (!messageId || typeof status !== 'number') return

  const result = messageIdIndex.get(messageId)
  if (result && (result.ack ?? 0) < status) {
    result.ack = status
    _broadcast('infinite_campaign', { type: 'ack', contact: result })
  }

  try {
    const list = loadHistory()
    let changed = false
    for (const record of list) {
      const r = (record.results || []).find(x => x.messageId === messageId)
      if (r && (r.ack ?? 0) < status) { r.ack = status; changed = true }
    }
    if (changed) fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2))
  } catch (e) { console.error('[Infinite] Erro ao salvar ack no histórico:', e.message) }
}

function handleWebhook(body) {
  if (body?.kind === 'ack') return handleAckWebhook(body)
  return handleWebhookMessage(body)
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
  sendMessage,
  runCampaign,
  campaignState,
  loadHistory,
  deleteHistoryRecord,
  handleWebhookMessage,
  handleAckWebhook,
  handleWebhook,
}
