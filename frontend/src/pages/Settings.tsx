import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import {
  Save, Info, Plus, Trash2, Zap, Tag, Edit2, Check, X,
  Code2, SlidersHorizontal, Copy, Lock, Globe, Cpu,
  MessageSquare, Radio, AlertTriangle, ChevronDown, ChevronUp, MessagesSquare,
  Webhook, RefreshCw, Send,
  Eye, EyeOff, KeyRound, Sun, Moon, Brain, Smartphone,
} from 'lucide-react'
import { v4 as uuid } from '../utils/uuid'
import type { QuickReply, Label, Channel } from '../types'
import { invalidateApiKeyCache } from '../api/client'

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const LABEL_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#06b6d4', '#84cc16', '#f59e0b',
]

// ── Webhook Tab ───────────────────────────────────────────────────────────────

interface WebhookEntry {
  id: string
  url: string
  events: string[]
  createdAt: string
}

const WEBHOOK_EVENTS = [
  { id: 'message_created',             label: 'Mensagem criada',             desc: 'Nova mensagem WhatsApp recebida (entrada)' },
  { id: 'message_sent',                label: 'Mensagem enviada',            desc: 'Mensagem enviada via API ou interface' },
  { id: 'conversation_status_changed', label: 'Status de conversa alterado', desc: 'Conversa transferida no pipeline / Kanban' },
  { id: 'contact_updated',             label: 'Contato atualizado',          desc: 'Etiqueta adicionada ou removida do contato' },
]

const EVENT_BADGE: Record<string, string> = {
  message_created:             'bg-blue-900/50 text-blue-300 border border-blue-700/40',
  message_sent:                'bg-green-900/50 text-green-300 border border-green-700/40',
  conversation_status_changed: 'bg-yellow-900/50 text-yellow-300 border border-yellow-700/40',
  contact_updated:             'bg-purple-900/50 text-purple-300 border border-purple-700/40',
}

function WebhooksTab() {
  const [hooks, setHooks] = useState<WebhookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [newEvents, setNewEvents] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, boolean | null>>({})
  const urlRef = useRef<HTMLInputElement>(null)

  function load() {
    setLoading(true)
    fetch('/api/webhooks').then(r => r.json()).then(setHooks).catch(() => setHooks([])).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (showModal) setTimeout(() => urlRef.current?.focus(), 50)
  }, [showModal])

  function toggleEvent(id: string) {
    setNewEvents(prev => prev.includes(id) ? prev.filter(e => e !== id) : [...prev, id])
  }

  async function addWebhook() {
    if (!newUrl.trim() || newEvents.length === 0) return
    setSaving(true)
    try {
      const r = await fetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl.trim(), events: newEvents }),
      })
      if (!r.ok) { const d = await r.json(); alert(d.error || 'Erro ao salvar'); return }
      setShowModal(false)
      setNewUrl('')
      setNewEvents([])
      load()
    } catch { alert('Erro de conexão com o backend') } finally { setSaving(false) }
  }

  async function deleteWebhook(id: string) {
    if (!confirm('Remover este webhook?')) return
    await fetch(`/api/webhooks/${id}`, { method: 'DELETE' })
    load()
  }

  async function testWebhook(id: string) {
    setTesting(id)
    setTestResult(prev => ({ ...prev, [id]: null }))
    try {
      const r = await fetch(`/api/webhooks/${id}/test`, { method: 'POST' })
      setTestResult(prev => ({ ...prev, [id]: r.ok }))
    } catch { setTestResult(prev => ({ ...prev, [id]: false })) }
    finally { setTesting(null) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400">Receba notificações em tempo real sobre eventos do sistema.</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors shrink-0"
        >
          <Plus size={14} /> Adicionar webhook
        </button>
      </div>

      {loading ? (
        <div className="text-center py-10 text-gray-600 text-sm">Carregando...</div>
      ) : hooks.length === 0 ? (
        <div className="bg-gray-900 border border-dashed border-gray-700 rounded-xl p-10 text-center">
          <Webhook size={28} className="text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Nenhum webhook configurado.</p>
          <p className="text-xs text-gray-600 mt-1">Adicione um URL externo para receber eventos em tempo real.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {hooks.map(wh => (
            <div key={wh.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <Webhook size={15} className="text-indigo-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-mono truncate">{wh.url}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {wh.events.map(ev => (
                      <span key={ev} className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${EVENT_BADGE[ev] || 'bg-gray-800 text-gray-400'}`}>
                        {WEBHOOK_EVENTS.find(e => e.id === ev)?.label || ev}
                      </span>
                    ))}
                  </div>
                  {testResult[wh.id] !== undefined && testResult[wh.id] !== null && (
                    <p className={`text-xs mt-1.5 ${testResult[wh.id] ? 'text-green-400' : 'text-red-400'}`}>
                      {testResult[wh.id] ? '✓ Teste enviado com sucesso' : '✗ Falha ao enviar — verifique a URL'}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => testWebhook(wh.id)}
                    disabled={testing === wh.id}
                    title="Enviar evento de teste"
                    className="text-gray-500 hover:text-indigo-400 p-1.5 rounded transition-colors disabled:opacity-40"
                  >
                    {testing === wh.id ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                  </button>
                  <button
                    onClick={() => deleteWebhook(wh.id)}
                    title="Remover"
                    className="text-gray-500 hover:text-red-400 p-1.5 rounded transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Payload reference */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Formato do payload enviado</p>
        <pre className="bg-gray-950 border border-gray-800/60 rounded-lg px-4 py-3 text-xs font-mono text-gray-300 overflow-x-auto">{`POST https://seu-servidor.com/webhook
Content-Type: application/json
x-crm-event: message_created

{
  "event": "message_created",
  "timestamp": "2024-01-15T14:30:00.000Z",
  "data": {
    "chipId": "chip_1",
    "from": "5511999998888@c.us",
    "body": "Olá! Gostaria de saber mais.",
    "pushname": "João Silva",
    "contactNumber": "5511999998888",
    "conversationId": "a3f2b8c1d4e5f6a7"   ← use este para responder
  }
}

// conversationId é único e estável por conversa (um por contato/canal).
// Toda vez que esse contato enviar mensagem, chegará sempre o mesmo ID.
// Use-o no campo conversationId do POST /api/send-message para responder.`}</pre>
      </div>

      {/* Add Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-800">
              <div>
                <h3 className="text-sm font-semibold text-white">Adicionar novo webhook</h3>
                <p className="text-xs text-gray-500 mt-0.5">Webhooks fornecem notificações em tempo real sobre eventos do sistema.</p>
              </div>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-white p-1"><X size={16} /></button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-300 mb-1.5">URL do Webhook</label>
                <input
                  ref={urlRef}
                  value={newUrl}
                  onChange={e => setNewUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && newEvents.length > 0 && addWebhook()}
                  placeholder="Exemplo: https://example.com/api/webhook"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-300 mb-2">Eventos</label>
                <div className="space-y-2">
                  {WEBHOOK_EVENTS.map(ev => {
                    const selected = newEvents.includes(ev.id)
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => toggleEvent(ev.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${selected ? 'bg-indigo-900/30 border-indigo-600/50' : 'bg-gray-800/60 border-gray-700 hover:border-gray-600'}`}
                      >
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${selected ? 'border-indigo-400 bg-indigo-500' : 'border-gray-600'}`}>
                          {selected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <div className="min-w-0">
                          <span className="text-xs font-medium text-white">{ev.label} </span>
                          <span className="text-[11px] text-gray-500">({ev.id})</span>
                          <p className="text-[11px] text-gray-500 truncate">{ev.desc}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-800">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
                Cancelar
              </button>
              <button
                onClick={addWebhook}
                disabled={saving || !newUrl.trim() || newEvents.length === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg transition-colors"
              >
                {saving ? <RefreshCw size={13} className="animate-spin" /> : <Webhook size={13} />}
                Criar webhook
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── API Docs helpers ───────────────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
const METHOD_BADGE: Record<Method, string> = {
  GET:    'bg-blue-900/60 text-blue-300 border border-blue-700/40',
  POST:   'bg-green-900/60 text-green-300 border border-green-700/40',
  PUT:    'bg-yellow-900/60 text-yellow-300 border border-yellow-700/40',
  DELETE: 'bg-red-900/60 text-red-300 border border-red-700/40',
}

function CopyBtn({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  function go() {
    navigator.clipboard.writeText(text)
    setDone(true)
    setTimeout(() => setDone(false), 1400)
  }
  return (
    <button onClick={go} title="Copiar" className={`text-gray-600 hover:text-gray-300 transition-colors ${className}`}>
      {done ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
    </button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative group">
      <pre className="bg-gray-950 border border-gray-800/60 rounded-lg px-4 py-3 text-xs font-mono text-gray-300 overflow-x-auto whitespace-pre leading-relaxed">
        {children}
      </pre>
      <CopyBtn text={children} className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  )
}

function SectionDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-gray-800" />
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest flex items-center gap-1.5 shrink-0">
        {children}
      </span>
      <div className="h-px flex-1 bg-gray-800" />
    </div>
  )
}

interface EndpointProps {
  method: Method
  path: string
  title: string
  description: string
  auth?: boolean
  pathParams?: Record<string, string>
  bodyDesc?: string
  bodyExample?: string
  response: string
  curl: string
  n8n?: string
}

function Endpoint({ method, path, title, description, auth = true, pathParams, bodyDesc, bodyExample, response, curl, n8n }: EndpointProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/40 transition-colors"
      >
        <span className={`shrink-0 font-mono text-[11px] font-bold px-2 py-0.5 rounded ${METHOD_BADGE[method]}`}>{method}</span>
        <code className="text-white text-sm font-mono flex-1 truncate">{path}</code>
        {auth && <Lock size={11} className="text-amber-500/60 shrink-0" />}
        <span className="text-xs text-gray-500 shrink-0 hidden sm:block">{title}</span>
        {open ? <ChevronUp size={14} className="text-gray-600 shrink-0" /> : <ChevronDown size={14} className="text-gray-600 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-gray-800 px-5 py-5 space-y-5">
          <p className="text-sm text-gray-400 leading-relaxed">{description}</p>

          {auth && (
            <div className="flex items-start gap-2 bg-amber-900/10 border border-amber-700/20 rounded-lg px-3 py-2.5 text-xs text-amber-300/70">
              <Lock size={11} className="shrink-0 mt-0.5 text-amber-500/60" />
              <span>Requer header <code className="text-amber-200/80 mx-0.5">x-api-token</code> se <code className="text-amber-200/80">API_KEY</code> estiver configurada no backend.</span>
            </div>
          )}

          {pathParams && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Path Params</p>
              <div className="bg-gray-950 border border-gray-800/60 rounded-lg divide-y divide-gray-800/60">
                {Object.entries(pathParams).map(([k, v]) => (
                  <div key={k} className="flex gap-4 px-3 py-2.5 text-xs">
                    <code className="text-indigo-400 w-40 shrink-0">{k}</code>
                    <span className="text-gray-400">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {bodyExample && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                Request Body <span className="normal-case font-normal text-gray-600">(application/json)</span>
              </p>
              {bodyDesc && <p className="text-xs text-gray-500 mb-2">{bodyDesc}</p>}
              <CodeBlock>{bodyExample}</CodeBlock>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Resposta</p>
            <CodeBlock>{response}</CodeBlock>
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Exemplo cURL</p>
            <CodeBlock>{curl}</CodeBlock>
          </div>

          {n8n && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Cpu size={11} className="text-indigo-400" />
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Exemplo n8n — HTTP Request</p>
              </div>
              <CodeBlock>{n8n}</CodeBlock>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── API Key Section ───────────────────────────────────────────────────────────

function ApiKeySection() {
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const fetchKey = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/apikey')
      const data = await res.json()
      setApiKey(data.key ?? null)
    } catch { /* ignora */ }
  }, [])

  useEffect(() => { fetchKey() }, [fetchKey])

  const handleCopy = () => {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleRegenerate = async () => {
    if (!confirm('Regenerar a chave tornará a chave atual inválida. Continuar?')) return
    setRegenerating(true)
    try {
      const res = await fetch('/api/settings/apikey/regenerate', { method: 'POST' })
      const data = await res.json()
      setApiKey(data.key ?? null)
      setVisible(true)
      invalidateApiKeyCache()
    } catch { /* ignora */ } finally {
      setRegenerating(false)
    }
  }

  const maskedKey = apiKey ? apiKey.slice(0, 8) + '•'.repeat(apiKey.length - 12) + apiKey.slice(-4) : ''

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound size={14} className="text-indigo-400" />
        <h3 className="text-sm font-semibold text-white">Chave de API</h3>
        <span className="ml-auto text-[10px] text-green-400 bg-green-400/10 border border-green-400/20 px-2 py-0.5 rounded-full">Ativa</span>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        Use esta chave em todas as requisições protegidas (envio de mensagens, CRM). Envie via header <code className="text-indigo-300">x-api-token</code>.
      </p>

      {/* Key display */}
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2.5 flex items-center gap-2 min-w-0">
          <Lock size={12} className="text-gray-600 shrink-0" />
          <span className="font-mono text-xs text-gray-300 truncate select-all flex-1">
            {apiKey ? (visible ? apiKey : maskedKey) : 'Carregando...'}
          </span>
        </div>
        <button
          onClick={() => setVisible(v => !v)}
          className="p-2 text-gray-500 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
          title={visible ? 'Ocultar chave' : 'Mostrar chave'}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button
          onClick={handleCopy}
          className="p-2 text-gray-500 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
          title="Copiar chave"
        >
          {copied ? <Check size={15} className="text-green-400" /> : <Copy size={15} />}
        </button>
      </div>

      {/* Header examples */}
      <div className="space-y-1">
        <p className="text-[10px] text-gray-600 uppercase tracking-wider font-semibold">Como usar nos headers</p>
        <CodeBlock>{`x-api-token: ${visible && apiKey ? apiKey : '<sua-chave-api>'}
# ou
apikey: ${visible && apiKey ? apiKey : '<sua-chave-api>'}
# ou
Authorization: Bearer ${visible && apiKey ? apiKey : '<sua-chave-api>'}`}</CodeBlock>
      </div>

      {/* Regenerate */}
      <div className="flex items-center justify-between pt-1 border-t border-gray-800">
        <p className="text-[11px] text-gray-600">Ao regenerar, a chave atual para de funcionar imediatamente.</p>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
          {regenerating ? 'Gerando...' : 'Regenerar'}
        </button>
      </div>
    </div>
  )
}

// ── API Docs main component ────────────────────────────────────────────────────

function ApiDocs() {
  return (
    <div className="space-y-5 pb-6">

      {/* API Key */}
      <ApiKeySection />

      {/* Auth usage info */}
      <div className="bg-amber-950/20 border border-amber-700/30 rounded-xl p-4 flex items-start gap-2">
        <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-300/70 leading-relaxed">
          Não exponha a API sem a chave configurada. Em produção use sempre HTTPS — configure um reverse proxy (nginx/Caddy) ou acesse via ngrok com autenticação.
        </p>
      </div>

      {/* Base URL + n8n tip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Globe size={13} className="text-indigo-400" />
            <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Base URL</p>
          </div>
          <code className="text-green-400 text-sm break-all">http://localhost:3001</code>
          <p className="text-xs text-gray-600 mt-2">Substitua pelo seu domínio ou URL do ngrok em produção.</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={13} className="text-indigo-400" />
            <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Exemplo no n8n</p>
          </div>
          <div className="text-xs space-y-1.5 text-gray-400">
            <div className="flex gap-2">
              <span className="text-gray-600 w-14 shrink-0">Nó:</span>
              <span className="text-white">HTTP Request</span>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-600 w-14 shrink-0">Auth:</span>
              <code className="text-indigo-300">x-api-token</code>
            </div>
            <div className="flex gap-2">
              <span className="text-gray-600 w-14 shrink-0">Valor:</span>
              <code className="text-gray-300 text-[11px]">{'{{ $env.CRM_API_KEY }}'}</code>
            </div>
          </div>
        </div>
      </div>

      {/* ── Chips / Instâncias ── */}
      <SectionDivider>Instâncias WhatsApp</SectionDivider>

      <Endpoint
        method="GET"
        path="/api/chips"
        title="Listar chips"
        auth={false}
        description="Retorna todas as instâncias WhatsApp cadastradas e seus status de conexão. Use para descobrir o chipId necessário no envio de mensagens — somente chips com status ready conseguem enviar."
        response={`[
  {
    "id": "chip_1",
    "name": "Vendas",
    "status": "ready",
    "phone": "5511999998888"
  },
  {
    "id": "chip_2",
    "name": "Suporte",
    "status": "disconnected",
    "phone": null
  }
]`}
        curl={`curl http://localhost:3001/api/chips`}
        n8n={`Method: GET
URL: http://localhost:3001/api/chips`}
      />

      {/* ── Mensagens ── */}
      <SectionDivider><MessageSquare size={11} /> Mensagens</SectionDivider>

      <Endpoint
        method="GET"
        path="/api/conversations"
        title="Listar conversas"
        auth={false}
        description="Retorna todas as conversas registradas no CRM com seus respectivos conversationIds. Use para descobrir o conversationId de um contato específico antes de enviar uma mensagem proativa."
        response={`[
  {
    "conversationId": "a3f2b8c1d4e5f6a7",
    "channel": "chip_1",
    "contact": "5511999998888@c.us"
  },
  {
    "conversationId": "b9c3d2e1f0a8b7c6",
    "channel": "123456789012345",
    "contact": "5521988887777"
  }
]`}
        curl={`curl http://localhost:3001/api/conversations`}
        n8n={`Method: GET
URL: http://localhost:3001/api/conversations`}
      />

      <Endpoint
        method="POST"
        path="/api/send-message"
        title="Enviar mensagem de texto"
        description="Envia mensagem via Chip (WhatsApp Web) ou Canal Oficial (Meta API). O campo conversationId vem do webhook (data.conversationId) quando o contato envia uma mensagem — cada contato tem um ID único e estável por canal. Use conversationId para responder. Para iniciar uma conversa nova (sem mensagem recebida antes), use chipId + to."
        bodyDesc="conversationId: ID único da conversa recebido pelo webhook — use para responder a um contato específico. Alternativa: chipId + to + message para nova conversa. message: texto da mensagem."
        bodyExample={`// RESPONDER — use o conversationId recebido no webhook:
{
  "conversationId": "a3f2b8c1d4e5f6a7",
  "message": "Olá! Como posso ajudar?"
}

// NOVA CONVERSA — quando não há mensagem recebida ainda:
{
  "chipId": "chip_1",
  "to": "5511999998888",
  "message": "Olá! Tudo bem?"
}`}
        response={`{ "ok": true, "msgId": "true_5511999998888@c.us_3EB01234ABCD" }`}
        curl={`# Responder usando conversationId do webhook:
curl -X POST http://localhost:3001/api/send-message \\
  -H "Content-Type: application/json" \\
  -H "x-api-token: sua-chave-secreta" \\
  -d '{
    "conversationId": "a3f2b8c1d4e5f6a7",
    "message": "Olá! Como posso ajudar?"
  }'`}
        n8n={`Method: POST
URL: http://localhost:3001/api/send-message

Headers:
  x-api-token: {{ $env.CRM_API_KEY }}
  Content-Type: application/json

Body (JSON) — conversationId vem do nó anterior (webhook):
{
  "conversationId": "{{ $json.data.conversationId }}",
  "message": "{{ $json.resposta }}"
}`}
      />

      {/* ── Etiquetas ── */}
      <SectionDivider><Tag size={11} /> Etiquetas</SectionDivider>

      <div className="space-y-2">
        <Endpoint
          method="POST"
          path="/api/crm/contacts/:phone/labels"
          title="Atribuir etiqueta"
          description="Atribui uma etiqueta a um contato pelo número de telefone. O frontend é notificado via WebSocket (evento crm_label_add) e o contato é atualizado em tempo real na tela. Use o nome exato da etiqueta cadastrada em Configurações > Etiquetas."
          pathParams={{
            ':phone': 'Número em formato E.164 sem + — somente dígitos (ex: 5511999998888).',
          }}
          bodyDesc='Use o nome exato da etiqueta como cadastrado em Configurações > Etiquetas.'
          bodyExample={`{ "label": "Cliente VIP" }`}
          response={`{ "ok": true }`}
          curl={`curl -X POST http://localhost:3001/api/crm/contacts/5511999998888/labels \\
  -H "Content-Type: application/json" \\
  -H "x-api-token: sua-chave-secreta" \\
  -d '{ "label": "Cliente VIP" }'`}
          n8n={`Method: POST
URL: http://localhost:3001/api/crm/contacts/{{ $json.phone }}/labels

Headers:
  x-api-token: {{ $env.CRM_API_KEY }}
  Content-Type: application/json

Body (JSON):
{ "label": "{{ $json.label }}" }`}
        />

        <Endpoint
          method="DELETE"
          path="/api/crm/contacts/:phone/labels/:label"
          title="Remover etiqueta"
          description="Remove uma etiqueta de um contato. O frontend é notificado via WebSocket (crm_label_remove) e a etiqueta some imediatamente. Se o nome da etiqueta contiver espaços ou caracteres especiais, codifique com URL-encoding (espaço = %20)."
          pathParams={{
            ':phone': 'Número em formato E.164 sem + — somente dígitos (ex: 5511999998888).',
            ':label': 'Nome da etiqueta. Espaços → %20 | outros especiais → encodeURIComponent.',
          }}
          response={`{ "ok": true }`}
          curl={`# Etiqueta sem espaços:
curl -X DELETE http://localhost:3001/api/crm/contacts/5511999998888/labels/Lead \\
  -H "x-api-token: sua-chave-secreta"

# Etiqueta com espaços (URL-encoded):
curl -X DELETE "http://localhost:3001/api/crm/contacts/5511999998888/labels/Cliente%20VIP" \\
  -H "x-api-token: sua-chave-secreta"`}
          n8n={`Method: DELETE
URL: http://localhost:3001/api/crm/contacts/{{ $json.phone }}/labels/{{ encodeURIComponent($json.label) }}

Headers:
  x-api-token: {{ $env.CRM_API_KEY }}`}
        />
      </div>

      {/* ── Pipeline ── */}
      <SectionDivider>Pipeline / Kanban</SectionDivider>

      <Endpoint
        method="PUT"
        path="/api/crm/conversations/:phone/pipeline"
        title="Transferir no pipeline"
        description="Move uma conversa para uma coluna específica do Kanban (pipeline). O frontend recebe o evento crm_pipeline_transfer via WebSocket e o card é reposicionado em tempo real. Para descobrir os IDs das colunas, acesse a página Kanban e inspecione os cards — o columnId está no store do CRM."
        pathParams={{
          ':phone': 'Número em formato E.164 sem + — somente dígitos (ex: 5511999998888).',
        }}
        bodyDesc="O columnId deve ser o ID de uma coluna existente no Kanban. Colunas padrão: col_1 (Novos), col_2 (Em Negociação), col_3 (Fechados)."
        bodyExample={`{ "columnId": "col_2" }`}
        response={`{ "ok": true }`}
        curl={`curl -X PUT http://localhost:3001/api/crm/conversations/5511999998888/pipeline \\
  -H "Content-Type: application/json" \\
  -H "x-api-token: sua-chave-secreta" \\
  -d '{ "columnId": "col_2" }'`}
        n8n={`Method: PUT
URL: http://localhost:3001/api/crm/conversations/{{ $json.phone }}/pipeline

Headers:
  x-api-token: {{ $env.CRM_API_KEY }}
  Content-Type: application/json

Body (JSON):
{ "columnId": "{{ $json.columnId }}" }`}
      />

      {/* ── IA ── */}
      <SectionDivider><Brain size={11} /> IA</SectionDivider>

      <Endpoint
        method="GET"
        path="/api/ia/fgts/phones"
        title="Telefones conectados à IA FGTS"
        auth={false}
        description="Retorna os chips configurados na aba IA > IA FGTS, com seus números de telefone e status de conexão. Use este endpoint para saber em quais instâncias a IA FGTS está ativa — somente nesses números ela terá acesso às conversas."
        response={`{
  "enabled": true,
  "phones": [
    {
      "type": "chip",
      "id": "chip2",
      "phone": "5511999998888",
      "status": "connected",
      "ready": true
    }
  ]
}`}
        curl={`curl http://localhost:3001/api/ia/fgts/phones`}
        n8n={`Method: GET
URL: http://localhost:3001/api/ia/fgts/phones`}
      />

      {/* ── WebSocket Events ── */}
      <SectionDivider><Radio size={11} /> Eventos WebSocket</SectionDivider>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <p className="text-xs text-gray-400 leading-relaxed">
          O servidor publica eventos em tempo real via WebSocket em{' '}
          <code className="text-indigo-300">ws://localhost:3001/ws</code>.
          Todas as mensagens têm o formato:{' '}
          <code className="text-gray-300">{'{ "type": "evento", "payload": { ... } }'}</code>
        </p>

        <div className="space-y-2">
          {([
            { type: 'crm_label_add',        payload: '{ phone, label }',       desc: 'Etiqueta atribuída a um contato',        trigger: 'POST /api/crm/contacts/:phone/labels' },
            { type: 'crm_label_remove',     payload: '{ phone, label }',       desc: 'Etiqueta removida de um contato',        trigger: 'DELETE /api/crm/contacts/:phone/labels/:label' },
            { type: 'crm_pipeline_transfer',payload: '{ phone, columnId }',    desc: 'Conversa transferida de coluna',         trigger: 'PUT /api/crm/conversations/:phone/pipeline' },
            { type: 'gmaps_result',         payload: '{ data, current, total }',desc: 'Resultado extraído do Google Maps',     trigger: 'POST /api/tools/gmaps/start' },
            { type: 'gmaps_log',            payload: '{ message }',            desc: 'Log de progresso da extração GMaps',    trigger: 'Contínuo durante extração' },
            { type: 'gmaps_done',           payload: '{}',                     desc: 'Extração do GMaps concluída',           trigger: 'Automático ao finalizar' },
            { type: 'chips_status',         payload: 'ChipStatus[]',           desc: 'Status atualizado das instâncias',      trigger: 'Ao conectar ou reconectar chip' },
          ] as const).map(e => (
            <div key={e.type} className="bg-gray-950 border border-gray-800/40 rounded-lg px-3 py-2.5 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-indigo-400 font-semibold">{e.type}</code>
                <code className="text-gray-600">{e.payload}</code>
              </div>
              <div className="flex items-center justify-between mt-0.5 gap-2">
                <span className="text-gray-500">{e.desc}</span>
                <code className="text-gray-700 text-[10px] shrink-0 hidden sm:block">{e.trigger}</code>
              </div>
            </div>
          ))}
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Ouvir eventos no Node.js</p>
          <CodeBlock>{`const WebSocket = require('ws')
const ws = new WebSocket('ws://localhost:3001/ws')

ws.on('message', (data) => {
  const { type, payload } = JSON.parse(data)

  if (type === 'crm_label_add') {
    console.log('Label adicionada:', payload.phone, '->', payload.label)
  }
  if (type === 'crm_pipeline_transfer') {
    console.log('Conversa movida:', payload.phone, '->', payload.columnId)
  }
})`}</CodeBlock>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Ouvir eventos no n8n — nó WebSocket Trigger</p>
          <CodeBlock>{`Nó: WebSocket Trigger
URL: ws://localhost:3001/ws

# Filtrar por tipo no nó seguinte (If / Switch):
# {{ $json.type === 'crm_label_add' }}
# → payload.phone, payload.label`}</CodeBlock>
        </div>
      </div>

    </div>
  )
}

// ── IA Tab ────────────────────────────────────────────────────────────────────

interface IAFgtsConfig {
  enabled: boolean
  chipIds: string[]
  channelIds: string[]   // armazena phoneNumberId dos canais Meta (não o UUID do frontend)
  webhookEnabled: boolean
  webhookUrl: string
}

function IATab({ channels: channelsProp }: { channels: Channel[] }) {
  const [config, setConfig] = useState<IAFgtsConfig>(
    { enabled: false, chipIds: [], channelIds: [], webhookEnabled: false, webhookUrl: '' }
  )
  const [chips, setChips] = useState<{ id: string; status: string; number: string | null; isReady: boolean }[]>([])
  const [backendChannels, setBackendChannels] = useState<Channel[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedIA, setSavedIA] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [expanded, setExpanded] = useState(true)

  // Usa canais do backend se retornou dados, senão usa os do Zustand (prop)
  const channels = (backendChannels !== null && backendChannels.length > 0) ? backendChannels : channelsProp

  useEffect(() => {
    Promise.allSettled([
      fetch('/api/ia/fgts').then(r => r.json()),
      fetch('/api/chips').then(r => r.json()),
      fetch('/api/channels').then(r => r.json()),
    ]).then(([ia, ch, chans]) => {
      if (ia.status === 'fulfilled') setConfig(c => ({ ...c, ...ia.value }))
      if (ch.status === 'fulfilled' && Array.isArray(ch.value)) setChips(ch.value)
      if (chans.status === 'fulfilled' && Array.isArray(chans.value)) setBackendChannels(chans.value)
    }).finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    setSaveError(false)
    try {
      const res = await fetch('/api/ia/fgts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSavedIA(true)
      setTimeout(() => setSavedIA(false), 2500)
    } catch {
      setSaveError(true)
      setTimeout(() => setSaveError(false), 3000)
    } finally { setSaving(false) }
  }

  function toggleChip(chipId: string) {
    setConfig(c => ({
      ...c,
      chipIds: c.chipIds.includes(chipId) ? c.chipIds.filter(id => id !== chipId) : [...c.chipIds, chipId],
    }))
  }

  // Para canais Meta, usa phoneNumberId (não o UUID) — assim o backend consegue comparar
  function toggleChannel(phoneNumberId: string) {
    setConfig(c => ({
      ...c,
      channelIds: c.channelIds.includes(phoneNumberId)
        ? c.channelIds.filter(id => id !== phoneNumberId)
        : [...c.channelIds, phoneNumberId],
    }))
  }

  if (loading) return <div className="py-10 text-center text-gray-600 text-sm">Carregando...</div>

  return (
    <div className="space-y-3">
      {/* IA FGTS card */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

        {/* Header — clicável para expandir */}
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-800/40 transition-colors text-left"
        >
          <div className="flex items-center gap-2.5">
            <Brain size={15} className="text-violet-400 shrink-0" />
            <span className="text-sm font-medium text-white">IA FGTS</span>
            <span className="text-[10px] px-2 py-0.5 bg-violet-900/30 text-violet-400 border border-violet-700/30 rounded-full">Beta</span>
            {config.enabled && (
              <span className="text-[10px] px-2 py-0.5 bg-green-900/40 text-green-400 border border-green-700/30 rounded-full">● ativo</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Toggle ativar/desativar — stopPropagation para não abrir o acordeão */}
            <label className="relative inline-flex items-center cursor-pointer" onClick={e => e.stopPropagation()}>
              <input type="checkbox" className="sr-only peer" checked={config.enabled}
                onChange={e => setConfig(c => ({ ...c, enabled: e.target.checked }))} />
              <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-600" />
            </label>
            <ChevronDown size={15} className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </div>
        </button>

        {/* Corpo expansível */}
        {expanded && (
          <div className="border-t border-gray-800 px-5 py-5 space-y-5">
            <p className="text-xs text-gray-500">Selecione os chips e canais onde a IA FGTS terá acesso às conversas e configure o webhook de recebimento.</p>

            {/* Chips */}
            {chips.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Chips</p>
                <div className="space-y-1.5">
                  {chips.map(chip => (
                    <label key={chip.id} className="flex items-center gap-3 cursor-pointer px-3 py-2.5 rounded-lg hover:bg-gray-800 transition-colors">
                      <input type="checkbox" checked={config.chipIds.includes(chip.id)}
                        onChange={() => toggleChip(chip.id)}
                        className="w-4 h-4 rounded border-gray-600 accent-violet-600 focus:ring-0 shrink-0" />
                      <Smartphone size={13} className="text-green-400 shrink-0" />
                      <span className="text-sm text-gray-200 flex-1">{chip.id}</span>
                      {chip.number && <span className="text-xs text-gray-500 font-mono">{chip.number}</span>}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${chip.isReady ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                        {chip.isReady ? 'conectado' : chip.status}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Canais Meta */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Canais Meta API</p>
              {channels.length === 0 ? (
                <p className="text-xs text-gray-600 px-3 py-2">Nenhum canal Meta configurado. Adicione um canal em <span className="text-violet-400">Canais</span>.</p>
              ) : (
                <div className="space-y-1.5">
                  {channels.map(channel => (
                    <label key={channel.id} className="flex items-center gap-3 cursor-pointer px-3 py-2.5 rounded-lg hover:bg-gray-800 transition-colors">
                      <input type="checkbox" checked={config.channelIds.includes(channel.phoneNumberId)}
                        onChange={() => toggleChannel(channel.phoneNumberId)}
                        className="w-4 h-4 rounded border-gray-600 accent-violet-600 focus:ring-0 shrink-0" />
                      <Globe size={13} className="text-blue-400 shrink-0" />
                      <span className="text-sm text-gray-200 flex-1">{channel.name}</span>
                      {channel.phoneNumber && <span className="text-xs text-gray-500 font-mono">{channel.phoneNumber}</span>}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${channel.status === 'connected' ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                        {channel.status}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Webhook */}
            <div className="border-t border-gray-800 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-white">Webhook de recebimento</p>
                  <p className="text-xs text-gray-500 mt-0.5">Dispara ao receber mensagem nos chips/canais selecionados</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input type="checkbox" className="sr-only peer" checked={config.webhookEnabled}
                    onChange={e => setConfig(c => ({ ...c, webhookEnabled: e.target.checked }))} />
                  <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-600" />
                </label>
              </div>

              {config.webhookEnabled && (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">URL do Webhook</label>
                    <input
                      value={config.webhookUrl}
                      onChange={e => setConfig(c => ({ ...c, webhookUrl: e.target.value }))}
                      placeholder="https://seu-sistema.com/webhook/ia"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500 font-mono placeholder-gray-600"
                    />
                  </div>
                  <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg px-3 py-2.5">
                    <p className="text-[10px] text-gray-500 mb-1.5 font-semibold uppercase tracking-wider">Payload enviado</p>
                    <pre className="text-[11px] text-gray-300 font-mono leading-relaxed">{`{
  "chipId": "chip_1",
  "from": "5511999998888",
  "message": "texto da mensagem",
  "name": "Nome do cliente"
}`}</pre>
                  </div>
                </>
              )}
            </div>

            <button onClick={save} disabled={saving}
              className={`flex items-center gap-2 px-4 py-2 text-sm text-white rounded-lg transition-colors disabled:opacity-50 ${savedIA ? 'bg-green-600' : saveError ? 'bg-red-600' : 'bg-violet-600 hover:bg-violet-500'}`}>
              <Save size={13} /> {savedIA ? 'Salvo!' : saveError ? 'Erro — reinicie o backend' : 'Salvar configuração'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Settings() {
  const {
    settings, updateSettings,
    addQuickReply, updateQuickReply, removeQuickReply,
    addLabel, updateLabel, removeLabel,
    clearConversations, clearAllTestData,
    conversations, messages, contacts,
    channels,
  } = useStore()

  const [tab, setTab] = useState<'config' | 'conversas' | 'webhooks' | 'ia' | 'docs'>('config')
  const [form, setForm] = useState(settings)
  const [saved, setSaved] = useState(false)
  const set = (k: keyof typeof form, v: any) => setForm(f => ({ ...f, [k]: v }))

  const [qrShortcut, setQrShortcut] = useState('')
  const [qrMessage, setQrMessage] = useState('')
  const [editingQr, setEditingQr] = useState<string | null>(null)
  const [editQrShortcut, setEditQrShortcut] = useState('')
  const [editQrMessage, setEditQrMessage] = useState('')

  const [labelName, setLabelName] = useState('')
  const [labelColor, setLabelColor] = useState(LABEL_COLORS[0])
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [editLabelName, setEditLabelName] = useState('')
  const [editLabelColor, setEditLabelColor] = useState('')

  function handleSave() {
    updateSettings(form)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function toggleDay(d: number) {
    const days = form.businessHours.days.includes(d)
      ? form.businessHours.days.filter(x => x !== d)
      : [...form.businessHours.days, d].sort()
    setForm(f => ({ ...f, businessHours: { ...f.businessHours, days } }))
  }

  function handleAddQr() {
    const shortcut = qrShortcut.trim().replace(/^\//, '')
    if (!shortcut || !qrMessage.trim()) return
    addQuickReply({ id: uuid(), shortcut, message: qrMessage.trim() })
    setQrShortcut('')
    setQrMessage('')
  }

  function startEditQr(qr: QuickReply) {
    setEditingQr(qr.id)
    setEditQrShortcut(qr.shortcut)
    setEditQrMessage(qr.message)
  }

  function saveEditQr(id: string) {
    updateQuickReply(id, { shortcut: editQrShortcut.trim().replace(/^\//, ''), message: editQrMessage.trim() })
    setEditingQr(null)
  }

  function handleAddLabel() {
    if (!labelName.trim()) return
    addLabel({ id: uuid(), name: labelName.trim(), color: labelColor })
    setLabelName('')
    setLabelColor(LABEL_COLORS[0])
  }

  function startEditLabel(l: Label) {
    setEditingLabel(l.id)
    setEditLabelName(l.name)
    setEditLabelColor(l.color)
  }

  function saveEditLabel(id: string) {
    updateLabel(id, { name: editLabelName.trim(), color: editLabelColor })
    setEditingLabel(null)
  }

  const quickReplies = settings.quickReplies || []
  const labels = settings.labels || []

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Configurações</h1>
          <p className="text-sm text-gray-400 mt-1">Configurações gerais do CRM</p>
        </div>
        {tab === 'config' && (
          <button onClick={handleSave}
            className={`flex items-center gap-2 px-4 py-2 text-sm text-white rounded-lg transition-colors ${saved ? 'bg-green-600' : 'bg-indigo-600 hover:bg-indigo-500'}`}>
            <Save size={15} /> {saved ? 'Salvo!' : 'Salvar'}
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex mb-6 border-b border-gray-800">
        <button
          onClick={() => setTab('config')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'config' ? 'text-white border-indigo-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
        >
          <SlidersHorizontal size={14} /> Configurações
        </button>
        <button
          onClick={() => setTab('conversas')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'conversas' ? 'text-white border-indigo-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
        >
          <MessagesSquare size={14} /> Conversas
        </button>
        <button
          onClick={() => setTab('webhooks')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'webhooks' ? 'text-white border-indigo-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
        >
          <Webhook size={14} /> Webhooks
        </button>
        <button
          onClick={() => setTab('ia')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'ia' ? 'text-violet-300 border-violet-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
        >
          <Brain size={14} /> IA
        </button>
        <button
          onClick={() => setTab('docs')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'docs' ? 'text-white border-indigo-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
        >
          <Code2 size={14} /> Docs API
        </button>
      </div>

      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'ia' && <IATab channels={channels} />}
      {tab === 'docs' && <ApiDocs />}

      {tab === 'conversas' && (
        <div className="space-y-6">
          {/* Respostas Rápidas */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-1">
              <Zap size={14} className="text-indigo-400" />
              <h2 className="text-sm font-medium text-white">Respostas Rápidas</h2>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Digite <code className="text-indigo-400 bg-gray-800 px-1 rounded">/atalho</code> no chat para inserir rapidamente uma resposta pré-configurada.
            </p>

            <div className="space-y-2 mb-4">
              <div className="flex gap-2">
                <div className="relative w-36 shrink-0">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-sm">/</span>
                  <input value={qrShortcut} onChange={e => setQrShortcut(e.target.value.replace(/\s/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && qrMessage && handleAddQr()}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-6 pr-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    placeholder="atalho" />
                </div>
                <input value={qrMessage} onChange={e => setQrMessage(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && qrShortcut && handleAddQr()}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="Texto da resposta rápida..." />
                <button onClick={handleAddQr} disabled={!qrShortcut.trim() || !qrMessage.trim()}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg shrink-0">
                  <Plus size={15} />
                </button>
              </div>
            </div>

            {quickReplies.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-3">Nenhuma resposta rápida cadastrada.</p>
            ) : (
              <div className="space-y-2">
                {quickReplies.map(qr => (
                  <div key={qr.id} className="bg-gray-800 rounded-lg p-3">
                    {editingQr === qr.id ? (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <div className="relative w-36 shrink-0">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-sm">/</span>
                            <input value={editQrShortcut} onChange={e => setEditQrShortcut(e.target.value.replace(/\s/g, ''))}
                              className="w-full bg-gray-700 border border-gray-600 rounded-lg pl-6 pr-3 py-1.5 text-sm text-white focus:outline-none" />
                          </div>
                          <input value={editQrMessage} onChange={e => setEditQrMessage(e.target.value)}
                            className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none" />
                        </div>
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setEditingQr(null)} className="text-gray-400 hover:text-white p-1"><X size={12} /></button>
                          <button onClick={() => saveEditQr(qr.id)} className="text-green-400 hover:text-green-300 p-1"><Check size={12} /></button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-3">
                        <span className="text-xs font-mono text-indigo-400 bg-indigo-900/30 px-2 py-0.5 rounded shrink-0">/{qr.shortcut}</span>
                        <span className="text-xs text-gray-300 flex-1 truncate">{qr.message}</span>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={() => startEditQr(qr)} className="text-gray-500 hover:text-white p-1"><Edit2 size={12} /></button>
                          <button onClick={() => removeQuickReply(qr.id)} className="text-gray-500 hover:text-red-400 p-1"><Trash2 size={12} /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Limpeza de dados de teste */}
          <section className="bg-gray-900 border border-red-900/40 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle size={14} className="text-red-400" />
              <h2 className="text-sm font-medium text-white">Dados de Teste</h2>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Apaga dados de conversas e mensagens para reiniciar os testes. Canais e configurações não são afetados.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 bg-gray-800 rounded-lg p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-white">Conversas e mensagens</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{conversations.length} conversa(s) · {messages.length} mensagem(ns) · contatos mantidos</p>
                </div>
                <button
                  onClick={() => { if (confirm(`Apagar ${conversations.length} conversa(s) e ${messages.length} mensagem(ns)?`)) clearConversations() }}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-red-900/40 hover:bg-red-800/60 border border-red-700/40 text-red-300 text-xs rounded-lg transition-colors"
                >
                  <Trash2 size={12} /> Limpar
                </button>
              </div>
              <div className="flex-1 bg-gray-800 rounded-lg p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-white">Tudo (contatos também)</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{contacts.length} contato(s) · {conversations.length} conversa(s) · {messages.length} msg(s)</p>
                </div>
                <button
                  onClick={() => { if (confirm(`Apagar ${contacts.length} contato(s), ${conversations.length} conversa(s) e ${messages.length} mensagem(ns)?`)) clearAllTestData() }}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-red-900/40 hover:bg-red-800/60 border border-red-700/40 text-red-300 text-xs rounded-lg transition-colors"
                >
                  <Trash2 size={12} /> Limpar tudo
                </button>
              </div>
            </div>
          </section>

          {/* Etiquetas */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-1">
              <Tag size={14} className="text-indigo-400" />
              <h2 className="text-sm font-medium text-white">Etiquetas</h2>
            </div>
            <p className="text-xs text-gray-500 mb-4">Organize conversas com etiquetas coloridas. Aplique-as diretamente no painel de mensagens.</p>

            <div className="space-y-2 mb-4">
              <div className="flex gap-2 items-center">
                <input value={labelName} onChange={e => setLabelName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddLabel()}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="Nome da etiqueta..." />
                <button onClick={handleAddLabel} disabled={!labelName.trim()}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg shrink-0">
                  <Plus size={15} />
                </button>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {LABEL_COLORS.map(c => (
                  <button key={c} type="button" onClick={() => setLabelColor(c)}
                    className={`w-6 h-6 rounded-full transition-transform ${labelColor === c ? 'scale-125 ring-2 ring-white ring-offset-1 ring-offset-gray-900' : 'hover:scale-110'}`}
                    style={{ background: c }} />
                ))}
              </div>
            </div>

            {labels.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-3">Nenhuma etiqueta cadastrada.</p>
            ) : (
              <div className="space-y-2">
                {labels.map(label => (
                  <div key={label.id} className="bg-gray-800 rounded-lg p-3">
                    {editingLabel === label.id ? (
                      <div className="space-y-2">
                        <input value={editLabelName} onChange={e => setEditLabelName(e.target.value)}
                          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none" />
                        <div className="flex gap-1.5 flex-wrap">
                          {LABEL_COLORS.map(c => (
                            <button key={c} type="button" onClick={() => setEditLabelColor(c)}
                              className={`w-5 h-5 rounded-full transition-transform ${editLabelColor === c ? 'scale-125 ring-2 ring-white ring-offset-1 ring-offset-gray-800' : 'hover:scale-110'}`}
                              style={{ background: c }} />
                          ))}
                        </div>
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setEditingLabel(null)} className="text-gray-400 hover:text-white p-1"><X size={12} /></button>
                          <button onClick={() => saveEditLabel(label.id)} className="text-green-400 hover:text-green-300 p-1"><Check size={12} /></button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: label.color }} />
                        <span className="text-xs font-medium flex-1" style={{ color: label.color }}>{label.name}</span>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={() => startEditLabel(label)} className="text-gray-500 hover:text-white p-1"><Edit2 size={12} /></button>
                          <button onClick={() => removeLabel(label.id)} className="text-gray-500 hover:text-red-400 p-1"><Trash2 size={12} /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'config' && (
        <div className="space-y-6">
          {/* Geral */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-white mb-4">Geral</h2>
            <div className="space-y-3">

              {/* Tema */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-white">Tema</p>
                  <p className="text-xs text-gray-500">Aparência da interface</p>
                </div>
                <div className="flex gap-0.5 bg-gray-800 p-0.5 rounded-lg">
                  <button
                    type="button"
                    onClick={() => { updateSettings({ theme: 'dark' }); set('theme', 'dark') }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${(form.theme ?? 'dark') === 'dark' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                    <Moon size={12} /> Escuro
                  </button>
                  <button
                    type="button"
                    onClick={() => { updateSettings({ theme: 'light' }); set('theme', 'light') }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${(form.theme ?? 'dark') === 'light' ? 'bg-amber-100 text-gray-900' : 'text-gray-400 hover:text-white'}`}>
                    <Sun size={12} /> Claro
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Nome do Negócio</label>
                <input value={form.businessName} onChange={e => set('businessName', e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="Meu Negócio" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Fuso Horário</label>
                <select value={form.timezone} onChange={e => set('timezone', e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                  <option value="America/Sao_Paulo">America/Sao_Paulo (BRT -3)</option>
                  <option value="America/Manaus">America/Manaus (AMT -4)</option>
                  <option value="America/Fortaleza">America/Fortaleza (BRT -3)</option>
                  <option value="America/Belem">America/Belem (BRT -3)</option>
                  <option value="America/Recife">America/Recife (BRT -3)</option>
                  <option value="America/Cuiaba">America/Cuiaba (AMT -4)</option>
                  <option value="America/Porto_Velho">America/Porto_Velho (AMT -4)</option>
                  <option value="America/Boa_Vista">America/Boa_Vista (AMT -4)</option>
                  <option value="America/Rio_Branco">America/Rio_Branco (ACT -5)</option>
                </select>
              </div>
            </div>
          </section>

          {/* Resposta automática */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-white">Resposta Automática</h2>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={form.autoReply} onChange={e => set('autoReply', e.target.checked)} />
                <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
            {form.autoReply && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Mensagem de resposta automática</label>
                <textarea value={form.autoReplyMessage} onChange={e => set('autoReplyMessage', e.target.value)} rows={3}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>
            )}
          </section>

          {/* Horário comercial */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-white">Horário Comercial</h2>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer"
                  checked={form.businessHours.enabled}
                  onChange={e => setForm(f => ({ ...f, businessHours: { ...f.businessHours, enabled: e.target.checked } }))} />
                <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {form.businessHours.enabled && (
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-400 mb-1">Início</label>
                    <input type="time" value={form.businessHours.start}
                      onChange={e => setForm(f => ({ ...f, businessHours: { ...f.businessHours, start: e.target.value } }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-gray-400 mb-1">Fim</label>
                    <input type="time" value={form.businessHours.end}
                      onChange={e => setForm(f => ({ ...f, businessHours: { ...f.businessHours, end: e.target.value } }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-2">Dias de funcionamento</label>
                  <div className="flex gap-2">
                    {DAYS.map((day, i) => (
                      <button key={i} onClick={() => toggleDay(i)}
                        className={`w-9 h-9 rounded-lg text-xs font-medium ${form.businessHours.days.includes(i) ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Mensagem fora do horário</label>
                  <textarea value={form.outsideHoursMessage} onChange={e => set('outsideHoursMessage', e.target.value)} rows={2}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Webhook */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Info size={15} className="text-indigo-400" />
              <h2 className="text-sm font-medium text-white">Informações do Webhook</h2>
            </div>
            <div className="bg-gray-800 rounded-lg p-4 text-xs space-y-2">
              <p className="text-gray-400">O backend precisa estar rodando em <code className="text-green-400">http://localhost:3001</code></p>
              <p className="text-gray-400">URL do webhook (configure no Meta Developers):</p>
              <code className="block text-green-400 bg-gray-900 rounded p-2">http://seu-dominio.com/api/webhook</code>
              <p className="text-gray-400 mt-2">Para desenvolvimento local use <strong className="text-white">ngrok</strong>:</p>
              <code className="block text-blue-400 bg-gray-900 rounded p-2">ngrok http 3001</code>
              <p className="text-gray-400">Depois configure a URL gerada + <code className="text-green-400">/api/webhook</code> no painel Meta.</p>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
