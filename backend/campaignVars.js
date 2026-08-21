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

// Randomiza só a abertura do template (via Groq/OpenAI) pra reduzir a
// assinatura de "mensagem idêntica em massa" sem arriscar mudar o conteúdo
// principal. Roda ANTES de resolvePayload/applyVars, em cima do template com
// os {{placeholders}} ainda intactos — a IA nunca vê o valor real das
// variáveis, só o nome delas, então não tem como confundir/trocar valores.
async function spinOpeningWithAI(template) {
  if (typeof template !== 'string' || !template.trim()) return template
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) return template
  const baseURL = process.env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'
  const model = process.env.GROQ_API_KEY ? 'llama3-8b-8192' : 'gpt-3.5-turbo'
  try {
    const resp = await axios.post(`${baseURL}/chat/completions`, {
      model, max_tokens: 400, temperature: 0.9,
      messages: [
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
      ],
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    const out = resp.data?.choices?.[0]?.message?.content?.trim()
    return out || template
  } catch (e) {
    return template
  }
}

module.exports = { firstNameOf, applyVars, resolvePayload, normalizeBrazilPhone, randDelaySec, spinOpeningWithAI }
