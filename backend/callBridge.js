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

// Abre a conversa navegando DIRETO pro deep link `send?phone=<numero>` — o
// próprio WhatsApp resolve o número no servidor dele, então não existe
// ambiguidade de nome possível (diferente de buscar na lista, onde dois
// contatos com o mesmo nome salvo, ex: ".", já causaram ligação pro número
// errado). Só funciona com número de telefone de verdade: contatos
// identificados por LID (ou grupos) não têm número pesquisável por essa via.
async function openChatViaPhoneLink(page, digits, onStatus) {
  async function safeGoto() {
    try {
      await page.goto(`https://web.whatsapp.com/send?phone=${digits}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.error('[CallBridge] page.goto falhou:', e.message)
    }
  }

  onStatus?.('sincronizando')
  await safeGoto()

  async function waitForOutcome(maxSeconds) {
    for (let i = 0; i < maxSeconds; i++) {
      await dismissNoveltiesModal(page).catch(() => {})
      const hasMain = await page.evaluate(() => !!document.querySelector('#main')).catch(() => false)
      if (hasMain) return 'ready'
      const invalid = await page.evaluate(() => {
        const body = document.body.innerText || ''
        return body.includes('não tem WhatsApp') || body.includes('Telefone incorreto') || body.includes('inválido')
      }).catch(() => false)
      if (invalid) return 'invalid'
      await new Promise(r => setTimeout(r, 500))
    }
    return 'timeout'
  }

  let outcome = await waitForOutcome(25)
  if (outcome === 'timeout') {
    // Frame principal pode nunca ter anexado (sobrecarga de CPU) — recria a
    // page e tenta de novo, agora com mais margem. Retorna a nova page pro
    // chamador poder atualizar sua referência.
    return { outcome: 'retry' }
  }
  if (outcome === 'invalid') throw new Error('Esse contato não tem um número de telefone válido no WhatsApp')
  return { outcome: 'ready' }
}

// Abre a conversa do contato (pelo número, via deep link) e clica no botão
// real de ligação de voz/vídeo do cabeçalho — o mesmo botão que um humano
// clicaria, que toca de verdade no aparelho do contato (sem link, sem
// mensagem). Recebe o browser (não uma page fixa): sob CPU sob pressão o
// Puppeteer às vezes nunca anexa o frame principal de uma page recém-criada
// ("Requesting main frame too early!" em loop) — nesse caso reusar a mesma
// page tende a repetir o problema, então a segunda tentativa recria a page
// do zero.
async function openChatAndCall(browser, contactName, callType, onStatus) {
  const digits = contactName.trim().replace(/^\+/, '')
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error('Esse contato não tem um número de telefone válido para ligação')
  }

  let page = await browser.newPage()
  await new Promise(r => setTimeout(r, 500)) // folga pro frame principal anexar

  let result = await openChatViaPhoneLink(page, digits, onStatus)
  if (result.outcome === 'retry') {
    try { await page.close() } catch (_) {}
    page = await browser.newPage()
    await new Promise(r => setTimeout(r, 500))
    result = await openChatViaPhoneLink(page, digits, onStatus)
  }
  if (result.outcome !== 'ready') {
    await dumpDiagnostics(page, 'app-not-ready')
    throw new Error('O WhatsApp Web não terminou de carregar')
  }

  onStatus?.('procurando_contato')

  const labels = callType === 'video'
    ? ['Ligação de vídeo', 'Video call']
    : ['Ligação de voz', 'Voice call']

  for (let i = 0; i < 10; i++) {
    const box = await findBoxByAriaLabel(page, labels)
    if (box) {
      // Captura erros de console/página e requisições de rede que falharem
      // a partir do clique — o clique sozinho não garante que o sinal de
      // chamada de fato saiu (a tela mostra "Ligando..." mesmo quando a
      // negociação falha silenciosamente por baixo), então isso é o que
      // permite ver O QUE quebrou sem precisar reproduzir outra ligação real.
      const netErrors = []
      const consoleErrors = []
      const onConsole = (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)) }
      const onPageError = (err) => consoleErrors.push('pageerror: ' + err.message)
      const onReqFailed = (req) => netErrors.push(`${req.url()} — ${req.failure()?.errorText}`)
      const onResponse = (resp) => { if (resp.status() >= 400) netErrors.push(`${resp.status()} ${resp.url()}`) }
      page.on('console', onConsole)
      page.on('pageerror', onPageError)
      page.on('requestfailed', onReqFailed)
      page.on('response', onResponse)

      await realClickByBox(page, box)
      await new Promise(r => setTimeout(r, 4000))

      page.off('console', onConsole)
      page.off('pageerror', onPageError)
      page.off('requestfailed', onReqFailed)
      page.off('response', onResponse)

      // Dump incondicional (não só em falha): precisamos ver o que a tela do
      // WhatsApp mostra logo após o clique pra saber se a ligação de verdade
      // começou, já que o clique em si não garante isso.
      await dumpDiagnostics(page, 'after-call-click')
      try {
        fs.writeFileSync(
          '/tmp/callbridge_fail_after-call-click-net.txt',
          `Console/página (erros):\n${consoleErrors.join('\n') || '(nenhum)'}\n\n` +
          `Rede (falhas/erros HTTP):\n${netErrors.slice(0, 50).join('\n') || '(nenhum)'}`
        )
      } catch (_) {}
      return { called: true, page }
    }
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

  // target.contactName: aqui é sempre o NÚMERO de telefone do contato
  // (formato "+55..."), montado pelo frontend — usado pra abrir a conversa
  // via deep link `send?phone=`, resolvido pelo próprio WhatsApp sem
  // ambiguidade de nome. Contatos identificados por LID ou grupos não têm
  // número de telefone de verdade, então não são suportados pra ligação.
  async start({ contactName }, { onVideoFrame, onAudioChunk, onStatus } = {}) {
    onStatus?.('preparando')
    ensurePulseAudio()
    this.clonedProfile = cloneSession(this.chipId)

    // Mesmas flags do Chrome do chip2 (server.js/initChip), que roda estável
    // há dias — a ponte de chamada usava um subconjunto menor e sofria com
    // "Requesting main frame too early!" toda vez, o que sugere que alguma
    // dessas flags (provavelmente --no-zygote) é o que faltava.
    // headless: true usa o modo headless ANTIGO do Chrome, que adiciona a
    // flag --mute-audio automaticamente (silencia toda saída de áudio, então
    // o call_out nunca recebia nada pro parec capturar). O modo "new" não
    // faz isso e realmente envia o áudio pro dispositivo PulseAudio.
    const chromePath = findChromePath()
    this.browser = await puppeteer.launch({
      headless: 'new',
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
    await new Promise(r => setTimeout(r, 3500))

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
