import { useState, useEffect, useRef, useMemo } from 'react'
import { useStore } from '../store'
import {
  Smartphone, Plus, Trash2, RefreshCw, Wifi, WifiOff,
  Play, Pause, Square, RotateCcw, Send, Upload, X,
  ChevronDown, ChevronUp, CheckCircle, XCircle, Clock,
  Zap, Shield, AlertCircle, Users, Loader2, Eye, FileText, MessageSquare,
  Settings, Globe
} from 'lucide-react'
import { onWSMessage } from '../api/websocket'
import type { Chip, ChipTemperature, ChipCampaignResult, ChipCampaignSettings, CampaignHistoryRecord, CsvContact } from '../types'

// ── Greeting pool (mirrors backend openingPhrases) ────────────────────────────
const ALL_GREETINGS = [
  'Oi, tudo bem?', 'Olá! Tudo certo?', 'E aí, como vai?', 'Oi! Espero que esteja bem.',
  'Bom dia! 😊', 'Boa tarde!', 'Boa noite!', 'Oi! 👋', 'Olá! 😊', 'E aí! Tudo na paz?'
]

// ── Status helpers ────────────────────────────────────────────────────────────

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

function parseContacts(text: string): CsvContact[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [num, ...rest] = l.split(/[,;\t]/)
    return { number: (num || '').replace(/\D/g, ''), name: rest.join(' ').trim(), vars: {} }
  }).filter(c => c.number.length >= 8)
}

function parseCsv(text: string): { contacts: CsvContact[]; extraHeaders: string[] } {
  const splitLine = (l: string): string[] => {
    const result: string[] = []; let cur = ''; let inQ = false
    for (const ch of l) {
      if (ch === '"') { inQ = !inQ; continue }
      if ((ch === ',' || ch === ';' || ch === '|' || ch === '\t') && !inQ) { result.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    result.push(cur.trim())
    return result
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return { contacts: [], extraHeaders: [] }
  const firstCols = splitLine(lines[0])
  const firstIsHeader = !/^\d{8,}/.test(firstCols[0].replace(/\D/g, ''))
  let headers: string[]
  let dataRows: string[]
  if (firstIsHeader) {
    headers = firstCols.map(h => h.toLowerCase().trim())
    dataRows = lines.slice(1)
  } else {
    headers = firstCols.map((_, i) => i === 0 ? 'telefone' : i === 1 ? 'nome' : `coluna${i}`)
    dataRows = lines
  }
  const extraHeaders = headers.slice(2)
  const contacts: CsvContact[] = dataRows.map(line => {
    const parts = splitLine(line)
    const number = (parts[0] || '').replace(/\D/g, '')
    const name = (parts[1] || '').trim()
    const vars: Record<string, string> = {}
    extraHeaders.forEach((h, i) => {
      vars[h] = (parts[i + 2] || '').trim()
      vars[String(i + 1)] = (parts[i + 2] || '').trim()  // also {{1}}, {{2}}, ...
    })
    return { number, name, vars }
  }).filter(c => c.number.length >= 8)
  return { contacts, extraHeaders }
}

// ═══════════════════════════════════════════════════════════════════════════════

async function apiFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts)
  return r.json()
}

export default function ChipsPage() {
  const { removeChipData } = useStore()
  const [chips, setChips] = useState<Chip[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [newChipId, setNewChipId] = useState('')
  const [adding, setAdding] = useState(false)

  const [showCampaign, setShowCampaign] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [campaignRunning, setCampaignRunning] = useState(false)
  const [campaignPaused, setCampaignPaused] = useState(false)
  const [results, setResults] = useState<ChipCampaignResult[]>([])
  const [stats, setStats] = useState({ current: 0, total: 0, success: 0, failed: 0 })
  const [finalStats, setFinalStats] = useState<{
    total: number; success: number; failed: number; skipped: number
    deliveryRate: string; riskLevel: string; startedAt: string; endedAt: string
    responses: number; responseRate: string
    interacted: number; interactionRate: string; notInteracted: number
  } | null>(null)
  const [recalculating, setRecalculating] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [riskLevel, setRiskLevel] = useState('BAIXO')
  const [waiting, setWaiting] = useState(0)
  const campaignStartRef = useRef<string>('')
  const waitRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const [history, setHistory] = useState<CampaignHistoryRecord[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState<string | null>(null)

  const [showProxyModal, setShowProxyModal] = useState(false)
  const [proxies, setProxies] = useState<string[]>([])
  const [newProxy, setNewProxy] = useState('')
  const [proxyAdding, setProxyAdding] = useState(false)

  // Chip config panel
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

  const [message, setMessage] = useState('')
  const [contactsText, setContactsText] = useState('')
  const [contactsTab, setContactsTab] = useState<'manual' | 'csv'>('manual')
  const [csvContacts, setCsvContacts] = useState<CsvContact[]>([])
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [selectedGreetings, setSelectedGreetings] = useState<string[]>([...ALL_GREETINGS])
  const [showGreetingPicker, setShowGreetingPicker] = useState(false)
  const [imageB64, setImageB64] = useState('')
  const [settings, setSettings] = useState<ChipCampaignSettings>({
    delayMin: 5, delayMax: 30, useAIHumanize: false, tone: 'amigavel',
    batchDelay: { enabled: false, everyMin: 10, everyMax: 20, pauseMin: 60, pauseMax: 120 }
  })

  // ── Fetch chips & subscribe to WS ─────────────────────────────────────────

  const loadChips = () => apiFetch('/api/chips').then(setChips).catch(() => {})

  // Auto-poll enquanto algum chip está conectando sem QR ainda
  useEffect(() => {
    const pending = chips.some(c => (c.status === 'connecting' || c.status === 'init') && !c.qr)
    if (!pending) return
    const t = setTimeout(loadChips, 2000)  // poll a cada 2s quando conectando
    return () => clearTimeout(t)
  }, [chips])

  const loadHistory = () =>
    fetch('/api/chip-campaign/history').then(r => r.json()).then(setHistory).catch(() => {})

  async function deleteHistory(id: string) {
    if (!confirm('Remover este registro do histórico?')) return
    await fetch(`/api/chip-campaign/history/${id}`, { method: 'DELETE' })
    setHistory(prev => prev.filter(c => c.id !== id))
  }

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

  useEffect(() => {
    loadChips()
    loadHistory()
    loadProxies()

    const offs = [
      onWSMessage('chips_status', (p: Chip[]) => setChips(p)),
      onWSMessage('chip_qr', (p: { chipId: string; qr: string }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, status: 'qr', qr: p.qr } : c))
      }),
      onWSMessage('chip_ready', (p: { chipId: string; number: string }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, status: 'connected', isReady: true, number: p.number, qr: null } : c))
      }),
      onWSMessage('chip_disconnected', (p: { chipId: string }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, status: 'disconnected', isReady: false, qr: null } : c))
      }),
      onWSMessage('chip_temperature', (p: { chipId: string; temperature: ChipTemperature }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, temperature: p.temperature } : c))
      }),
      onWSMessage('chip_campaign', (p: any) => handleCampaignEvent(p)),
      onWSMessage('tick_update', (p: any) => setRiskLevel(p.riskLevel || 'BAIXO')),
      onWSMessage('ban_alert', (p: any) => addLog(`🚨 ${p.message}`)),
    ]

    return () => offs.forEach(f => f())
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  // ── Campaign events ───────────────────────────────────────────────────────

  function handleCampaignEvent(p: any) {
    if (p.type === 'progress') {
      setStats({ current: p.current, total: p.total, success: p.success, failed: p.failed })
      setCampaignRunning(true)
      addLog(`⏳ [${p.current}/${p.total}] Enviando para ${p.contact?.number}...`)
    }
    if (p.type === 'result') {
      setResults(prev => {
        const next = [...prev]
        const i = next.findIndex(r => r.number === p.contact?.number)
        if (i >= 0) next[i] = p.contact; else next.push(p.contact)
        return next
      })
      setStats(s => ({ ...s, success: p.success, failed: p.failed }))
      addLog(p.contact?.status === 'success'
        ? `✅ ${p.contact.number}`
        : `❌ ${p.contact?.number} — ${p.contact?.error}`)
    }
    if (p.type === 'waiting') {
      setRiskLevel(p.risk || 'BAIXO')
      startWait(p.delay)
      addLog(`⏱️ Aguardando ${p.delay}s  (risco: ${p.risk})`)
    }
    if (p.type === 'skipped') addLog(`⏭️ ${p.number} — já enviado anteriormente`)
    if (p.type === 'cooldown') addLog(`🛑 Cooldown ${p.seconds}s`)
    if (p.type === 'batch_pause') { startWait(p.seconds); addLog(`☕ Pausa de lote (${p.batchCount} enviados) — aguardando ${p.seconds}s`) }
    if (p.type === 'paused') { setCampaignPaused(true); addLog(`⏸️ ${p.reason || 'Pausado'}`) }
    if (p.type === 'stopped') { setCampaignRunning(false); setCampaignPaused(false); addLog('🛑 Interrompido.') }
    if (p.type === 'done') {
      setCampaignRunning(false); setCampaignPaused(false)
      addLog(`🏁 Concluído! Sucesso: ${p.success}  Falha: ${p.failed}  Entrega: ${p.stats?.deliveryRate}`)
      // Fetch response stats + interaction rate then build final summary
      const sentContacts = (p.results ?? [])
        .filter((r: any) => r.status === 'success')
        .map((r: any) => ({ number: r.number, sentAt: r.sentAt ?? 0 }))

      Promise.all([
        fetch('/api/responses/stats').then(r => r.json()).catch(() => ({})),
        fetch('/api/chip-campaign/interaction-rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sentContacts }),
        }).then(r => r.json()).catch(() => ({ interacted: 0, rate: '0%', notInteracted: 0 })),
      ]).then(([rs, ir]) => {
        setFinalStats({
          total: p.total,
          success: p.success,
          failed: p.failed,
          skipped: Math.max(0, p.total - p.success - p.failed),
          deliveryRate: p.stats?.deliveryRate ?? '—',
          riskLevel: p.stats?.riskLevel ?? 'BAIXO',
          startedAt: campaignStartRef.current,
          endedAt: new Date().toLocaleTimeString('pt-BR'),
          responses: rs.last24h ?? 0,
          responseRate: p.success > 0
            ? (((rs.last24h ?? 0) / p.success) * 100).toFixed(1) + '%'
            : '0%',
          interacted: ir.interacted ?? 0,
          interactionRate: ir.rate ?? '0%',
          notInteracted: ir.notInteracted ?? 0,
        })
        setShowDetails(true)
        // Refresh history list after campaign saves to backend
        setTimeout(loadHistory, 1500)
      })
    }
  }

  function addLog(msg: string) {
    const ts = new Date().toLocaleTimeString('pt-BR')
    setLog(prev => [...prev.slice(-199), `[${ts}] ${msg}`])
  }

  function startWait(sec: number) {
    if (waitRef.current) clearInterval(waitRef.current)
    setWaiting(sec)
    const t = setInterval(() => setWaiting(p => { if (p <= 1) { clearInterval(t); return 0 } return p - 1 }), 1000)
    waitRef.current = t
  }

  // ── Chip actions ──────────────────────────────────────────────────────────

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

  // ── Campaign actions ──────────────────────────────────────────────────────

  function getActiveContacts(): CsvContact[] {
    return contactsTab === 'csv' ? csvContacts : parseContacts(contactsText)
  }

  async function startCampaign(force = false) {
    const contacts = getActiveContacts()
    if (contacts.length === 0) return alert('Adicione pelo menos um número.')
    if (!message.trim()) return alert('Escreva a mensagem.')
    const body = {
      contacts, messageTemplate: message,
      settings: { ...settings, greetings: selectedGreetings, force },
      mediaData: imageB64 ? { type: 'image', base64: imageB64 } : null,
    }
    const r = await fetch('/api/chip-campaign/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const d = await r.json()
    if (!r.ok) {
      if (d.error === 'RISK_TIME' && confirm(d.message + '\n\nContinuar mesmo assim?')) startCampaign(true)
      else if (d.error !== 'RISK_TIME') alert(d.error)
      return
    }
    setResults([]); setLog([]); setFinalStats(null); setShowDetails(false)
    setCampaignRunning(true)
    setStats({ current: 0, total: d.count, success: 0, failed: 0 })
    campaignStartRef.current = new Date().toLocaleTimeString('pt-BR')
    addLog(`🚀 Campanha iniciada — ${d.count} contatos`)
  }

  async function togglePause() {
    await apiFetch('/api/chip-campaign/pause', { method: 'POST' })
    setCampaignPaused(p => !p)
  }

  async function stop() {
    if (!confirm('Interromper a campanha?')) return
    await apiFetch('/api/chip-campaign/stop', { method: 'POST' })
  }

  async function recalcInteraction() {
    if (!finalStats || recalculating) return
    setRecalculating(true)
    const sentContacts = results.filter(r => r.status === 'success').map(r => ({ number: r.number, sentAt: r.sentAt ?? 0 }))
    try {
      const [rs, ir] = await Promise.all([
        fetch('/api/responses/stats').then(r => r.json()),
        fetch('/api/chip-campaign/interaction-rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sentContacts }),
        }).then(r => r.json()),
      ])
      setFinalStats(prev => prev ? {
        ...prev,
        responses: rs.last24h ?? prev.responses,
        responseRate: prev.success > 0
          ? (((rs.last24h ?? 0) / prev.success) * 100).toFixed(1) + '%'
          : '0%',
        interacted: ir.interacted ?? prev.interacted,
        interactionRate: ir.rate ?? prev.interactionRate,
        notInteracted: ir.notInteracted ?? prev.notInteracted,
      } : prev)
    } catch (_) {}
    setRecalculating(false)
  }

  async function resetSent() {
    const d = await apiFetch('/api/chip-campaign/reset-sent', { method: 'POST' })
    addLog(`🔄 Histórico limpo: ${d.cleared} número(s)`)
  }

  function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setImageB64(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setCsvFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const { contacts, extraHeaders } = parseCsv(text)
      setCsvContacts(contacts)
      setCsvHeaders(extraHeaders)
    }
    reader.readAsText(file, 'UTF-8')
    e.target.value = ''
  }

  function toggleGreeting(g: string) {
    setSelectedGreetings(prev =>
      prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]
    )
  }

  function exportCSV() {
    const csv = ['Número,Nome,Status,Chip,Mensagem,Erro',
      ...results.map(r => `"${r.number}","${r.name}","${r.status}","${r.via}","${(r.message || '').replace(/"/g, '""')}","${r.error || ''}"`)
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = 'resultados.csv'; a.click()
  }

  const riskColors: Record<string, string> = {
    BAIXO: 'text-green-400', MEDIO: 'text-yellow-400', ALTO: 'text-orange-400', CRITICO: 'text-red-400'
  }

  // Live message preview — uses first contact's data and first selected greeting
  const previewMessage = useMemo(() => {
    if (!message.trim()) return ''
    const contacts = getActiveContacts()
    const c = contacts[0] ?? { number: '5511999990001', name: 'João', vars: {} }
    let msg = message
    msg = msg.replace(/\{\{name\}\}/gi, c.name || 'Nome')
    if (c.vars) {
      for (const [k, v] of Object.entries(c.vars)) {
        msg = msg.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'gi'), v)
      }
    }
    const greeting = selectedGreetings[0] ?? 'Oi, tudo bem?'
    return `${greeting}\n\n${msg}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, contactsText, csvContacts, contactsTab, selectedGreetings])

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-white">Chips WhatsApp</h1>
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

      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Chips grid */}
        {chips.length === 0 ? (
          <div className="text-center text-gray-500 py-16">
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

        {/* Campaign section */}
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
          <button onClick={() => setShowCampaign(s => !s)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-700/50 transition-colors">
            <div className="flex items-center gap-2">
              <Send size={15} className="text-green-400" />
              <span className="text-sm font-semibold text-white">Campanha via Chips</span>
              {campaignRunning && (
                <span className="text-xs bg-green-900/50 text-green-400 px-2 py-0.5 rounded-full animate-pulse ml-1">Em andamento</span>
              )}
            </div>
            {showCampaign ? <ChevronUp size={15} className="text-gray-500" /> : <ChevronDown size={15} className="text-gray-500" />}
          </button>

          {showCampaign && (
            <div className="border-t border-gray-700 p-5 space-y-5">

              {/* Running state */}
              {campaignRunning ? (
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span>{stats.current}/{stats.total} processados</span>
                      <span className={riskColors[riskLevel] || 'text-gray-400'}>
                        <Shield size={10} className="inline mr-1" />Risco: {riskLevel}
                      </span>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-2">
                      <div className="bg-green-500 h-2 rounded-full transition-all"
                        style={{ width: stats.total ? `${(stats.current / stats.total) * 100}%` : '0%' }} />
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <span className="flex items-center gap-1 text-green-400"><CheckCircle size={11} /> {stats.success}</span>
                    <span className="flex items-center gap-1 text-red-400"><XCircle size={11} /> {stats.failed}</span>
                    {waiting > 0 && <span className="flex items-center gap-1 text-yellow-400"><Clock size={11} /> {waiting}s</span>}
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={togglePause}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-white text-xs rounded-lg">
                      {campaignPaused ? <Play size={12} /> : <Pause size={12} />}
                      {campaignPaused ? 'Retomar' : 'Pausar'}
                    </button>
                    <button onClick={stop}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-800 hover:bg-red-700 text-white text-xs rounded-lg">
                      <Square size={12} /> Parar
                    </button>
                    <button onClick={resetSent}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg ml-auto">
                      <RotateCcw size={12} /> Limpar histórico
                    </button>
                  </div>
                </div>
              ) : (
                /* Form */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

                  {/* ── LEFT: message + greetings + preview + settings ── */}
                  <div className="space-y-4">

                    {/* Message template */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1.5">
                        Template da mensagem
                      </label>
                      <textarea value={message} onChange={e => setMessage(e.target.value)} rows={5}
                        placeholder={"Use {{name}} para nome, {{1}} {{2}}... para colunas do CSV.\nEx: Olá {{name}}, temos uma oferta em {{cidade}}!"}
                        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-green-500" />
                    </div>

                    {/* Greeting pool selector */}
                    <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
                      <button type="button" onClick={() => setShowGreetingPicker(s => !s)}
                        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-800 transition-colors text-left">
                        <div className="flex items-center gap-2">
                          <MessageSquare size={12} className="text-indigo-400" />
                          <span className="text-xs font-medium text-gray-300">Cumprimentos iniciais</span>
                          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${selectedGreetings.length === 0 ? 'bg-red-900/50 text-red-400' : 'bg-indigo-900/50 text-indigo-400'}`}>
                            {selectedGreetings.length} ativo(s)
                          </span>
                        </div>
                        {showGreetingPicker ? <ChevronUp size={12} className="text-gray-500" /> : <ChevronDown size={12} className="text-gray-500" />}
                      </button>
                      {showGreetingPicker && (
                        <div className="border-t border-gray-700 p-3 grid grid-cols-1 gap-1.5">
                          <p className="text-[11px] text-gray-500 mb-1">Desmarque os que não quer usar (ex: "Boa noite!" durante o dia)</p>
                          {ALL_GREETINGS.map(g => (
                            <label key={g} className="flex items-center gap-2 cursor-pointer select-none group">
                              <input type="checkbox" checked={selectedGreetings.includes(g)}
                                onChange={() => toggleGreeting(g)}
                                className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-0 focus:ring-offset-0" />
                              <span className={`text-xs ${selectedGreetings.includes(g) ? 'text-gray-200' : 'text-gray-600 line-through'}`}>{g}</span>
                            </label>
                          ))}
                          <div className="flex gap-2 mt-1 pt-1 border-t border-gray-800">
                            <button type="button" onClick={() => setSelectedGreetings([...ALL_GREETINGS])}
                              className="text-[11px] text-indigo-400 hover:text-indigo-300">Marcar todos</button>
                            <button type="button" onClick={() => setSelectedGreetings([])}
                              className="text-[11px] text-red-400 hover:text-red-300">Desmarcar todos</button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Live preview */}
                    {previewMessage && (
                      <div className="bg-gray-900 rounded-lg border border-gray-700 p-3 space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                          <Eye size={11} /> Preview com {getActiveContacts()[0]?.name || 'primeiro contato'} · cumprimento: "{selectedGreetings[0] ?? '—'}"
                        </div>
                        <div className="bg-green-900/20 border border-green-800/30 rounded-lg px-3 py-2 text-xs text-green-200 whitespace-pre-wrap leading-relaxed">
                          {previewMessage}
                        </div>
                      </div>
                    )}

                    {/* Image */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1.5">Imagem (opcional)</label>
                      {imageB64 ? (
                        <div className="flex items-center gap-2">
                          <img src={imageB64} alt="" className="w-12 h-12 object-cover rounded" />
                          <button onClick={() => setImageB64('')} className="text-red-400 hover:text-red-300"><X size={14} /></button>
                        </div>
                      ) : (
                        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer hover:text-gray-200">
                          <Upload size={11} /> Carregar imagem
                          <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
                        </label>
                      )}
                    </div>

                    {/* Delay entre mensagens */}
                    <div className="space-y-2">
                      <label className="block text-xs font-medium text-gray-400">Delay entre envios (segundos)</label>
                      <div className="flex items-center gap-2 text-xs text-gray-300">
                        <input type="number" min={1} value={settings.delayMin}
                          onChange={e => setSettings(s => ({ ...s, delayMin: +e.target.value }))}
                          className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center focus:outline-none focus:border-green-500" />
                        <span className="text-gray-500">até</span>
                        <input type="number" min={1} value={settings.delayMax}
                          onChange={e => setSettings(s => ({ ...s, delayMax: +e.target.value }))}
                          className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center focus:outline-none focus:border-green-500" />
                        <span className="text-gray-500">seg</span>
                      </div>

                      {/* Batch delay */}
                      <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
                        <label className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none">
                          <input type="checkbox"
                            checked={settings.batchDelay?.enabled ?? false}
                            onChange={e => setSettings(s => ({ ...s, batchDelay: { ...(s.batchDelay!), enabled: e.target.checked } }))}
                            className="rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-0" />
                          <span className="text-xs text-gray-300">☕ Pausa a cada lote de mensagens</span>
                        </label>
                        {settings.batchDelay?.enabled && (
                          <div className="border-t border-gray-700 px-3 pb-3 pt-2 space-y-2">
                            <div className="flex items-center gap-2 text-xs text-gray-400">
                              <span className="text-gray-500 w-20 shrink-0">A cada</span>
                              <input type="number" min={1} value={settings.batchDelay.everyMin}
                                onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, everyMin: +e.target.value } }))}
                                className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                              <span className="text-gray-600">a</span>
                              <input type="number" min={1} value={settings.batchDelay.everyMax}
                                onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, everyMax: +e.target.value } }))}
                                className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                              <span className="text-gray-500">envios</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-gray-400">
                              <span className="text-gray-500 w-20 shrink-0">Pausar</span>
                              <input type="number" min={1} value={settings.batchDelay.pauseMin}
                                onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, pauseMin: +e.target.value } }))}
                                className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                              <span className="text-gray-600">a</span>
                              <input type="number" min={1} value={settings.batchDelay.pauseMax}
                                onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, pauseMax: +e.target.value } }))}
                                className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                              <span className="text-gray-500">seg</span>
                            </div>
                            <p className="text-[11px] text-orange-400/70">
                              Ex: a cada {settings.batchDelay.everyMin}–{settings.batchDelay.everyMax} envios, pausa de {settings.batchDelay.pauseMin}–{settings.batchDelay.pauseMax}s para parecer mais humano.
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                      <input type="checkbox" checked={settings.useAIHumanize}
                        onChange={e => setSettings(s => ({ ...s, useAIHumanize: e.target.checked }))} className="rounded" />
                      <Zap size={11} className="text-yellow-400" /> Humanizar com IA (GROQ_API_KEY ou OPENAI_API_KEY)
                    </label>
                  </div>

                  {/* ── RIGHT: contacts (manual / CSV) ── */}
                  <div className="space-y-3">

                    {/* Tabs */}
                    <div className="flex gap-1 bg-gray-900 rounded-lg p-1 w-fit">
                      {(['manual', 'csv'] as const).map(tab => (
                        <button key={tab} type="button" onClick={() => setContactsTab(tab)}
                          className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${contactsTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                          {tab === 'manual' ? <><Users size={11} className="inline mr-1" />Manual</> : <><FileText size={11} className="inline mr-1" />CSV</>}
                        </button>
                      ))}
                    </div>

                    {contactsTab === 'manual' ? (
                      <div>
                        <textarea value={contactsText} onChange={e => setContactsText(e.target.value)} rows={10}
                          placeholder={"5511999990001,João\n5511999990002,Maria\n5511999990003"}
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono resize-none focus:outline-none focus:border-green-500" />
                        <p className="text-xs text-gray-500 mt-1">{parseContacts(contactsText).length} contato(s) · formato: número,nome</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Upload zone */}
                        <label className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg p-6 cursor-pointer transition-colors ${csvContacts.length > 0 ? 'border-green-700/50 bg-green-900/10 hover:bg-green-900/20' : 'border-gray-700 bg-gray-900 hover:border-gray-500'}`}>
                          <Upload size={20} className={csvContacts.length > 0 ? 'text-green-400' : 'text-gray-500'} />
                          <div className="text-center">
                            {csvContacts.length > 0 ? (
                              <>
                                <p className="text-xs font-medium text-green-300">{csvFileName}</p>
                                <p className="text-[11px] text-green-500 mt-0.5">{csvContacts.length} contatos carregados · clique para trocar</p>
                              </>
                            ) : (
                              <>
                                <p className="text-xs text-gray-400">Clique para carregar CSV</p>
                                <p className="text-[11px] text-gray-600 mt-0.5">Formato: telefone, nome, coluna1, coluna2…</p>
                              </>
                            )}
                          </div>
                          <input type="file" accept=".csv,.txt" className="hidden" onChange={handleCsvUpload} />
                        </label>

                        {/* Detected variables */}
                        {csvHeaders.length > 0 && (
                          <div className="bg-indigo-900/20 border border-indigo-800/30 rounded-lg p-3 space-y-1.5">
                            <p className="text-[11px] font-medium text-indigo-400">Variáveis detectadas no CSV:</p>
                            <div className="flex flex-wrap gap-1.5">
                              <span className="text-[11px] bg-gray-800 text-green-300 px-2 py-0.5 rounded font-mono">{'{{name}}'}</span>
                              {csvHeaders.map((h, i) => (
                                <span key={h} className="text-[11px] bg-gray-800 text-indigo-300 px-2 py-0.5 rounded font-mono">
                                  {`{{${h}}}`}
                                  <span className="text-gray-600 ml-1">ou</span>
                                  {` {{${i + 1}}}`}
                                </span>
                              ))}
                            </div>
                            <p className="text-[11px] text-gray-500">Copie qualquer variável acima e cole no template.</p>
                          </div>
                        )}

                        {/* Preview table */}
                        {csvContacts.length > 0 && (
                          <div className="overflow-auto rounded-lg border border-gray-700 max-h-48">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-gray-800 text-gray-400 text-left">
                                  <th className="px-3 py-2">Telefone</th>
                                  <th className="px-3 py-2">Nome</th>
                                  {csvHeaders.map(h => <th key={h} className="px-3 py-2">{h}</th>)}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-800">
                                {csvContacts.slice(0, 5).map((c, i) => (
                                  <tr key={i} className="hover:bg-gray-800/40">
                                    <td className="px-3 py-1.5 font-mono text-gray-300">{c.number}</td>
                                    <td className="px-3 py-1.5 text-gray-400">{c.name}</td>
                                    {csvHeaders.map(h => <td key={h} className="px-3 py-1.5 text-gray-500">{c.vars[h] || '—'}</td>)}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {csvContacts.length > 5 && (
                              <div className="px-3 py-1.5 bg-gray-900 text-[11px] text-gray-600 border-t border-gray-800">
                                +{csvContacts.length - 5} contatos a mais…
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!campaignRunning && (
                <button onClick={() => startCampaign()}
                  disabled={!chips.some(c => c.isReady)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors">
                  <Send size={14} /> Iniciar Campanha
                </button>
              )}

              {/* Live log */}
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1.5">Log em tempo real</p>
                <div ref={logRef}
                  className="h-32 bg-gray-900 rounded-lg p-3 overflow-y-auto text-xs font-mono text-gray-300 space-y-0.5">
                  {log.length === 0
                    ? <p className="text-gray-600">Log aparecerá aqui quando a campanha iniciar…</p>
                    : log.map((l, i) => <p key={i}>{l}</p>)}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Detalhes da Campanha ───────────────────────────────────────────── */}
        {(results.length > 0 || finalStats) && (
          <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
            <button onClick={() => setShowDetails(s => !s)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-700/50 transition-colors">
              <div className="flex items-center gap-2">
                <CheckCircle size={15} className="text-indigo-400" />
                <span className="text-sm font-semibold text-white">Detalhes da Campanha</span>
                {finalStats && (
                  <span className="text-xs bg-indigo-900/50 text-indigo-400 px-2 py-0.5 rounded-full ml-1">
                    {finalStats.success} enviados · {finalStats.failed} erros
                  </span>
                )}
                {!finalStats && campaignRunning && (
                  <span className="text-xs bg-yellow-900/50 text-yellow-400 px-2 py-0.5 rounded-full ml-1 animate-pulse">
                    Em andamento
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {finalStats && (
                  <button onClick={e => { e.stopPropagation(); exportCSV() }}
                    className="text-xs text-green-400 hover:text-green-300 px-2 py-1 rounded border border-green-700 hover:border-green-500">
                    Exportar CSV
                  </button>
                )}
                {showDetails ? <ChevronUp size={15} className="text-gray-500" /> : <ChevronDown size={15} className="text-gray-500" />}
              </div>
            </button>

            {showDetails && (
              <div className="border-t border-gray-700 p-5 space-y-5">

                {/* Summary cards */}
                {finalStats && (
                  <>
                    {/* Row 1 — volume */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: 'Total disparado', value: finalStats.total, color: 'text-white', bg: 'bg-gray-700/50', icon: '📊' },
                        { label: 'Enviados com sucesso', value: finalStats.success, color: 'text-green-400', bg: 'bg-green-900/20', icon: '✅' },
                        { label: 'Erros', value: finalStats.failed, color: 'text-red-400', bg: 'bg-red-900/20', icon: '❌' },
                        { label: 'Pulados', value: Math.max(0, finalStats.skipped), color: 'text-gray-400', bg: 'bg-gray-700/30', icon: '⏭️' },
                      ].map(card => (
                        <div key={card.label} className={`${card.bg} rounded-xl p-4 flex flex-col gap-1`}>
                          <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
                          <p className="text-[11px] text-gray-500">{card.icon} {card.label}</p>
                        </div>
                      ))}
                    </div>

                    {/* Row 2 — interaction */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* Interaction rate — main highlight */}
                      <div className="bg-indigo-900/30 border border-indigo-700/40 rounded-xl p-4 flex flex-col gap-2 sm:col-span-1">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-3xl font-bold text-indigo-300">{finalStats.interactionRate}</p>
                            <p className="text-xs text-indigo-400 mt-0.5">💬 Taxa de interação</p>
                          </div>
                          <button onClick={recalcInteraction} disabled={recalculating}
                            className="p-1.5 bg-indigo-800/50 hover:bg-indigo-700/50 rounded-lg text-indigo-300 disabled:opacity-40 transition-colors" title="Recalcular">
                            <RefreshCw size={12} className={recalculating ? 'animate-spin' : ''} />
                          </button>
                        </div>
                        <div className="w-full bg-indigo-900/50 rounded-full h-1.5 mt-1">
                          <div className="bg-indigo-400 h-1.5 rounded-full transition-all"
                            style={{ width: finalStats.interactionRate.replace('%','') + '%' }} />
                        </div>
                        <p className="text-[11px] text-indigo-500">
                          {finalStats.interacted} responderam · {finalStats.notInteracted} não interagiram
                        </p>
                      </div>

                      {/* Delivery rate */}
                      <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-4 flex flex-col gap-2">
                        <p className="text-3xl font-bold text-blue-300">{finalStats.deliveryRate}</p>
                        <p className="text-xs text-blue-400">📶 Taxa de entrega (ACK)</p>
                        <p className="text-[11px] text-blue-600">Confirmação de entrega pelo WhatsApp</p>
                      </div>

                      {/* Risk + time */}
                      <div className="bg-gray-700/30 border border-gray-700/40 rounded-xl p-4 flex flex-col gap-3">
                        <div>
                          <p className={`text-xl font-bold ${
                            finalStats.riskLevel === 'CRITICO' ? 'text-red-400'
                            : finalStats.riskLevel === 'ALTO' ? 'text-orange-400'
                            : finalStats.riskLevel === 'MEDIO' ? 'text-yellow-400'
                            : 'text-green-400'
                          }`}>⚠️ {finalStats.riskLevel}</p>
                          <p className="text-[11px] text-gray-500 mt-0.5">Risco de ban no final</p>
                        </div>
                        <div className="space-y-0.5 text-[11px] text-gray-500 border-t border-gray-700 pt-2">
                          <p>🕐 Início: <span className="text-gray-300">{finalStats.startedAt}</span></p>
                          <p>🏁 Fim: <span className="text-gray-300">{finalStats.endedAt}</span></p>
                        </div>
                      </div>
                    </div>

                    {/* Interaction bar — visual breakdown */}
                    <div className="bg-gray-900 rounded-xl p-4 space-y-2">
                      <p className="text-xs font-medium text-gray-400">Interação dos contatos disparados</p>
                      <div className="flex rounded-full overflow-hidden h-4 text-[10px] font-medium">
                        {finalStats.interacted > 0 && (
                          <div className="bg-indigo-500 flex items-center justify-center text-white transition-all"
                            style={{ width: finalStats.interactionRate }}>
                            {finalStats.interacted > 2 ? finalStats.interacted : ''}
                          </div>
                        )}
                        {finalStats.failed > 0 && (
                          <div className="bg-red-700/60 flex items-center justify-center text-red-200 transition-all"
                            style={{ width: finalStats.total > 0 ? `${(finalStats.failed / finalStats.total * 100).toFixed(1)}%` : '0%' }}>
                            {finalStats.failed > 2 ? finalStats.failed : ''}
                          </div>
                        )}
                        <div className="bg-gray-700 flex-1 flex items-center justify-center text-gray-500">
                          {finalStats.notInteracted > 0 ? `${finalStats.notInteracted} sem resp.` : ''}
                        </div>
                      </div>
                      <div className="flex gap-4 text-[11px]">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-indigo-500 inline-block" /> Interagiram ({finalStats.interacted})</span>
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-700/60 inline-block" /> Erro ({finalStats.failed})</span>
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gray-700 inline-block" /> Sem resposta ({finalStats.notInteracted})</span>
                      </div>
                    </div>
                  </>
                )}

                {/* Results table */}
                {results.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border border-gray-700">
                    <table className="w-full text-xs text-gray-300">
                      <thead className="bg-gray-900">
                        <tr className="text-gray-500">
                          <th className="text-left px-3 py-2">#</th>
                          <th className="text-left px-3 py-2">Número</th>
                          <th className="text-left px-3 py-2">Nome</th>
                          <th className="text-left px-3 py-2">Chip</th>
                          <th className="text-left px-3 py-2">Status</th>
                          <th className="text-left px-3 py-2">Ack</th>
                          <th className="text-left px-3 py-2">Detalhe</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r, i) => (
                          <tr key={i} className={`border-t border-gray-800/60 ${
                            r.status === 'success' ? 'hover:bg-green-900/10'
                            : r.status === 'failed' ? 'hover:bg-red-900/10'
                            : 'hover:bg-yellow-900/10'
                          }`}>
                            <td className="px-3 py-1.5 text-gray-600">{r.index + 1}</td>
                            <td className="px-3 py-1.5 font-mono">{r.number}</td>
                            <td className="px-3 py-1.5 max-w-[120px] truncate">{r.name || '—'}</td>
                            <td className="px-3 py-1.5 text-gray-500">{r.via || '—'}</td>
                            <td className="px-3 py-1.5">
                              {r.status === 'success'
                                ? <span className="flex items-center gap-1 text-green-400"><CheckCircle size={10} /> Enviado</span>
                                : r.status === 'failed'
                                ? <span className="flex items-center gap-1 text-red-400"><XCircle size={10} /> Falha</span>
                                : <span className="flex items-center gap-1 text-yellow-400"><Clock size={10} /> Enviando</span>}
                            </td>
                            <td className="px-3 py-1.5 text-gray-500">
                              {r.ack !== undefined
                                ? r.ack >= 3 ? <span className="text-blue-400">Lido</span>
                                  : r.ack >= 2 ? <span className="text-gray-300">Entregue</span>
                                  : r.ack >= 1 ? <span className="text-gray-500">Enviado</span>
                                  : '—'
                                : '—'}
                            </td>
                            <td className="px-3 py-1.5 text-gray-500 max-w-[200px]">
                              {r.error
                                ? <span className="text-red-400 text-[11px] truncate block" title={r.error}>{r.error}</span>
                                : r.message
                                ? <span className="text-gray-600 text-[11px] truncate block" title={r.message}>{r.message.slice(0, 60)}{r.message.length > 60 ? '…' : ''}</span>
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="px-3 py-2 bg-gray-900 text-xs text-gray-600 border-t border-gray-800 flex justify-between">
                      <span>{results.length} contato(s) processado(s)</span>
                      <span className="text-green-400">{results.filter(r => r.status === 'success').length} enviados</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Histórico de Campanhas ──────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <button onClick={() => { setShowHistory(s => !s); if (!showHistory) loadHistory() }}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-700/50 transition-colors">
          <div className="flex items-center gap-2">
            <Clock size={15} className="text-purple-400" />
            <span className="text-sm font-semibold text-white">Histórico de Campanhas</span>
            {history.length > 0 && (
              <span className="text-xs bg-purple-900/50 text-purple-400 px-2 py-0.5 rounded-full ml-1">
                {history.length} campanha(s)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); loadHistory() }}
              className="p-1 text-gray-500 hover:text-white transition-colors" title="Atualizar">
              <RefreshCw size={13} />
            </button>
            {showHistory ? <ChevronUp size={16} className="text-gray-500" /> : <ChevronDown size={16} className="text-gray-500" />}
          </div>
        </button>

        {showHistory && (
          <div className="border-t border-gray-700 p-5 space-y-3">
            {history.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">Nenhuma campanha salva ainda.</p>
            ) : history.map(c => {
              const expanded = historyExpanded === c.id
              const total = c.total || (c.success + c.failed + c.skipped)
              const delivRate = total > 0 ? ((c.success / total) * 100).toFixed(1) + '%' : '0%'
              const startDate = new Date(c.startedAt).toLocaleString('pt-BR')
              const endDate = new Date(c.endedAt).toLocaleString('pt-BR')
              const durationMs = c.endedAt - c.startedAt
              const durationMin = Math.floor(durationMs / 60000)
              const durationSec = Math.floor((durationMs % 60000) / 1000)
              return (
                <div key={c.id} className="bg-gray-900 rounded-xl border border-gray-700/60 overflow-hidden">
                  <button onClick={() => setHistoryExpanded(expanded ? null : c.id)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors text-left">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm text-white font-medium">{startDate}</span>
                        <span className="text-xs text-gray-500 mt-0.5">
                          {total} contatos · {c.success} enviados · {c.failed} erros · {durationMin}m{durationSec}s
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`text-sm font-bold ${c.failed === 0 ? 'text-green-400' : c.success > c.failed ? 'text-yellow-400' : 'text-red-400'}`}>
                        {delivRate}
                      </span>
                      <button onClick={e => { e.stopPropagation(); deleteHistory(c.id) }}
                        className="p-1 text-gray-600 hover:text-red-400 transition-colors" title="Remover">
                        <Trash2 size={13} />
                      </button>
                      {expanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
                    </div>
                  </button>

                  {expanded && (
                    <div className="border-t border-gray-700/60 p-4 space-y-3">
                      {/* Summary row */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {[
                          { label: 'Total', value: total, color: 'text-white' },
                          { label: 'Enviados', value: c.success, color: 'text-green-400' },
                          { label: 'Erros', value: c.failed, color: 'text-red-400' },
                          { label: 'Pulados', value: c.skipped ?? 0, color: 'text-gray-400' },
                        ].map(card => (
                          <div key={card.label} className="bg-gray-800 rounded-lg p-3">
                            <p className={`text-xl font-bold ${card.color}`}>{card.value}</p>
                            <p className="text-[11px] text-gray-500 mt-0.5">{card.label}</p>
                          </div>
                        ))}
                      </div>
                      <div className="text-[11px] text-gray-500 flex gap-4">
                        <span>🕐 Início: <span className="text-gray-300">{startDate}</span></span>
                        <span>🏁 Fim: <span className="text-gray-300">{endDate}</span></span>
                      </div>
                      {/* Results table */}
                      {c.results && c.results.length > 0 && (
                        <div className="overflow-auto rounded-lg border border-gray-700 max-h-60">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-gray-800 text-gray-400 text-left">
                                <th className="px-3 py-2">#</th>
                                <th className="px-3 py-2">Número</th>
                                <th className="px-3 py-2">Nome</th>
                                <th className="px-3 py-2">Chip</th>
                                <th className="px-3 py-2">Status</th>
                                <th className="px-3 py-2">Detalhe</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                              {c.results.map((r, idx) => (
                                <tr key={idx} className="hover:bg-gray-800/40">
                                  <td className="px-3 py-1.5 text-gray-600">{r.index + 1}</td>
                                  <td className="px-3 py-1.5 font-mono text-gray-300">{r.number}</td>
                                  <td className="px-3 py-1.5 text-gray-400 max-w-[120px] truncate">{r.name}</td>
                                  <td className="px-3 py-1.5 text-gray-500">{r.via || '—'}</td>
                                  <td className="px-3 py-1.5">
                                    {r.status === 'success'
                                      ? <span className="text-green-400 font-medium">✓ Enviado</span>
                                      : <span className="text-red-400">✗ Erro</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-gray-600 max-w-[180px]">
                                    {r.error
                                      ? <span className="text-red-400 truncate block" title={r.error}>{r.error.slice(0,60)}</span>
                                      : r.message
                                      ? <span className="text-gray-600 truncate block" title={r.message}>{r.message.slice(0,60)}</span>
                                      : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

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
}
