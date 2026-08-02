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

// Abre a conversa do contato (via deep link) e clica no botão real de
// ligação de voz/vídeo do cabeçalho — o mesmo botão que um humano clicaria,
// que toca de verdade no aparelho do contato (sem link, sem mensagem).
async function openChatAndCall(page, phone, callType) {
  const digits = String(phone).replace(/\D/g, '')
  const url = `https://web.whatsapp.com/send?phone=${digits}`

  async function waitLoad() {
    for (let i = 0; i < 15; i++) {
      const loaded = await page.evaluate(() =>
        !document.body.innerText.includes('Suas mensagens estão sendo baixadas')).catch(() => true)
      if (loaded) break
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
  await waitLoad()
  await dismissNoveltiesModal(page)
  await new Promise(r => setTimeout(r, 1500))

  // Numa sessão recém-clonada o popup de "Novidades" costuma aparecer nesse
  // primeiro carregamento e engole a abertura automática da conversa do
  // ?phone= — se não abriu (sem #main na tela), navega pro mesmo link de
  // novo agora que o popup já não atrapalha mais.
  let hasMain = await page.evaluate(() => !!document.querySelector('#main')).catch(() => false)
  if (!hasMain) {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
    await waitLoad()
    await new Promise(r => setTimeout(r, 1500))
    hasMain = await page.evaluate(() => !!document.querySelector('#main')).catch(() => false)
  }

  if (!hasMain) {
    const notOnWhatsapp = await page.evaluate(() =>
      document.body.innerText.includes('não está no WhatsApp') ||
      document.body.innerText.includes('is not on WhatsApp')).catch(() => false)
    if (notOnWhatsapp) throw new Error('Esse número não tem WhatsApp')
    throw new Error('Não consegui abrir a conversa desse contato no WhatsApp Web')
  }

  const labels = callType === 'video'
    ? ['Ligação de vídeo', 'Video call']
    : ['Ligação de voz', 'Voice call']

  for (let i = 0; i < 10; i++) {
    const box = await findBoxByAriaLabel(page, labels)
    if (box) { await realClickByBox(page, box); return true }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
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

  // phone: número/chatId do contato (ex: "5535999998888" ou "5535999998888@c.us")
  async start(phone, { onVideoFrame, onAudioChunk, onStatus } = {}) {
    onStatus?.('preparando')
    ensurePulseAudio()
    this.clonedProfile = cloneSession(this.chipId)

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
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=960,720',
      ],
    })

    const context = this.browser.defaultBrowserContext()
    await context.overridePermissions('https://web.whatsapp.com', ['camera', 'microphone'])

    onStatus?.('autenticando_ligando')
    this.callPage = await this.browser.newPage()
    const called = await openChatAndCall(this.callPage, phone, this.callType)
    if (!called) throw new Error('Não encontrei o botão de ligação no cabeçalho da conversa')

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
