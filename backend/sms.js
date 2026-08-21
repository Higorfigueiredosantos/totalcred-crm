'use strict'
// Disparo SMS via automação do Google Messages Web (messages.google.com/web)
// — não é um gateway SMS tradicional (Twilio etc). O usuário pareia o
// celular Android por QR code, igual ao WhatsApp Web, e o envio acontece
// controlando essa interface web com Puppeteer (já é dependência do
// projeto, usado pelos Chips e pelo gmaps_scraper.js).
//
// ATENÇÃO — ponto de maior incerteza do módulo: os seletores DOM abaixo
// (ver SELECTORS) foram extraídos do driver Playwright de um projeto de
// referência (github.com/Captando/disparador-sms), não testados ao vivo
// contra uma conta/telefone real. Interface não-documentada do Google e
// sujeita a mudar — se o pareamento ou o envio travarem em produção, o log
// de erro aponta exatamente qual seletor não bateu (cada etapa lança um erro
// descritivo própio); ajuste as constantes abaixo, não é preciso caçar em
// outro lugar do arquivo.
const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer')
const {
  applyVars, normalizeBrazilPhone, randDelaySec, spinOpeningWithAI,
} = require('./campaignVars')

const DATA_DIR = path.join(__dirname, 'data')
const INSTANCES_FILE = path.join(DATA_DIR, 'sms_instances.json')
const HISTORY_FILE = path.join(DATA_DIR, 'sms_campaigns_history.json')
const SMS_SESSIONS_DIR = path.join(__dirname, '.sms_sessions')

const AUTH_URL = 'https://messages.google.com/web/authentication'
const NEW_CONVERSATION_URL = 'https://messages.google.com/web/conversations/new'

// Cadeias de seletores candidatos — a primeira que existir na página é usada.
// Ver aviso no topo do arquivo.
const SELECTORS = {
  // Confirmados contra a página real (Google Mensagens na Web: pareamento
  // via QR code). <mw-qr-code> renderiza um <canvas> internamente só pra
  // gerar a imagem e mantém ele "display:none" — o QR de verdade pra
  // exibir é o <img data-uri> logo ao lado, já pronto (sem precisar de
  // screenshot). O <canvas>, mesmo escondido, ainda serve pra saber que a
  // etapa de QR está ativa.
  qrContainer: ['mw-qr-code'],
  qrImage: ['mw-qr-code img'],
  // Sem fallback genérico tipo "main" aqui de propósito — confirmado em
  // teste que a própria tela de QR/autenticação também tem um elemento
  // <main>, o que fazia detectState() reportar "connected" mesmo sem
  // nenhum pareamento real. A checagem de URL em detectState() é o sinal
  // mais confiável; o seletor é só uma confirmação a mais quando bate.
  conversationsList: ['mws-conversations-list'],
  recipientInput: [
    'input[placeholder*="name" i]', 'input[placeholder*="number" i]',
    'input[aria-label*="recipient" i]', 'input[aria-label*="destinatário" i]',
  ],
  messageInput: [
    '[data-e2e-message-input-box]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="mensagem" i]',
    '[contenteditable="true"]',
  ],
  sendButton: [
    '[data-e2e-send-text-button]',
    'button[aria-label*="Send" i]', 'button[aria-label*="Enviar" i]',
  ],
  // Não confirmados contra a página real (não tenho como logar numa conta
  // de verdade neste ambiente) — usados só pra detectar resposta de lead
  // (ver refreshInbound). Best-effort, seguindo a mesma convenção de nomes
  // "mws-*" já confirmada em conversationsList.
  conversationListItem: ['mws-conversation-list-item', '[data-e2e-conversation]'],
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let _broadcast = () => {}
function init({ broadcast }) {
  if (broadcast) _broadcast = broadcast
  resyncInstancesOnBoot()
  startWatchdog()
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}
function ensureSessionsDir() {
  if (!fs.existsSync(SMS_SESSIONS_DIR)) fs.mkdirSync(SMS_SESSIONS_DIR, { recursive: true })
}

// ── Registro local (id -> label) ─────────────────────────────────────────────

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
  } catch (e) { console.error('[SMS] Erro ao salvar registro:', e.message) }
}

// ── Sessões em memória (browser/page Puppeteer por id) ───────────────────────

const smsSessions = {}

function findChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
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

// Chrome deixa lockfiles (SingletonLock/SingletonCookie/SingletonSocket) no
// perfil quando derruba sem sair limpo — sem removê-los, o próximo launch
// com o mesmo userDataDir falha achando que já tem uma instância rodando.
// Se o unlink falhar (arquivo em uso — "resource busy"), é sinal forte de
// que um Chrome zumbi de uma tentativa anterior AINDA está rodando e
// segurando o lock de verdade (visto na prática: o puppeteer.launch pode
// falhar e ainda assim deixar o processo Chrome vivo por trás, um problema
// conhecido do Puppeteer no Windows) — nesse caso é melhor falhar cedo com
// uma mensagem clara do que deixar o launch inteiro (bem mais lento)
// estourar timeout com um erro genérico.
function clearSingletonLocks(profileDir) {
  if (!fs.existsSync(profileDir)) return
  let blocked = false
  for (const f of fs.readdirSync(profileDir)) {
    if (!f.startsWith('Singleton')) continue
    try { fs.unlinkSync(path.join(profileDir, f)) } catch (e) { blocked = true }
  }
  if (blocked) {
    throw new Error('Uma sessão anterior desta conta ainda parece estar rodando (perfil bloqueado). Aguarde alguns segundos e tente reconectar; se persistir, reinicie o backend.')
  }
}

// Tenta cada seletor candidato em sequência (não em paralelo, pra não deixar
// várias esperas penduradas) até achar um elemento ou estourar o timeout
// total. Retorna o ElementHandle ou null.
async function waitForAny(page, selectors, totalTimeoutMs, options = {}) {
  const perSelector = Math.max(500, Math.floor(totalTimeoutMs / selectors.length))
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: perSelector, ...options })
      if (el) return el
    } catch (e) { /* tenta o próximo candidato */ }
  }
  return null
}

// A URL é o sinal mais confiável de "logado" — bem mais estável do que
// qualquer seletor DOM, que muda com qualquer redesign da página. O
// seletor do QR ainda é necessário pra saber QUANDO capturar a imagem, mas
// pra decidir "conectado" a URL manda mais que qualquer elemento presente.
function urlLooksConnected(page) {
  const url = page.url()
  return /\/web\/conversations(\/|$|\?)/.test(url) && !/\/authentication/i.test(url)
}

async function detectState(page, timeoutMs = 12000) {
  if (urlLooksConnected(page)) return 'connected'
  const [listEl, qrEl] = await Promise.all([
    waitForAny(page, SELECTORS.conversationsList, timeoutMs).catch(() => null),
    waitForAny(page, SELECTORS.qrContainer, timeoutMs).catch(() => null),
  ])
  if (listEl && urlLooksConnected(page)) return 'connected'
  if (qrEl) return 'qr'
  return 'unknown'
}

// O <mw-qr-code> gera a imagem num <canvas> interno mas mantém ele
// "display:none" — o QR de verdade pra exibir é o <img data-uri> logo ao
// lado, já pronto como data:image/png;base64,... (confirmado inspecionando
// a página real). Lê o atributo src direto, sem precisar de screenshot —
// mais simples e evita a fragilidade de esperar animação de fade-in do
// canvas escondido (o que causava "Node is either not visible..." em teste).
// Algumas cargas da página demoram mais que outras pro Angular terminar de
// montar o <img> do QR (visto na prática: falha isolada em algumas
// tentativas mesmo com a página já carregada) — algumas tentativas curtas
// cobrem essa variação sem esperar o timeout inteiro de uma vez só.
async function captureQRCode(page, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const el = await waitForAny(page, SELECTORS.qrImage, 5000)
      if (!el) throw new Error('QR code não encontrado na página (seletor pode estar desatualizado)')
      const src = await page.evaluate(img => img.src, el)
      if (!src || !src.startsWith('data:image')) throw new Error('QR code encontrado mas sem imagem válida')
      return src
    } catch (e) {
      lastErr = e
      await sleep(1000)
    }
  }
  throw lastErr
}

async function waitForLogin(page, timeoutMs = 3 * 60 * 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) throw new Error('Página fechada durante o pareamento')
    const state = await detectState(page, 3000)
    if (state === 'connected') return true
    await sleep(2000)
  }
  return false
}

// Melhor esforço — não é crítico pro funcionamento, só pra exibir o número
// pareado na tela. Google Messages Web não expõe isso de forma tão direta
// quanto o whatsmeow, então isso é uma raspagem heurística do texto visível.
async function scrapeNumber(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText || '')
    const m = text.match(/\+?\d[\d\s()-]{8,}\d/)
    return m ? m[0].replace(/\D/g, '') : null
  } catch (e) { return null }
}

function broadcastStatus() {
  _broadcast('sms_status', listInstances())
}

function listInstances() {
  const registry = loadRegistry()
  return Object.keys(registry).map(id => {
    const s = smsSessions[id]
    return {
      id,
      label: registry[id].label || null,
      status: s?.status || 'disconnected',
      qr: s?.qr || null,
      number: s?.number || null,
      errorMsg: s?.errorMsg || null,
    }
  })
}

function scheduleReconnect(id) {
  const session = smsSessions[id]
  if (!session) return
  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1
  const delay = Math.min(session.reconnectAttempts * 10000, 60000)
  console.log(`[SMS ${id}] Reconectando em ${delay / 1000}s`)
  setTimeout(() => {
    const s = smsSessions[id]
    if (s && s.status !== 'connected') {
      initSmsSession(id).catch(e => console.error(`[SMS ${id}] Falha ao reconectar:`, e.message))
    }
  }, delay)
}

async function initSmsSession(id) {
  if (!smsSessions[id]) {
    smsSessions[id] = { browser: null, page: null, status: 'connecting', qr: null, number: null, errorMsg: null, reconnectAttempts: 0 }
  }
  const session = smsSessions[id]
  session.status = 'connecting'
  session.qr = null
  session.errorMsg = null
  broadcastStatus()

  if (session.browser) {
    const old = session.browser
    session.browser = null
    try { await old.close() } catch (e) {}
  }

  const profileDir = path.join(SMS_SESSIONS_DIR, id)

  try {
    ensureSessionsDir()
    clearSingletonLocks(profileDir)

    const chromePath = findChromePath()
    const launchOpts = {
      // 'new' (não `true`) — versões recentes do Chrome instalado no sistema
      // (ex.: via findChromePath, ou PUPPETEER_EXECUTABLE_PATH no Docker de
      // produção) já removeram o Headless antigo; sem isso o launch falha
      // silenciosamente ("Failed to launch the browser process! undefined")
      // contra qualquer Chrome atualizado, só funcionando com o Chromium
      // antigo empacotado junto do Puppeteer.
      headless: 'new',
      userDataDir: profileDir,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--no-first-run', '--no-zygote', '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    }
    if (chromePath) launchOpts.executablePath = chromePath

    const browser = await puppeteer.launch(launchOpts)
    session.browser = browser

    browser.on('disconnected', () => {
      if (session.browser !== browser) return // browser antigo trocado por um relaunch manual — ignora
      session.browser = null
      session.page = null
      if (session.status !== 'disconnected') {
        session.status = 'disconnected'
        broadcastStatus()
        _broadcast('sms_disconnected', { id })
        scheduleReconnect(id)
      }
    })

    const pages = await browser.pages()
    const page = pages[0] || await browser.newPage()
    session.page = page
    await page.goto(AUTH_URL, { waitUntil: 'networkidle2', timeout: 30000 })

    const initTimeout = setTimeout(() => {
      if (session.status === 'connecting' || session.status === 'qr') {
        session.status = 'error'
        session.errorMsg = 'Tempo esgotado aguardando o pareamento (3min). Clique em Reconectar.'
        session.qr = null
        broadcastStatus()
      }
    }, 3 * 60 * 1000 + 15000)

    const initialState = await detectState(page, 12000)
    if (initialState === 'qr') {
      const qr = await captureQRCode(page)
      session.status = 'qr'
      session.qr = qr
      broadcastStatus()
      _broadcast('sms_qr', { id, qr })
    }

    const ok = await waitForLogin(page)
    clearTimeout(initTimeout)
    if (!ok) {
      if (session.status !== 'error') {
        session.status = 'error'
        session.errorMsg = 'Tempo esgotado aguardando o pareamento.'
        broadcastStatus()
      }
      return
    }

    session.status = 'connected'
    session.qr = null
    session.reconnectAttempts = 0
    session.number = await scrapeNumber(page)
    broadcastStatus()
    _broadcast('sms_ready', { id, number: session.number })
    console.log(`[SMS ${id}] Conectado${session.number ? ' — ' + session.number : ''}`)
  } catch (e) {
    session.status = 'error'
    session.errorMsg = e.message
    session.qr = null
    broadcastStatus()
    console.error(`[SMS ${id}] Erro:`, e.message)
  }
}

async function createInstance(id, label) {
  const registry = loadRegistry()
  if (!registry[id]) {
    registry[id] = { label: label || null }
    saveRegistry(registry)
  } else if (label && label !== registry[id].label) {
    registry[id].label = label
    saveRegistry(registry)
  }
  initSmsSession(id).catch(e => console.error(`[SMS ${id}] Falha ao iniciar:`, e.message))
  return { ok: true, id }
}

async function disconnectInstance(id) {
  const session = smsSessions[id]
  if (session?.browser) {
    const b = session.browser
    session.browser = null // evita que o handler 'disconnected' trate isso como queda e reagende reconexão
    try { await b.close() } catch (e) {}
  }
  if (session) {
    session.status = 'disconnected'
    session.qr = null
    session.page = null
  }
  broadcastStatus()
  return { ok: true }
}

async function reconnectInstance(id) {
  const registry = loadRegistry()
  if (!registry[id]) throw new Error('Sessão não encontrada')
  initSmsSession(id).catch(e => console.error(`[SMS ${id}] Falha ao reconectar:`, e.message))
  return { ok: true }
}

async function deleteInstance(id) {
  await disconnectInstance(id)
  delete smsSessions[id]
  const registry = loadRegistry()
  delete registry[id]
  saveRegistry(registry)
  try { fs.rmSync(path.join(SMS_SESSIONS_DIR, id), { recursive: true, force: true }) } catch (e) {}
  return { ok: true }
}

function updateLabel(id, label) {
  const registry = loadRegistry()
  if (!registry[id]) throw new Error('Sessão não encontrada')
  registry[id].label = label || null
  saveRegistry(registry)
  return { ok: true }
}

function resyncInstancesOnBoot() {
  const registry = loadRegistry()
  Object.keys(registry).forEach((id, i) => {
    smsSessions[id] = { browser: null, page: null, status: 'connecting', qr: null, number: null, errorMsg: null, reconnectAttempts: 0 }
    setTimeout(() => {
      initSmsSession(id).catch(e => console.error(`[SMS ${id}] Falha ao restaurar:`, e.message))
    }, 2000 + i * 3000)
  })
}

// Watchdog leve: sessões marcadas "connected" podem ter sido desvinculadas
// pelo celular sem o Puppeteer perceber (não derruba o browser, só troca o
// conteúdo da página) — verifica periodicamente sem navegar (mais barato) e
// só re-navega pra confirmar se o indício de queda persistir. Pula sessões
// ocupadas num disparo em andamento — mesma proteção aplicada no watchdog do
// Wuzapi (ver backend/wuzapi.js) depois de descobrir que forçar reconexão no
// meio de uma campanha ativa é o que fazia o canal "cair" sozinho.
const SMS_WATCHDOG_INTERVAL_MS = 2 * 60 * 1000

async function healthCheckConnectedSessions() {
  const busy = new Set(campaignState.current?.instanceIds || [])
  for (const [id, session] of Object.entries(smsSessions)) {
    if (session.status !== 'connected') continue
    if (busy.has(id)) continue
    if (!session.page || session.page.isClosed()) continue
    try {
      const listEl = await waitForAny(session.page, SELECTORS.conversationsList, 4000)
      if (listEl) continue
      await session.page.goto(AUTH_URL, { waitUntil: 'networkidle2', timeout: 20000 })
      const state = await detectState(session.page, 8000)
      if (state === 'connected') continue
      if (state === 'qr') {
        const qr = await captureQRCode(session.page)
        session.status = 'qr'
        session.qr = qr
        broadcastStatus()
        _broadcast('sms_qr', { id, qr })
      } else {
        session.status = 'disconnected'
        broadcastStatus()
        _broadcast('sms_disconnected', { id })
        scheduleReconnect(id)
      }
    } catch (e) { /* falha pontual da checagem — próxima rodada tenta de novo */ }
  }
}

function startWatchdog() {
  setInterval(() => { healthCheckConnectedSessions().catch(() => {}) }, SMS_WATCHDOG_INTERVAL_MS)
}

// ── Envio ─────────────────────────────────────────────────────────────────────

async function sendSmsText(id, phoneDigits, text) {
  const session = smsSessions[id]
  if (!session || !session.page || session.status !== 'connected') throw new Error('Sessão não conectada')
  const page = session.page

  await page.goto(NEW_CONVERSATION_URL, { waitUntil: 'networkidle2', timeout: 30000 })

  const recipientInput = await waitForAny(page, SELECTORS.recipientInput, 10000)
  if (!recipientInput) throw new Error('Campo de destinatário não encontrado (seletor pode estar desatualizado)')
  await recipientInput.click()
  await recipientInput.type(phoneDigits, { delay: 30 })
  await sleep(1200)
  // Confirma o destinatário: clica na 1ª sugestão se existir, senão Enter.
  try {
    const suggestion = await page.$('[role="option"], .contact-list-item')
    if (suggestion) await suggestion.click()
    else await page.keyboard.press('Enter')
  } catch (e) {}
  await sleep(800)

  const messageBox = await waitForAny(page, SELECTORS.messageInput, 10000)
  if (!messageBox) throw new Error('Campo de mensagem não encontrado (seletor pode estar desatualizado)')
  await messageBox.click()
  await messageBox.type(text, { delay: 8 })

  const sendBtn = await waitForAny(page, SELECTORS.sendButton, 6000)
  if (sendBtn) await sendBtn.click()
  else await page.keyboard.press('Enter')

  await sleep(1000)
  return { ok: true }
}

// ── Respostas recebidas (taxa de interação) ──────────────────────────────────
//
// Google Messages Web não tem webhook nem evento de "mensagem recebida" —
// diferente do Wuzapi (webhook HTTP) e dos Chips (client.on('message', ...)
// do whatsapp-web.js). Sem isso, o único jeito é olhar a própria lista de
// conversas de tempos em tempos (só quando pedido, ver /interaction-rate em
// server.js — não fica escaneando sozinho em loop, pra não competir com o
// disparo pela mesma página/sessão).
//
// Heurística usada: uma conversa aparece marcada como "não lida" na lista
// só quando chega mensagem nova e ninguém (nem essa automação, nem o
// próprio usuário no celular) ainda abriu ela. Como a automação nunca abre
// a conversa de um contato específico pra ler (só navega pra
// NEW_CONVERSATION_URL pra enviar), qualquer "não lida" detectada é sinal
// de resposta de verdade — não precisa de timestamp exato, que a lista não
// expõe de forma confiável.
//
// AVISO: mesma ressalva do resto do módulo — os seletores de
// conversationListItem não foram confirmados contra a página real (sem
// telefone pareado pra testar). Se a taxa de interação nunca mudar mesmo
// com respostas reais chegando, esse é o primeiro lugar pra ajustar.
const responseStats = { responses: [] }

async function scanConversationsForReplies(page) {
  await page.goto('https://messages.google.com/web/conversations', { waitUntil: 'networkidle2', timeout: 20000 })
  await waitForAny(page, SELECTORS.conversationsList, 10000)
  return page.evaluate((itemSelectors) => {
    let items = []
    for (const sel of itemSelectors) {
      items = Array.from(document.querySelectorAll(sel))
      if (items.length) break
    }
    return items.map(el => ({
      text: (el.innerText || '').slice(0, 300),
      unread: el.className.includes('unread') || !!el.querySelector('[class*="unread" i]'),
    }))
  }, SELECTORS.conversationListItem)
}

// Varre as conversas das sessões indicadas em busca de respostas novas —
// chamado sob demanda (botão "Atualizar Métricas" no relatório), não em
// background. Atualiza responseStats.responses com o que achar. Pula
// sessões ocupadas AGORA num disparo em andamento — essa varredura navega
// a mesma página que o envio usa (ver sendSmsText), então rodar as duas
// coisas ao mesmo tempo na mesma sessão arrisca atrapalhar um envio real
// no meio do caminho.
async function refreshInbound(ids) {
  const busy = new Set(campaignState.running ? (campaignState.current?.instanceIds || []) : [])
  for (const id of ids) {
    if (busy.has(id)) continue
    const session = smsSessions[id]
    if (!session || session.status !== 'connected' || !session.page) continue
    try {
      const rows = await scanConversationsForReplies(session.page)
      const now = Date.now()
      for (const row of rows) {
        if (!row.unread) continue
        const m = row.text.match(/\+?\d[\d\s()-]{8,}\d/)
        if (!m) continue
        const phone = m[0].replace(/\D/g, '')
        const existing = responseStats.responses.find(r => r.from === phone)
        if (existing) existing.timestamp = now
        else responseStats.responses.push({ from: phone, timestamp: now })
      }
    } catch (e) {
      console.error(`[SMS ${id}] Falha ao verificar respostas:`, e.message)
    }
  }
  if (responseStats.responses.length > 2000) responseStats.responses.splice(0, responseStats.responses.length - 2000)
}

// ── Campanha ──────────────────────────────────────────────────────────────────

const CAMPAIGN_MAX_CONSECUTIVE_FAILURES = 3
const CAMPAIGN_BATCH_SIZE = 25
const CAMPAIGN_BATCH_PAUSE_MIN = 90
const CAMPAIGN_BATCH_PAUSE_MAX = 240

const campaignState = {
  running: false,
  paused: false,
  stopped: false,
  sentNumbers: new Set(),
  results: [],
  current: null,
  startedAt: null,
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
  } catch (e) { console.error('[SMS] Erro ao salvar histórico:', e.message) }
}

function deleteHistoryRecord(id) {
  const list = loadHistory().filter(c => c.id !== id)
  ensureDataDir()
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2))
}

async function runCampaign(data) {
  const { name, text, instanceIds, contacts, delayMin = 5, delayMax = 15, batchDelay, spinWithAI, firstNameOnly } = data

  try {
    // Confere de verdade (estado em memória, sem round-trip de rede) se cada
    // sessão selecionada está mesmo conectada ANTES de gastar tentativas de
    // envio nela — mesma lição aplicada no Wuzapi: sem isso, uma sessão já
    // caída só era descoberta depois de 3 falhas seguidas, e a mensagem do
    // circuit breaker ("provavelmente caiu") escondia a causa real.
    const offline = instanceIds.filter(id => smsSessions[id]?.status !== 'connected')
    if (offline.length) {
      throw new Error(`Essas sessões não estão conectadas: ${offline.join(', ')}. Reconecte antes de iniciar o disparo.`)
    }

    const bd = batchDelay?.enabled && batchDelay.everyMin > 0 && batchDelay.pauseMin > 0 ? batchDelay : null
    const batchSize = bd ? randDelaySec(bd.everyMin, bd.everyMax) : CAMPAIGN_BATCH_SIZE
    const batchPauseMin = bd ? bd.pauseMin : CAMPAIGN_BATCH_PAUSE_MIN
    const batchPauseMax = bd ? Math.max(bd.pauseMax, bd.pauseMin) : CAMPAIGN_BATCH_PAUSE_MAX

    campaignState.results = []
    campaignState.paused = false
    campaignState.stopped = false
    campaignState.running = true
    campaignState.current = data
    const startedAt = Date.now()
    campaignState.startedAt = startedAt
    let success = 0, failed = 0
    let consecutiveFailures = 0
    let batchCount = 0
    let rrIndex = 0

    _broadcast('sms_campaign', { type: 'started', instances: instanceIds, total: contacts.length })

    // Aquecimento: o primeiro envio também espera um delay aleatório em vez
    // de sair na hora que o usuário clica "Iniciar" (mesma correção aplicada
    // no Wuzapi — abrir a campanha com um envio instantâneo é o padrão mais
    // fácil de ser flagrado como automação).
    const warmup = randDelaySec(delayMin, delayMax)
    _broadcast('sms_campaign', { type: 'waiting', delay: warmup, next: 1 })
    await sleep(warmup * 1000)

    for (let i = 0; i < contacts.length; i++) {
      if (campaignState.stopped) break
      while (campaignState.paused) await sleep(500)

      const contact = contacts[i]
      const phone = normalizeBrazilPhone(String(contact.number || '').replace(/\D/g, ''))

      if (campaignState.sentNumbers.has(phone)) {
        _broadcast('sms_campaign', { type: 'skipped', number: phone, current: i + 1, total: contacts.length })
        continue
      }

      const result = { index: i, number: phone, name: contact.name || phone, status: 'sending' }
      campaignState.results.push(result)
      _broadcast('sms_campaign', { type: 'progress', contact: result, success, failed, total: contacts.length, current: i + 1 })

      try {
        const instanceId = instanceIds[rrIndex % instanceIds.length]
        rrIndex++
        const template = spinWithAI ? await spinOpeningWithAI(text) : text
        const resolved = applyVars(template, { ...contact, number: phone }, firstNameOnly)
        await sendSmsText(instanceId, phone, resolved)
        result.status = 'success'
        result.via = instanceId
        result.sentAt = Date.now()
        success++
        batchCount++
        consecutiveFailures = 0
        campaignState.sentNumbers.add(phone)
        _broadcast('sms_campaign', { type: 'result', contact: result, success, failed })
      } catch (e) {
        result.status = 'failed'
        result.error = e.message || 'Erro desconhecido'
        failed++
        consecutiveFailures++
        _broadcast('sms_campaign', { type: 'result', contact: result, success, failed })

        if (consecutiveFailures >= CAMPAIGN_MAX_CONSECUTIVE_FAILURES) {
          campaignState.stopped = true
          _broadcast('sms_campaign', {
            type: 'circuit_break',
            reason: `⚠️ ${consecutiveFailures} envios seguidos falharam (último erro: "${result.error}") — pode ser a sessão que caiu ou algo errado nos dados enviados (ex.: número inválido). Campanha parada automaticamente antes de mandar o resto da lista pro vazio.`,
          })
          break
        }
      }

      if (i < contacts.length - 1 && !campaignState.stopped) {
        if (batchCount >= batchSize) {
          const pause = Math.floor(Math.random() * (batchPauseMax - batchPauseMin + 1)) + batchPauseMin
          _broadcast('sms_campaign', { type: 'batch_pause', seconds: pause, batchCount })
          await sleep(pause * 1000)
          batchCount = 0
        }
        const delay = randDelaySec(delayMin, delayMax)
        _broadcast('sms_campaign', { type: 'waiting', delay, next: i + 2 })
        await sleep(delay * 1000)
      }
    }

    _broadcast('sms_campaign', { type: 'done', success, failed, total: contacts.length, results: campaignState.results })

    saveHistoryRecord({
      id: startedAt.toString(),
      name: name || 'Campanha SMS',
      text,
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
    campaignState.startedAt = null
  } catch (e) {
    // Falhou antes/durante o setup (sessão offline, etc.) — sem isso o erro
    // só aparecia no console: a rota de start já respondeu "ok" pro
    // navegador antes de chamar essa função (ver /api/sms-campaign/start em
    // server.js), então sem um broadcast aqui o usuário via a campanha
    // "sumir" sem explicação.
    _broadcast('sms_campaign', {
      type: 'circuit_break',
      reason: `⚠️ Não foi possível iniciar o disparo: ${e.message}`,
    })
    campaignState.running = false
    campaignState.current = null
    campaignState.startedAt = null
  }
}

module.exports = {
  init,
  listInstances,
  createInstance,
  disconnectInstance,
  reconnectInstance,
  deleteInstance,
  updateLabel,
  runCampaign,
  campaignState,
  loadHistory,
  deleteHistoryRecord,
  responseStats,
  refreshInbound,
}
