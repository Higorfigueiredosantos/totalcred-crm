import { useImperativeHandle, forwardRef, useState } from 'react'
import {
  Smartphone, Plus, Trash2, RefreshCw, Wifi, WifiOff,
  X, AlertCircle, Loader2, Settings, Globe, Users,
} from 'lucide-react'
import { useChips, apiFetch } from '../../hooks/useChips'
import type { Chip, ChipTemperature } from '../../types'

function statusColor(s: Chip['status']) {
  if (s === 'connected') return 'text-green-400'
  if (s === 'qr' || s === 'connecting' || s === 'init') return 'text-yellow-400'
  if (s === 'error' || s === 'auth_failure') return 'text-red-400'
  return 'text-gray-400'
}

function statusLabel(s: Chip['status']) {
  const map: Record<string, string> = {
    init: 'Iniciando', connecting: 'Conectando', qr: 'Escaneie o QR',
    connected: 'Conectado', disconnected: 'Desconectado',
    error: 'Erro', auth_failure: 'Falha de autenticação'
  }
  return map[s] ?? s
}

export interface ChipConnectionsHandle {
  openAddModal: () => void
}

interface Props {
  removeChipData: (chipId: string) => void
}

// Conexões via QR Code (API não oficial / whatsapp-web.js) — antes era a página /chips.
const ChipConnections = forwardRef<ChipConnectionsHandle, Props>(({ removeChipData }, ref) => {
  const { chips, setChips, loadChips } = useChips()

  const [showAddModal, setShowAddModal] = useState(false)
  const [newChipId, setNewChipId] = useState('')
  const [adding, setAdding] = useState(false)

  const [showProxyModal, setShowProxyModal] = useState(false)
  const [proxies, setProxies] = useState<string[]>([])
  const [newProxy, setNewProxy] = useState('')
  const [proxyAdding, setProxyAdding] = useState(false)

  const [chipConfigId, setChipConfigId] = useState<string | null>(null)
  const [configLabel, setConfigLabel] = useState('')
  const [configTemp, setConfigTemp] = useState<ChipTemperature>('frio')
  const [configGroups, setConfigGroups] = useState(false)
  const [chipLabels, setChipLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('chip_labels') || '{}') } catch { return {} }
  })
  const [chipGroupSettings, setChipGroupSettings] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('chip_group_settings') || '{}') } catch { return {} }
  })

  useImperativeHandle(ref, () => ({
    openAddModal: () => setShowAddModal(true),
  }))

  const loadProxies = () =>
    fetch('/api/proxies').then(r => r.json()).then(setProxies).catch(() => {})

  async function addProxy() {
    if (!newProxy.trim()) return
    setProxyAdding(true)
    const r = await fetch('/api/proxies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy: newProxy.trim() })
    })
    const d = await r.json()
    if (d.ok) { setProxies(d.list); setNewProxy('') }
    else alert(d.error)
    setProxyAdding(false)
  }

  async function removeProxy(idx: number) {
    const r = await fetch(`/api/proxies/${idx}`, { method: 'DELETE' })
    const d = await r.json()
    if (d.ok) setProxies(d.list)
  }

  async function addChip() {
    const id = newChipId.trim()
    if (!id) return
    setAdding(true)
    await apiFetch('/api/chips/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chipId: id })
    })
    setShowAddModal(false)
    setNewChipId('')
    setAdding(false)
    // Reload list immediately — WS will keep it updated after
    setTimeout(loadChips, 500)
  }

  async function disconnect(chipId: string) {
    if (!confirm(`Desconectar o chip "${chipId}"? A sessão será apagada.`)) return
    await apiFetch('/api/chips/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chipId })
    })
    removeChipData(chipId)
  }

  async function reconnect(chipId: string) {
    await apiFetch('/api/chips/reconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chipId })
    })
  }

  async function setTemperature(chipId: string, temperature: ChipTemperature) {
    await fetch(`/api/chips/${chipId}/temperature`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature })
    })
    setChips(prev => prev.map(c => c.id === chipId ? { ...c, temperature } : c))
  }

  function saveChipLabelToStorage(chipId: string, label: string) {
    const updated = { ...chipLabels, [chipId]: label }
    setChipLabels(updated)
    localStorage.setItem('chip_labels', JSON.stringify(updated))
  }

  function openChipConfig(chip: Chip) {
    setConfigLabel(chipLabels[chip.id] || '')
    setConfigTemp(chip.temperature ?? 'frio')
    setConfigGroups(chipGroupSettings[chip.id] ?? false)
    setChipConfigId(chip.id)
  }

  async function saveChipConfig() {
    if (!chipConfigId) return
    const chip = chips.find(c => c.id === chipConfigId)
    if (!chip) return
    const label = configLabel.trim()
    saveChipLabelToStorage(chipConfigId, label)
    if (configTemp && configTemp !== chip.temperature) {
      await setTemperature(chipConfigId, configTemp)
    }
    const newGroupSettings = { ...chipGroupSettings, [chipConfigId]: configGroups }
    localStorage.setItem('chip_group_settings', JSON.stringify(newGroupSettings))
    setChipGroupSettings(newGroupSettings)
    setChipConfigId(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Chips (API Não Oficial)</h2>
          <p className="text-xs text-gray-400 mt-0.5">Conexões via QR Code — disparo sem API oficial</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadChips}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors">
            <RefreshCw size={14} /> Atualizar
          </button>
          <button onClick={() => { setShowProxyModal(true); loadProxies() }}
            title="Configurar Proxies"
            className="p-2 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white rounded-lg transition-colors">
            <Settings size={15} />
          </button>
          <button onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg transition-colors">
            <Plus size={14} /> Adicionar Chip
          </button>
        </div>
      </div>

      {chips.length === 0 ? (
        <div className="text-center text-gray-500 py-16 border-2 border-dashed border-gray-800 rounded-xl">
          <Smartphone size={40} className="mx-auto mb-3 opacity-25" />
          <p className="text-sm">Nenhum chip conectado.</p>
          <p className="text-xs mt-1 text-gray-600">Clique em "Adicionar Chip" e escaneie o QR Code com o WhatsApp.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {chips.map(chip => (
            <div key={chip.id} className="bg-gray-800 rounded-xl border border-gray-700 p-4 flex flex-col gap-3">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{chipLabels[chip.id] || chip.id}</p>
                  {chipLabels[chip.id] && (
                    <p className="text-[10px] text-gray-600 truncate">{chip.id}</p>
                  )}
                  <p className="text-xs text-gray-400">{chip.number ? `+${chip.number}` : 'Aguardando…'}</p>
                  <span className={`text-[10px] font-medium ${
                    chip.temperature === 'quente' ? 'text-red-400'
                    : chip.temperature === 'morno' ? 'text-yellow-400'
                    : 'text-blue-400'
                  }`}>● {chip.temperature ?? 'frio'}</span>
                  {chip.proxy && (
                    <p className="text-[10px] flex items-center gap-1 truncate text-indigo-400">
                      <Globe size={9} />
                      {chip.proxy.startsWith('rotador:')
                        ? '🔄 Rotação ativa'
                        : chip.proxy.replace(/^https?:\/\//, '').replace(/:[^@]*@/, ':***@')}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button onClick={() => openChipConfig(chip)} title="Configurar chip"
                    className="p-1 text-gray-500 hover:text-white hover:bg-gray-700 rounded-md transition-colors">
                    <Settings size={14} />
                  </button>
                  <span className={`text-xs flex items-center gap-1 ${statusColor(chip.status)}`}>
                    {chip.isReady ? <Wifi size={11} /> : chip.status === 'connecting' || chip.status === 'init' ? <Loader2 size={11} className="animate-spin" /> : <WifiOff size={11} />}
                    {statusLabel(chip.status)}
                  </span>
                </div>
              </div>

              {/* QR Code */}
              {chip.status === 'qr' && chip.qr && (
                <div className="flex flex-col items-center gap-2 bg-white rounded-lg p-3">
                  <img src={chip.qr} alt="QR Code" className="w-44 h-44 object-contain" />
                  <p className="text-xs text-gray-600 font-medium">Escaneie com o WhatsApp</p>
                </div>
              )}

              {/* Waiting for QR */}
              {(chip.status === 'connecting' || chip.status === 'init') && !chip.qr && (
                <div className="flex items-center gap-2 text-yellow-400 text-xs bg-yellow-400/10 rounded-lg px-3 py-2">
                  <Loader2 size={12} className="animate-spin" />
                  Iniciando… O QR aparecerá em breve.
                </div>
              )}

              {(chip.status === 'error' || chip.status === 'auth_failure') && (
                <div className="flex flex-col gap-1 text-red-400 text-xs bg-red-400/10 rounded-lg px-3 py-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    <AlertCircle size={12} /> Erro ao iniciar
                  </span>
                  {chip.errorMsg && (
                    <span className="text-red-300/80 font-mono break-all leading-relaxed">{chip.errorMsg}</span>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button onClick={() => reconnect(chip.id)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg transition-colors">
                  <RefreshCw size={11} /> Reconectar
                </button>
                <button onClick={() => disconnect(chip.id)}
                  className="p-1.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 rounded-lg transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Proxy modal */}
      {showProxyModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-lg space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe size={16} className="text-indigo-400" />
                <h2 className="text-sm font-semibold text-white">Gerenciar Proxies</h2>
              </div>
              <button onClick={() => setShowProxyModal(false)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>

            <div className="bg-indigo-900/20 border border-indigo-800/30 rounded-lg p-3 text-xs text-indigo-300 space-y-1">
              <p className="font-medium">🔄 Rotação automática por requisição</p>
              <p className="text-indigo-400">• Cada mensagem, disparo ou maturação usa um proxy diferente do pool</p>
              <p className="text-indigo-400">• Nunca dois chips usam o mesmo proxy ao mesmo tempo</p>
              <p className="text-indigo-400">• A ordem é aleatória (shuffle) — sem padrão sequencial detectável</p>
              <p className="text-indigo-400">• Formatos: <code className="bg-gray-800 px-1 rounded">host:porta</code>, <code className="bg-gray-800 px-1 rounded">user:pass@host:porta</code>, <code className="bg-gray-800 px-1 rounded">http://host:porta</code></p>
            </div>

            {/* Add proxy */}
            <div className="flex gap-2">
              <input
                value={newProxy} onChange={e => setNewProxy(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addProxy()}
                placeholder="http://host:porta ou socks5://user:pass@host:porta"
                className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <button onClick={addProxy} disabled={!newProxy.trim() || proxyAdding}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg whitespace-nowrap">
                {proxyAdding ? <Loader2 size={13} className="animate-spin" /> : '+ Adicionar'}
              </button>
            </div>

            {/* Proxy list */}
            {proxies.length === 0 ? (
              <div className="text-center py-6 text-gray-600 text-sm">
                <Globe size={24} className="mx-auto mb-2 opacity-30" />
                Nenhum proxy cadastrado. Os chips usarão conexão direta.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {proxies.map((p, i) => {
                  const inUse = chips.find(c => c.proxy === p)
                  return (
                    <div key={i} className="flex items-center gap-2 bg-gray-900 rounded-lg px-3 py-2">
                      <Globe size={12} className={inUse ? 'text-green-400' : 'text-gray-600'} />
                      <span className="flex-1 text-xs font-mono text-gray-300 truncate">
                        {p.replace(/:[^@]*@/, ':***@')}
                      </span>
                      {inUse && (
                        <span className="text-[10px] text-green-400 bg-green-900/30 px-1.5 py-0.5 rounded shrink-0">
                          {inUse.id}
                        </span>
                      )}
                      <button onClick={() => removeProxy(i)}
                        className="text-gray-600 hover:text-red-400 transition-colors shrink-0">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="flex justify-between items-center pt-1 border-t border-gray-700">
              <span className="text-xs text-gray-500">{proxies.length} proxy(s) no pool · {chips.filter(c => c.proxy?.startsWith('rotador:')).length} chip(s) com rotação ativa</span>
              <button onClick={() => setShowProxyModal(false)}
                className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg">Fechar</button>
            </div>
          </div>
        </div>
      )}

      {/* Chip config modal */}
      {chipConfigId && (() => {
        const chip = chips.find(c => c.id === chipConfigId)
        if (!chip) return null
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Settings size={14} className="text-gray-400" /> Configurar Chip
                </h2>
                <button onClick={() => setChipConfigId(null)} className="text-gray-500 hover:text-white">
                  <X size={16} />
                </button>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Nome do Chip</label>
                <input
                  autoFocus
                  value={configLabel}
                  onChange={e => setConfigLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveChipConfig()}
                  placeholder={chip.id}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
                />
                <p className="text-[11px] text-gray-600 mt-1">ID: {chip.id}</p>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-2">Temperatura</label>
                <div className="flex gap-2">
                  {([
                    ['frio',   '#60a5fa', '#1e3a5f', 'Frio'],
                    ['morno',  '#fbbf24', '#3d2e00', 'Morno'],
                    ['quente', '#f87171', '#4c1010', 'Quente'],
                  ] as const).map(([t, activeColor, bg, label]) => (
                    <button key={t} type="button"
                      onClick={() => setConfigTemp(t as ChipTemperature)}
                      style={configTemp === t
                        ? { background: activeColor, color: '#0f172a', boxShadow: `0 0 10px ${activeColor}55` }
                        : { background: bg, color: activeColor }}
                      className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all border-0">
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between py-2 border-t border-gray-700">
                <div>
                  <p className="text-sm text-white flex items-center gap-2">
                    <Users size={14} className="text-gray-400" /> Receber mensagens de grupos
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5">Se desativado, mensagens de grupos não chegam em Mensagens</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
                  <input type="checkbox" className="sr-only peer" checked={configGroups}
                    onChange={e => setConfigGroups(e.target.checked)} />
                  <div className="w-9 h-5 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-600" />
                </label>
              </div>

              <div className="flex gap-2 justify-end pt-1 border-t border-gray-700">
                <button onClick={() => setChipConfigId(null)}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">
                  Cancelar
                </button>
                <button onClick={saveChipConfig}
                  className="px-4 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
                  Salvar
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Add chip modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-4">
            <h2 className="text-sm font-semibold text-white">Adicionar Chip</h2>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Nome / ID do Chip</label>
              <input autoFocus value={newChipId}
                onChange={e => setNewChipId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                onKeyDown={e => e.key === 'Enter' && addChip()}
                placeholder="ex: chip1, vendas, suporte"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500" />
              <p className="text-xs text-gray-500 mt-1">Somente letras, números, _ e -</p>
            </div>

            <div className="bg-gray-900 rounded-lg p-3 text-xs text-gray-400 space-y-1.5">
              <p className="flex items-center gap-1.5"><AlertCircle size={11} className="text-yellow-400 shrink-0" />
                Um QR Code aparecerá no card do chip em 20-60 segundos.</p>
              <p className="flex items-center gap-1.5"><Users size={11} className="text-green-400 shrink-0" />
                Adicione vários chips para disparo em round-robin.</p>
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowAddModal(false); setNewChipId('') }}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancelar</button>
              <button onClick={addChip} disabled={!newChipId.trim() || adding}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-lg">
                {adding ? <><Loader2 size={13} className="animate-spin" /> Conectando…</> : 'Conectar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

ChipConnections.displayName = 'ChipConnections'

export default ChipConnections
