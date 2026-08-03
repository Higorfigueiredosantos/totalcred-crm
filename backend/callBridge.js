'use strict'
// Ponte de chamada de voz/vídeo: abre uma sessão autenticada (clonada da sessão
// real do chip, isolada, sem tocar no Chrome ao vivo que cuida das mensagens),
// abre a conversa do contato e clica no botão real de ligação do WhatsApp Web
// (toca de verdade no aparelho dele, sem link e sem mensagem), e expõe vídeo
// (via CDP screencast) e áudio (via dispositivos virtuais do PulseAudio) pra
// quem estiver usando o CRM — sem depender de app nativo nem de embutir a
// página da Meta.
const path = require('path')
const fs = require('fs')
const { execSync, spawn } = require('child_process')
const puppeteer = require('puppeteer')

const WWA_SESSIONS_DIR = path.join(__dirname, '.wwa_sessions')
const PULSE_SOCKET = '/tmp/pulse.sock'
const PULSE_SCRIPT = path.join(__dirname, 'pulse-call.pa')
const AUDIO_RATE = 16000

function findChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const c of candidates) { if (fs.existsSync(c)) return c }
  return null
}

let pulseReady = false
function ensurePulseAudio() {
  if (pulseReady) return
  try {
    execSync(`pactl --server=unix:${PULSE_SOCKET} info`, { stdio: 'ignore' })
    pulseReady = true
    return
  } catch (_) { /* ainda não está rodando, sobe abaixo */ }

  execSync(
    `pulseaudio -n -F ${PULSE_SCRIPT} --daemonize=yes --system=false ` +
    `--disallow-exit=yes --exit-idle-time=-1 --log-target=stderr`,
    { stdio: 'inherit' }
  )
  // espera o socket aparecer
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(PULSE_SOCKET)) break
    execSync('sleep 0.3')
  }
  pulseReady = true
}

function cloneSession(chipId) {
  const src = path.join(WWA_SESSIONS_DIR, `session-${chipId}`)
  if (!fs.existsSync(src)) throw new Error(`Sessão do chip ${chipId} não encontrada`)
  const dest = path.join('/tmp', `callbridge-${chipId}-${Date.now()}`)
  execSync(`cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`)
  execSync(`find ${JSON.stringify(dest)} -name "Singleton*" -delete 2>/dev/null || true`)
  return dest
}

// Cliques sintéticos (elemento.click() via page.evaluate) não disparam os
// handlers de pointer event que o React do WhatsApp Web escuta em alguns
// componentes — usa um clique de mouse real nas coordenadas do elemento.
async function realClickByBox(page, box) {
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

async function findBoxByText(page, texts) {
  return page.evaluate((texts) => {
    const els = Array.from(document.querySelectorAll('button, div[role="button"], span'))
    const el = els.find(e => texts.includes((e.textContent || '').trim()))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, texts)
}

async function findBoxByAriaLabel(page, labels) {
  return page.evaluate((labels) => {
    const main = document.querySelector('#main') || document.querySelector('[data-testid="conversation-panel-wrapper"]')
    const header = main ? main.querySelector('header') : null
    if (!header) return null
    const els = Array.from(header.querySelectorAll('[aria-label]'))
    const el = els.find(e => labels.includes(e.getAttribute('aria-label')))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, labels)
}

// Fecha o popup de "Novidades do WhatsApp Web" que aparece no primeiro carregamento
async function dismissNoveltiesModal(page) {
  const box = await findBoxByText(page, ['Continuar', 'Continue', 'OK', 'Got it'])
  if (box) await realClickByBox(page, box)
}

// Abre a página principal do WhatsApp Web (sem depender de link/telefone) e
// espera ela carregar de verdade, tentando fechar o popup de "Novidades" a
// cada volta (aparece toda vez numa sessão recém-clonada e engole outras
// interações se não for fechado). Retorna 'ready' ou 'timeout'.
// Caixa de pesquisa do WhatsApp Web: um <input> de verdade (não
// contenteditable, como em versões antigas), identificado com mais
// confiança pelo aria-label (funciona em pt-BR e en) do que por classes.
const SEARCH_INPUT_SELECTOR = 'input[data-tab="3"], input[aria-label*="Pesquisar"], input[aria-label*="Search"]'

async function waitForAppReady(page, maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    await dismissNoveltiesModal(page).catch(() => {})
    const ready = await page.evaluate((sel) => !!document.querySelector(sel), SEARCH_INPUT_SELECTOR)
      .catch(e => { console.error('[CallBridge] waitForAppReady evaluate falhou:', e.message); return false })
    if (ready) return 'ready'
    await new Promise(r => setTimeout(r, 1000))
  }
  return 'timeout'
}

// Busca o contato pelo NOME salvo no CRM (não pelo telefone): muitos contatos
// nessa conta são identificados internamente por LID, não por um número de
// telefone de verdade, então o deep link `send?phone=` retorna "esse número
// não tem WhatsApp" mesmo para contatos com quem já se conversa normalmente.
// Buscar pelo nome, do mesmo jeito que um humano faria na caixa de pesquisa,
// funciona independente de LID ou telefone.
async function searchAndOpenChat(page, contactName) {
  // Clicar por coordenada costuma focar um <div> de sobreposição em vez do
  // <input> de verdade (o WhatsApp Web desenha uma camada por cima) — focar
  // direto via .focus() no elemento é o que realmente funciona.
  const focused = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    el.focus()
    return document.activeElement === el
  }, SEARCH_INPUT_SELECTOR).catch(() => false)
  if (!focused) throw new Error('Não encontrei a caixa de pesquisa do WhatsApp Web')

  await page.keyboard.type(contactName, { delay: 40 })
  await new Promise(r => setTimeout(r, 1500))

  const resultBox = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="cell-frame-container"], div[role="listitem"], div[role="gridcell"]')
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }).catch(() => null)
  if (!resultBox) throw new Error(`Não encontrei "${contactName}" na busca do WhatsApp Web`)

  await realClickByBox(page, resultBox)

  for (let i = 0; i < 15; i++) {
    const hasMain = await page.evaluate(() => !!document.querySelector('#main')).catch(() => false)
    if (hasMain) return
    await new Promise(r => setTimeout(r, 1000))
  }
  await dumpDiagnostics(page, 'no-main-after-search')
  throw new Error('Não consegui abrir a conversa desse contato no WhatsApp Web')
}

// Abre a conversa do contato (buscando pelo nome) e clica no botão real de
// ligação de voz/vídeo do cabeçalho — o mesmo botão que um humano clicaria,
// que toca de verdade no aparelho do contato (sem link, sem mensagem).
// Recebe o browser (não uma page fixa): sob CPU sob pressão o Puppeteer às
// vezes nunca anexa o frame principal de uma page recém-criada ("Requesting
// main frame too early!" em loop) — nesse caso reusar a mesma page tende a
// repetir o problema, então a segunda tentativa recria a page do zero.
async function openChatAndCall(browser, contactName, callType, onStatus) {
  let page = await browser.newPage()
  await new Promise(r => setTimeout(r, 500)) // folga pro frame principal anexar

  async function safeGoto() {
    try {
      await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.error('[CallBridge] page.goto falhou:', e.message)
    }
  }

  onStatus?.('sincronizando')
  await safeGoto()
  let outcome = await waitForAppReady(page, 25)
  if (outcome === 'timeout') {
    // Frame principal nunca anexou (sobrecarga de CPU) — recria a page e
    // tenta de novo, agora com mais margem.
    try { await page.close() } catch (_) {}
    page = await browser.newPage()
    await new Promise(r => setTimeout(r, 500))
    await safeGoto()
    outcome = await waitForAppReady(page, 70)
  }
  if (outcome !== 'ready') {
    await dumpDiagnostics(page, 'app-not-ready')
    throw new Error('O WhatsApp Web não terminou de carregar')
  }

  // O popup de "Novidades" às vezes só aparece um pouco DEPOIS da caixa de
  // pesquisa já existir no DOM — a checagem de waitForAppReady já passava
  // antes dele nem ter surgido, então nunca era fechado a tempo e acabava
  // engolindo o clique no resultado da busca (o clique caía no popup por
  // cima, não na conversa por baixo). Dedica alguns segundos só pra isso.
  for (let i = 0; i < 5; i++) {
    await dismissNoveltiesModal(page).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
  }

  onStatus?.('procurando_contato')
  await searchAndOpenChat(page, contactName)

  const labels = callType === 'video'
    ? ['Ligação de vídeo', 'Video call']
    : ['Ligação de voz', 'Voice call']

  for (let i = 0; i < 10; i++) {
    const box = await findBoxByAriaLabel(page, labels)
    if (box) { await realClickByBox(page, box); return { called: true, page } }
    await new Promise(r => setTimeout(r, 1000))
  }
  await dumpDiagnostics(page, 'no-call-button')
  return { called: false, page }
}

// Salva screenshot + texto da página em /tmp pra diagnosticar falhas reais
// sem precisar reproduzir o cenário depois.
async function dumpDiagnostics(page, tag) {
  try {
    await page.screenshot({ path: `/tmp/callbridge_fail_${tag}.png` })
    const text = await page.evaluate(() => document.body.innerText.slice(0, 2000))
    fs.writeFileSync(`/tmp/callbridge_fail_${tag}.txt`, `URL: ${page.url()}\n\n${text}`)
  } catch (_) { /* melhor esforço, não deve derrubar o fluxo principal */ }
}

class CallBridge {
  constructor(chipId, callType) {
    this.chipId = chipId
    this.callType = callType
    this.browser = null
    this.callPage = null
    this.cdp = null
    this.clonedProfile = null
    this.parec = null
    this.paplay = null
    this.stopped = false
  }

  // target.contactName: nome salvo no CRM — usado pra buscar o contato no
  // WhatsApp Web (não dá pra confiar no telefone: muitos contatos nessa
  // conta são identificados por LID interno, não por número de telefone).
  async start({ contactName }, { onVideoFrame, onAudioChunk, onStatus } = {}) {
    onStatus?.('preparando')
    ensurePulseAudio()
    this.clonedProfile = cloneSession(this.chipId)

    // Mesmas flags do Chrome do chip2 (server.js/initChip), que roda estável
    // há dias — a ponte de chamada usava um subconjunto menor e sofria com
    // "Requesting main frame too early!" toda vez, o que sugere que alguma
    // dessas flags (provavelmente --no-zygote) é o que faltava.
    const chromePath = findChromePath()
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath || undefined,
      userDataDir: this.clonedProfile,
      env: { ...process.env, PULSE_SERVER: `unix:${PULSE_SOCKET}` },
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
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=960,720',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    })

    const context = this.browser.defaultBrowserContext()
    await context.overridePermissions('https://web.whatsapp.com', ['camera', 'microphone'])

    const { called, page } = await openChatAndCall(this.browser, contactName, this.callType, onStatus)
    this.callPage = page
    if (!called) throw new Error('Não encontrei o botão de ligação no cabeçalho da conversa')
    onStatus?.('autenticando_ligando')

    // espera a discagem conectar
    await new Promise(r => setTimeout(r, 6000))

    this.cdp = await this.callPage.target().createCDPSession()
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 1 })
    this.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      onVideoFrame?.(Buffer.from(data, 'base64'))
      try { await this.cdp.send('Page.screencastFrameAck', { sessionId }) } catch (_) {}
    })

    this.parec = spawn('parec', [
      `--server=unix:${PULSE_SOCKET}`,
      '--device=call_out.monitor',
      '--format=s16le', `--rate=${AUDIO_RATE}`, '--channels=1', '--raw',
    ])
    this.parec.stdout.on('data', chunk => onAudioChunk?.(chunk))
    this.parec.on('error', () => {})

    this.paplay = spawn('paplay', [
      `--server=unix:${PULSE_SOCKET}`,
      '--device=call_in',
      '--format=s16le', `--rate=${AUDIO_RATE}`, '--channels=1', '--raw',
    ])
    this.paplay.on('error', () => {})

    onStatus?.('conectado')
  }

  writeMic(buffer) {
    if (this.paplay && !this.paplay.stdin.destroyed) this.paplay.stdin.write(buffer)
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    try { this.parec?.kill() } catch (_) {}
    try { this.paplay?.stdin.end() } catch (_) {}
    try { this.paplay?.kill() } catch (_) {}
    try { await this.browser?.close() } catch (_) {}
    try { if (this.clonedProfile) fs.rmSync(this.clonedProfile, { recursive: true, force: true }) } catch (_) {}
  }
}

module.exports = { CallBridge }
