'use strict'
// Ponte de chamada de voz/vídeo: abre uma sessão autenticada (clonada da sessão
// real do chip, isolada, sem tocar no Chrome ao vivo que cuida das mensagens),
// entra na call.whatsapp.com de verdade dentro dela, e expõe vídeo (via CDP
// screencast) e áudio (via dispositivos virtuais do PulseAudio) pra quem estiver
// usando o CRM — sem depender de app nativo nem de embutir a página da Meta.
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

async function clickJoinButton(page) {
  for (let i = 0; i < 10; i++) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const btn = btns.find(b =>
        /^(join call|entrar na liga)/i.test((b.textContent || '').trim()) && b.offsetParent !== null)
      if (btn) { btn.click(); return true }
      return false
    }).catch(() => false)
    if (clicked) return true
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

  async start(link, { onVideoFrame, onAudioChunk, onStatus } = {}) {
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
    await context.overridePermissions(link, ['camera', 'microphone'])

    onStatus?.('autenticando')
    const warmupPage = await this.browser.newPage()
    await warmupPage.goto('https://web.whatsapp.com', { waitUntil: 'networkidle2', timeout: 45000 })
    for (let i = 0; i < 15; i++) {
      const loaded = await warmupPage.evaluate(() =>
        !document.body.innerText.includes('Suas mensagens estão sendo baixadas')).catch(() => true)
      if (loaded) break
      await new Promise(r => setTimeout(r, 2000))
    }

    onStatus?.('entrando_na_chamada')
    this.callPage = await this.browser.newPage()
    await this.callPage.goto(link, { waitUntil: 'networkidle2', timeout: 30000 })
    const joined = await clickJoinButton(this.callPage)
    if (!joined) throw new Error('Não encontrei o botão de entrar na chamada')

    // espera terminar de navegar pro app principal e a call conectar
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
