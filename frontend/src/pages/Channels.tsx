import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useAuthStore } from '../store/auth'
import type { Channel, ProxyConfig } from '../types'
import {
  Plus, Trash2, RefreshCw, Copy, CheckCircle, XCircle, Edit2, Shield,
  ChevronDown, ChevronUp, Loader2, Download, Zap, X, Smartphone, Globe
} from 'lucide-react'
import { v4 as uuid } from '../utils/uuid'
import ChipConnections, { type ChipConnectionsHandle } from './channels/ChipConnections'

const defaultProxy: ProxyConfig = {
  enabled: false, type: 'http', host: '', port: 8080, username: '', password: '',
}

// ── Quality helpers ────────────────────────────────────────────────────────────

function qualityMeta(q: string | undefined) {
  if (q === 'GREEN')  return { label: 'Alta',  bar: 'bg-green-500',  text: 'text-green-400',  badge: 'bg-green-900/30 border-green-800/40 text-green-400' }
  if (q === 'YELLOW') return { label: 'Média', bar: 'bg-yellow-500', text: 'text-yellow-400', badge: 'bg-yellow-900/30 border-yellow-800/40 text-yellow-400' }
  if (q === 'RED')    return { label: 'Baixa', bar: 'bg-red-500',    text: 'text-red-400',    badge: 'bg-red-900/30 border-red-800/40 text-red-400' }
  return { label: '—', bar: 'bg-gray-700', text: 'text-gray-500', badge: 'bg-gray-800 border-gray-700 text-gray-500' }
}

// ── Proxy section ──────────────────────────────────────────────────────────────

function ProxySection({ proxy, onChange }: { proxy: ProxyConfig; onChange: (p: ProxyConfig) => void }) {
  const [open, setOpen] = useState(proxy.enabled)
  const set = (k: keyof ProxyConfig, v: any) => onChange({ ...proxy, [k]: v })

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm">
        <div className="flex items-center gap-2">
          <Shield size={14} className={proxy.enabled ? 'text-indigo-400' : 'text-gray-500'} />
          <span className={proxy.enabled ? 'text-indigo-300' : 'text-gray-400'}>
            Proxy {proxy.enabled ? `— ${proxy.type.toUpperCase()} ${proxy.host}:${proxy.port}` : '(opcional)'}
          </span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {open && (
        <div className="p-3 space-y-3 bg-gray-800/50">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={proxy.enabled} onChange={e => set('enabled', e.target.checked)}
              className="w-4 h-4 accent-indigo-500" />
            <span className="text-sm text-gray-300">Ativar proxy para este canal</span>
          </label>
          {proxy.enabled && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tipo</label>
                <div className="flex gap-1">
                  {(['http', 'https', 'socks5'] as const).map(t => (
                    <button key={t} onClick={() => set('type', t)}
                      className={`flex-1 py-1.5 text-xs rounded-lg font-mono font-medium transition-colors ${
                        proxy.type === t ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'
                      }`}>{t.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">Host</label>
                  <input value={proxy.host} onChange={e => set('host', e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                    placeholder="192.168.1.100 ou proxy.example.com" />
                </div>
                <div className="w-24">
                  <label className="block text-xs text-gray-500 mb-1">Porta</label>
                  <input value={proxy.port} onChange={e => set('port', parseInt(e.target.value) || 0)}
                    type="number" min="1" max="65535"
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                    placeholder="8080" />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">Usuário (opcional)</label>
                  <input value={proxy.username ?? ''} onChange={e => set('username', e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    placeholder="user" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">Senha (opcional)</label>
                  <input value={proxy.password ?? ''} onChange={e => set('password', e.target.value)}
                    type="password"
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    placeholder="••••••••" />
                </div>
              </div>
              <div className="bg-gray-900 rounded-lg p-2 text-xs font-mono text-gray-400">
                {proxy.username
                  ? `${proxy.type}://${proxy.username}:***@${proxy.host}:${proxy.port}`
                  : `${proxy.type}://${proxy.host}:${proxy.port}`}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Type chooser (Oficial vs Não Oficial) ──────────────────────────────────────

function ChannelTypeChooser({
  showUnofficial, onClose, onPickOfficial, onPickUnofficial,
}: { showUnofficial: boolean; onClose: () => void; onPickOfficial: () => void; onPickUnofficial: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">Novo Canal</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-gray-400 mb-1">Escolha como este canal vai se conectar:</p>
          <button onClick={onPickOfficial}
            className="w-full flex items-start gap-3 p-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-indigo-600 rounded-xl text-left transition-colors">
            <div className="w-9 h-9 rounded-lg bg-indigo-900/50 flex items-center justify-center shrink-0">
              <Globe size={16} className="text-indigo-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">API Oficial (Meta Cloud API)</p>
              <p className="text-xs text-gray-400 mt-0.5">Conecta via Phone Number ID, WABA e Access Token da Meta.</p>
            </div>
          </button>
          {showUnofficial && (
            <button onClick={onPickUnofficial}
              className="w-full flex items-start gap-3 p-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-green-600 rounded-xl text-left transition-colors">
              <div className="w-9 h-9 rounded-lg bg-green-900/50 flex items-center justify-center shrink-0">
                <Smartphone size={16} className="text-green-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">API Não Oficial (QR Code)</p>
                <p className="text-xs text-gray-400 mt-0.5">Conecta um número via WhatsApp Web, escaneando um QR Code.</p>
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Channel modal (create/edit) ────────────────────────────────────────────────

function Modal({ ch, onClose, onSave }: { ch?: Channel; onClose: () => void; onSave: (c: Channel) => void }) {
  const [form, setForm] = useState<Channel>(ch ?? {
    id: uuid(), name: '', phoneNumberId: '', accessToken: '', wabaId: '',
    webhookVerifyToken: uuid().replace(/-/g, ''), status: 'disconnected', phoneNumber: '',
    proxy: { ...defaultProxy },
  })

  const set = (k: keyof Channel, v: any) => setForm(f => ({ ...f, [k]: v }))

  async function testConnection() {
    try {
      let data: any
      if (form.proxy?.enabled) {
        const res = await fetch('/api/graph', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'GET', path: `/${form.phoneNumberId}`,
            params: { fields: 'display_phone_number,verified_name' },
            accessToken: form.accessToken, proxy: form.proxy,
          }),
        })
        data = await res.json()
      } else {
        const res = await fetch(
          `https://graph.facebook.com/v20.0/${form.phoneNumberId}?fields=display_phone_number,verified_name&access_token=${form.accessToken}`
        )
        data = await res.json()
      }
      if (data.error) throw new Error(data.error.message)
      setForm(f => ({ ...f, status: 'connected', phoneNumber: data.display_phone_number }))
      alert(`Conectado: ${data.verified_name} (${data.display_phone_number})`)
    } catch (e: any) {
      setForm(f => ({ ...f, status: 'error' }))
      alert(`Erro: ${e.message}`)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">{ch ? 'Editar Canal' : 'Novo Canal WhatsApp'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Nome do Canal</label>
            <input value={form.name} onChange={e => set('name', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="Ex: Suporte Principal" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Phone Number ID</label>
            <input value={form.phoneNumberId} onChange={e => set('phoneNumberId', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
              placeholder="123456789012345" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">WABA ID</label>
            <input value={form.wabaId} onChange={e => set('wabaId', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
              placeholder="987654321012345" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Access Token (permanente)</label>
            <input value={form.accessToken} onChange={e => set('accessToken', e.target.value)}
              type="password"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono"
              placeholder="EAAxxxxxxxxxxxxxxx" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Webhook Verify Token</label>
            <div className="flex gap-2">
              <input value={form.webhookVerifyToken} readOnly
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono" />
              <button onClick={() => navigator.clipboard.writeText(form.webhookVerifyToken)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white">
                <Copy size={14} />
              </button>
            </div>
          </div>
          <ProxySection proxy={form.proxy ?? { ...defaultProxy }} onChange={p => set('proxy', p)} />
          <div className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400">
            <p className="font-medium text-gray-300 mb-1">URL do Webhook:</p>
            <code className="text-green-400">https://seu-dominio.com/api/webhook</code>
            <p className="mt-2">Verify Token: <span className="text-gray-300 font-mono">{form.webhookVerifyToken}</span></p>
          </div>
        </div>
        <div className="flex gap-2 p-5 border-t border-gray-800">
          <button onClick={testConnection}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm text-white rounded-lg">
            <RefreshCw size={14} /> Testar Conexão
          </button>
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={() => onSave(form)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Register modal (ativar Cloud API) ─────────────────────────────────────────

function RegisterModal({ ch, onClose }: { ch: Channel; onClose: () => void }) {
  const [pin, setPin] = useState('000000')
  const [loading, setLoading] = useState(false)

  async function doRegister() {
    if (!/^\d{6}$/.test(pin)) return alert('O PIN deve ter exatamente 6 dígitos.')
    setLoading(true)
    try {
      const res = await fetch(`https://graph.facebook.com/v25.0/${ch.phoneNumberId}/register`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ch.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      alert('Número registrado com sucesso na Meta!')
      onClose()
    } catch (e: any) {
      alert(`Erro ao registrar: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">Registrar na Meta</h2>
            <p className="text-xs text-gray-400 mt-0.5">{ch.name} · {ch.phoneNumber || ch.phoneNumberId}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-400">
            Registra o número na Cloud API da Meta (ativa o uso via API oficial). O PIN é o código de verificação de 2 fatores configurado no gerenciador.
          </p>
          <div>
            <label className="block text-xs text-gray-400 mb-1">PIN de verificação (6 dígitos)</label>
            <input
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono text-center tracking-widest focus:outline-none focus:border-indigo-500"
              placeholder="000000"
            />
            <p className="text-[10px] text-gray-500 mt-1">Se não configurou 2FA, use 000000</p>
          </div>
          <div className="bg-gray-800/60 rounded-lg p-3 text-xs font-mono text-gray-400 space-y-1">
            <p className="text-gray-500">POST /v25.0/{ch.phoneNumberId}/register</p>
            <p className="text-gray-300">{'{ "messaging_product": "whatsapp", "pin": "' + pin + '" }'}</p>
          </div>
        </div>
        <div className="flex gap-2 p-5 border-t border-gray-800">
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={doRegister} disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm text-white rounded-lg">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            Registrar
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Import WABA modal ──────────────────────────────────────────────────────────

function ImportWabaModal({
  sourceCh, existingChannels, onImport, onClose
}: { sourceCh: Channel; existingChannels: Channel[]; onImport: (chs: Channel[]) => void; onClose: () => void }) {
  const [useManual, setUseManual] = useState(false)
  const [customWabaId, setCustomWabaId] = useState('')
  const [customToken, setCustomToken] = useState('')
  const [numbers, setNumbers] = useState<any[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const wabaId = useManual ? customWabaId : (sourceCh.wabaId || '')
  const token  = useManual ? customToken  : (sourceCh.accessToken || '')

  const alreadyById = new Set(existingChannels.map(c => c.phoneNumberId).filter(Boolean))

  async function fetchNumbers() {
    if (!wabaId || !token) return alert('Informe o WABA ID e o Access Token.')
    setLoading(true)
    setNumbers([])
    setSelected(new Set())
    try {
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&access_token=${token}`
      )
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      const list: any[] = data.data || []
      setNumbers(list)
      // pré-seleciona apenas os números ainda não importados
      setSelected(new Set(list.filter(n => !alreadyById.has(n.id)).map(n => n.id)))
    } catch (e: any) {
      alert(`Erro: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  function selectAllNew() {
    setSelected(new Set(numbers.filter(n => !alreadyById.has(n.id)).map(n => n.id)))
  }

  function doImport() {
    const toImport: Channel[] = numbers
      .filter(n => selected.has(n.id) && !alreadyById.has(n.id))
      .map(n => ({
        id: uuid(),
        name: n.verified_name || n.display_phone_number,
        phoneNumberId: n.id,
        accessToken: token,
        wabaId,
        webhookVerifyToken: uuid().replace(/-/g, ''),
        status: 'connected' as const,
        phoneNumber: n.display_phone_number,
        proxy: { ...defaultProxy },
      }))
    onImport(toImport)
  }

  const newCount = numbers.filter(n => !alreadyById.has(n.id)).length

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="font-semibold text-white">Buscar números da WABA</h2>
            <p className="text-xs text-gray-400 mt-0.5">{sourceCh.name} · WABA: {sourceCh.wabaId || '?'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">

          {/* Credential toggle */}
          <div className="space-y-3">
            <div className="flex gap-2">
              <button onClick={() => setUseManual(false)}
                className={`flex-1 py-1.5 text-xs rounded-lg font-medium transition-colors border ${
                  !useManual ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}>
                Usar credenciais do canal
              </button>
              <button onClick={() => setUseManual(true)}
                className={`flex-1 py-1.5 text-xs rounded-lg font-medium transition-colors border ${
                  useManual ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
                }`}>
                Inserir manualmente
              </button>
            </div>

            {!useManual ? (
              <div className="bg-gray-800/60 rounded-lg px-3 py-2 text-xs space-y-0.5">
                <p className="text-gray-500">WABA ID: <span className="text-gray-300 font-mono">{sourceCh.wabaId || '—'}</span></p>
                <p className="text-gray-500">Token: <span className="text-gray-300 font-mono">{sourceCh.accessToken ? '••••••••' + sourceCh.accessToken.slice(-6) : '—'}</span></p>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">WABA ID</label>
                  <input value={customWabaId} onChange={e => setCustomWabaId(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                    placeholder="987654321012345" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Access Token</label>
                  <input value={customToken} onChange={e => setCustomToken(e.target.value)} type="password"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                    placeholder="EAAxxxx" />
                </div>
              </>
            )}
          </div>

          {/* Fetch button — always visible */}
          <button onClick={fetchNumbers} disabled={loading}
            className="flex items-center justify-center gap-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm text-white rounded-lg font-medium transition-colors">
            {loading ? <><Loader2 size={14} className="animate-spin" /> Buscando...</> : <><RefreshCw size={14} /> Buscar números da WABA</>}
          </button>

          {/* Number list */}
          {numbers.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {numbers.length} encontrado(s) · <span className="text-green-400">{newCount} novo(s)</span>
                </p>
                <button onClick={selectAllNew} className="text-xs text-indigo-400 hover:text-indigo-300">
                  Selecionar novos
                </button>
              </div>
              {numbers.map(n => {
                const q = qualityMeta(n.quality_rating)
                const already = alreadyById.has(n.id)
                const isSelected = selected.has(n.id)
                return (
                  <div key={n.id}
                    onClick={() => !already && toggleSelect(n.id)}
                    className={`flex items-center gap-3 p-3 rounded-lg transition-colors border ${
                      already
                        ? 'bg-gray-800/40 border-gray-700/40 cursor-default opacity-60'
                        : isSelected
                          ? 'bg-indigo-900/30 border-indigo-700/50 cursor-pointer'
                          : 'bg-gray-800 border-gray-700 cursor-pointer hover:bg-gray-700'
                    }`}>
                    <input type="checkbox" checked={isSelected} disabled={already}
                      onChange={() => !already && toggleSelect(n.id)}
                      className="accent-indigo-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{n.verified_name}</p>
                      <p className="text-xs text-gray-400">{n.display_phone_number}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {already && (
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-700 border border-gray-600 text-gray-400">
                          Já adicionado
                        </span>
                      )}
                      <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${q.badge}`}>
                        {q.label}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex gap-2 p-5 border-t border-gray-800 shrink-0">
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={doImport} disabled={selected.size === 0}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-sm text-white rounded-lg">
            <Download size={14} /> Conectar {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function Channels() {
  const { channels, addChannel, updateChannel, removeChannel, removeChipData } = useStore()
  const { can } = useAuthStore()
  const [modal, setModal] = useState<{ open: boolean; ch?: Channel }>({ open: false })
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [qualityMap, setQualityMap] = useState<Record<string, string>>({})
  const [registerCh, setRegisterCh] = useState<Channel | null>(null)
  const [importCh, setImportCh] = useState<Channel | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const chipConnectionsRef = useRef<ChipConnectionsHandle>(null)
  const canUnofficial = can('chipsPage')

  // Sync channels to backend so IATab and other backend-fetchers always see the latest
  useEffect(() => {
    fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(channels),
    }).catch(() => {})
  }, [channels])

  // Fetch quality for all channels with credentials on mount
  useEffect(() => {
    channels.forEach(ch => { if (ch.wabaId && ch.accessToken) fetchQuality(ch) })
  }, [channels.length])

  async function fetchQuality(ch: Channel) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${ch.wabaId}/phone_numbers?fields=id,quality_rating&access_token=${ch.accessToken}`
      )
      const data = await res.json()
      if (!data.data) return
      const match = data.data.find((d: any) => d.id === ch.phoneNumberId)
      if (match?.quality_rating) {
        setQualityMap(prev => ({ ...prev, [ch.id]: match.quality_rating }))
      }
    } catch (_) {}
  }

  function handleSave(ch: Channel) {
    if (channels.find(c => c.id === ch.id)) updateChannel(ch.id, ch)
    else addChannel(ch)
    setModal({ open: false })
    if (ch.wabaId && ch.accessToken) fetchQuality(ch)
  }

  function handleImport(newChannels: Channel[]) {
    newChannels.forEach(ch => {
      if (!channels.find(c => c.phoneNumberId === ch.phoneNumberId)) addChannel(ch)
    })
    setImportCh(null)
  }

  async function verifyChannel(ch: Channel) {
    if (!ch.accessToken || !ch.phoneNumberId) return alert('Preencha o Access Token e o Phone Number ID antes de verificar.')
    setVerifyingId(ch.id)
    try {
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${ch.phoneNumberId}?fields=display_phone_number,verified_name&access_token=${ch.accessToken}`
      )
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      updateChannel(ch.id, { status: 'connected', phoneNumber: data.display_phone_number })
      fetchQuality(ch)
    } catch (e: any) {
      updateChannel(ch.id, { status: 'error' })
      alert(`Erro ao verificar: ${e.message}`)
    } finally {
      setVerifyingId(null)
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Canais WhatsApp</h1>
          <p className="text-sm text-gray-400 mt-1">Gerencie suas contas WhatsApp Business API</p>
        </div>
        <button onClick={() => setChooserOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
          <Plus size={16} /> Novo Canal
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 items-start">
      <div>
        <h2 className="text-base font-semibold text-white mb-4">Canais Oficiais</h2>
        {channels.length === 0 ? (
        <div className="border-2 border-dashed border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-400 mb-2">Nenhum canal configurado</p>
          <button onClick={() => setChooserOpen(true)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
            Adicionar Canal
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 min-[1600px]:grid-cols-2 gap-4">
          {channels.map(ch => {
            const q = qualityMeta(qualityMap[ch.id])
            return (
              <div key={ch.id} className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden flex flex-col">
                {/* Quality bar */}
                <div className={`h-1 w-full ${q.bar} transition-colors`} title={`Qualidade: ${q.label}`} />

                <div className="p-4 flex flex-col gap-3 flex-1">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-semibold text-white truncate">{ch.name}</p>
                        {qualityMap[ch.id] && (
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${q.badge}`}>
                            {q.label}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 truncate">{ch.phoneNumber || '—'}</p>
                      <span className={`text-[10px] font-medium flex items-center gap-1 ${
                        ch.status === 'connected' ? 'text-green-400'
                        : ch.status === 'error' ? 'text-red-400'
                        : 'text-gray-500'
                      }`}>
                        {ch.status === 'connected' ? <CheckCircle size={10} />
                          : ch.status === 'error' ? <XCircle size={10} />
                          : <RefreshCw size={10} />}
                        {ch.status === 'connected' ? 'Conectado'
                          : ch.status === 'error' ? 'Credenciais inválidas'
                          : 'Não verificado'}
                      </span>
                      {ch.proxy?.enabled && (
                        <span className="text-[10px] flex items-center gap-1 text-indigo-400 truncate">
                          <Shield size={9} /> {ch.proxy.type.toUpperCase()} proxy
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <button onClick={() => setModal({ open: true, ch })}
                        className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded-md transition-colors">
                        <Edit2 size={14} />
                      </button>
                      <button onClick={() => removeChannel(ch.id)}
                        className="p-1 text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded-md transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="flex flex-col gap-1.5 text-[10px]">
                    <div className="bg-gray-900/60 rounded-lg px-2.5 py-1.5">
                      <p className="text-gray-500 mb-0.5">Phone Number ID</p>
                      <p className="text-gray-300 font-mono truncate">{ch.phoneNumberId || '—'}</p>
                    </div>
                    <div className="bg-gray-900/60 rounded-lg px-2.5 py-1.5">
                      <p className="text-gray-500 mb-0.5">WABA ID</p>
                      <p className="text-gray-300 font-mono truncate">{ch.wabaId || '—'}</p>
                    </div>
                    <div className="bg-gray-900/60 rounded-lg px-2.5 py-1.5">
                      <p className="text-gray-500 mb-0.5">Webhook URL <span className="text-yellow-500">(precisa ser pública)</span></p>
                      <p className="text-yellow-400 font-mono truncate text-[9px]">https://seu-dominio.com/api/webhook</p>
                      <p className="text-gray-600 text-[9px] mt-0.5">Use ngrok http 3001 para desenvolvimento local</p>
                    </div>
                    <div className="bg-gray-900/60 rounded-lg px-2.5 py-1.5">
                      <p className="text-gray-500 mb-0.5">Verify Token</p>
                      <p className="text-gray-300 font-mono truncate">{ch.webhookVerifyToken || '—'}</p>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-col gap-1.5 mt-auto">
                    <button
                      onClick={() => setImportCh(ch)}
                      className="flex items-center justify-center gap-1.5 w-full py-1.5 text-xs rounded-lg bg-green-900/40 hover:bg-green-600 border border-green-800/50 text-green-300 hover:text-white transition-colors"
                    >
                      <Download size={11} /> Buscar números WABA
                    </button>
                    <button
                      onClick={() => setRegisterCh(ch)}
                      className="flex items-center justify-center gap-1.5 w-full py-1.5 text-xs rounded-lg bg-indigo-900/40 hover:bg-indigo-600 border border-indigo-800/50 text-indigo-300 hover:text-white transition-colors"
                    >
                      <Zap size={11} /> Registrar na Meta
                    </button>
                    <button
                      onClick={() => verifyChannel(ch)}
                      disabled={verifyingId === ch.id}
                      className="flex items-center justify-center gap-1.5 w-full py-1.5 text-xs rounded-lg bg-gray-900/60 hover:bg-gray-700 text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
                    >
                      {verifyingId === ch.id
                        ? <><Loader2 size={11} className="animate-spin" /> Verificando...</>
                        : <><RefreshCw size={11} /> Verificar conexão</>}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      </div>

      {canUnofficial && (
        <div>
          <ChipConnections ref={chipConnectionsRef} removeChipData={removeChipData} />
        </div>
      )}
      </div>

      {chooserOpen && (
        <ChannelTypeChooser
          showUnofficial={canUnofficial}
          onClose={() => setChooserOpen(false)}
          onPickOfficial={() => { setChooserOpen(false); setModal({ open: true }) }}
          onPickUnofficial={() => { setChooserOpen(false); chipConnectionsRef.current?.openAddModal() }}
        />
      )}

      {modal.open && (
        <Modal ch={modal.ch} onClose={() => setModal({ open: false })} onSave={handleSave} />
      )}
      {registerCh && (
        <RegisterModal ch={registerCh} onClose={() => setRegisterCh(null)} />
      )}
      {importCh && (
        <ImportWabaModal
          sourceCh={importCh}
          existingChannels={channels}
          onImport={handleImport}
          onClose={() => setImportCh(null)}
        />
      )}
    </div>
  )
}
