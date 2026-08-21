import { useImperativeHandle, forwardRef, useState } from 'react'
import {
  MessageSquare, Plus, Trash2, RefreshCw, Wifi, WifiOff,
  X, AlertCircle, Loader2, Settings,
} from 'lucide-react'
import { useSmsInstances } from '../../hooks/useSmsInstances'
import { apiFetch } from '../../hooks/useChips'
import type { SmsInstance, SmsStatus } from '../../types'

function statusColor(s: SmsStatus) {
  if (s === 'connected') return 'text-green-400'
  if (s === 'qr' || s === 'connecting') return 'text-yellow-400'
  if (s === 'error') return 'text-red-400'
  return 'text-gray-400'
}

function statusLabel(s: SmsStatus) {
  const map: Record<SmsStatus, string> = {
    connecting: 'Conectando', qr: 'Escaneie o QR',
    connected: 'Conectado', disconnected: 'Desconectado', error: 'Erro',
  }
  return map[s] ?? s
}

export interface SmsConnectionsHandle {
  openAddModal: () => void
}

// Conexões via SMS (BETA) — automação do Google Messages Web
// (messages.google.com/web), pareado por QR igual ao WhatsApp Web. Envio
// puro texto pelo Disparador; sem leitura de mensagens recebidas nesta
// versão.
const SmsConnections = forwardRef<SmsConnectionsHandle, {}>((_props, ref) => {
  const { instances, loadInstances } = useSmsInstances()

  const [showAddModal, setShowAddModal] = useState(false)
  const [newId, setNewId] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [adding, setAdding] = useState(false)

  const [configId, setConfigId] = useState<string | null>(null)
  const [configLabel, setConfigLabel] = useState('')
  const [savingLabel, setSavingLabel] = useState(false)

  useImperativeHandle(ref, () => ({
    openAddModal: () => setShowAddModal(true),
  }))

  async function addInstance() {
    const id = newId.trim()
    if (!id) return
    setAdding(true)
    try {
      await apiFetch('/api/sms/instances', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, label: newLabel.trim() || undefined })
      })
      setShowAddModal(false)
      setNewId('')
      setNewLabel('')
    } finally {
      setAdding(false)
      setTimeout(loadInstances, 500)
    }
  }

  async function reconnect(id: string) {
    await apiFetch(`/api/sms/instances/${encodeURIComponent(id)}/reconnect`, { method: 'POST' })
    setTimeout(loadInstances, 500)
  }

  async function removeInstance(id: string) {
    if (!confirm(`Remover a sessão "${id}"? Será preciso escanear um novo QR.`)) return
    await apiFetch(`/api/sms/instances/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setTimeout(loadInstances, 300)
  }

  function openConfig(inst: SmsInstance) {
    setConfigLabel(inst.label || '')
    setConfigId(inst.id)
  }

  async function saveConfig() {
    if (!configId) return
    setSavingLabel(true)
    try {
      await apiFetch(`/api/sms/instances/${encodeURIComponent(configId)}/label`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: configLabel.trim() })
      })
      setConfigId(null)
    } finally {
      setSavingLabel(false)
      loadInstances()
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            SMS <span className="text-[10px] font-bold uppercase tracking-wide bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">Beta</span>
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">Disparo de SMS via Google Messages Web — pareie o Android por QR</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadInstances}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors">
            <RefreshCw size={14} /> Atualizar
          </button>
          <button onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
            <Plus size={14} /> Adicionar Sessão
          </button>
        </div>
      </div>

      {instances.length === 0 ? (
        <div className="text-center text-gray-500 py-16 border-2 border-dashed border-gray-800 rounded-xl">
          <MessageSquare size={40} className="mx-auto mb-3 opacity-25" />
          <p className="text-sm">Nenhuma sessão de SMS conectada.</p>
          <p className="text-xs mt-1 text-gray-600">Clique em "Adicionar Sessão" e escaneie o QR Code com o celular Android (Google Messages).</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 min-[1600px]:grid-cols-3 gap-3">
          {instances.map(inst => (
            <div key={inst.id} className="bg-gray-800 rounded-lg border border-gray-700 p-2.5 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-1.5">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{inst.label || inst.id}</p>
                  {inst.label && (
                    <p className="text-[9px] text-gray-600 truncate">{inst.id}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button onClick={() => openConfig(inst)} title="Configurar sessão"
                    className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded-md transition-colors">
                    <Settings size={12} />
                  </button>
                  <span className={`text-[10px] flex items-center gap-1 ${statusColor(inst.status)}`}>
                    {inst.status === 'connected' ? <Wifi size={10} /> : inst.status === 'connecting' ? <Loader2 size={10} className="animate-spin" /> : <WifiOff size={10} />}
                    {statusLabel(inst.status)}
                  </span>
                </div>
              </div>

              {inst.status === 'qr' && inst.qr && (
                <div className="flex flex-col items-center gap-1.5 bg-white rounded-lg p-2">
                  <img src={inst.qr} alt="QR Code" className="w-32 h-32 object-contain" />
                  <p className="text-[10px] text-gray-600 font-medium">Escaneie com o Google Messages</p>
                </div>
              )}

              {inst.status === 'connecting' && !inst.qr && (
                <div className="flex items-center gap-2 text-yellow-400 text-[10px] bg-yellow-400/10 rounded-lg px-2 py-1.5">
                  <Loader2 size={11} className="animate-spin" />
                  Iniciando… O QR aparecerá em breve.
                </div>
              )}

              {inst.status === 'error' && (
                <div className="flex items-center gap-2 text-red-400 text-[10px] bg-red-400/10 rounded-lg px-2 py-1.5">
                  <AlertCircle size={11} />
                  {inst.errorMsg || 'Erro na sessão.'}
                </div>
              )}

              {inst.status === 'disconnected' && (
                <div className="flex items-center gap-2 text-gray-400 text-[10px] bg-gray-900/50 rounded-lg px-2 py-1.5">
                  <AlertCircle size={11} />
                  Clique em Reconectar para gerar um novo QR.
                </div>
              )}

              <div className="flex gap-1.5">
                <button onClick={() => reconnect(inst.id)}
                  className="flex-1 flex items-center justify-center gap-1 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-[10px] rounded-md transition-colors">
                  <RefreshCw size={10} /> Reconectar
                </button>
                <button onClick={() => removeInstance(inst.id)}
                  className="p-1 bg-red-900/40 hover:bg-red-800/60 text-red-400 rounded-md transition-colors">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Config modal */}
      {configId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Settings size={14} className="text-gray-400" /> Configurar Sessão
              </h2>
              <button onClick={() => setConfigId(null)} className="text-gray-500 hover:text-white">
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
                placeholder={configId}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <p className="text-[11px] text-gray-600 mt-1">Sessão: {configId}</p>
            </div>

            <div className="flex gap-2 justify-end pt-1 border-t border-gray-700">
              <button onClick={() => setConfigId(null)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">
                Cancelar
              </button>
              <button onClick={saveConfig} disabled={savingLabel}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg">
                {savingLabel && <Loader2 size={13} className="animate-spin" />} Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add instance modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-4">
            <h2 className="text-sm font-semibold text-white">Adicionar Sessão SMS</h2>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nome / ID da Sessão</label>
              <input autoFocus value={newId}
                onChange={e => setNewId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                onKeyDown={e => e.key === 'Enter' && addInstance()}
                placeholder="ex: sms-principal"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
              <p className="text-xs text-gray-500 mt-1">Somente letras, números, _ e -</p>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nome de exibição (opcional)</label>
              <input value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addInstance()}
                placeholder="ex: SMS Principal"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
            </div>

            <div className="bg-gray-900 rounded-lg p-3 text-xs text-gray-400 space-y-1.5">
              <p className="flex items-center gap-1.5"><AlertCircle size={11} className="text-yellow-400 shrink-0" />
                Um QR Code aparecerá no card da sessão em alguns segundos.</p>
              <p className="flex items-center gap-1.5"><MessageSquare size={11} className="text-blue-400 shrink-0" />
                Beta: só envia texto puro pelo Disparador, sem leitura de mensagens recebidas.</p>
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowAddModal(false); setNewId(''); setNewLabel('') }}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancelar</button>
              <button onClick={addInstance} disabled={!newId.trim() || adding}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg">
                {adding ? <><Loader2 size={13} className="animate-spin" /> Conectando…</> : 'Conectar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

SmsConnections.displayName = 'SmsConnections'

export default SmsConnections
