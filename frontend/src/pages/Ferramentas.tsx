import { useState, useEffect, useRef } from 'react'
import {
  Wrench, Play, Square, Download, Search, CheckCircle, XCircle,
  Users, ExternalLink, MapPin, Phone, Building, RefreshCw, Upload, X,
  Bot, Plus, Trash2, Save, Power, Clock, MessageSquare, AlertCircle,
  Image as ImageIcon, Mic, Settings,
} from 'lucide-react'
import { onWSMessage } from '../api/websocket'
import { useWuzapiInstances } from '../hooks/useWuzapiInstances'
import type { AutobotRule, AutobotConfig, WuzapiInstance } from '../types'
import { v4 as uuid } from '../utils/uuid'

type Tab = 'maturador' | 'maturador-wuzapi' | 'filtro' | 'grupos' | 'gmaps' | 'autobot'

// ── CSV export helper ─────────────────────────────────────────────────────────

function downloadCSV(rows: string[][], filename: string) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function Ferramentas() {
  const [tab, setTab] = useState<Tab>('maturador')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800 shrink-0">
        <Wrench size={18} className="text-green-400" />
        <h1 className="text-lg font-semibold text-white">Ferramentas</h1>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-800 shrink-0 px-6">
        {([
          { id: 'maturador', label: 'Maturador' },
          { id: 'maturador-wuzapi', label: 'Maturador Wuzapi' },
          { id: 'filtro', label: 'Filtro de Números' },
          { id: 'grupos', label: 'Grupos' },
          { id: 'gmaps', label: 'Google Maps' },
          { id: 'autobot', label: 'Autobot' },
        ] as { id: Tab; label: string }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id ? 'border-green-500 text-green-400' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >{t.label}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'maturador' && <MaturadorTab />}
        {tab === 'maturador-wuzapi' && <WuzapiMaturadorTab />}
        {tab === 'filtro' && <FiltroTab />}
        {tab === 'grupos' && <GruposTab />}
        {tab === 'gmaps' && <GMapsTab />}
        {tab === 'autobot' && <AutobotTab />}
      </div>
    </div>
  )
}

// ── MATURADOR TAB ─────────────────────────────────────────────────────────────

type MaturadorStatus = 'idle' | 'running' | 'paused'

type LogEntry = {
  ts: string
  text: string
  kind: 'system' | 'msg' | 'error' | 'warn' | 'delay'
  from?: string
  to?: string
  msgText?: string
  msgType?: 'text' | 'image' | 'audio'
  fileName?: string
}

type MaturadorMediaFile = { name: string; type: 'image' | 'audio'; url: string }

type DayStat = { sent: number; received: number }

type WarmingEntry = {
  startDate: string       // ISO — primeiro dia de ativação
  activeDays: number      // dias em que o maturador foi ativado para este chip
  lastActiveDate: string  // YYYY-MM-DD local — evita contar o mesmo dia duas vezes
  dailyStats: Record<string, DayStat>  // chave YYYY-MM-DD local
}

// Jornada de aquecimento do maturador Wuzapi — cada número (instância) tem a
// sua própria, começando no dia 1 na primeira vez que participa (controlada
// pelo backend, sobrevive a reload/reconexão do navegador).
type MaturadorJourneyEntry = {
  dayIndex: number
  dailyTarget: number
  dailySent: number
  dailyReceived: number
  startDate: string | null
  history: Record<string, { day: number; target: number; sent: number; received: number }>
}

// Configurações da jornada do maturador Wuzapi, ajustáveis pela engrenagem.
// A jornada tem 10 dias, cada um com sua própria meta (dia 11+ repete a meta
// do dia 10 no backend).
type MaturadorDaySettings = {
  sendMin: number
  sendMax: number
  receiveMin: number
  receiveMax: number
  partners: number  // parceiros fixos que cada canal deve ter até esse dia
}

type MaturadorSettings = {
  days: MaturadorDaySettings[]         // 10 posições, uma por dia da jornada
  participantInstances: string[]       // nomes das instâncias participantes — vazio = todas conectadas/selecionadas
  matrixInstances: string[]            // nomes marcados como "número matriz" — só usado no modo Matriz
}

// Modo "entre si": pares fixos entre todos os participantes (o de sempre).
// Modo "matriz": só os números matriz iniciam conversa, sempre com um
// receptor — matriz não tem limite de envio/recebimento, a cota do dia vale
// só pro receptor. Escolhido ao clicar em Iniciar (não fica salvo).
type MaturadorMode = 'pairs' | 'hub'

const DEFAULT_MATURADOR_DAYS: MaturadorDaySettings[] = [
  { sendMin: 5, sendMax: 10, receiveMin: 3, receiveMax: 6, partners: 1 },
  { sendMin: 7, sendMax: 13, receiveMin: 4, receiveMax: 8, partners: 1 },
  { sendMin: 10, sendMax: 16, receiveMin: 5, receiveMax: 10, partners: 2 },
  { sendMin: 12, sendMax: 18, receiveMin: 6, receiveMax: 12, partners: 2 },
  { sendMin: 15, sendMax: 22, receiveMin: 8, receiveMax: 14, partners: 3 },
  { sendMin: 18, sendMax: 25, receiveMin: 10, receiveMax: 16, partners: 3 },
  { sendMin: 20, sendMax: 28, receiveMin: 12, receiveMax: 18, partners: 4 },
  { sendMin: 23, sendMax: 30, receiveMin: 14, receiveMax: 20, partners: 4 },
  { sendMin: 25, sendMax: 33, receiveMin: 16, receiveMax: 22, partners: 5 },
  { sendMin: 25, sendMax: 35, receiveMin: 18, receiveMax: 25, partners: 5 },
]

const DEFAULT_MATURADOR_SETTINGS: MaturadorSettings = { days: DEFAULT_MATURADOR_DAYS.map(d => ({ ...d })), participantInstances: [], matrixInstances: [] }

// Retorna data local no formato YYYY-MM-DD (não UTC)
function localDateKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Biblioteca de fotos/áudios compartilhada pelos dois maturadores (Chips e
// Wuzapi) — mesmo storage no backend, uma única lista pra gerenciar.
function MaturadorMediaLibrary() {
  const [mediaLibrary, setMediaLibrary] = useState<{ images: MaturadorMediaFile[]; audios: MaturadorMediaFile[] }>({ images: [], audios: [] })
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadingAudio, setUploadingAudio] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)

  function refreshMediaLibrary() {
    fetch('/api/maturador/media').then(r => r.json()).then((d: any) => {
      setMediaLibrary({ images: d.images || [], audios: d.audios || [] })
    }).catch(() => {})
  }

  useEffect(() => { refreshMediaLibrary() }, [])

  async function uploadMedia(files: FileList | null, type: 'image' | 'audio') {
    if (!files || !files.length) return
    const setUploading = type === 'image' ? setUploadingImage : setUploadingAudio
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('type', type)
        const r = await fetch('/api/maturador/media', { method: 'POST', body: fd })
        if (!r.ok) {
          const d = await r.json().catch(() => ({}))
          alert(d.error || 'Falha ao enviar arquivo')
        }
      }
      refreshMediaLibrary()
    } finally {
      setUploading(false)
    }
  }

  async function deleteMedia(file: MaturadorMediaFile) {
    setMediaLibrary(prev => ({
      images: prev.images.filter(f => f.name !== file.name || file.type !== 'image'),
      audios: prev.audios.filter(f => f.name !== file.name || file.type !== 'audio'),
    }))
    await fetch(`/api/maturador/media/${file.type}/${encodeURIComponent(file.name)}`, { method: 'DELETE' }).catch(() => {})
  }

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white mb-1">Biblioteca de mídia</h2>
        <p className="text-xs text-gray-400">
          Fotos e áudios que os maturadores sorteiam para enviar (além das mensagens de texto) — compartilhada entre Chips e Wuzapi.
          Áudios são convertidos automaticamente para nota de voz.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Imagens */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400">
              <ImageIcon size={13} /> Imagens ({mediaLibrary.images.length})
            </label>
            <button type="button" onClick={() => imageInputRef.current?.click()} disabled={uploadingImage}
              className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 disabled:opacity-50">
              <Upload size={12} /> {uploadingImage ? 'Enviando...' : 'Adicionar'}
            </button>
            <input ref={imageInputRef} type="file" accept="image/*" multiple hidden
              onChange={e => { uploadMedia(e.target.files, 'image'); e.target.value = '' }} />
          </div>
          {mediaLibrary.images.length === 0 ? (
            <p className="text-xs text-gray-600 bg-gray-900 border border-gray-700 rounded-lg px-3 py-4 text-center">Nenhuma imagem ainda</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {mediaLibrary.images.map(f => (
                <div key={f.name} className="relative group aspect-square rounded-lg overflow-hidden border border-gray-700 bg-gray-900">
                  <img src={f.url} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => deleteMedia(f)}
                    className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Trash2 size={14} className="text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Áudios */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400">
              <Mic size={13} /> Áudios ({mediaLibrary.audios.length})
            </label>
            <button type="button" onClick={() => audioInputRef.current?.click()} disabled={uploadingAudio}
              className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 disabled:opacity-50">
              <Upload size={12} /> {uploadingAudio ? 'Enviando...' : 'Adicionar'}
            </button>
            <input ref={audioInputRef} type="file" accept="audio/*" multiple hidden
              onChange={e => { uploadMedia(e.target.files, 'audio'); e.target.value = '' }} />
          </div>
          {mediaLibrary.audios.length === 0 ? (
            <p className="text-xs text-gray-600 bg-gray-900 border border-gray-700 rounded-lg px-3 py-4 text-center">Nenhum áudio ainda</p>
          ) : (
            <div className="space-y-1.5">
              {mediaLibrary.audios.map(f => (
                <div key={f.name} className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5">
                  <audio src={f.url} controls className="h-8 flex-1 min-w-0" />
                  <button type="button" onClick={() => deleteMedia(f)} className="text-gray-500 hover:text-red-400 shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MaturadorTab() {
  const [status, setStatus] = useState<MaturadorStatus>('idle')
  const [minDelay, setMinDelay] = useState(60)
  const [maxDelay, setMaxDelay] = useState(300)
  // Log persiste no localStorage para sobreviver à navegação
  const [log, setLog] = useState<LogEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem('maturador_log') || '[]') } catch { return [] }
  })
  const [nextIn, setNextIn] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [availableChips, setAvailableChips] = useState<{ id: string; isReady: boolean; number?: string }[]>([])
  const [selectedChips, setSelectedChips] = useState<string[]>([])
  const [expandedChip, setExpandedChip] = useState<string | null>(null)

  // Envio de fotos/áudios da biblioteca compartilhada (ver MaturadorMediaLibrary)
  const [mediaEnabled, setMediaEnabled] = useState(true)

  // Esteira: dias ATIVOS por chip com estatísticas diárias
  const [warmingDates, setWarmingDates] = useState<Record<string, WarmingEntry>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('warming_dates') || '{}')
      const result: Record<string, WarmingEntry> = {}
      for (const [id, val] of Object.entries(raw)) {
        if (typeof val === 'string') {
          // Migração formato antigo
          const elapsed = Math.floor((Date.now() - new Date(val as string).getTime()) / 86400000)
          result[id] = { startDate: val as string, activeDays: Math.max(elapsed, 1), lastActiveDate: '', dailyStats: {} }
        } else {
          const entry = val as any
          result[id] = { ...entry, dailyStats: entry.dailyStats ?? {} }
        }
      }
      return result
    } catch { return {} }
  })

  const running = status === 'running'

  // Ao montar: buscar chips E verificar se o backend ainda está rodando
  useEffect(() => {
    fetch('/api/chips').then(r => r.json()).then((d: any[]) => {
      setAvailableChips(d)
      const ready = d.filter((c: any) => c.isReady).map((c: any) => c.id)
      setSelectedChips(prev => prev.length ? prev : ready)
    }).catch(() => {})

    // Reintegrar estado do backend
    fetch('/api/maturador/status').then(r => r.json()).then((d: any) => {
      if (typeof d.mediaEnabled === 'boolean') setMediaEnabled(d.mediaEnabled)
      if (d.running) {
        setStatus('running')
        if (d.minDelay) setMinDelay(d.minDelay)
        if (d.maxDelay) setMaxDelay(d.maxDelay)
        if (d.chipIds?.length) setSelectedChips(d.chipIds)
        // Adiciona entrada de "retorno" no log para indicar que estava rodando
        addLog({
          ts: new Date().toLocaleTimeString('pt-BR'),
          text: 'Maturador já estava em execução — retomando monitoramento.',
          kind: 'system',
        })
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const off = onWSMessage('maturador', (payload: any) => {
      const ts = new Date().toLocaleTimeString('pt-BR')
      if (payload.type === 'started') {
        setStatus('running')
        addLog({ ts, text: 'Maturador iniciado!', kind: 'system' })
      }
      if (payload.type === 'stopped') {
        setStatus(prev => prev === 'paused' ? 'paused' : 'idle')
        setNextIn(0)
        if (countdownRef.current) clearInterval(countdownRef.current)
        addLog({ ts, text: 'Maturador parado.', kind: 'system' })
      }
      if (payload.type === 'log') {
        // Registrar estatística diária para sender e receiver
        const day = localDateKey()
        setWarmingDates(prev => {
          const updated = { ...prev }
          const addStat = (chipId: string, field: 'sent' | 'received') => {
            if (!updated[chipId]) return
            const stats = { ...updated[chipId].dailyStats }
            const cur = stats[day] ?? { sent: 0, received: 0 }
            stats[day] = { ...cur, [field]: cur[field] + 1 }
            updated[chipId] = { ...updated[chipId], dailyStats: stats }
          }
          addStat(payload.from, 'sent')
          addStat(payload.to, 'received')
          try { localStorage.setItem('warming_dates', JSON.stringify(updated)) } catch {}
          return updated
        })
        addLog({ ts, text: '', kind: 'msg', from: payload.from, to: payload.to, msgText: payload.message, msgType: payload.msgType || 'text', fileName: payload.fileName })
      }
      if (payload.type === 'error') {
        addLog({ ts, text: `[${payload.chipId}] ${payload.error}`, kind: 'error' })
      }
      if (payload.type === 'waiting') {
        addLog({ ts, text: payload.message, kind: 'warn' })
      }
      if (payload.type === 'delay') {
        addLog({ ts, text: `Próximo envio em ${payload.seconds}s`, kind: 'delay' })
        startCountdown(payload.seconds)
      }
    })
    return () => { off(); if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  // Persiste log no localStorage (últimas 200 entradas) para sobreviver à navegação
  useEffect(() => {
    try { localStorage.setItem('maturador_log', JSON.stringify(log.slice(-200))) } catch {}
  }, [log])

  function addLog(entry: LogEntry) {
    setLog(prev => [...prev.slice(-499), entry])
  }

  function startCountdown(seconds: number) {
    if (countdownRef.current) clearInterval(countdownRef.current)
    setNextIn(seconds)
    const t = setInterval(() => setNextIn(prev => {
      if (prev <= 1) { clearInterval(t); return 0 }
      return prev - 1
    }), 1000)
    countdownRef.current = t
  }

  // Registra ativação — incrementa apenas se hoje (hora local) ainda não foi contado
  function recordWarmingStart(chipIds: string[]) {
    const today = localDateKey()
    setWarmingDates(prev => {
      const updated = { ...prev }
      for (const id of chipIds) {
        if (!updated[id]) {
          updated[id] = { startDate: new Date().toISOString(), activeDays: 1, lastActiveDate: today, dailyStats: {} }
        } else if (updated[id].lastActiveDate !== today) {
          // Novo dia local → incrementa
          updated[id] = { ...updated[id], activeDays: updated[id].activeDays + 1, lastActiveDate: today }
        }
        // Mesmo dia → não incrementa
      }
      try { localStorage.setItem('warming_dates', JSON.stringify(updated)) } catch {}
      return updated
    })
  }

  function removeFromEsteira(chipId: string) {
    const updated = { ...warmingDates }
    delete updated[chipId]
    setWarmingDates(updated)
    localStorage.setItem('warming_dates', JSON.stringify(updated))
  }

  function getChipLabel(chipId: string) {
    try { return (JSON.parse(localStorage.getItem('chip_labels') || '{}') as Record<string, string>)[chipId] || chipId }
    catch { return chipId }
  }

  function getWarmingStatus(entry: WarmingEntry) {
    const days = entry.activeDays
    if (days >= 15) return { days, status: 'Quente', badgeCls: 'bg-red-900/40 text-red-400',    barColor: 'bg-red-500',    progress: 100 }
    if (days >= 7)  return { days, status: 'Morno',  badgeCls: 'bg-yellow-900/40 text-yellow-400', barColor: 'bg-yellow-500', progress: (days / 15) * 100 }
    return              { days, status: 'Frio',   badgeCls: 'bg-blue-900/40 text-blue-400',    barColor: 'bg-blue-500',   progress: (days / 15) * 100 }
  }

  async function start() {
    if (selectedChips.length < 2) return alert('Selecione pelo menos 2 chips para iniciar o maturador.')
    const r = await fetch('/api/maturador/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minDelay, maxDelay, chipIds: selectedChips, mediaEnabled })
    })
    const d = await r.json()
    if (!r.ok) { alert(d.error); return }
    recordWarmingStart(selectedChips)
  }

  async function pause() {
    await fetch('/api/maturador/stop', { method: 'POST' })
    setStatus('paused')
    setNextIn(0)
    if (countdownRef.current) clearInterval(countdownRef.current)
    addLog({ ts: new Date().toLocaleTimeString('pt-BR'), text: 'Maturador pausado — clique em Retomar para continuar.', kind: 'warn' })
  }

  async function resume() {
    const r = await fetch('/api/maturador/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minDelay, maxDelay, chipIds: selectedChips, mediaEnabled })
    })
    if (!r.ok) { const d = await r.json(); alert(d.error); return }
    setStatus('running')
    addLog({ ts: new Date().toLocaleTimeString('pt-BR'), text: 'Maturador retomado.', kind: 'system' })
  }

  async function cancel() {
    await fetch('/api/maturador/stop', { method: 'POST' })
    setStatus('idle')
    setNextIn(0)
    if (countdownRef.current) clearInterval(countdownRef.current)
    addLog({ ts: new Date().toLocaleTimeString('pt-BR'), text: 'Maturador cancelado.', kind: 'error' })
    try { localStorage.removeItem('maturador_log') } catch {}
  }

  const connectedChips = availableChips.filter(c => c.isReady)
  const msgCount = log.filter(l => l.kind === 'msg').length

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-white mb-1">Maturador de Chips</h2>
          <p className="text-xs text-gray-400">Os chips se enviam mensagens entre si automaticamente para aquecimento. Necessário no mínimo 2 chips conectados.</p>
        </div>

        {/* Chip selector */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-2">
            Chips para o maturador <span className="text-gray-600">({connectedChips.length} conectado(s))</span>
          </label>
          {availableChips.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-900/40 rounded-lg px-3 py-2">
              ⚠️ Nenhum chip conectado. Acesse a página de Chips e conecte pelo menos 2.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableChips.map(chip => {
                const sel = selectedChips.includes(chip.id)
                const label = getChipLabel(chip.id)
                return (
                  <button key={chip.id} type="button" disabled={running || !chip.isReady}
                    onClick={() => setSelectedChips(prev =>
                      sel ? prev.filter(id => id !== chip.id) : [...prev, chip.id]
                    )}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${
                      sel
                        ? 'bg-green-900/40 border-green-600 text-green-300'
                        : chip.isReady
                        ? 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                        : 'bg-gray-900 border-gray-800 text-gray-600'
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${chip.isReady ? 'bg-green-400' : 'bg-gray-600'}`} />
                    {label}
                    {sel && <span className="text-green-400 ml-0.5">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
          {connectedChips.length > 0 && selectedChips.length < 2 && (
            <p className="text-xs text-yellow-400/80 mt-1.5">⚠️ Selecione pelo menos 2 chips para iniciar</p>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Delay mínimo</label>
            <div className="flex items-center gap-1">
              <input type="number" min={10} value={minDelay} onChange={e => setMinDelay(+e.target.value)}
                disabled={running}
                className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-green-500 disabled:opacity-50" />
              <span className="text-xs text-gray-400">s</span>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Delay máximo</label>
            <div className="flex items-center gap-1">
              <input type="number" min={10} value={maxDelay} onChange={e => setMaxDelay(+e.target.value)}
                disabled={running}
                className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-green-500 disabled:opacity-50" />
              <span className="text-xs text-gray-400">s</span>
            </div>
          </div>
          {running && nextIn > 0 && (
            <div className="ml-auto text-center">
              <p className="text-xs text-gray-500">Próximo em</p>
              <p className="text-2xl font-mono font-bold text-green-400">{nextIn}s</p>
            </div>
          )}
        </div>

        {/* Envio de mídia */}
        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer w-fit">
          <input type="checkbox" checked={mediaEnabled} disabled={running}
            onChange={e => setMediaEnabled(e.target.checked)}
            className="accent-green-500 disabled:opacity-50" />
          Também enviar fotos e áudios da biblioteca (não só texto)
        </label>

        {/* Status bar */}
        {status !== 'idle' && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
            status === 'running' ? 'bg-green-900/20 border border-green-800/50 text-green-400'
            : 'bg-yellow-900/20 border border-yellow-800/50 text-yellow-400'
          }`}>
            <span className={`w-2 h-2 rounded-full shrink-0 ${status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'}`} />
            {status === 'running'
              ? `Maturando... ${msgCount} mensagens enviadas nesta sessão`
              : 'Pausado — clique em Retomar para continuar'}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {status === 'idle' && (
            <button onClick={start} disabled={selectedChips.length < 2}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg">
              <Play size={14} /> Iniciar Maturador
            </button>
          )}
          {status === 'running' && (
            <>
              <button onClick={pause}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm rounded-lg">
                ⏸ Pausar
              </button>
              <button onClick={cancel}
                className="flex items-center gap-2 px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-sm rounded-lg">
                <Square size={14} /> Cancelar
              </button>
            </>
          )}
          {status === 'paused' && (
            <>
              <button onClick={resume}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
                <Play size={14} /> Retomar
              </button>
              <button onClick={cancel}
                className="flex items-center gap-2 px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-sm rounded-lg">
                <Square size={14} /> Cancelar
              </button>
            </>
          )}
        </div>
      </div>

      <MaturadorMediaLibrary />

      {/* Atividade */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-gray-400">Atividade</p>
            {msgCount > 0 && (
              <span className="text-[10px] bg-green-900/30 text-green-400 px-1.5 py-0.5 rounded-full">
                {msgCount} enviadas
              </span>
            )}
          </div>
          <button onClick={() => setLog([])} className="text-xs text-gray-600 hover:text-gray-400">Limpar</button>
        </div>
        <div ref={logRef} className="h-72 bg-gray-900 rounded-xl border border-gray-700 p-3 overflow-y-auto space-y-1">
          {log.length === 0 ? (
            <p className="text-xs text-gray-600 font-mono">Atividade aparecerá aqui quando o maturador iniciar...</p>
          ) : log.map((l, i) => {
            if (l.kind === 'msg') {
              return (
                <div key={i} className="flex gap-2 py-1 border-b border-gray-800/60">
                  <span className="text-[10px] text-gray-600 font-mono shrink-0 mt-0.5 w-16">{l.ts}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 text-xs flex-wrap">
                      <span className="font-mono text-green-400 font-semibold">{l.from}</span>
                      <span className="text-gray-600">→</span>
                      <span className="font-mono text-blue-400">{l.to}</span>
                    </div>
                    {l.msgType === 'image' && (
                      <p className="text-[11px] text-purple-300 mt-0.5 flex items-center gap-1">
                        <ImageIcon size={11} /> Imagem enviada{l.msgText ? ` — "${l.msgText}"` : ''}
                      </p>
                    )}
                    {l.msgType === 'audio' && (
                      <p className="text-[11px] text-orange-300 mt-0.5 flex items-center gap-1">
                        <Mic size={11} /> Áudio (nota de voz) enviado
                      </p>
                    )}
                    {(!l.msgType || l.msgType === 'text') && l.msgText && (
                      <p className="text-[11px] text-gray-300 mt-0.5 truncate">{l.msgText}</p>
                    )}
                  </div>
                </div>
              )
            }
            return (
              <p key={i} className={`text-xs font-mono flex gap-2 ${
                l.kind === 'error' ? 'text-red-400' : l.kind === 'warn' ? 'text-yellow-400' : l.kind === 'delay' ? 'text-gray-500' : 'text-gray-400'
              }`}>
                <span className="text-gray-600 shrink-0 w-16">{l.ts}</span>
                <span>{l.kind === 'error' ? '❌' : l.kind === 'warn' ? '⚠️' : l.kind === 'delay' ? '⏱️' : '🟢'} {l.text}</span>
              </p>
            )
          })}
        </div>
      </div>

      {/* Esteira Aquecimento */}
      {Object.keys(warmingDates).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Esteira de Aquecimento</p>
          <div className="space-y-3">
            {Object.entries(warmingDates).map(([chipId, entry]) => {
              const { days, status: tempStatus, badgeCls, barColor, progress } = getWarmingStatus(entry)
              const label = getChipLabel(chipId)
              const startFmt = new Date(entry.startDate).toLocaleDateString('pt-BR')
              const isActiveToday = entry.lastActiveDate === localDateKey()
              const isExpanded = expandedChip === chipId

              // Jornada: lista de dias com stats, mais recente primeiro
              const today = localDateKey()
              const journeyDays = Object.entries(entry.dailyStats ?? {})
                .sort(([a], [b]) => b.localeCompare(a))

              // Totais gerais
              const totalSent = journeyDays.reduce((s, [, v]) => s + v.sent, 0)
              const totalReceived = journeyDays.reduce((s, [, v]) => s + v.received, 0)

              function fmtDay(key: string) {
                const [y, m, d] = key.split('-')
                return `${d}/${m}/${y}`
              }

              return (
                <div key={chipId} className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                  {/* Header */}
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-white">{label}</p>
                          {isActiveToday && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-green-900/40 text-green-400 rounded-full border border-green-800/50">
                              ativo hoje
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">Iniciado em {startFmt}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeCls}`}>{tempStatus}</span>
                        <button
                          onClick={() => setExpandedChip(isExpanded ? null : chipId)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 bg-indigo-900/20 rounded-lg border border-indigo-800/40"
                        >
                          {isExpanded ? 'Fechar' : 'Detalhes'}
                        </button>
                        <button onClick={() => removeFromEsteira(chipId)} title="Remover da esteira"
                          className="text-gray-600 hover:text-red-400 transition-colors p-1">
                          <X size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Barra de progresso */}
                    <div className="flex justify-between text-[11px] text-gray-500 mb-1.5">
                      <span>{days} dia(s) de aquecimento ativo</span>
                      <span>{Math.round(progress)}% (meta: 15 dias)</span>
                    </div>
                    <div className="relative w-full bg-gray-700 rounded-full h-2">
                      <div className={`${barColor} h-2 rounded-full transition-all`} style={{ width: `${Math.min(progress, 100)}%` }} />
                      <div className="absolute top-1/2 -translate-y-1/2 w-px h-3.5 bg-yellow-500/60"
                        style={{ left: `${(7 / 15) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-[10px] mt-1.5">
                      <span className="text-blue-400/70">Frio (0–6d)</span>
                      <span className="text-yellow-400/70">Morno (7–14d)</span>
                      <span className="text-red-400/70">Quente (15d+)</span>
                    </div>
                  </div>

                  {/* Detalhes / Jornada */}
                  {isExpanded && (
                    <div className="border-t border-gray-700 bg-gray-900/50">
                      {/* Resumo geral */}
                      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
                        <div className="px-4 py-3 text-center">
                          <p className="text-lg font-bold text-white">{days}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">Dias ativos</p>
                        </div>
                        <div className="px-4 py-3 text-center">
                          <p className="text-lg font-bold text-green-400">{totalSent}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">Msgs enviadas</p>
                        </div>
                        <div className="px-4 py-3 text-center">
                          <p className="text-lg font-bold text-blue-400">{totalReceived}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">Msgs recebidas</p>
                        </div>
                      </div>

                      {/* Jornada dia a dia */}
                      <div className="p-4">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-3">Jornada</p>
                        {journeyDays.length === 0 ? (
                          <p className="text-xs text-gray-600 text-center py-3">Nenhuma atividade registrada ainda.</p>
                        ) : (
                          <div className="space-y-2">
                            {journeyDays.map(([dateKey, stat]) => {
                              const isToday = dateKey === today
                              const total = stat.sent + stat.received
                              const sentPct = total > 0 ? (stat.sent / total) * 100 : 0
                              return (
                                <div key={dateKey} className={`rounded-lg p-3 ${isToday ? 'bg-green-900/20 border border-green-800/40' : 'bg-gray-800'}`}>
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                      <span className={`text-xs font-semibold ${isToday ? 'text-green-400' : 'text-gray-300'}`}>
                                        {isToday ? 'Hoje' : fmtDay(dateKey)}
                                      </span>
                                      {isToday && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
                                    </div>
                                    <span className="text-[10px] text-gray-500">{total} mensagens</span>
                                  </div>
                                  {/* Mini barra enviadas vs recebidas */}
                                  <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-700 mb-2">
                                    <div className="bg-green-500 transition-all" style={{ width: `${sentPct}%` }} />
                                    <div className="bg-blue-500 transition-all" style={{ width: `${100 - sentPct}%` }} />
                                  </div>
                                  <div className="flex gap-4 text-[10px]">
                                    <span className="text-green-400">↑ {stat.sent} enviadas</span>
                                    <span className="text-blue-400">↓ {stat.received} recebidas</span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── WUZAPI MATURADOR TAB ────────────────────────────────────────────────────────
// Mesma lógica do maturador dos Chips, mas as instâncias e o envio passam
// pela API do Wuzapi (BETA). Além disso tem uma "Jornada de Aquecimento" com
// meta diária de mensagens controlada pelo backend e configurável pela
// engrenagem (quantas enviar/receber por dia, quantos contatos conectados
// participam) — assim que a meta do dia é batida o maturador para sozinho
// até o dia seguinte.

type CampaignStatus = 'idle' | 'running' | 'paused'

// Uma campanha = uma seleção de instâncias rodando seu próprio loop de
// aquecimento. Várias podem existir ao mesmo tempo (ver getBusyInstanceNames
// no backend) — cada uma só é bloqueada de rodar se outra campanha já
// estiver usando alguma das mesmas instâncias. localId é gerado no front e
// sobrevive a pausa/retomada (permite manter o card estável); backendId só
// existe enquanto a campanha está de fato rodando no servidor.
type CampaignUI = {
  localId: string
  backendId: string | null
  status: CampaignStatus
  selectedInstances: string[]
  mode: MaturadorMode
  minDelay: number
  maxDelay: number
  mediaEnabled: boolean
  log: LogEntry[]
  nextIn: number
  msgCount: number
  dayQuotaReached: boolean
}

function makeDraftCampaign(selectedInstances: string[]): CampaignUI {
  return {
    localId: uuid(), backendId: null, status: 'idle',
    selectedInstances, mode: 'pairs', minDelay: 60, maxDelay: 300, mediaEnabled: true,
    log: [], nextIn: 0, msgCount: 0, dayQuotaReached: false,
  }
}

function WuzapiMaturadorTab() {
  const { instances } = useWuzapiInstances()
  const [campaigns, setCampaigns] = useState<CampaignUI[]>([])
  const [initialized, setInitialized] = useState(false)
  const countdownRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  // Jornada de aquecimento — uma por número (vem do backend), compartilhada
  // por todas as campanhas (é por instância, não por campanha).
  const [journeys, setJourneys] = useState<Record<string, MaturadorJourneyEntry>>({})
  const [expandedJourney, setExpandedJourney] = useState<string | null>(null)
  const [journeySettings, setJourneySettings] = useState<MaturadorSettings>(DEFAULT_MATURADOR_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [openSettingsFor, setOpenSettingsFor] = useState<string | null>(null)

  // Canais no maturador: histórico de mensagens enviadas/recebidas por instância
  const [warmingDates, setWarmingDates] = useState<Record<string, WarmingEntry>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('wuzapi_warming_dates') || '{}')
      const result: Record<string, WarmingEntry> = {}
      for (const [id, val] of Object.entries(raw)) {
        const entry = val as any
        result[id] = { ...entry, dailyStats: entry.dailyStats ?? {} }
      }
      return result
    } catch { return {} }
  })
  const [expandedInstance, setExpandedInstance] = useState<string | null>(null)

  const connectedInstances = instances.filter(i => i.status === 'connected')

  useEffect(() => {
    let storedCampaigns: CampaignUI[] = []
    try {
      const raw = JSON.parse(localStorage.getItem('wuzapi_maturador_campaigns') || '[]')
      if (Array.isArray(raw)) storedCampaigns = raw
    } catch {}

    Promise.all([
      fetch('/api/wuzapi/instances').then(r => r.json()).catch(() => []),
      fetch('/api/wuzapi-maturador/status').then(r => r.json()).catch(() => null),
    ]).then(([instanceList, d]) => {
      if (d?.journeys) setJourneys(d.journeys)
      if (d?.settings) setJourneySettings(d.settings)

      const backendCampaigns: any[] = d?.campaigns || []
      const readyNames = (instanceList || []).filter((i: any) => i.status === 'connected').map((i: any) => i.name)
      const matchedBackendIds = new Set<string>()

      // Campanhas guardadas localmente (rascunhos e as que já estavam
      // rodando antes de recarregar a página) — reconciliadas com o que o
      // backend realmente tem em execução agora.
      let next: CampaignUI[] = storedCampaigns.map(c => ({ ...c, nextIn: 0 })).map(c => {
        if (!c.backendId) return c
        const bc = backendCampaigns.find(b => b.id === c.backendId)
        if (!bc) return { ...c, backendId: null, status: 'idle' as CampaignStatus }
        matchedBackendIds.add(bc.id)
        return {
          ...c, status: 'running' as CampaignStatus,
          selectedInstances: bc.instanceNames, mode: bc.mode,
          minDelay: bc.minDelay, maxDelay: bc.maxDelay, mediaEnabled: bc.mediaEnabled,
          dayQuotaReached: bc.dayQuotaReached, msgCount: bc.msgCount,
        }
      })

      // Campanhas rodando no backend que a gente ainda não tinha localmente
      // (ex.: primeiro carregamento da página com o maturador já ativo).
      for (const bc of backendCampaigns) {
        if (matchedBackendIds.has(bc.id)) continue
        next.push({
          localId: uuid(), backendId: bc.id, status: 'running',
          selectedInstances: bc.instanceNames, mode: bc.mode,
          minDelay: bc.minDelay, maxDelay: bc.maxDelay, mediaEnabled: bc.mediaEnabled,
          dayQuotaReached: bc.dayQuotaReached, msgCount: bc.msgCount,
          log: [{ ts: new Date().toLocaleTimeString('pt-BR'), text: 'Maturador já estava em execução — retomando monitoramento.', kind: 'system' }],
          nextIn: 0,
        })
      }

      if (!next.length) {
        const draft = makeDraftCampaign(readyNames)
        next = [draft]
        // Assim que a aba abre com nenhuma campanha configurada, já pede pra
        // escolher o modo (Matriz/Entre si) e o delay antes de mais nada.
        setOpenSettingsFor(draft.localId)
      }
      setCampaigns(next)
      setInitialized(true)
    })
  }, [])

  useEffect(() => {
    const off = onWSMessage('wuzapi_maturador', (payload: any) => {
      const ts = new Date().toLocaleTimeString('pt-BR')
      const campaignId = payload.campaignId as string | undefined

      const appendLog = (entry: LogEntry) => {
        if (!campaignId) return
        setCampaigns(prev => prev.map(c => c.backendId === campaignId ? { ...c, log: [...c.log.slice(-499), entry] } : c))
      }

      if (payload.type === 'day_started') {
        setJourneys(prev => ({
          ...prev,
          [payload.instanceName]: {
            ...(prev[payload.instanceName] || { startDate: null, history: {}, dailyReceived: 0 }),
            dayIndex: payload.day, dailyTarget: payload.target, dailySent: 0, dailyReceived: 0,
          },
        }))
        setCampaigns(prev => prev.map(c => c.backendId === campaignId ? { ...c, dayQuotaReached: false } : c))
        appendLog({ ts, text: `${getInstanceLabel(payload.instanceName)}: dia ${payload.day} da jornada iniciado — meta de ${payload.target} mensagens hoje.`, kind: 'system' })
      }
      if (payload.type === 'day_complete') {
        setCampaigns(prev => prev.map(c => c.backendId === campaignId ? { ...c, dayQuotaReached: true } : c))
        appendLog({ ts, text: 'Meta de hoje atingida para todos os números selecionados — aguardando o próximo dia.', kind: 'system' })
      }
      if (payload.type === 'log') {
        setJourneys(prev => {
          const next = { ...prev }
          if (payload.from) {
            const cur = next[payload.from] || { dayIndex: payload.senderDay, dailyTarget: payload.senderTarget, dailySent: 0, dailyReceived: 0, startDate: null, history: {} }
            next[payload.from] = { ...cur, dayIndex: payload.senderDay ?? cur.dayIndex, dailyTarget: payload.senderTarget ?? cur.dailyTarget, dailySent: payload.senderSent ?? cur.dailySent }
          }
          if (payload.to) {
            const cur = next[payload.to] || { dayIndex: payload.receiverDay, dailyTarget: 0, dailySent: 0, dailyReceived: 0, startDate: null, history: {} }
            next[payload.to] = { ...cur, dayIndex: payload.receiverDay ?? cur.dayIndex, dailyReceived: payload.receiverReceived ?? (cur.dailyReceived + 1) }
          }
          return next
        })
        // Registrar estatística diária para sender e receiver (canal conectado)
        const day = localDateKey()
        setWarmingDates(prev => {
          const updated = { ...prev }
          const addStat = (name: string, field: 'sent' | 'received') => {
            if (!updated[name]) return
            const stats = { ...updated[name].dailyStats }
            const cur = stats[day] ?? { sent: 0, received: 0 }
            stats[day] = { ...cur, [field]: cur[field] + 1 }
            updated[name] = { ...updated[name], dailyStats: stats }
          }
          addStat(payload.from, 'sent')
          addStat(payload.to, 'received')
          try { localStorage.setItem('wuzapi_warming_dates', JSON.stringify(updated)) } catch {}
          return updated
        })
        setCampaigns(prev => prev.map(c => c.backendId === campaignId ? { ...c, msgCount: c.msgCount + 1 } : c))
        appendLog({ ts, text: '', kind: 'msg', from: payload.from, to: payload.to, msgText: payload.message, msgType: payload.msgType || 'text', fileName: payload.fileName })
      }
      if (payload.type === 'error') {
        appendLog({ ts, text: `[${payload.instanceName}] ${payload.error}`, kind: 'error' })
      }
      if (payload.type === 'waiting') {
        appendLog({ ts, text: payload.message, kind: 'warn' })
      }
      if (payload.type === 'delay') {
        appendLog({ ts, text: `Próximo envio em ${payload.seconds}s`, kind: 'delay' })
        if (campaignId) startCountdown(campaignId, payload.seconds)
      }
      if (payload.type === 'stopped' && campaignId) {
        stopCountdown(campaignId)
        setCampaigns(prev => prev.map(c => c.backendId === campaignId ? { ...c, status: c.status === 'paused' ? 'paused' : 'idle', nextIn: 0 } : c))
      }
    })
    return () => { off(); Object.values(countdownRefs.current).forEach(clearInterval) }
  }, [])

  useEffect(() => {
    if (!initialized) return
    try { localStorage.setItem('wuzapi_maturador_campaigns', JSON.stringify(campaigns.map(c => ({ ...c, log: c.log.slice(-200) })))) } catch {}
  }, [campaigns, initialized])

  function updateCampaign(localId: string, updater: (c: CampaignUI) => CampaignUI) {
    setCampaigns(prev => prev.map(c => c.localId === localId ? updater(c) : c))
  }

  function startCountdown(campaignId: string, seconds: number) {
    if (countdownRefs.current[campaignId]) clearInterval(countdownRefs.current[campaignId])
    setCampaigns(prev => prev.map(c => c.backendId === campaignId ? { ...c, nextIn: seconds } : c))
    const t = setInterval(() => {
      setCampaigns(prev => prev.map(c => {
        if (c.backendId !== campaignId) return c
        if (c.nextIn <= 1) { clearInterval(t); return { ...c, nextIn: 0 } }
        return { ...c, nextIn: c.nextIn - 1 }
      }))
    }, 1000)
    countdownRefs.current[campaignId] = t
  }

  function stopCountdown(campaignId: string) {
    if (countdownRefs.current[campaignId]) { clearInterval(countdownRefs.current[campaignId]); delete countdownRefs.current[campaignId] }
  }

  // Registra ativação — incrementa apenas se hoje (hora local) ainda não foi contado
  function recordWarmingStart(names: string[]) {
    const today = localDateKey()
    setWarmingDates(prev => {
      const updated = { ...prev }
      for (const id of names) {
        if (!updated[id]) {
          updated[id] = { startDate: new Date().toISOString(), activeDays: 1, lastActiveDate: today, dailyStats: {} }
        } else if (updated[id].lastActiveDate !== today) {
          updated[id] = { ...updated[id], activeDays: updated[id].activeDays + 1, lastActiveDate: today }
        }
      }
      try { localStorage.setItem('wuzapi_warming_dates', JSON.stringify(updated)) } catch {}
      return updated
    })
  }

  function removeFromEsteira(name: string) {
    const updated = { ...warmingDates }
    delete updated[name]
    setWarmingDates(updated)
    localStorage.setItem('wuzapi_warming_dates', JSON.stringify(updated))
  }

  function getWarmingStatus(entry: WarmingEntry) {
    const days = entry.activeDays
    if (days >= 15) return { days, status: 'Quente', badgeCls: 'bg-red-900/40 text-red-400',    barColor: 'bg-red-500',    progress: 100 }
    if (days >= 7)  return { days, status: 'Morno',  badgeCls: 'bg-yellow-900/40 text-yellow-400', barColor: 'bg-yellow-500', progress: (days / 15) * 100 }
    return              { days, status: 'Frio',   badgeCls: 'bg-blue-900/40 text-blue-400',    barColor: 'bg-blue-500',   progress: (days / 15) * 100 }
  }

  function addCampaign() {
    const busy = new Set(campaigns.flatMap(c => c.selectedInstances))
    const preset = connectedInstances.map(i => i.name).filter(n => !busy.has(n))
    const draft = makeDraftCampaign(preset)
    setCampaigns(prev => [...prev, draft])
    // Ao criar uma campanha nova (ex.: pra rodar uma Matriz junto com uma
    // Entre si já em andamento), a engrenagem já abre pra escolher o modo e o
    // delay antes de mexer na seleção de números.
    setOpenSettingsFor(draft.localId)
  }

  function removeCampaign(localId: string) {
    setCampaigns(prev => prev.filter(c => c.localId !== localId))
    setOpenSettingsFor(prev => prev === localId ? null : prev)
  }

  async function launchCampaign(localId: string, resuming: boolean) {
    const c = campaigns.find(x => x.localId === localId)
    if (!c) return
    if (!resuming) {
      if (c.selectedInstances.length < 2) return alert('Selecione pelo menos 2 instâncias para iniciar essa campanha.')
      if (c.mode === 'hub' && !journeySettings.matrixInstances.length) {
        return alert('Marque pelo menos um número matriz na engrenagem antes de iniciar no modo Matriz.')
      }
    }
    const r = await fetch('/api/wuzapi-maturador/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minDelay: c.minDelay, maxDelay: c.maxDelay, instanceNames: c.selectedInstances, mediaEnabled: c.mediaEnabled, mode: c.mode })
    })
    const d = await r.json()
    if (!r.ok) { alert(d.error); return }
    if (!resuming) recordWarmingStart(c.selectedInstances)
    updateCampaign(localId, x => ({
      ...x, backendId: d.campaign.id, status: 'running',
      ...(resuming ? {} : { msgCount: 0, dayQuotaReached: false }),
    }))
    if (resuming) {
      updateCampaign(localId, x => ({ ...x, log: [...x.log.slice(-499), { ts: new Date().toLocaleTimeString('pt-BR'), text: 'Maturador retomado.', kind: 'system' }] }))
    }
  }

  async function pauseCampaign(localId: string) {
    const c = campaigns.find(x => x.localId === localId)
    if (!c?.backendId) return
    const backendId = c.backendId
    await fetch('/api/wuzapi-maturador/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: backendId }) })
    stopCountdown(backendId)
    updateCampaign(localId, x => ({
      ...x, backendId: null, status: 'paused', nextIn: 0,
      log: [...x.log.slice(-499), { ts: new Date().toLocaleTimeString('pt-BR'), text: 'Maturador pausado — clique em Retomar para continuar.', kind: 'warn' }],
    }))
  }

  async function cancelCampaign(localId: string) {
    const c = campaigns.find(x => x.localId === localId)
    if (c?.backendId) {
      await fetch('/api/wuzapi-maturador/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.backendId }) })
      stopCountdown(c.backendId)
    }
    updateCampaign(localId, x => ({ ...x, backendId: null, status: 'idle', nextIn: 0, log: [] }))
  }

  async function deleteJourney(name: string) {
    if (!confirm(`Apagar a jornada de ${getInstanceLabel(name)}? Ela volta pro dia 1 na próxima vez que participar, e os parceiros fixos dela são desfeitos.`)) return
    await fetch(`/api/wuzapi-maturador/journey/${encodeURIComponent(name)}`, { method: 'DELETE' })
    setJourneys(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    if (expandedJourney === name) setExpandedJourney(null)
  }

  async function saveJourneySettings(next: MaturadorSettings) {
    const r = await fetch('/api/wuzapi-maturador/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    })
    const d = await r.json()
    if (!r.ok) { alert(d.error); return }
    setJourneySettings(d)
    setShowSettings(false)
  }

  function getInstanceLabel(name: string) {
    return instances.find(i => i.name === name)?.label || name
  }

  function fmtDay(key: string) {
    const [y, m, d] = key.split('-')
    return `${d}/${m}/${y}`
  }

  const journeyNames = Object.keys(journeys).sort((a, b) => getInstanceLabel(a).localeCompare(getInstanceLabel(b)))

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white mb-1">Maturador de Instâncias (Wuzapi)</h2>
          <p className="text-xs text-gray-400">As instâncias Wuzapi se enviam mensagens entre si automaticamente para aquecimento. Rode quantas campanhas quiser em paralelo — cada instância só pode estar em uma por vez.</p>
        </div>
        <button onClick={addCampaign} title="Adicionar outra campanha de aquecimento"
          className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-lg shrink-0">
          <Plus size={14} /> Nova campanha
        </button>
      </div>

      {campaigns.length === 0 ? (
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 text-center">
          <p className="text-xs text-gray-400 mb-3">Nenhuma campanha configurada ainda.</p>
          <button onClick={addCampaign}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
            <Plus size={14} /> Nova campanha
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {campaigns.map(c => (
            <WuzapiCampaignCard
              key={c.localId}
              campaign={c}
              instances={instances}
              connectedInstances={connectedInstances}
              journeySettings={journeySettings}
              busyElsewhere={(name: string) => campaigns.some(o => o.localId !== c.localId && o.selectedInstances.includes(name))}
              getInstanceLabel={getInstanceLabel}
              settingsOpen={openSettingsFor === c.localId}
              onOpenSettings={() => setOpenSettingsFor(c.localId)}
              onCloseSettings={() => setOpenSettingsFor(prev => prev === c.localId ? null : prev)}
              onSelectInstances={(names: string[]) => updateCampaign(c.localId, x => ({ ...x, selectedInstances: names }))}
              onChangeMode={(mode: MaturadorMode) => updateCampaign(c.localId, x => ({ ...x, mode }))}
              onChangeMinDelay={(v: number) => updateCampaign(c.localId, x => ({ ...x, minDelay: v }))}
              onChangeMaxDelay={(v: number) => updateCampaign(c.localId, x => ({ ...x, maxDelay: v }))}
              onChangeMediaEnabled={(v: boolean) => updateCampaign(c.localId, x => ({ ...x, mediaEnabled: v }))}
              onStart={() => launchCampaign(c.localId, false)}
              onPause={() => pauseCampaign(c.localId)}
              onResume={() => launchCampaign(c.localId, true)}
              onCancel={() => cancelCampaign(c.localId)}
              onRemove={() => removeCampaign(c.localId)}
              onClearLog={() => updateCampaign(c.localId, x => ({ ...x, log: [] }))}
            />
          ))}
        </div>
      )}

      {/* Jornada de Aquecimento — cada número tem a sua própria, dia 1..10 */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white mb-1">Jornada de Aquecimento</h2>
              <p className="text-xs text-gray-400">Cada número tem sua própria esteira de 10 dias, começando no dia em que entra no maturador.</p>
            </div>
            <button onClick={() => setShowSettings(true)} title="Ajustar metas da jornada"
              className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-700 transition-colors shrink-0">
              <Settings size={15} />
            </button>
          </div>

          {journeyNames.length === 0 ? (
            <p className="text-xs text-gray-500">A jornada começa assim que o maturador for iniciado. Ajuste as metas e escolha os números na engrenagem acima antes de começar, se quiser.</p>
          ) : (
            <div className="space-y-3">
              {journeyNames.map(name => {
                const j = journeys[name]
                const isMatrix = journeySettings.matrixInstances.includes(name)
                const pct = j.dailyTarget ? Math.min((j.dailySent / j.dailyTarget) * 100, 100) : 0
                const done = !isMatrix && j.dailyTarget > 0 && j.dailySent >= j.dailyTarget
                const isExpanded = expandedJourney === name
                const historyDays = Object.entries(j.history || {}).sort(([a], [b]) => b.localeCompare(a))
                return (
                  <div key={name} className="bg-gray-900 rounded-lg border border-gray-700 p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                        {getInstanceLabel(name)}
                        {isMatrix && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-900/40 text-indigo-300">Matriz</span>}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-900/40 text-indigo-300">Dia {j.dayIndex}</span>
                        {historyDays.length > 0 && (
                          <button onClick={() => setExpandedJourney(isExpanded ? null : name)} className="text-[10px] text-indigo-400 hover:text-indigo-300">
                            {isExpanded ? 'Fechar' : 'Histórico'}
                          </button>
                        )}
                        <button onClick={() => deleteJourney(name)} title="Apagar jornada"
                          className="text-gray-600 hover:text-red-400 transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                      <span>{isMatrix ? 'Sem limite' : done ? 'Meta de hoje atingida 🎉' : 'Enviando hoje...'}</span>
                      <span>{j.dailySent} enviadas · {j.dailyReceived} recebidas</span>
                    </div>
                    {!isMatrix && (
                      <div className="w-full bg-gray-700 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${done ? 'bg-green-500' : 'bg-indigo-500'}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    {isExpanded && (
                      <div className="mt-2 space-y-1">
                        {historyDays.map(([date, h]) => (
                          <div key={date} className="flex items-center justify-between text-[11px] bg-gray-800 border border-gray-700 rounded px-2 py-1">
                            <span className="text-gray-400">Dia {h.day} <span className="text-gray-600">— {fmtDay(date)}</span></span>
                            <span className={h.sent >= h.target ? 'text-green-400' : 'text-gray-300'}>
                              {h.sent}/{h.target} enviadas · {h.received} recebidas {h.sent >= h.target ? '✓' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
      </div>

      <MaturadorMediaLibrary />

      {/* Canais no Maturador */}
      {Object.keys(warmingDates).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Canais no Maturador</p>
          <div className="space-y-3">
            {Object.entries(warmingDates).map(([name, entry]) => {
              const { days, status: tempStatus, badgeCls, barColor, progress } = getWarmingStatus(entry)
              const label = getInstanceLabel(name)
              const isConnected = instances.find(i => i.name === name)?.status === 'connected'
              const startFmt = new Date(entry.startDate).toLocaleDateString('pt-BR')
              const isActiveToday = entry.lastActiveDate === localDateKey()
              const isExpanded = expandedInstance === name

              const today = localDateKey()
              const channelDays = Object.entries(entry.dailyStats ?? {})
                .sort(([a], [b]) => b.localeCompare(a))

              const totalSent = channelDays.reduce((s, [, v]) => s + v.sent, 0)
              const totalReceived = channelDays.reduce((s, [, v]) => s + v.received, 0)

              return (
                <div key={name} className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                  {/* Header */}
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isConnected ? 'bg-green-400' : 'bg-gray-600'}`} />
                          <p className="text-sm font-semibold text-white">{label}</p>
                          {isActiveToday && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-green-900/40 text-green-400 rounded-full border border-green-800/50">
                              ativo hoje
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">Conectado ao maturador desde {startFmt}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeCls}`}>{tempStatus}</span>
                        <button
                          onClick={() => setExpandedInstance(isExpanded ? null : name)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 bg-indigo-900/20 rounded-lg border border-indigo-800/40"
                        >
                          {isExpanded ? 'Fechar' : 'Detalhes'}
                        </button>
                        <button onClick={() => removeFromEsteira(name)} title="Remover do histórico"
                          className="text-gray-600 hover:text-red-400 transition-colors p-1">
                          <X size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Barra de progresso */}
                    <div className="flex justify-between text-[11px] text-gray-500 mb-1.5">
                      <span>{days} dia(s) de aquecimento ativo</span>
                      <span>{Math.round(progress)}% (meta: 15 dias)</span>
                    </div>
                    <div className="relative w-full bg-gray-700 rounded-full h-2">
                      <div className={`${barColor} h-2 rounded-full transition-all`} style={{ width: `${Math.min(progress, 100)}%` }} />
                      <div className="absolute top-1/2 -translate-y-1/2 w-px h-3.5 bg-yellow-500/60"
                        style={{ left: `${(7 / 15) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-[10px] mt-1.5">
                      <span className="text-blue-400/70">Frio (0–6d)</span>
                      <span className="text-yellow-400/70">Morno (7–14d)</span>
                      <span className="text-red-400/70">Quente (15d+)</span>
                    </div>
                  </div>

                  {/* Detalhes / histórico */}
                  {isExpanded && (
                    <div className="border-t border-gray-700 bg-gray-900/50">
                      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
                        <div className="px-4 py-3 text-center">
                          <p className="text-lg font-bold text-white">{days}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">Dias ativos</p>
                        </div>
                        <div className="px-4 py-3 text-center">
                          <p className="text-lg font-bold text-green-400">{totalSent}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">Msgs enviadas</p>
                        </div>
                        <div className="px-4 py-3 text-center">
                          <p className="text-lg font-bold text-blue-400">{totalReceived}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">Msgs recebidas</p>
                        </div>
                      </div>

                      <div className="p-4">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-3">Histórico</p>
                        {channelDays.length === 0 ? (
                          <p className="text-xs text-gray-600 text-center py-3">Nenhuma atividade registrada ainda.</p>
                        ) : (
                          <div className="space-y-2">
                            {channelDays.map(([dateKey, stat]) => {
                              const isToday = dateKey === today
                              const total = stat.sent + stat.received
                              const sentPct = total > 0 ? (stat.sent / total) * 100 : 0
                              return (
                                <div key={dateKey} className={`rounded-lg p-3 ${isToday ? 'bg-green-900/20 border border-green-800/40' : 'bg-gray-800'}`}>
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                      <span className={`text-xs font-semibold ${isToday ? 'text-green-400' : 'text-gray-300'}`}>
                                        {isToday ? 'Hoje' : fmtDay(dateKey)}
                                      </span>
                                      {isToday && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
                                    </div>
                                    <span className="text-[10px] text-gray-500">{total} mensagens</span>
                                  </div>
                                  <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-700 mb-2">
                                    <div className="bg-green-500 transition-all" style={{ width: `${sentPct}%` }} />
                                    <div className="bg-blue-500 transition-all" style={{ width: `${100 - sentPct}%` }} />
                                  </div>
                                  <div className="flex gap-4 text-[10px]">
                                    <span className="text-green-400">↑ {stat.sent} enviadas</span>
                                    <span className="text-blue-400">↓ {stat.received} recebidas</span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showSettings && (
        <WuzapiMaturadorSettingsModal
          settings={journeySettings}
          instances={instances}
          onSave={saveJourneySettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

// ── Card de uma campanha do maturador Wuzapi ──────────────────────────────────
// Cada campanha roda de forma independente (própria seleção de instâncias,
// modo, delay e atividade) — o card só trava a edição enquanto a campanha
// está "running" (igual sempre foi: pausada, dá pra reajustar antes de
// retomar).
function WuzapiCampaignCard({
  campaign, instances, connectedInstances, journeySettings, busyElsewhere, getInstanceLabel,
  settingsOpen, onOpenSettings, onCloseSettings,
  onSelectInstances, onChangeMode, onChangeMinDelay, onChangeMaxDelay, onChangeMediaEnabled,
  onStart, onPause, onResume, onCancel, onRemove, onClearLog,
}: {
  campaign: CampaignUI
  instances: WuzapiInstance[]
  connectedInstances: WuzapiInstance[]
  journeySettings: MaturadorSettings
  busyElsewhere: (name: string) => boolean
  getInstanceLabel: (name: string) => string
  settingsOpen: boolean
  onOpenSettings: () => void
  onCloseSettings: () => void
  onSelectInstances: (names: string[]) => void
  onChangeMode: (mode: MaturadorMode) => void
  onChangeMinDelay: (v: number) => void
  onChangeMaxDelay: (v: number) => void
  onChangeMediaEnabled: (v: boolean) => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onRemove: () => void
  onClearLog: () => void
}) {
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [campaign.log])

  const running = campaign.status === 'running'
  const locked = running
  const msgCount = campaign.log.filter(l => l.kind === 'msg').length

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
      {/* Cabeçalho: modo e delay ficam na engrenagem, escolhidos antes de mais nada */}
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-gray-700/60">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${
            campaign.mode === 'hub' ? 'bg-indigo-900/40 text-indigo-300' : 'bg-green-900/40 text-green-300'
          }`}>
            {campaign.mode === 'hub' ? 'Matriz' : 'Entre si'}
          </span>
          <span className="text-[11px] text-gray-500">Delay {campaign.minDelay}–{campaign.maxDelay}s</span>
          {campaign.mode === 'hub' && !journeySettings.matrixInstances.length && (
            <span className="text-[11px] text-yellow-400/80">⚠️ sem número matriz marcado</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onOpenSettings} disabled={locked} title="Escolher modo e delay"
            className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            <Settings size={14} />
          </button>
          {campaign.status === 'idle' && (
            <button onClick={onRemove} title="Remover campanha" className="text-gray-600 hover:text-red-400 transition-colors p-1.5">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {settingsOpen && (
        <WuzapiCampaignSettingsModal
          campaign={campaign}
          journeySettings={journeySettings}
          onSave={(patch) => {
            onChangeMode(patch.mode)
            onChangeMinDelay(patch.minDelay)
            onChangeMaxDelay(patch.maxDelay)
            onCloseSettings()
          }}
          onClose={onCloseSettings}
        />
      )}

      {/* Instance selector */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-2">
          Instâncias desta campanha <span className="text-gray-600">({connectedInstances.length} conectada(s))</span>
        </label>
        {instances.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-900/40 rounded-lg px-3 py-2">
            ⚠️ Nenhuma instância Wuzapi cadastrada. Acesse Canais → Wuzapi e conecte pelo menos 2.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {instances.map(inst => {
              const sel = campaign.selectedInstances.includes(inst.name)
              const busy = !sel && busyElsewhere(inst.name)
              const label = inst.label || inst.name
              return (
                <button key={inst.name} type="button" disabled={locked || inst.status !== 'connected' || busy}
                  title={busy ? 'Já está selecionada em outra campanha' : undefined}
                  onClick={() => onSelectInstances(sel ? campaign.selectedInstances.filter(id => id !== inst.name) : [...campaign.selectedInstances, inst.name])}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${
                    sel
                      ? 'bg-green-900/40 border-green-600 text-green-300'
                      : inst.status === 'connected'
                      ? 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                      : 'bg-gray-900 border-gray-800 text-gray-600'
                  }`}>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${inst.status === 'connected' ? 'bg-green-400' : 'bg-gray-600'}`} />
                  {label}
                  {sel && <span className="text-green-400 ml-0.5">✓</span>}
                </button>
              )
            })}
          </div>
        )}
        {connectedInstances.length > 0 && campaign.selectedInstances.length < 2 && (
          <p className="text-xs text-yellow-400/80 mt-1.5">⚠️ Selecione pelo menos 2 instâncias para iniciar</p>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer w-fit">
        <input type="checkbox" checked={campaign.mediaEnabled} disabled={locked}
          onChange={e => onChangeMediaEnabled(e.target.checked)}
          className="accent-green-500 disabled:opacity-50" />
        Também enviar fotos e áudios da biblioteca (não só texto)
      </label>

      {campaign.status !== 'idle' && (
        <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs ${
          running && campaign.dayQuotaReached ? 'bg-indigo-900/20 border border-indigo-800/50 text-indigo-300'
          : campaign.status === 'running' ? 'bg-green-900/20 border border-green-800/50 text-green-400'
          : 'bg-yellow-900/20 border border-yellow-800/50 text-yellow-400'
        }`}>
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              running && campaign.dayQuotaReached ? 'bg-indigo-400' : campaign.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'
            }`} />
            {running && campaign.dayQuotaReached
              ? 'Meta de hoje atingida para todos os números — aguardando o próximo dia'
              : campaign.status === 'running'
              ? `Maturando... ${msgCount} mensagens enviadas nesta sessão`
              : 'Pausado — clique em Retomar para continuar'}
          </span>
          {running && campaign.nextIn > 0 && (
            <span className="font-mono font-bold shrink-0">Próximo em {campaign.nextIn}s</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {campaign.status === 'idle' && (
          <button onClick={onStart} disabled={campaign.selectedInstances.length < 2}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg">
            <Play size={14} /> Iniciar Maturador
          </button>
        )}
        {campaign.status === 'running' && (
          <>
            <button onClick={onPause}
              className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm rounded-lg">
              ⏸ Pausar
            </button>
            <button onClick={onCancel}
              className="flex items-center gap-2 px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-sm rounded-lg">
              <Square size={14} /> Cancelar
            </button>
          </>
        )}
        {campaign.status === 'paused' && (
          <>
            <button onClick={onResume}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
              <Play size={14} /> Retomar
            </button>
            <button onClick={onCancel}
              className="flex items-center gap-2 px-4 py-2 bg-red-800 hover:bg-red-700 text-white text-sm rounded-lg">
              <Square size={14} /> Cancelar
            </button>
          </>
        )}
      </div>

      {/* Atividade desta campanha */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-gray-400">Atividade</p>
            {msgCount > 0 && (
              <span className="text-[10px] bg-green-900/30 text-green-400 px-1.5 py-0.5 rounded-full">
                {msgCount} enviadas
              </span>
            )}
          </div>
          <button onClick={onClearLog} className="text-xs text-gray-600 hover:text-gray-400">Limpar</button>
        </div>
        <div ref={logRef} className="h-56 bg-gray-900 rounded-xl border border-gray-700 p-3 overflow-y-auto space-y-1">
          {campaign.log.length === 0 ? (
            <p className="text-xs text-gray-600 font-mono">Atividade aparecerá aqui quando essa campanha iniciar...</p>
          ) : campaign.log.map((l, i) => {
            if (l.kind === 'msg') {
              return (
                <div key={i} className="flex gap-2 py-1 border-b border-gray-800/60">
                  <span className="text-[10px] text-gray-600 font-mono shrink-0 mt-0.5 w-16">{l.ts}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 text-xs flex-wrap">
                      <span className="font-mono text-green-400 font-semibold">{getInstanceLabel(l.from || '')}</span>
                      <span className="text-gray-600">→</span>
                      <span className="font-mono text-blue-400">{getInstanceLabel(l.to || '')}</span>
                    </div>
                    {l.msgType === 'image' && (
                      <p className="text-[11px] text-purple-300 mt-0.5 flex items-center gap-1">
                        <ImageIcon size={11} /> Imagem enviada{l.msgText ? ` — "${l.msgText}"` : ''}
                      </p>
                    )}
                    {l.msgType === 'audio' && (
                      <p className="text-[11px] text-orange-300 mt-0.5 flex items-center gap-1">
                        <Mic size={11} /> Áudio (nota de voz) enviado
                      </p>
                    )}
                    {(!l.msgType || l.msgType === 'text') && l.msgText && (
                      <p className="text-[11px] text-gray-300 mt-0.5 truncate">{l.msgText}</p>
                    )}
                  </div>
                </div>
              )
            }
            return (
              <p key={i} className={`text-xs font-mono flex gap-2 ${
                l.kind === 'error' ? 'text-red-400' : l.kind === 'warn' ? 'text-yellow-400' : l.kind === 'delay' ? 'text-gray-500' : 'text-gray-400'
              }`}>
                <span className="text-gray-600 shrink-0 w-16">{l.ts}</span>
                <span>{l.kind === 'error' ? '❌' : l.kind === 'warn' ? '⚠️' : l.kind === 'delay' ? '⏱️' : '🟢'} {l.text}</span>
              </p>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Configuração de uma campanha: modo (Matriz/Entre si) + delay ────────────────
// Escolhido de cara pela engrenagem, antes de mexer na seleção de números —
// evita começar uma campanha sem decidir isso primeiro.
function WuzapiCampaignSettingsModal({
  campaign, journeySettings, onSave, onClose,
}: {
  campaign: CampaignUI
  journeySettings: MaturadorSettings
  onSave: (patch: { mode: MaturadorMode; minDelay: number; maxDelay: number }) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<MaturadorMode>(campaign.mode)
  const [minDelay, setMinDelay] = useState(campaign.minDelay)
  const [maxDelay, setMaxDelay] = useState(campaign.maxDelay)

  function save() {
    if (minDelay < 10 || maxDelay < minDelay) {
      return alert('O delay máximo precisa ser maior ou igual ao mínimo (mínimo de 10s).')
    }
    onSave({ mode, minDelay, maxDelay })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Settings size={15} /> Configurar campanha</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-2">Modo da jornada</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode('pairs')}
              className={`flex-1 text-left px-3 py-2 rounded-lg text-xs border transition-colors ${
                mode === 'pairs' ? 'bg-green-900/40 border-green-600 text-green-300' : 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}>
              <span className="font-semibold block">Entre si</span>
              <span className="text-[10px] opacity-80">Cada número troca mensagens com parceiros fixos que vão crescendo aos poucos.</span>
            </button>
            <button type="button" onClick={() => setMode('hub')}
              className={`flex-1 text-left px-3 py-2 rounded-lg text-xs border transition-colors ${
                mode === 'hub' ? 'bg-green-900/40 border-green-600 text-green-300' : 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}>
              <span className="font-semibold block">Matriz</span>
              <span className="text-[10px] opacity-80">Só os números matriz (escolhidos na engrenagem da Jornada de Aquecimento) iniciam conversa com os demais — sem limite pra eles.</span>
            </button>
          </div>
          {mode === 'hub' && !journeySettings.matrixInstances.length && (
            <p className="text-xs text-yellow-400/80 mt-1.5">⚠️ Nenhum número matriz marcado ainda — ajuste na engrenagem da Jornada de Aquecimento antes de iniciar.</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-2">Delay entre mensagens</label>
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Mínimo</label>
              <div className="flex items-center gap-1">
                <input type="number" min={10} value={minDelay} onChange={e => setMinDelay(+e.target.value)}
                  className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-green-500" />
                <span className="text-xs text-gray-400">s</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Máximo</label>
              <div className="flex items-center gap-1">
                <input type="number" min={10} value={maxDelay} onChange={e => setMaxDelay(+e.target.value)}
                  className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-green-500" />
                <span className="text-xs text-gray-400">s</span>
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1.5">Vale entre cada mensagem da troca — não só entre rodadas.</p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-xs text-gray-400 hover:text-white rounded-lg">Cancelar</button>
          <button onClick={save} className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg">Salvar</button>
        </div>
      </div>
    </div>
  )
}

function WuzapiMaturadorSettingsModal({
  settings, instances, onSave, onClose
}: { settings: MaturadorSettings; instances: WuzapiInstance[]; onSave: (s: MaturadorSettings) => void; onClose: () => void }) {
  const [days, setDays] = useState<MaturadorDaySettings[]>(
    Array.from({ length: 10 }, (_, i) => ({ ...(settings.days?.[i] || DEFAULT_MATURADOR_DAYS[i]) }))
  )
  const [participantInstances, setParticipantInstances] = useState<string[]>(settings.participantInstances || [])
  const [matrixInstances, setMatrixInstances] = useState<string[]>(settings.matrixInstances || [])

  function updateDay(i: number, patch: Partial<MaturadorDaySettings>) {
    setDays(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d))
  }

  function toggleParticipant(name: string) {
    setParticipantInstances(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  function toggleMatrix(name: string) {
    setMatrixInstances(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }

  function save() {
    for (let i = 0; i < days.length; i++) {
      const d = days[i]
      if (d.sendMin < 1 || d.sendMax < d.sendMin) return alert(`Dia ${i + 1}: a meta de envio precisa ter mínimo ≥ 1 e máximo ≥ mínimo.`)
      if (d.receiveMin < 0 || d.receiveMax < d.receiveMin) return alert(`Dia ${i + 1}: a meta de recebimento precisa ter máximo ≥ mínimo.`)
      if (d.partners < 1) return alert(`Dia ${i + 1}: cada canal precisa de pelo menos 1 parceiro fixo.`)
    }
    onSave({ days, participantInstances, matrixInstances })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Settings size={15} /> Metas da Jornada (10 dias)</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>

        <p className="text-xs text-gray-500">
          Cada linha é um dia da esteira de aquecimento (o dia 11 em diante repete a meta do dia 10). "Parceiros fixos" é quantos
          canais diferentes cada participante deve trocar mensagens até aquele dia — os parceiros nunca somem, só vão sendo
          adicionados aos poucos, então o número que um canal chama continua sendo o mesmo que troca mensagens com ele.
        </p>

        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-xs border-collapse min-w-[640px]">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left font-medium pb-2 pr-2">Dia</th>
                <th className="text-left font-medium pb-2 pr-2">Enviadas/dia</th>
                <th className="text-left font-medium pb-2 pr-2">Recebidas/dia (canal)</th>
                <th className="text-left font-medium pb-2">Parceiros fixos</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={i} className="border-t border-gray-700">
                  <td className="py-1.5 pr-2 text-gray-300 font-semibold">{i + 1}</td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1">
                      <input type="number" min={1} value={d.sendMin} onChange={e => updateDay(i, { sendMin: +e.target.value })}
                        className="w-14 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-white text-center focus:outline-none focus:border-green-500" />
                      <span className="text-gray-500 shrink-0">até</span>
                      <input type="number" min={1} value={d.sendMax} onChange={e => updateDay(i, { sendMax: +e.target.value })}
                        className="w-14 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-white text-center focus:outline-none focus:border-green-500" />
                    </div>
                  </td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1">
                      <input type="number" min={0} value={d.receiveMin} onChange={e => updateDay(i, { receiveMin: +e.target.value })}
                        className="w-14 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-white text-center focus:outline-none focus:border-green-500" />
                      <span className="text-gray-500 shrink-0">até</span>
                      <input type="number" min={0} value={d.receiveMax} onChange={e => updateDay(i, { receiveMax: +e.target.value })}
                        className="w-14 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-white text-center focus:outline-none focus:border-green-500" />
                    </div>
                  </td>
                  <td className="py-1.5">
                    <input type="number" min={1} value={d.partners} onChange={e => updateDay(i, { partners: +e.target.value })}
                      className="w-14 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-white text-center focus:outline-none focus:border-green-500" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Números que participam da jornada</label>
          {instances.length === 0 ? (
            <p className="text-xs text-gray-600">Nenhuma instância Wuzapi cadastrada ainda.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {instances.map(inst => {
                const sel = participantInstances.includes(inst.name)
                const label = inst.label || inst.name
                return (
                  <button key={inst.name} type="button" onClick={() => toggleParticipant(inst.name)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                      sel
                        ? 'bg-green-900/40 border-green-600 text-green-300'
                        : inst.status === 'connected'
                        ? 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                        : 'bg-gray-900 border-gray-800 text-gray-600'
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${inst.status === 'connected' ? 'bg-green-400' : 'bg-gray-600'}`} />
                    {label}
                    {sel && <span className="text-green-400 ml-0.5">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-1.5">Escolha quais números entram na jornada — nenhum selecionado usa todos os conectados/selecionados ao iniciar. Números marcados como matriz abaixo sempre participam, mesmo que não estejam marcados aqui.</p>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Números matriz (modo Matriz)</label>
          {instances.length === 0 ? (
            <p className="text-xs text-gray-600">Nenhuma instância Wuzapi cadastrada ainda.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {instances.map(inst => {
                const sel = matrixInstances.includes(inst.name)
                const label = inst.label || inst.name
                return (
                  <button key={inst.name} type="button" onClick={() => toggleMatrix(inst.name)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                      sel
                        ? 'bg-indigo-900/40 border-indigo-600 text-indigo-300'
                        : inst.status === 'connected'
                        ? 'bg-gray-700 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                        : 'bg-gray-900 border-gray-800 text-gray-600'
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${inst.status === 'connected' ? 'bg-green-400' : 'bg-gray-600'}`} />
                    {label}
                    {sel && <span className="text-indigo-300 ml-0.5">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-1.5">
            No modo Matriz, só esses números iniciam conversa (mandam mensagem primeiro) com os demais — eles não têm limite de
            envio nem de recebimento; a meta do dia acima vale só pros números receptores.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={save} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
            <Save size={14} /> Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

// ── FILTRO TAB ────────────────────────────────────────────────────────────────

type FilterResult = { number: string; hasWhatsapp: boolean | null; error?: string }

function FiltroTab() {
  const [numbersText, setNumbersText] = useState('')
  const [results, setResults] = useState<FilterResult[]>([])
  const [filtering, setFiltering] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })

  function parseNumbers(text: string) {
    return text.split('\n').map(l => l.replace(/\D/g, '').trim()).filter(n => n.length >= 8)
  }

  async function runFilter() {
    const numbers = parseNumbers(numbersText)
    if (numbers.length === 0) return alert('Adicione números para filtrar.')
    if (numbers.length > 500) return alert('Máximo de 500 números por vez.')
    setFiltering(true)
    setResults([])
    setProgress({ current: 0, total: numbers.length })

    // Filter in batches of 20
    const batchSize = 20
    const allResults: FilterResult[] = []
    for (let i = 0; i < numbers.length; i += batchSize) {
      const batch = numbers.slice(i, i + batchSize)
      try {
        const r = await fetch('/api/tools/filter', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ numbers: batch })
        })
        const d = await r.json()
        allResults.push(...(d.results || []))
      } catch (e) {
        batch.forEach(n => allResults.push({ number: n, hasWhatsapp: null, error: 'Erro de rede' }))
      }
      setProgress({ current: Math.min(i + batchSize, numbers.length), total: numbers.length })
      setResults([...allResults])
    }
    setFiltering(false)
  }

  const valid = results.filter(r => r.hasWhatsapp === true)
  const invalid = results.filter(r => r.hasWhatsapp === false)
  const unknown = results.filter(r => r.hasWhatsapp === null)

  function exportValid() {
    downloadCSV([['Número'], ...valid.map(r => [r.number])], 'numeros_whatsapp.csv')
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setNumbersText(ev.target?.result as string || '')
    reader.readAsText(file)
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-white mb-1">Filtro de Números WhatsApp</h2>
          <p className="text-xs text-gray-400">Verifica quais números têm WhatsApp ativo. Requer chip conectado.</p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-gray-400">Números (um por linha)</label>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer hover:text-gray-200">
              <Upload size={11} /> Carregar arquivo
              <input type="file" accept=".csv,.txt" className="hidden" onChange={handleFileUpload} />
            </label>
          </div>
          <textarea
            value={numbersText}
            onChange={e => setNumbersText(e.target.value)}
            rows={8}
            placeholder={"5511999990001\n5511999990002\n5511999990003"}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono resize-none focus:outline-none focus:border-green-500"
          />
          <p className="text-xs text-gray-500 mt-1">{parseNumbers(numbersText).length} número(s)</p>
        </div>
        <button onClick={runFilter} disabled={filtering}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-lg">
          {filtering ? <><RefreshCw size={14} className="animate-spin" /> Filtrando...</> : <><Search size={14} /> Filtrar</>}
        </button>
      </div>

      {(results.length > 0 || filtering) && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-3">
          {filtering && (
            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Verificando...</span><span>{progress.current}/{progress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          <div className="flex gap-4 text-xs">
            <span className="text-green-400 flex items-center gap-1"><CheckCircle size={12} /> {valid.length} com WhatsApp</span>
            <span className="text-red-400 flex items-center gap-1"><XCircle size={12} /> {invalid.length} sem WhatsApp</span>
            {unknown.length > 0 && <span className="text-gray-400">{unknown.length} inconclusivos</span>}
          </div>

          {valid.length > 0 && (
            <button onClick={exportValid} className="flex items-center gap-1.5 text-xs text-green-400 hover:text-green-300">
              <Download size={12} /> Exportar números válidos ({valid.length})
            </button>
          )}

          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs text-gray-300">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-1.5 pr-3">Número</th>
                  <th className="text-left py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-1 pr-3 font-mono">{r.number}</td>
                    <td className="py-1">
                      {r.hasWhatsapp === true
                        ? <span className="flex items-center gap-1 text-green-400"><CheckCircle size={10} /> Com WhatsApp</span>
                        : r.hasWhatsapp === false
                        ? <span className="flex items-center gap-1 text-red-400"><XCircle size={10} /> Sem WhatsApp</span>
                        : <span className="text-gray-500">Inconclusivo</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── GRUPOS TAB ────────────────────────────────────────────────────────────────

type Group = { id: string; name: string; memberCount: number | string }
type Member = { number: string; name: string }

function GruposTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPages, setSearchPages] = useState(3)
  const [searchLinks, setSearchLinks] = useState<string[]>([])
  const [searching, setSearching] = useState(false)

  async function loadGroups() {
    setLoadingGroups(true)
    const r = await fetch('/api/tools/groups/list')
    const d = await r.json()
    setGroups(d.groups || [])
    if (d.error) alert(d.error)
    setLoadingGroups(false)
  }

  async function loadMembers(group: Group) {
    setSelectedGroup(group)
    setLoadingMembers(true)
    setMembers([])
    const r = await fetch('/api/tools/groups/members', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: group.id })
    })
    const d = await r.json()
    setMembers(d.members || [])
    setLoadingMembers(false)
  }

  async function searchGroups() {
    if (!searchQuery.trim()) return alert('Digite um tema para buscar.')
    setSearching(true)
    setSearchLinks([])
    const r = await fetch('/api/tools/groups/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchQuery, pages: searchPages })
    })
    const d = await r.json()
    setSearchLinks(d.links || [])
    if (d.blocked) alert(d.message || 'Google bloqueou temporariamente. Tente em alguns minutos.')
    else if (d.error) alert('Erro: ' + d.error)
    setSearching(false)
  }

  function exportMembers() {
    downloadCSV([['Número', 'Nome'], ...members.map(m => [m.number, m.name])], `membros_${selectedGroup?.name}.csv`)
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* My groups */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Meus Grupos</h2>
            <p className="text-xs text-gray-400 mt-0.5">Grupos do chip conectado</p>
          </div>
          <button onClick={loadGroups} disabled={loadingGroups}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg">
            <RefreshCw size={12} className={loadingGroups ? 'animate-spin' : ''} /> Carregar
          </button>
        </div>

        {groups.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">Clique em "Carregar" para listar os grupos do chip conectado.</p>
        ) : (
          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {groups.map(g => (
              <div key={g.id} className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <Users size={13} className="text-gray-500" />
                  <span className="text-sm text-gray-200">{g.name}</span>
                  <span className="text-xs text-gray-500">{g.memberCount} membros</span>
                </div>
                <button onClick={() => loadMembers(g)}
                  className="text-xs text-green-400 hover:text-green-300">
                  Ver membros
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Members panel */}
        {selectedGroup && (
          <div className="border-t border-gray-700 pt-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-300">
                {loadingMembers ? 'Carregando...' : `${members.length} membros — ${selectedGroup.name}`}
              </p>
              <div className="flex gap-2">
                {members.length > 0 && (
                  <button onClick={exportMembers} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                    <Download size={11} /> Exportar
                  </button>
                )}
                <button onClick={() => { setSelectedGroup(null); setMembers([]) }} className="text-gray-500 hover:text-gray-300"><X size={14} /></button>
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto">
              {loadingMembers ? (
                <p className="text-xs text-gray-500 text-center py-4">Carregando membros...</p>
              ) : (
                <div className="grid grid-cols-2 gap-1">
                  {members.map((m, i) => (
                    <div key={i} className="text-xs font-mono text-gray-300 bg-gray-900 rounded px-2 py-1">{m.number}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Search groups */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Buscar Grupos Públicos</h2>
          <p className="text-xs text-gray-400 mt-0.5">Encontra links de grupos públicos no Google</p>
        </div>
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && searchGroups()}
            placeholder="Tema: ex. 'imóveis São Paulo'"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
          <select value={searchPages} onChange={e => setSearchPages(+e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded-lg px-2 text-sm text-white focus:outline-none">
            {[1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n} pág.</option>)}
          </select>
          <button onClick={searchGroups} disabled={searching}
            className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-lg">
            {searching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
            {searching ? 'Buscando...' : 'Buscar'}
          </button>
        </div>

        {searchLinks.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-400">{searchLinks.length} grupos encontrados</p>
              <button onClick={() => downloadCSV([['Link'], ...searchLinks.map(l => [l])], 'grupos_whatsapp.csv')}
                className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                <Download size={11} /> Exportar links
              </button>
            </div>
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {searchLinks.map((link, i) => (
                <div key={i} className="flex items-center gap-2 bg-gray-900 rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-300 flex-1 truncate font-mono">{link}</span>
                  <a href={link} target="_blank" rel="noopener noreferrer" className="text-green-400 hover:text-green-300 shrink-0">
                    <ExternalLink size={12} />
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── GMAPS TAB ─────────────────────────────────────────────────────────────────

type GMapsResult = { name: string; phone: string; address: string }

function GMapsTab() {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(30)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<GMapsResult[]>([])
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/tools/gmaps/status').then(r => r.json()).then(d => {
      if (d.isScraping) setRunning(true)
    }).catch(() => {})

    const offs = [
      onWSMessage('gmaps_result', (payload: any) => {
        setResults(prev => [...prev, payload.data])
        setLog(prev => [...prev, `✅ [${payload.current}/${payload.total}] ${payload.data?.name} — ${payload.data?.phone || 'sem telefone'}`])
      }),
      onWSMessage('gmaps_log', (payload: any) => {
        setLog(prev => [...prev, `ℹ️ ${payload.message}`])
      }),
      onWSMessage('gmaps_done', () => {
        setRunning(false)
        setLog(prev => [...prev, '🏁 Extração concluída!'])
      }),
    ]
    return () => offs.forEach(f => f())
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function start() {
    if (!query.trim()) return alert('Digite um termo de busca.')
    setResults([])
    setLog([`🔍 Iniciando busca por: "${query}"...`])
    setRunning(true)
    try {
      const r = await fetch('/api/tools/gmaps/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit })
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        setLog(prev => [...prev, `❌ Erro: ${d.error}`])
        setRunning(false)
      }
    } catch (e: any) {
      setLog(prev => [...prev, `❌ Erro de conexão: ${e.message}`])
      setRunning(false)
    }
  }

  async function stop() {
    await fetch('/api/tools/gmaps/stop', { method: 'POST' })
    setRunning(false)
    setLog(prev => [...prev, '⏹️ Parado pelo usuário.'])
  }

  function exportResults() {
    downloadCSV(
      [['Nome', 'Telefone', 'Endereço'], ...results.map(r => [r.name, r.phone, r.address])],
      'gmaps_contatos.csv'
    )
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Extrator Google Maps</h2>
          <p className="text-xs text-gray-400 mt-0.5">Extrai nome, telefone e endereço de estabelecimentos no Google Maps.</p>
        </div>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !running && start()}
            placeholder="ex: academias de ginástica em São Paulo"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
          <input type="number" min={5} max={200} value={limit} onChange={e => setLimit(+e.target.value)}
            className="w-20 bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white text-center focus:outline-none focus:border-green-500" />
          {!running ? (
            <button onClick={start} className="flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
              <Play size={14} /> Iniciar
            </button>
          ) : (
            <button onClick={stop} className="flex items-center gap-1.5 px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm rounded-lg">
              <Square size={14} /> Parar
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500">Limite de {limit} resultados</p>
      </div>

      {/* Log */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-400">Log de extração</p>
          {results.length > 0 && (
            <button onClick={exportResults} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
              <Download size={11} /> Exportar {results.length} contato(s)
            </button>
          )}
        </div>
        <div ref={logRef} className="h-40 bg-gray-800 rounded-xl border border-gray-700 p-3 overflow-y-auto text-xs font-mono text-gray-300 space-y-0.5">
          {log.length === 0
            ? <p className="text-gray-600">Log aparecerá aqui quando a extração iniciar...</p>
            : log.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      </div>

      {/* Results table */}
      {results.length > 0 && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <p className="text-xs font-medium text-gray-300">{results.length} estabelecimento(s) extraído(s)</p>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs text-gray-300">
              <thead className="sticky top-0 bg-gray-800">
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left px-4 py-2"><Building size={10} className="inline mr-1" />Nome</th>
                  <th className="text-left px-4 py-2"><Phone size={10} className="inline mr-1" />Telefone</th>
                  <th className="text-left px-4 py-2"><MapPin size={10} className="inline mr-1" />Endereço</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-700/30">
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 font-mono text-green-400">{r.phone || '—'}</td>
                    <td className="px-4 py-2 text-gray-400 max-w-xs truncate">{r.address || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── AUTOBOT TAB ───────────────────────────────────────────────────────────────

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const DAY_NUM = [7, 1, 2, 3, 4, 5, 6]

const DEFAULT_CONFIG: AutobotConfig = {
  active: false,
  rules: [],
  workingHours: { enabled: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  antiSpamMinutes: 60,
  aiEnabled: false,
  escalationWord: 'atendente',
  pausedContacts: [],
}

function RuleModal({
  rule, onSave, onClose
}: { rule: Partial<AutobotRule>; onSave: (r: AutobotRule) => void; onClose: () => void }) {
  const [trigger, setTrigger] = useState(rule.trigger || '')
  const [response, setResponse] = useState(rule.response || '')
  const [matchType, setMatchType] = useState<'contains' | 'exact'>(rule.matchType || 'contains')

  function save() {
    if (!trigger.trim()) return alert('O gatilho não pode estar vazio.')
    if (!response.trim()) return alert('A resposta não pode estar vazia.')
    onSave({ id: rule.id || uuid(), trigger: trigger.trim(), response: response.trim(), matchType })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{rule.id ? 'Editar Regra' : 'Nova Regra'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Gatilho (palavra-chave)</label>
            <input
              value={trigger}
              onChange={e => setTrigger(e.target.value)}
              placeholder="oi | olá | preço | * (qualquer mensagem)"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">Use | para múltiplos gatilhos. Use * para qualquer mensagem.</p>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Tipo de correspondência</label>
            <div className="flex gap-3">
              {(['contains', 'exact'] as const).map(type => (
                <label key={type} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input type="radio" value={type} checked={matchType === type} onChange={() => setMatchType(type)} />
                  {type === 'contains' ? 'Contém' : 'Exato'}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Resposta automática</label>
            <textarea
              value={response}
              onChange={e => setResponse(e.target.value)}
              rows={5}
              placeholder={"Olá! Obrigado por entrar em contato.\n\nVariáveis: {{hora}}, {{data}}"}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">Variáveis disponíveis: {'{{hora}}'}, {'{{data}}'}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={save} className="flex items-center gap-1.5 px-4 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
            <Save size={13} /> Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

function AutobotTab() {
  const [config, setConfig] = useState<AutobotConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingRule, setEditingRule] = useState<Partial<AutobotRule> | null>(null)
  const [recentActivity, setRecentActivity] = useState<{ ts: string; type: string; contact: string; text?: string }[]>([])

  useEffect(() => {
    fetch('/api/autobot/rules')
      .then(r => r.json())
      .then(d => { setConfig(d); setLoading(false) })
      .catch(() => setLoading(false))

    const offs = [
      onWSMessage('autobot', (payload: any) => {
        const ts = new Date().toLocaleTimeString('pt-BR')
        if (payload.type === 'sent') {
          setRecentActivity(prev => [{ ts, type: 'sent', contact: payload.contact, text: payload.response }, ...prev.slice(0, 29)])
        }
        if (payload.type === 'escalation') {
          setRecentActivity(prev => [{ ts, type: 'escalation', contact: payload.contact }, ...prev.slice(0, 29)])
          setConfig(c => ({ ...c, pausedContacts: [...(c.pausedContacts || []), payload.contact] }))
        }
        if (payload.type === 'status') {
          setConfig(c => ({ ...c, active: payload.active }))
        }
      }),
    ]
    return () => offs.forEach(f => f())
  }, [])

  async function saveConfig() {
    setSaving(true)
    await fetch('/api/autobot/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
    setSaving(false)
  }

  async function toggleActive() {
    const newActive = !config.active
    setConfig(c => ({ ...c, active: newActive }))
    await fetch('/api/autobot/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: newActive })
    })
  }

  function saveRule(rule: AutobotRule) {
    setConfig(c => {
      const exists = c.rules.findIndex(r => r.id === rule.id)
      const rules = exists >= 0
        ? c.rules.map(r => r.id === rule.id ? rule : r)
        : [...c.rules, rule]
      return { ...c, rules }
    })
    setEditingRule(null)
  }

  function deleteRule(id: string) {
    if (!confirm('Excluir esta regra?')) return
    setConfig(c => ({ ...c, rules: c.rules.filter(r => r.id !== id) }))
  }

  async function unpauseContact(contact: string) {
    setConfig(c => ({ ...c, pausedContacts: (c.pausedContacts || []).filter(x => x !== contact) }))
    await fetch('/api/autobot/unpause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact })
    })
  }

  function toggleDay(dayNum: number) {
    setConfig(c => ({
      ...c,
      workingHours: {
        ...c.workingHours,
        days: c.workingHours.days.includes(dayNum)
          ? c.workingHours.days.filter(d => d !== dayNum)
          : [...c.workingHours.days, dayNum]
      }
    }))
  }

  if (loading) return <div className="flex items-center justify-center py-16 text-gray-500">Carregando...</div>

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-400">Respostas automáticas por palavras-chave</p>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleActive}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              config.active
                ? 'bg-green-900/50 text-green-400 border border-green-700 hover:bg-green-800/50'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
            }`}
          >
            <Power size={14} className={config.active ? 'text-green-400' : 'text-gray-500'} />
            {config.active ? 'Ativo' : 'Inativo'}
          </button>
          <button
            onClick={saveConfig}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-lg"
          >
            <Save size={14} /> {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>

      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
        config.active
          ? 'bg-green-900/20 border-green-800 text-green-400'
          : 'bg-gray-800 border-gray-700 text-gray-400'
      }`}>
        <div className={`w-2 h-2 rounded-full ${config.active ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
        <p className="text-sm">
          {config.active
            ? 'Autobot ativo — respondendo mensagens automaticamente'
            : 'Autobot inativo — nenhuma resposta automática será enviada'}
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <MessageSquare size={15} className="text-gray-400" />
            <h2 className="text-sm font-semibold text-white">Regras de Resposta</h2>
            <span className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{config.rules.length}</span>
          </div>
          <button
            onClick={() => setEditingRule({})}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded-lg"
          >
            <Plus size={13} /> Nova Regra
          </button>
        </div>
        {config.rules.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <MessageSquare size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-xs">Nenhuma regra configurada.</p>
            <p className="text-xs mt-0.5">Adicione regras para responder automaticamente.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {config.rules.map(rule => (
              <div key={rule.id} className="flex items-start gap-3 px-5 py-4 hover:bg-gray-700/30 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-xs bg-gray-900 text-green-400 px-2 py-0.5 rounded font-mono">{rule.trigger}</code>
                    <span className="text-xs text-gray-500">{rule.matchType === 'exact' ? 'exato' : 'contém'}</span>
                  </div>
                  <p className="text-xs text-gray-300 line-clamp-2">{rule.response}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => setEditingRule(rule)} className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded">
                    <Save size={13} />
                  </button>
                  <button onClick={() => deleteRule(rule.id)} className="p-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-900/20 rounded">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-5">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Clock size={15} className="text-gray-400" /> Configurações</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={config.workingHours.enabled}
              onChange={e => setConfig(c => ({ ...c, workingHours: { ...c.workingHours, enabled: e.target.checked } }))}
              className="rounded"
            />
            Horário de atendimento
          </label>
          {config.workingHours.enabled && (
            <div className="pl-5 space-y-3">
              <div className="flex items-center gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Início</label>
                  <input type="time" value={config.workingHours.start}
                    onChange={e => setConfig(c => ({ ...c, workingHours: { ...c.workingHours, start: e.target.value } }))}
                    className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fim</label>
                  <input type="time" value={config.workingHours.end}
                    onChange={e => setConfig(c => ({ ...c, workingHours: { ...c.workingHours, end: e.target.value } }))}
                    className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
                </div>
              </div>
              <div className="flex gap-1.5">
                {DAYS.map((label, i) => {
                  const dayNum = DAY_NUM[i]
                  const active = config.workingHours.days.includes(dayNum)
                  return (
                    <button key={label} onClick={() => toggleDay(dayNum)}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        active ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                      }`}>{label}</button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-300">Intervalo anti-spam</label>
          <input
            type="number" min={0} max={1440}
            value={config.antiSpamMinutes}
            onChange={e => setConfig(c => ({ ...c, antiSpamMinutes: +e.target.value }))}
            className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-green-500"
          />
          <span className="text-xs text-gray-400">minutos (0 = sem limite)</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-300">Palavra de escalada</label>
          <input
            value={config.escalationWord}
            onChange={e => setConfig(c => ({ ...c, escalationWord: e.target.value }))}
            placeholder="atendente"
            className="w-32 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500"
          />
          <span className="text-xs text-gray-400">pausa o bot para esse contato</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={config.aiEnabled}
            onChange={e => setConfig(c => ({ ...c, aiEnabled: e.target.checked }))}
            className="rounded"
          />
          Respostas com IA (requer GROQ_API_KEY ou OPENAI_API_KEY no .env)
        </label>
      </div>

      {(config.pausedContacts || []).length > 0 && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Bot size={15} className="text-gray-400" />
            Contatos com atendimento humano
            <span className="text-xs bg-yellow-900/50 text-yellow-400 px-1.5 py-0.5 rounded-full">{config.pausedContacts.length}</span>
          </h2>
          <p className="text-xs text-gray-400">O autobot está pausado para estes contatos. Clique em X para reativar.</p>
          <div className="flex flex-wrap gap-2">
            {config.pausedContacts.map(c => (
              <div key={c} className="flex items-center gap-1.5 bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5">
                <span className="text-xs font-mono text-gray-300">{c}</span>
                <button onClick={() => unpauseContact(c)} className="text-gray-500 hover:text-red-400">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentActivity.length > 0 && (
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <AlertCircle size={15} className="text-gray-400" /> Atividade Recente
          </h2>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {recentActivity.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-gray-600 shrink-0">{a.ts}</span>
                <span className={a.type === 'escalation' ? 'text-yellow-400' : 'text-gray-300'}>
                  {a.type === 'sent' ? `Respondeu ${a.contact}: ${a.text?.slice(0, 60)}...` : `${a.contact} pediu atendente`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {editingRule !== null && (
        <RuleModal rule={editingRule} onSave={saveRule} onClose={() => setEditingRule(null)} />
      )}
    </div>
  )
}
