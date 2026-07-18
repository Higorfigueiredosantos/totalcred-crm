import { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from 'react'
import {
  Smartphone, Play, Pause, Square, RotateCcw, Send, Upload, X,
  ChevronDown, ChevronUp, CheckCircle, XCircle, Clock,
  Zap, Shield, AlertCircle, Users, Loader2, Eye, FileText, MessageSquare,
  Globe, RefreshCw, Trash2,
} from 'lucide-react'
import { onWSMessage } from '../../api/websocket'
import { useChips, apiFetch } from '../../hooks/useChips'
import type { ChipCampaignResult, ChipCampaignSettings, CampaignHistoryRecord, CsvContact } from '../../types'

// ── Greeting pool (mirrors backend openingPhrases) ────────────────────────────
const ALL_GREETINGS = [
  'Oi, tudo bem?', 'Olá! Tudo certo?', 'E aí, como vai?', 'Oi! Espero que esteja bem.',
  'Bom dia! 😊', 'Boa tarde!', 'Boa noite!', 'Oi! 👋', 'Olá! 😊', 'E aí! Tudo na paz?'
]

function parseContacts(text: string): CsvContact[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [num, ...rest] = l.split(/[,;\t]/)
    return { number: (num || '').replace(/\D/g, ''), name: rest.join(' ').trim(), vars: {} }
  }).filter(c => c.number.length >= 8)
}

function parseCsvRaw(text: string): { allHeaders: string[]; rawRows: Record<string, string>[] } {
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
  if (lines.length === 0) return { allHeaders: [], rawRows: [] }
  const firstCols = splitLine(lines[0])
  const firstIsHeader = !/^\d{8,}/.test(firstCols[0].replace(/\D/g, ''))
  let allHeaders: string[]
  let dataRows: string[]
  if (firstIsHeader) {
    allHeaders = firstCols.map(h => h.toLowerCase().trim())
    dataRows = lines.slice(1)
  } else {
    allHeaders = firstCols.map((_, i) => i === 0 ? 'telefone' : i === 1 ? 'nome' : `coluna${i}`)
    dataRows = lines
  }
  const rawRows = dataRows.map(line => {
    const parts = splitLine(line)
    const row: Record<string, string> = {}
    allHeaders.forEach((h, i) => { row[h] = (parts[i] || '').trim() })
    return row
  })
  return { allHeaders, rawRows }
}

function buildContacts(rawRows: Record<string, string>[], allHeaders: string[], phoneCol: string): { contacts: CsvContact[]; extraHeaders: string[] } {
  const nameCol = allHeaders.find(h => h !== phoneCol && /nome|name/i.test(h))
    ?? allHeaders.find(h => h !== phoneCol)
    ?? ''
  const extraHeaders = allHeaders.filter(h => h !== phoneCol && h !== nameCol)
  const contacts: CsvContact[] = rawRows.map(row => {
    const number = (row[phoneCol] ?? '').replace(/\D/g, '')
    const name = (row[nameCol] ?? '').trim()
    const vars: Record<string, string> = {}
    extraHeaders.forEach((h, i) => {
      vars[h] = row[h] ?? ''
      vars[String(i + 1)] = row[h] ?? ''
    })
    return { number, name, vars }
  }).filter(c => c.number.length >= 8)
  return { contacts, extraHeaders }
}

export interface ChipCampaignPanelHandle {
  open: () => void
}

// Painel de campanha via Chips (API não oficial) — antes vivia dentro de /chips,
// agora embutido no Disparador como o destino "Não Oficial" do seletor de tipo.
const ChipCampaignPanel = forwardRef<ChipCampaignPanelHandle>((_props, ref) => {
  const { chips } = useChips()
  const containerRef = useRef<HTMLDivElement>(null)

  const [chipLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('chip_labels') || '{}') } catch { return {} }
  })

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
  const [historyEngagement, setHistoryEngagement] = useState<Record<string, { loading: boolean; engaged: number; total: number; rate: string; numbers: string[] } | null>>({})

  const [message, setMessage] = useState('')
  const [contactsText, setContactsText] = useState('')
  const [contactsTab, setContactsTab] = useState<'manual' | 'csv'>('manual')
  const [csvContacts, setCsvContacts] = useState<CsvContact[]>([])
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvRawRows, setCsvRawRows] = useState<Record<string, string>[]>([])
  const [csvAllHeaders, setCsvAllHeaders] = useState<string[]>([])
  const [csvPhoneColumn, setCsvPhoneColumn] = useState<string>('')
  const [selectedGreetings, setSelectedGreetings] = useState<string[]>([...ALL_GREETINGS])
  const [showGreetingPicker, setShowGreetingPicker] = useState(false)
  const [imageB64, setImageB64] = useState('')
  const [selectedChipIds, setSelectedChipIds] = useState<string[]>([])
  const [csvDups, setCsvDups] = useState(0)
  const [waFilterState, setWaFilterState] = useState<'idle' | 'running' | 'done'>('idle')
  const [waFilterProgress, setWaFilterProgress] = useState({ checked: 0, total: 0, hasWa: 0, noWa: 0 })
  const [noWaNumbers, setNoWaNumbers] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<ChipCampaignSettings>({
    delayMin: 5, delayMax: 30, useAIHumanize: false, tone: 'amigavel',
    batchDelay: { enabled: false, everyMin: 10, everyMax: 20, pauseMin: 60, pauseMax: 120 }
  })

  useImperativeHandle(ref, () => ({
    open: () => {
      setShowCampaign(true)
      setTimeout(() => containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    },
  }))

  const loadHistory = () =>
    fetch('/api/chip-campaign/history').then(r => r.json()).then(setHistory).catch(() => {})

  async function deleteHistory(id: string) {
    if (!confirm('Remover este registro do histórico?')) return
    await fetch(`/api/chip-campaign/history/${id}`, { method: 'DELETE' })
    setHistory(prev => prev.filter(c => c.id !== id))
  }

  async function fetchHistoryEngagement(record: CampaignHistoryRecord) {
    setHistoryEngagement(prev => ({ ...prev, [record.id]: { loading: true, engaged: 0, total: 0, rate: '0%', numbers: [] } }))
    const sentContacts = (record.results || [])
      .filter(r => r.status === 'success')
      .map(r => ({ number: r.number, sentAt: r.sentAt ?? record.startedAt }))
    try {
      const res = await fetch('/api/chip-campaign/interaction-rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentContacts }),
      })
      const data = await res.json()
      setHistoryEngagement(prev => ({
        ...prev,
        [record.id]: { loading: false, engaged: data.interacted ?? 0, total: data.sent ?? 0, rate: data.rate ?? '0%', numbers: data.interactedNumbers ?? [] }
      }))
    } catch {
      setHistoryEngagement(prev => ({ ...prev, [record.id]: null }))
    }
  }

  useEffect(() => {
    loadHistory()

    const offs = [
      onWSMessage('chip_campaign', (p: any) => handleCampaignEvent(p)),
      onWSMessage('tick_update', (p: any) => setRiskLevel(p.riskLevel || 'BAIXO')),
      onWSMessage('ban_alert', (p: any) => addLog(`🚨 ${p.message}`)),
      onWSMessage('wa_filter_progress', (p: any) => {
        setWaFilterProgress({ checked: p.checked, total: p.total, hasWa: p.hasWa, noWa: p.noWa })
      }),
      onWSMessage('wa_filter_done', (p: any) => {
        setWaFilterState('done')
        if (p.error) { alert(`Erro no filtro: ${p.error}`); setWaFilterState('idle'); return }
        const noWa = new Set<string>(
          (p.results as { number: string; hasWhatsapp: boolean }[]).filter(r => !r.hasWhatsapp).map(r => r.number)
        )
        setNoWaNumbers(noWa)
        setWaFilterProgress(prev => ({ ...prev, hasWa: p.hasWa ?? prev.hasWa, noWa: p.noWa ?? prev.noWa }))
      }),
    ]

    return () => offs.forEach(f => f())
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (p.type === 'started') {
      addLog(`🔀 Chips em rotação: ${(p.chips as string[]).join(', ')} (${p.chips.length} chip${p.chips.length !== 1 ? 's' : ''})`)
    }
    if (p.type === 'waiting') {
      setRiskLevel(p.risk || 'BAIXO')
      startWait(p.delay)
      const nextInfo = p.nextChip ? ` → próximo: ${p.nextChip}` : ''
      addLog(`⏱️ Aguardando ${p.delay}s  (risco: ${p.risk})${nextInfo}`)
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

  // ── Campaign actions ──────────────────────────────────────────────────────

  function getActiveContacts(): CsvContact[] {
    return contactsTab === 'csv' ? csvContacts : parseContacts(contactsText)
  }

  async function startCampaign(force = false) {
    const contacts = getActiveContacts()
    if (contacts.length === 0) return alert('Adicione pelo menos um número.')
    if (!message.trim()) return alert('Escreva a mensagem.')
    const chipsToUse = selectedChipIds.length > 0 ? selectedChipIds : chips.filter(c => c.isReady).map(c => c.id)
    if (chipsToUse.length === 0) return alert('Nenhum chip conectado disponível.')
    const body = {
      contacts, messageTemplate: message,
      settings: { ...settings, greetings: selectedGreetings, force, selectedChipIds: chipsToUse },
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

  function applyPhoneColumn(rawRows: Record<string, string>[], allHeaders: string[], phoneCol: string) {
    const { contacts, extraHeaders } = buildContacts(rawRows, allHeaders, phoneCol)
    const seen = new Set<string>()
    let dups = 0
    contacts.forEach(c => { if (seen.has(c.number)) dups++; else seen.add(c.number) })
    setCsvDups(dups)
    setCsvContacts(contacts)
    setCsvHeaders(extraHeaders)
    setWaFilterState('idle')
    setNoWaNumbers(new Set())
  }

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setCsvFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const { allHeaders, rawRows } = parseCsvRaw(text)
      if (allHeaders.length === 0) return
      const autoPhone = allHeaders.find(h => /telefon|phone|cel|whats|mobile|fone/i.test(h)) ?? allHeaders[0]
      setCsvRawRows(rawRows)
      setCsvAllHeaders(allHeaders)
      setCsvPhoneColumn(autoPhone)
      applyPhoneColumn(rawRows, allHeaders, autoPhone)
    }
    reader.readAsText(file, 'UTF-8')
    e.target.value = ''
  }

  function handlePhoneColumnChange(col: string) {
    setCsvPhoneColumn(col)
    applyPhoneColumn(csvRawRows, csvAllHeaders, col)
  }

  function removeDuplicates() {
    if (!csvPhoneColumn) return
    const seen = new Set<string>()
    const newRaw: Record<string, string>[] = []
    csvRawRows.forEach(row => {
      const phone = (row[csvPhoneColumn] ?? '').replace(/\D/g, '')
      if (phone.length < 8) { newRaw.push(row); return }
      if (!seen.has(phone)) { seen.add(phone); newRaw.push(row) }
    })
    setCsvRawRows(newRaw)
    const { contacts, extraHeaders } = buildContacts(newRaw, csvAllHeaders, csvPhoneColumn)
    setCsvContacts(contacts)
    setCsvHeaders(extraHeaders)
    setCsvDups(0)
  }

  async function startWaFilter() {
    if (csvContacts.length === 0 || waFilterState === 'running') return
    setWaFilterState('running')
    setNoWaNumbers(new Set())
    setWaFilterProgress({ checked: 0, total: csvContacts.length, hasWa: 0, noWa: 0 })
    const r = await fetch('/api/tools/wa-filter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers: csvContacts.map(c => c.number) }),
    })
    const d = await r.json()
    if (!r.ok) { alert(d.error || 'Erro ao iniciar filtro'); setWaFilterState('idle') }
  }

  function removeNoWa() {
    setCsvContacts(prev => prev.filter(c => !noWaNumbers.has(c.number)))
    setNoWaNumbers(new Set())
    setWaFilterState('idle')
    setWaFilterProgress({ checked: 0, total: 0, hasWa: 0, noWa: 0 })
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
    <div className="space-y-6">
      {/* Campaign section */}
      <div ref={containerRef} className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <button onClick={() => setShowCampaign(s => !s)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-700/50 transition-colors">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-green-900/50 flex items-center justify-center shrink-0">
              <Send size={13} className="text-green-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white text-left">Campanha via Chips</p>
              <p className="text-[11px] text-gray-500 text-left">Disparo em massa com rotação de chips e proxies</p>
            </div>
            {campaignRunning && (
              <span className="text-[11px] bg-green-900/50 border border-green-700/40 text-green-400 px-2 py-0.5 rounded-full animate-pulse">
                ● Em andamento
              </span>
            )}
          </div>
          {showCampaign ? <ChevronUp size={15} className="text-gray-500" /> : <ChevronDown size={15} className="text-gray-500" />}
        </button>

        {showCampaign && (
          <div className="border-t border-gray-700 p-5 space-y-5">

            {/* Running state */}
            {campaignRunning ? (
              <div className="space-y-4">
                {/* Progress */}
                <div className="bg-gray-900 rounded-xl border border-gray-700 p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-300 font-medium">{stats.current} / {stats.total} processados</span>
                    <span className={`flex items-center gap-1 font-medium ${riskColors[riskLevel] || 'text-gray-400'}`}>
                      <Shield size={10} /> Risco: {riskLevel}
                    </span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div className="bg-green-500 h-2.5 rounded-full transition-all"
                      style={{ width: stats.total ? `${(stats.current / stats.total) * 100}%` : '0%' }} />
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={12} /> {stats.success} enviados</span>
                    <span className="flex items-center gap-1.5 text-red-400"><XCircle size={12} /> {stats.failed} erros</span>
                    {waiting > 0 && <span className="flex items-center gap-1.5 text-yellow-400 ml-auto"><Clock size={12} /> aguardando {waiting}s…</span>}
                    {campaignPaused && <span className="text-yellow-400 font-medium ml-auto">⏸ Pausado</span>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={togglePause}
                    className={`flex items-center gap-1.5 px-4 py-2 text-white text-xs rounded-lg transition-colors ${campaignPaused ? 'bg-green-700 hover:bg-green-600' : 'bg-yellow-700 hover:bg-yellow-600'}`}>
                    {campaignPaused ? <><Play size={12} /> Retomar</> : <><Pause size={12} /> Pausar</>}
                  </button>
                  <button onClick={stop}
                    className="flex items-center gap-1.5 px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-xs rounded-lg transition-colors">
                    <Square size={12} /> Parar
                  </button>
                  <button onClick={resetSent}
                    className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg ml-auto transition-colors">
                    <RotateCcw size={12} /> Limpar enviados
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

                  {/* Chips para disparo */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-gray-400">Chips para disparo</label>
                      <div className="flex gap-2">
                        <button type="button"
                          onClick={() => setSelectedChipIds(chips.filter(c => c.isReady).map(c => c.id))}
                          className="text-[11px] text-green-400 hover:text-green-300">Todos</button>
                        <button type="button"
                          onClick={() => setSelectedChipIds([])}
                          className="text-[11px] text-red-400 hover:text-red-300">Nenhum</button>
                      </div>
                    </div>
                    <div className="bg-gray-900 rounded-lg border border-gray-700 divide-y divide-gray-800">
                      {chips.filter(c => c.isReady).length === 0 ? (
                        <p className="px-3 py-2.5 text-xs text-red-400">Nenhum chip conectado</p>
                      ) : chips.filter(c => c.isReady).map(chip => {
                        const checked = selectedChipIds.length === 0 || selectedChipIds.includes(chip.id)
                        return (
                          <label key={chip.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none hover:bg-gray-800/60">
                            <input type="checkbox" checked={checked}
                              onChange={() => {
                                const all = chips.filter(c => c.isReady).map(c => c.id)
                                const current = selectedChipIds.length === 0 ? all : selectedChipIds
                                setSelectedChipIds(
                                  current.includes(chip.id)
                                    ? current.filter(id => id !== chip.id)
                                    : [...current, chip.id]
                                )
                              }}
                              className="rounded border-gray-600 bg-gray-800 text-green-500 focus:ring-0 focus:ring-offset-0" />
                            <Smartphone size={11} className="text-green-400 shrink-0" />
                            <span className="text-xs text-gray-300 flex-1">{chipLabels[chip.id] || chip.id}</span>
                            {chip.number && <span className="text-[11px] text-gray-500">{chip.number}</span>}
                            {chip.proxy && (
                              <span className="text-[11px] bg-blue-900/40 text-blue-400 px-1.5 py-0.5 rounded ml-1">proxy</span>
                            )}
                          </label>
                        )
                      })}
                    </div>
                    {(() => {
                      const readyChips = chips.filter(c => c.isReady)
                      const activeCount = selectedChipIds.length === 0 ? readyChips.length : selectedChipIds.filter(id => readyChips.some(c => c.id === id)).length
                      return activeCount > 1 ? (
                        <p className="text-[11px] text-green-400/70">
                          Rotação entre {activeCount} chips — nunca o mesmo chip em disparos seguidos.
                        </p>
                      ) : activeCount === 1 ? (
                        <p className="text-[11px] text-yellow-400/70">1 chip selecionado — todos os disparos usarão este chip.</p>
                      ) : (
                        <p className="text-[11px] text-red-400">Selecione pelo menos 1 chip.</p>
                      )
                    })()}
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
                      <label className={`flex items-center gap-3 border rounded-xl px-4 py-3 cursor-pointer transition-colors ${csvContacts.length > 0 ? 'border-green-700/50 bg-green-900/10 hover:bg-green-900/20' : 'border-dashed border-gray-700 bg-gray-900 hover:border-gray-500'}`}>
                        <Upload size={18} className={csvContacts.length > 0 ? 'text-green-400 shrink-0' : 'text-gray-500 shrink-0'} />
                        <div className="flex-1 min-w-0">
                          {csvContacts.length > 0 ? (
                            <>
                              <p className="text-xs font-medium text-green-300 truncate">{csvFileName}</p>
                              <p className="text-[11px] text-green-600 mt-0.5">{csvContacts.length} contatos · clique para trocar</p>
                            </>
                          ) : (
                            <>
                              <p className="text-xs text-gray-400">Clique para carregar CSV</p>
                              <p className="text-[11px] text-gray-600 mt-0.5">telefone, nome, coluna1…</p>
                            </>
                          )}
                        </div>
                        <input type="file" accept=".csv,.txt" className="hidden" onChange={handleCsvUpload} />
                      </label>

                      {/* Phone column selector */}
                      {csvAllHeaders.length > 0 && (
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] text-gray-500 shrink-0">Coluna de telefone:</label>
                          <select
                            value={csvPhoneColumn}
                            onChange={e => handlePhoneColumnChange(e.target.value)}
                            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500"
                          >
                            {csvAllHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      )}

                      {/* Duplicates & WA filter */}
                      {csvContacts.length > 0 && (
                        <div className="rounded-xl border border-gray-700 bg-gray-900 overflow-hidden">
                          {/* Duplicates row */}
                          <div className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-800">
                            <AlertCircle size={13} className={csvDups > 0 ? 'text-yellow-400 shrink-0' : 'text-gray-600 shrink-0'} />
                            <span className="text-xs flex-1">
                              {csvDups > 0
                                ? <span className="text-yellow-400">{csvDups} número{csvDups !== 1 ? 's' : ''} duplicado{csvDups !== 1 ? 's' : ''}</span>
                                : <span className="text-gray-500">Sem duplicatas detectadas</span>}
                            </span>
                            <button
                              onClick={removeDuplicates}
                              disabled={csvDups === 0}
                              className="text-[11px] bg-yellow-800 hover:bg-yellow-700 disabled:opacity-30 disabled:cursor-not-allowed text-white px-2.5 py-1 rounded-md transition-colors shrink-0">
                              Remover duplicados
                            </button>
                          </div>

                          {/* WA filter row */}
                          <div className="px-3 py-2.5 space-y-2">
                            <div className="flex items-center gap-2">
                              <Globe size={13} className="text-blue-400 shrink-0" />
                              <span className="text-xs text-gray-400 flex-1">Verificar WhatsApp</span>
                              {waFilterState === 'idle' && (
                                <button onClick={startWaFilter}
                                  className="text-[11px] bg-blue-700 hover:bg-blue-600 text-white px-2.5 py-1 rounded-md transition-colors shrink-0">
                                  Verificar ({csvContacts.length})
                                </button>
                              )}
                              {waFilterState === 'running' && (
                                <span className="text-[11px] text-blue-400 flex items-center gap-1 shrink-0">
                                  <Loader2 size={10} className="animate-spin" /> Verificando…
                                </span>
                              )}
                              {waFilterState === 'done' && (
                                <button onClick={() => { setWaFilterState('idle'); setNoWaNumbers(new Set()) }}
                                  className="text-[11px] text-gray-500 hover:text-gray-300 shrink-0">Refazer</button>
                              )}
                            </div>
                            {waFilterState === 'running' && (
                              <div className="space-y-1">
                                <div className="w-full bg-gray-800 rounded-full h-1">
                                  <div className="bg-blue-500 h-1 rounded-full transition-all"
                                    style={{ width: waFilterProgress.total ? `${(waFilterProgress.checked / waFilterProgress.total) * 100}%` : '0%' }} />
                                </div>
                                <div className="flex justify-between text-[10px] text-gray-600">
                                  <span>{waFilterProgress.checked}/{waFilterProgress.total}</span>
                                  <span><span className="text-green-500">{waFilterProgress.hasWa} ✓</span> · <span className="text-red-500">{waFilterProgress.noWa} ✗</span></span>
                                </div>
                              </div>
                            )}
                            {waFilterState === 'done' && (
                              noWaNumbers.size === 0
                                ? <p className="text-[11px] text-green-400">✅ Todos os {csvContacts.length} números têm WhatsApp</p>
                                : <div className="flex items-center justify-between">
                                    <span className="text-[11px] text-red-400">{noWaNumbers.size} sem WA · {csvContacts.length - noWaNumbers.size} válidos</span>
                                    <button onClick={removeNoWa}
                                      className="text-[11px] bg-red-800 hover:bg-red-700 text-white px-2.5 py-1 rounded-md transition-colors">
                                      Remover inválidos
                                    </button>
                                  </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Detected variables */}
                      {csvHeaders.length > 0 && (
                        <div className="bg-indigo-950/40 border border-indigo-800/30 rounded-xl p-3 space-y-2">
                          <p className="text-[11px] font-medium text-indigo-400">Variáveis disponíveis no template:</p>
                          <div className="flex flex-wrap gap-1.5">
                            <code className="text-[11px] bg-gray-800 text-green-300 px-2 py-0.5 rounded">{'{{name}}'}</code>
                            {csvHeaders.map((h) => (
                              <code key={h} className="text-[11px] bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">
                                {`{{${h}}}`}
                              </code>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Preview table */}
                      {csvContacts.length > 0 && (
                        <div className="rounded-xl border border-gray-700 overflow-hidden">
                          <div className="bg-gray-800/80 px-3 py-2 flex items-center justify-between border-b border-gray-700">
                            <span className="text-[11px] font-medium text-gray-400">Prévia</span>
                            <span className="text-[11px] text-gray-600">{csvContacts.length} contatos</span>
                          </div>
                          <div className="overflow-auto max-h-44">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-gray-900 text-gray-500 text-left">
                                  <th className="px-3 py-1.5 font-medium">Telefone</th>
                                  <th className="px-3 py-1.5 font-medium">Nome</th>
                                  {csvHeaders.map(h => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-800">
                                {csvContacts.slice(0, 5).map((c, i) => {
                                  const noWa = noWaNumbers.has(c.number)
                                  return (
                                    <tr key={i} className={`hover:bg-gray-800/30 ${noWa ? 'opacity-40' : ''}`}>
                                      <td className={`px-3 py-1.5 font-mono ${noWa ? 'text-red-400 line-through' : 'text-gray-300'}`}>
                                        {c.number}
                                      </td>
                                      <td className="px-3 py-1.5 text-gray-400">{c.name || '—'}</td>
                                      {csvHeaders.map(h => <td key={h} className="px-3 py-1.5 text-gray-500">{c.vars[h] || '—'}</td>)}
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                          {csvContacts.length > 5 && (
                            <div className="px-3 py-1.5 bg-gray-900 text-[11px] text-gray-600 border-t border-gray-800">
                              +{csvContacts.length - 5} contatos não exibidos
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
              <div className="flex items-center gap-3">
                <button onClick={() => startCampaign()}
                  disabled={!chips.some(c => c.isReady)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors shadow-lg shadow-green-900/30">
                  <Send size={14} /> Iniciar Campanha
                </button>
                {!chips.some(c => c.isReady) && (
                  <span className="text-xs text-red-400">Nenhum chip conectado</span>
                )}
              </div>
            )}

            {/* Live log */}
            <div className="rounded-xl border border-gray-700 overflow-hidden">
              <div className="bg-gray-900 px-3 py-2 flex items-center justify-between border-b border-gray-700">
                <span className="text-[11px] font-medium text-gray-500">Log em tempo real</span>
                {log.length > 0 && (
                  <span className="text-[11px] text-gray-700">{log.length} eventos</span>
                )}
              </div>
              <div ref={logRef}
                className="h-28 bg-gray-950 p-3 overflow-y-auto text-xs font-mono text-gray-400 space-y-0.5">
                {log.length === 0
                  ? <p className="text-gray-700">Log aparecerá aqui quando a campanha iniciar…</p>
                  : log.map((l, i) => <p key={i} className="leading-relaxed">{l}</p>)}
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

      {/* ── Histórico de Campanhas ──────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <div role="button" tabIndex={0}
          onClick={() => { setShowHistory(s => !s); if (!showHistory) loadHistory() }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowHistory(s => !s); if (!showHistory) loadHistory() } }}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-700/50 transition-colors cursor-pointer">
          <div className="flex items-center gap-2">
            <Clock size={15} className="text-purple-400" />
            <span className="text-sm font-semibold text-white">Histórico de Campanhas</span>
            {history.length > 0 && (
              <span className="text-[11px] bg-purple-900/50 text-purple-400 px-2 py-0.5 rounded-full font-medium">
                {history.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); loadHistory() }}
              className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors" title="Atualizar">
              <RefreshCw size={13} />
            </button>
            {showHistory ? <ChevronUp size={15} className="text-gray-500" /> : <ChevronDown size={15} className="text-gray-500" />}
          </div>
        </div>

        {showHistory && (
          <div className="border-t border-gray-700 p-4 space-y-2">
            {history.length === 0 ? (
              <div className="text-center py-8 text-gray-600">
                <Clock size={28} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Nenhuma campanha salva ainda.</p>
              </div>
            ) : history.map(c => {
              const expanded = historyExpanded === c.id
              const total = c.total || (c.success + c.failed + c.skipped)
              const successPct = total > 0 ? (c.success / total) * 100 : 0
              const delivRate = successPct.toFixed(1) + '%'
              const startDate = new Date(c.startedAt).toLocaleString('pt-BR')
              const endDate = new Date(c.endedAt).toLocaleString('pt-BR')
              const durationMs = c.endedAt - c.startedAt
              const durationMin = Math.floor(durationMs / 60000)
              const durationSec = Math.floor((durationMs % 60000) / 1000)
              const rateColor = successPct >= 90 ? 'text-green-400' : successPct >= 60 ? 'text-yellow-400' : 'text-red-400'
              const barColor = successPct >= 90 ? 'bg-green-500' : successPct >= 60 ? 'bg-yellow-500' : 'bg-red-500'

              function exportHistoryCSV() {
                const csv = ['Número,Nome,Status,Chip,Erro',
                  ...(c.results || []).map(r => `"${r.number}","${r.name}","${r.status}","${r.via || ''}","${r.error || ''}"`)
                ].join('\n')
                const a = document.createElement('a')
                a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
                a.download = `campanha_${new Date(c.startedAt).toISOString().slice(0,10)}.csv`
                a.click()
              }

              return (
                <div key={c.id} className="bg-gray-900 rounded-xl border border-gray-700/50 overflow-hidden">
                  {/* Card header */}
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button onClick={() => setHistoryExpanded(expanded ? null : c.id)}
                      className="flex-1 flex items-center gap-3 min-w-0 text-left">
                      {/* Rate badge */}
                      <div className={`text-lg font-bold w-16 shrink-0 ${rateColor}`}>{delivRate}</div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium">{startDate}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                            <div className={`${barColor} h-1.5 rounded-full transition-all`} style={{ width: `${successPct}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500 shrink-0">{durationMin}m{durationSec}s</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[11px]">
                          <span className="text-gray-500">{total} enviados</span>
                          <span className="text-green-500">{c.success} ✓</span>
                          {c.failed > 0 && <span className="text-red-400">{c.failed} ✗</span>}
                          {(c.skipped ?? 0) > 0 && <span className="text-gray-600">{c.skipped} pulados</span>}
                        </div>
                      </div>
                      {expanded ? <ChevronUp size={14} className="text-gray-600 shrink-0" /> : <ChevronDown size={14} className="text-gray-600 shrink-0" />}
                    </button>
                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={exportHistoryCSV}
                        className="p-1.5 text-gray-500 hover:text-green-400 hover:bg-gray-800 rounded-lg transition-colors" title="Exportar CSV">
                        <FileText size={13} />
                      </button>
                      <button onClick={() => deleteHistory(c.id)}
                        className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors" title="Remover">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-gray-800 px-4 py-4 space-y-3">
                      {/* Summary cards */}
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: 'Total', value: total, color: 'text-white', bg: 'bg-gray-800' },
                          { label: 'Enviados', value: c.success, color: 'text-green-400', bg: 'bg-green-900/20' },
                          { label: 'Erros', value: c.failed, color: 'text-red-400', bg: 'bg-red-900/20' },
                          { label: 'Pulados', value: c.skipped ?? 0, color: 'text-gray-400', bg: 'bg-gray-800' },
                        ].map(card => (
                          <div key={card.label} className={`${card.bg} rounded-lg p-2.5 text-center`}>
                            <p className={`text-lg font-bold ${card.color}`}>{card.value}</p>
                            <p className="text-[10px] text-gray-600 mt-0.5">{card.label}</p>
                          </div>
                        ))}
                      </div>

                      {/* Engagement */}
                      {(() => {
                        const eng = historyEngagement[c.id]
                        const engPct = eng && eng.total > 0 ? Math.round(eng.engaged / eng.total * 100) : 0
                        return (
                          <div className="bg-indigo-950/40 border border-indigo-800/30 rounded-xl p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <MessageSquare size={13} className="text-indigo-400" />
                                <span className="text-xs font-medium text-indigo-300">Engajamento</span>
                                {eng && !eng.loading && (
                                  <span className={`text-xs font-bold ${engPct >= 20 ? 'text-green-400' : engPct >= 5 ? 'text-yellow-400' : 'text-gray-400'}`}>
                                    {eng.rate} ({eng.engaged}/{eng.total})
                                  </span>
                                )}
                              </div>
                              <button
                                onClick={() => fetchHistoryEngagement(c)}
                                disabled={eng?.loading}
                                className="flex items-center gap-1 text-[11px] bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white px-2.5 py-1 rounded-md transition-colors">
                                {eng?.loading
                                  ? <><Loader2 size={10} className="animate-spin" /> Calculando…</>
                                  : <><RefreshCw size={10} /> {eng ? 'Recalcular' : 'Calcular Engajamento'}</>}
                              </button>
                            </div>
                            {eng && !eng.loading && (
                              <>
                                <div className="w-full bg-indigo-900/40 rounded-full h-1.5">
                                  <div className="bg-indigo-500 h-1.5 rounded-full transition-all" style={{ width: `${engPct}%` }} />
                                </div>
                                {eng.engaged === 0
                                  ? <p className="text-[11px] text-gray-500">Nenhum contato respondeu ainda.</p>
                                  : <p className="text-[11px] text-gray-400">{eng.engaged} contato{eng.engaged !== 1 ? 's' : ''} responderam ou clicaram após o disparo.</p>}
                              </>
                            )}
                            {!eng && <p className="text-[11px] text-gray-600">Conta quem respondeu ou clicou após receber a mensagem.</p>}
                          </div>
                        )
                      })()}

                      <div className="text-[11px] text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
                        <span>Início: <span className="text-gray-400">{startDate}</span></span>
                        <span>Fim: <span className="text-gray-400">{endDate}</span></span>
                        <span>Duração: <span className="text-gray-400">{durationMin}m{durationSec}s</span></span>
                      </div>
                      {/* Results table */}
                      {c.results && c.results.length > 0 && (
                        <div className="rounded-lg border border-gray-700/60 overflow-hidden">
                          <div className="bg-gray-800 px-3 py-1.5 flex items-center justify-between">
                            <span className="text-[11px] text-gray-500">{c.results.length} registros</span>
                          </div>
                          <div className="overflow-auto max-h-56">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-gray-900 text-gray-500 text-left border-b border-gray-800">
                                  <th className="px-3 py-2 font-medium">#</th>
                                  <th className="px-3 py-2 font-medium">Número</th>
                                  <th className="px-3 py-2 font-medium">Nome</th>
                                  <th className="px-3 py-2 font-medium">Chip</th>
                                  <th className="px-3 py-2 font-medium">Status</th>
                                  <th className="px-3 py-2 font-medium">Detalhe</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-800/60">
                                {c.results.map((r, idx) => (
                                  <tr key={idx} className={r.status === 'success' ? 'hover:bg-green-900/10' : 'hover:bg-red-900/10'}>
                                    <td className="px-3 py-1.5 text-gray-700">{r.index + 1}</td>
                                    <td className="px-3 py-1.5 font-mono text-gray-300">{r.number}</td>
                                    <td className="px-3 py-1.5 text-gray-400 max-w-[100px] truncate">{r.name || '—'}</td>
                                    <td className="px-3 py-1.5 text-gray-500 text-[11px]">{r.via || '—'}</td>
                                    <td className="px-3 py-1.5">
                                      {r.status === 'success'
                                        ? <span className="inline-flex items-center gap-1 text-green-400 text-[11px] font-medium"><CheckCircle size={10} /> Enviado</span>
                                        : <span className="inline-flex items-center gap-1 text-red-400 text-[11px]"><XCircle size={10} /> Erro</span>}
                                    </td>
                                    <td className="px-3 py-1.5 max-w-[160px]">
                                      {r.error
                                        ? <span className="text-red-400 text-[11px] truncate block" title={r.error}>{r.error.slice(0, 50)}</span>
                                        : r.message
                                        ? <span className="text-gray-600 text-[11px] truncate block" title={r.message}>{r.message.slice(0, 50)}</span>
                                        : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
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
    </div>
  )
})

ChipCampaignPanel.displayName = 'ChipCampaignPanel'

export default ChipCampaignPanel
