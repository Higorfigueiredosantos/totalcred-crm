'use strict'
// Helpers de template/variável, delay e randomização de abertura via IA,
// compartilhados por todo motor de campanha que resolve {{name}}/{{coluna}}
// em cima de um contato (Wuzapi e SMS hoje — os Chips em server.js têm sua
// própria cópia intocada, mais antiga e já testada em produção, não vale o
// risco de mexer nela só por consistência).
const axios = require('axios')

function firstNameOf(name) {
  const trimmed = String(name || '').trim()
  return trimmed ? trimmed.split(/\s+/)[0] : ''
}

function applyVars(text, contact, firstNameOnly) {
  if (typeof text !== 'string') return text
  const rawName = contact?.name || ''
  const name = firstNameOnly ? firstNameOf(rawName) : rawName
  const vars = contact?.vars || {}
  let msg = text
  if (name) msg = msg.replace(/\{\{name\}\}/gi, name).replace(/\{name\}/gi, name)
  for (const [k, v] of Object.entries(vars)) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    msg = msg.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'gi'), String(v ?? ''))
  }
  return msg
}

function resolvePayload(payload, contact, firstNameOnly) {
  if (typeof payload === 'string') return applyVars(payload, contact, firstNameOnly)
  if (Array.isArray(payload)) return payload.map(v => resolvePayload(v, contact, firstNameOnly))
  if (payload && typeof payload === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(payload)) out[k] = resolvePayload(v, contact, firstNameOnly)
    return out
  }
  return payload
}

// Número sem DDI e com até 11 dígitos (DDD + 8/9 dígitos — tamanho de um
// número brasileiro sem "55") ganha o "55" na frente. Mesma regra usada há
// mais tempo pro envio via Chips (formatNumber em server.js) — sem isso um
// número só com DDD ia incompleto pro provedor, o envio falhava, e falhas
// seguidas disparavam o circuit breaker com uma mensagem enganosa de
// "instância caiu" quando o problema real era o número mal formatado.
function normalizeBrazilPhone(digits) {
  const n = String(digits || '')
  if (n && !n.startsWith('55') && n.length <= 11) return '55' + n
  return n
}

const randDelaySec = (min, max) => Math.floor(Math.random() * (Math.max(max, min) - min + 1)) + min

// Config do LLM usado pra variar mensagens. O modelo antigo do Groq
// ("llama3-8b-8192") foi descontinuado — com ele toda chamada falhava e o
// spin devolvia silenciosamente o texto original (ou seja, "randomizar com
// IA" mandava a mesma mensagem pra todo mundo). AI_SPIN_MODEL permite trocar
// o modelo sem mexer no código.
function getLLMConfig() {
  const groq = process.env.GROQ_API_KEY
  const apiKey = groq || process.env.OPENAI_API_KEY
  if (!apiKey) return null
  return {
    apiKey,
    isGroq: !!groq,
    baseURL: groq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1',
    model: process.env.AI_SPIN_MODEL || (groq ? null : 'gpt-4o-mini'),
  }
}

// O catálogo do Groq muda (modelos são descontinuados e nem toda chave tem
// acesso a todos) — em vez de cravar um nome, pergunta pro /models quais a
// chave enxerga e pega o primeiro da lista de preferência. Cacheado; é
// refeito se o modelo escolhido sumir.
const GROQ_PREFERRED = [
  'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b', 'qwen/qwen3-32b', 'llama-3.1-8b-instant',
]
const NON_CHAT_RE = /whisper|guard|orpheus|tts|allam|embed/i
let _groqModelCache = null

async function resolveModel(cfg) {
  if (cfg.model) return cfg.model
  if (_groqModelCache) return _groqModelCache
  const { data } = await axios.get(`${cfg.baseURL}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, timeout: 15000 })
  const ids = (data?.data || []).map(m => m.id)
  _groqModelCache = GROQ_PREFERRED.find(id => ids.includes(id)) || ids.find(id => !NON_CHAT_RE.test(id))
  if (!_groqModelCache) throw new Error('Nenhum modelo de chat disponível pra essa GROQ_API_KEY')
  console.log(`[IA] Modelo Groq usado pra variar mensagens: ${_groqModelCache}`)
  return _groqModelCache
}

async function callLLM(messages, { temperature = 0.9, maxTokens = 600 } = {}) {
  const cfg = getLLMConfig()
  if (!cfg) throw new Error('Nenhuma GROQ_API_KEY/OPENAI_API_KEY configurada')
  const model = await resolveModel(cfg)
  // Modelos de raciocínio (gpt-oss/qwen3) gastam tokens "pensando" antes da
  // resposta — esforço baixo + teto maior pra não cortar a mensagem final.
  const reasoning = /gpt-oss|qwen3/i.test(model)
  const body = { model, max_tokens: reasoning ? maxTokens + 1500 : maxTokens, temperature, messages }
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low'
  if (cfg.isGroq && /qwen3/i.test(model)) body.reasoning_format = 'hidden'
  try {
    const resp = await axios.post(`${cfg.baseURL}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000,
    })
    return resp.data?.choices?.[0]?.message?.content?.trim() || ''
  } catch (e) {
    const msg = e?.response?.data?.error?.message || ''
    if (/does not exist|decommissioned|not have access|model_not_found/i.test(msg)) _groqModelCache = null
    throw e
  }
}

// Randomiza só a abertura do template (via Groq/OpenAI) pra reduzir a
// assinatura de "mensagem idêntica em massa" sem arriscar mudar o conteúdo
// principal. Roda ANTES de resolvePayload/applyVars, em cima do template com
// os {{placeholders}} ainda intactos — a IA nunca vê o valor real das
// variáveis, só o nome delas, então não tem como confundir/trocar valores.
async function spinOpeningWithAI(template) {
  if (typeof template !== 'string' || !template.trim()) return template
  if (!getLLMConfig()) return template
  try {
    const out = await callLLM([
      {
        role: 'system',
        content: 'Você varia levemente mensagens para reduzir a chance de detecção como disparo em massa. '
          + 'Regras obrigatórias: (1) troque só as primeiras palavras — cumprimento/abertura — por um sinônimo natural; '
          + '(2) NUNCA altere o restante do texto, nem qualquer trecho entre chaves duplas como {{name}} ou {{coluna}} — copie esses marcadores exatamente iguais; '
          + '(3) mantenha o mesmo idioma, tom, sentido e tamanho aproximado da mensagem original; '
          + '(4) não adicione nem remova informação, links ou instruções; '
          + '(5) responda somente com a mensagem final, sem comentários nem aspas.',
      },
      { role: 'user', content: template },
    ], { maxTokens: 400 })
    const cleaned = cleanLLMOutput(out)
    return cleaned && validateVariant(template, cleaned).ok ? cleaned : template
  } catch (e) {
    return template
  }
}

// ─── Variação completa da mensagem (Wuzapi) ───────────────────────────────
// Diferente do spinOpeningWithAI (que só troca o cumprimento), aqui a IA
// reescreve a mensagem inteira a cada envio — mesmo contexto/oferta, outras
// palavras. A garantia de que as variáveis continuam intactas NÃO depende da
// IA obedecer o prompt: toda versão gerada passa por validateVariant, que
// confere se os mesmos {{marcadores}} (mesma quantidade de cada), os mesmos
// números/valores e os mesmos links do original estão lá. Versão que não
// passa é descartada e pede outra; se nenhuma passar, envia o original.

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi
const NUMBER_RE = /\d+(?:[.,]\d+)*/g

const normKey = s => String(s).trim().toLowerCase()

function placeholdersOf(text) {
  const out = []
  String(text).replace(PLACEHOLDER_RE, (_m, k) => { out.push(normKey(k)); return _m })
  return out.sort()
}

// Normaliza "{{ Name }}" → "{{name}}" usando a grafia exata do original, pra
// applyVars (que procura "{{chave}}" sem espaços) sempre achar o marcador.
function canonicalizePlaceholders(original, text) {
  const canon = new Map()
  String(original).replace(PLACEHOLDER_RE, (_m, k) => { canon.set(normKey(k), k.trim()); return _m })
  return String(text).replace(PLACEHOLDER_RE, (m, k) => {
    const c = canon.get(normKey(k))
    return c ? `{{${c}}}` : m
  })
}

function cleanLLMOutput(out) {
  let s = String(out || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  s = s.replace(/^<<<\s*/, '').replace(/\s*>>>$/, '').trim()
  s = s.replace(/^(mensagem( reescrita| final)?|vers[aã]o( reescrita)?|resposta)\s*:\s*/i, '').trim()
  if (s.length > 1 && /^["“'].*["”']$/s.test(s)) s = s.slice(1, -1).trim()
  return s.replace(/[ \t]+$/gm, '')
}

const normForCompare = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

function validateVariant(original, variant) {
  if (!variant || !variant.trim()) return { ok: false, reason: 'vazia' }
  const a = placeholdersOf(original), b = placeholdersOf(variant)
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) {
    return { ok: false, reason: `variáveis alteradas (esperado ${a.map(k => `{{${k}}}`).join(', ') || 'nenhuma'}, veio ${b.map(k => `{{${k}}}`).join(', ') || 'nenhuma'})` }
  }
  // Números/links checados fora dos marcadores, pra "{{coluna2}}" não contar como número.
  const strip = t => String(t).replace(PLACEHOLDER_RE, ' ')
  const vStripped = strip(variant)
  for (const url of strip(original).match(URL_RE) || []) {
    if (!vStripped.includes(url)) return { ok: false, reason: `link alterado/removido (${url})` }
  }
  const vNums = vStripped.match(NUMBER_RE) || []
  for (const n of strip(original).replace(URL_RE, ' ').match(NUMBER_RE) || []) {
    if (!vNums.includes(n)) return { ok: false, reason: `número/valor alterado (${n})` }
  }
  const timeGreeting = /\b(bom dia|boa tarde|boa noite)\b/i
  if (timeGreeting.test(variant) && !timeGreeting.test(original)) return { ok: false, reason: 'cumprimento dependente de horário' }
  const lo = original.length, lv = variant.length
  if (lv < lo * 0.5 || lv > lo * 1.8 + 40) return { ok: false, reason: 'tamanho muito diferente do original' }
  return { ok: true }
}

function buildRewriteMessages(template, avoid) {
  const keys = []
  String(template).replace(PLACEHOLDER_RE, m => { keys.push(m); return m })
  const system = [
    'Você reescreve mensagens de WhatsApp para que cada envio de uma campanha seja diferente, mantendo exatamente o mesmo significado.',
    'Regras obrigatórias:',
    '1. Reescreva a mensagem com outras palavras (cumprimento diferente, sinônimos, outra ordem de frases), mas mantenha o MESMO contexto, oferta, intenção, tom e chamada para ação.',
    '2. Todo marcador entre chaves duplas (ex: {{name}}, {{cidade}}) deve aparecer na resposta EXATAMENTE como está no original, com a mesma grafia e a mesma quantidade de vezes. Nunca traduza, renomeie, remova, invente marcadores novos ou troque o marcador por um valor.',
    '3. Mantenha todos os números, valores, datas, porcentagens e links exatamente iguais ao original.',
    '4. Não adicione informação, promessa ou oferta que não exista no original, e não remova nenhuma informação.',
    '5. Mesmo idioma, tamanho parecido e estrutura de parágrafos parecida. Mantenha emojis só se o original tiver.',
    '6. Não use cumprimentos que dependem do horário ("bom dia", "boa tarde", "boa noite") a menos que o original use — a mensagem pode ser enviada a qualquer hora.',
    '7. Responda SOMENTE com a mensagem final, sem aspas, sem título e sem explicações.',
  ].join('\n')
  let user = `Mensagem original:\n<<<\n${template}\n>>>`
  user += keys.length
    ? `\n\nMarcadores que DEVEM aparecer na resposta, exatamente assim: ${keys.join(', ')}`
    : '\n\nA mensagem não tem marcadores {{...}} — não crie nenhum.'
  if (avoid.length) {
    user += `\n\nNão repita nenhuma destas versões já enviadas (escreva algo diferente delas):\n${avoid.map(v => `- ${v.slice(0, 300).replace(/\n/g, ' ')}`).join('\n')}`
  }
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// Um spinner por campanha: lembra das versões já usadas pra nunca mandar a
// mesma duas vezes (nem o próprio original quando a IA está funcionando).
function createTemplateSpinner(template, { maxAttempts = 3, avoidWindow = 5 } = {}) {
  const used = new Set([normForCompare(template)])
  const recent = []

  async function next() {
    if (typeof template !== 'string' || !template.trim()) return { text: template, ok: false, reason: 'texto vazio' }
    if (!getLLMConfig()) return { text: template, ok: false, reason: 'nenhuma GROQ_API_KEY/OPENAI_API_KEY configurada no servidor' }
    let lastReason = ''
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const raw = await callLLM(buildRewriteMessages(template, recent.slice(-avoidWindow)), {
          temperature: Math.min(1.2, 0.9 + attempt * 0.15),
        })
        const candidate = canonicalizePlaceholders(template, cleanLLMOutput(raw))
        const v = validateVariant(template, candidate)
        if (!v.ok) { lastReason = v.reason; continue }
        const key = normForCompare(candidate)
        if (used.has(key)) { lastReason = 'versão repetida'; continue }
        used.add(key)
        recent.push(candidate)
        if (recent.length > avoidWindow * 2) recent.shift()
        return { text: candidate, ok: true }
      } catch (e) {
        lastReason = e?.response?.data?.error?.message || e.message || 'erro na IA'
      }
    }
    return { text: template, ok: false, reason: lastReason }
  }

  return { next }
}

// Sorteio "sem reposição": embaralha a lista e vai consumindo; quando acaba,
// embaralha de novo. Assim todas as imagens saem na mesma proporção e nunca
// repete a mesma imagem duas vezes seguidas (inclusive na virada do ciclo).
function createShuffleBag(items) {
  const list = (items || []).filter(Boolean)
  let bag = []
  let last
  function refill() {
    bag = [...list]
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]]
    }
    if (bag.length > 1 && bag[bag.length - 1] === last) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]
    }
  }
  return {
    size: list.length,
    next() {
      if (!list.length) return undefined
      if (!bag.length) refill()
      last = bag.pop()
      return last
    },
  }
}

module.exports = {
  firstNameOf, applyVars, resolvePayload, normalizeBrazilPhone, randDelaySec,
  spinOpeningWithAI, createTemplateSpinner, validateVariant, createShuffleBag,
}
