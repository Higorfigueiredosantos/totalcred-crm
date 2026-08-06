import { useImperativeHandle, forwardRef, useState } from 'react'
import {
  FlaskConical, Plus, Trash2, RefreshCw, Wifi, WifiOff,
  X, AlertCircle, Loader2, Settings, Shield, PowerOff,
} from 'lucide-react'
import { useWuzapiInstances } from '../../hooks/useWuzapiInstances'
import { apiFetch } from '../../hooks/useChips'
import type { WuzapiInstance, WuzapiStatus } from '../../types'

function statusColor(s: WuzapiStatus) {
  if (s === 'connected') return 'text-green-400'
  if (s === 'qr' || s === 'connecting') return 'text-yellow-400'
  return 'text-gray-400'
}

function statusLabel(s: WuzapiStatus) {
  const map: Record<WuzapiStatus, string> = {
    connecting: 'Conectando', qr: 'Escaneie o QR',
    connected: 'Conectado', disconnected: 'Desconectado',
  }
  return map[s] ?? s
}

export interface WuzapiConnectionsHandle {
  openAddModal: () => void
}

// Conexões via Wuzapi (whatsmeow) — BETA. Recebe mensagens (chegam em
// Mensagens igual a um chip normal) e dispara botões via Disparador. Se não
// funcionar bem, o plano é remover essa integração.
const WuzapiConnections = forwardRef<WuzapiConnectionsHandle, {}>((_props, ref) => {
  const { instances, loadInstances } = useWuzapiInstances()

  const [showAddModal, setShowAddModal] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [adding, setAdding] = useState(false)

  const [configName, setConfigName] = useState<string | null>(null)
  const [configLabel, setConfigLabel] = useState('')
  const [configProxyUrl, setConfigProxyUrl] = useState('')
  const [configProxyEnabled, setConfigProxyEnabled] = useState(false)
  const [configStatus, setConfigStatus] = useState<WuzapiStatus>('disconnected')
  const [savingProxy, setSavingProxy] = useState(false)

  useImperativeHandle(ref, () => ({
    openAddModal: () => setShowAddModal(true),
  }))

  async function addInstance() {
    const name = newName.trim()
    if (!name) return
    setAdding(true)
    try {
      await apiFetch('/api/wuzapi/instances', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, label: newLabel.trim() || undefined })
      })
      setShowAddModal(false)
      setNewName('')
      setNewLabel('')
    } finally {
      setAdding(false)
      setTimeout(loadInstances, 500)
    }
  }

  async function reconnect(name: string) {
    await apiFetch('/api/wuzapi/instances', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    })
    setTimeout(loadInstances, 500)
  }

  async function removeInstance(name: string) {
    if (!confirm(`Remover a instância "${name}"? A sessão será apagada e será preciso escanear um novo QR.`)) return
    await apiFetch(`/api/wuzapi/instances/${encodeURIComponent(name)}`, { method: 'DELETE' })
    setTimeout(loadInstances, 300)
  }

  function openConfig(inst: WuzapiInstance) {
    setConfigLabel(inst.label || '')
    setConfigProxyUrl(inst.proxyUrl || '')
    setConfigProxyEnabled(!!inst.proxyEnabled)
    setConfigStatus(inst.status)
    setConfigName(inst.name)
  }

  async function saveConfig() {
    if (!configName) return
    await apiFetch(`/api/wuzapi/instances/${encodeURIComponent(configName)}/label`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: configLabel.trim() })
    })

    setSavingProxy(true)
    try {
      const r = await apiFetch(`/api/wuzapi/instances/${encodeURIComponent(configName)}/proxy`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyUrl: configProxyUrl.trim(), enabled: configProxyEnabled })
      })
      if (r?.error) throw new Error(r.error)
      setConfigName(null)
    } catch (e: any) {
      alert(
        /connected|conectad/i.test(e.message || '')
          ? 'Não é possível trocar o proxy com a instância conectada. Desconecte primeiro (botão abaixo) e tente de novo.'
          : `Erro ao salvar proxy: ${e.message}`
      )
    } finally {
      setSavingProxy(false)
      loadInstances()
    }
  }

  async function disconnectFromConfig() {
    if (!configName) return
    await apiFetch(`/api/wuzapi/instances/${encodeURIComponent(configName)}/disconnect`, { method: 'POST' })
    setConfigStatus('disconnected')
    setTimeout(loadInstances, 300)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            Wuzapi <span className="text-[10px] font-bold uppercase tracking-wide bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">Beta</span>
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">WhatsApp via whatsmeow — recebe e envia mensagens, com suporte a botões nativos</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadInstances}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors">
            <RefreshCw size={14} /> Atualizar
          </button>
          <button onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded-lg transition-colors">
            <Plus size={14} /> Adicionar Instância
          </button>
        </div>
      </div>

      {instances.length === 0 ? (
        <div className="text-center text-gray-500 py-16 border-2 border-dashed border-gray-800 rounded-xl">
          <FlaskConical size={40} className="mx-auto mb-3 opacity-25" />
          <p className="text-sm">Nenhuma instância Wuzapi conectada.</p>
          <p className="text-xs mt-1 text-gray-600">Clique em "Adicionar Instância" e escaneie o QR Code com o WhatsApp.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 min-[1600px]:grid-cols-2 gap-4">
          {instances.map(inst => (
            <div key={inst.name} className="bg-gray-800 rounded-xl border border-gray-700 p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{inst.label || inst.name}</p>
                  {inst.label && (
                    <p className="text-[10px] text-gray-600 truncate">{inst.name}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button onClick={() => openConfig(inst)} title="Configurar instância"
                    className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded-md transition-colors">
                    <Settings size={14} />
                  </button>
                  <span className={`text-xs flex items-center gap-1 ${statusColor(inst.status)}`}>
                    {inst.status === 'connected' ? <Wifi size={11} /> : inst.status === 'connecting' ? <Loader2 size={11} className="animate-spin" /> : <WifiOff size={11} />}
                    {statusLabel(inst.status)}
                  </span>
                </div>
              </div>

              {inst.status === 'qr' && inst.qr && (
                <div className="flex flex-col items-center gap-2 bg-white rounded-lg p-3">
                  <img src={inst.qr} alt="QR Code" className="w-44 h-44 object-contain" />
                  <p className="text-xs text-gray-600 font-medium">Escaneie com o WhatsApp</p>
                </div>
              )}

              {inst.status === 'connecting' && !inst.qr && (
                <div className="flex items-center gap-2 text-yellow-400 text-xs bg-yellow-400/10 rounded-lg px-3 py-2">
                  <Loader2 size={12} className="animate-spin" />
                  Iniciando… O QR aparecerá em breve.
                </div>
              )}

              {inst.status === 'disconnected' && (
                <div className="flex items-center gap-2 text-gray-400 text-xs bg-gray-900/50 rounded-lg px-3 py-2">
                  <AlertCircle size={12} />
                  Clique em Reconectar para gerar um novo QR.
                </div>
              )}

              <div className="flex gap-2">
                <button onClick={() => reconnect(inst.name)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg transition-colors">
                  <RefreshCw size={11} /> Reconectar
                </button>
                <button onClick={() => removeInstance(inst.name)}
                  className="p-1.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 rounded-lg transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Config modal */}
      {configName && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Settings size={14} className="text-gray-400" /> Configurar Instância
              </h2>
              <button onClick={() => setConfigName(null)} className="text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nome de exibição</label>
              <input
                autoFocus
                value={configLabel}
                onChange={e => setConfigLabel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveConfig()}
                placeholder={configName}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
              />
              <p className="text-[11px] text-gray-600 mt-1">Instância: {configName}</p>
            </div>

            <div className="border-t border-gray-700 pt-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-white flex items-center gap-2">
                  <Shield size={14} className="text-gray-400" /> Proxy da instância
                </p>
                <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
                  <input type="checkbox" className="sr-only peer" checked={configProxyEnabled}
                    onChange={e => setConfigProxyEnabled(e.target.checked)} />
                  <div className="w-9 h-5 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-600" />
                </label>
              </div>
              {configProxyEnabled && (
                <input
                  value={configProxyUrl}
                  onChange={e => setConfigProxyUrl(e.target.value)}
                  placeholder="socks5://usuario:senha@host:porta"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 font-mono"
                />
              )}
              <p className="text-[11px] text-gray-500">O proxy passa a ser responsável por todas as ações desse canal (envio, recebimento, QR).</p>
              {configStatus !== 'disconnected' && (
                <div className="flex items-center justify-between bg-yellow-900/20 border border-yellow-800/40 rounded-lg px-3 py-2">
                  <span className="text-[11px] text-yellow-300">Desconecte antes de trocar o proxy</span>
                  <button onClick={disconnectFromConfig}
                    className="flex items-center gap-1 text-[11px] text-yellow-400 hover:text-yellow-200 underline">
                    <PowerOff size={11} /> Desconectar
                  </button>
                </div>
              )}
            </div>

            <div className="flex gap-2 justify-end pt-1 border-t border-gray-700">
              <button onClick={() => setConfigName(null)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">
                Cancelar
              </button>
              <button onClick={saveConfig} disabled={savingProxy}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm rounded-lg">
                {savingProxy && <Loader2 size={13} className="animate-spin" />} Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add instance modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-4">
            <h2 className="text-sm font-semibold text-white">Adicionar Instância Wuzapi</h2>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nome / ID da Instância</label>
              <input autoFocus value={newName}
                onChange={e => setNewName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                onKeyDown={e => e.key === 'Enter' && addInstance()}
                placeholder="ex: teste-botao"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
              <p className="text-xs text-gray-500 mt-1">Somente letras, números, _ e -</p>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nome de exibição (opcional)</label>
              <input value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addInstance()}
                placeholder="ex: Teste Wuzapi"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
            </div>

            <div className="bg-gray-900 rounded-lg p-3 text-xs text-gray-400 space-y-1.5">
              <p className="flex items-center gap-1.5"><AlertCircle size={11} className="text-yellow-400 shrink-0" />
                Um QR Code aparecerá no card da instância em alguns segundos.</p>
              <p className="flex items-center gap-1.5"><FlaskConical size={11} className="text-orange-400 shrink-0" />
                Beta: mensagens recebidas chegam em Mensagens; botões são disparados pelo Disparador.</p>
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowAddModal(false); setNewName(''); setNewLabel('') }}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancelar</button>
              <button onClick={addInstance} disabled={!newName.trim() || adding}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm rounded-lg">
                {adding ? <><Loader2 size={13} className="animate-spin" /> Conectando…</> : 'Conectar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

WuzapiConnections.displayName = 'WuzapiConnections'

export default WuzapiConnections
