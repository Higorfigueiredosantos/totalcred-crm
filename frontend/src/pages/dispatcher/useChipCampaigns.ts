import { useEffect, useRef, useState } from 'react'
import { onWSMessage } from '../../api/websocket'
import { apiFetch } from '../../hooks/useChips'
import type { CampaignHistoryRecord, ChipCampaignResult } from '../../types'
import {
  type ChipCampaignConfig, type ChipCampaignFinalStats, type ChipCampaignItem,
  saveCampaignName, lookupCampaignName,
} from './chipCampaign'

function historyToItem(rec: CampaignHistoryRecord): ChipCampaignItem {
  return {
    id: rec.id,
    name: lookupCampaignName(rec.startedAt) ?? `Campanha via Chips`,
    status: 'done',
    chipIds: [],
    createdAt: rec.startedAt,
    endedAt: rec.endedAt,
    stats: { current: rec.total, total: rec.total, success: rec.success, failed: rec.failed },
    log: [],
    results: rec.results ?? [],
    finalStats: null,
    riskLevel: '—',
    waiting: 0,
    paused: false,
    fromHistory: true,
  }
}

// Estado + ações da campanha via Chips, no mesmo shape de "lista de itens" usado
// pelas campanhas oficiais (Blast) — cada disparo (rodando ou já concluído) é um
// ChipCampaignItem. Só existe uma campanha via chips ativa por vez (limite do
// backend em /api/chip-campaign/*), então `current` representa essa campanha.
export function useChipCampaigns() {
  const [current, setCurrent] = useState<ChipCampaignItem | null>(null)
  const [history, setHistory] = useState<CampaignHistoryRecord[]>([])
  const [finalStatsCache, setFinalStatsCache] = useState<Record<string, ChipCampaignFinalStats>>({})
  const [recalculatingId, setRecalculatingId] = useState<string | null>(null)
  const waitRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadHistory = () =>
    fetch('/api/chip-campaign/history').then(r => r.json()).then(setHistory).catch(() => {})

  useEffect(() => { loadHistory() }, [])

  useEffect(() => {
    const offs = [
      onWSMessage('chip_campaign', (p: any) => handleCampaignEvent(p)),
      onWSMessage('tick_update', (p: any) => {
        setCurrent(prev => prev ? { ...prev, riskLevel: p.riskLevel || prev.riskLevel } : prev)
      }),
      onWSMessage('ban_alert', (p: any) => addLog(`🚨 ${p.message}`)),
    ]
    return () => offs.forEach(f => f())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addLog(msg: string) {
    const ts = new Date().toLocaleTimeString('pt-BR')
    setCurrent(prev => prev ? { ...prev, log: [...prev.log.slice(-199), `[${ts}] ${msg}`] } : prev)
  }

  function startWait(sec: number) {
    if (waitRef.current) clearInterval(waitRef.current)
    setCurrent(prev => prev ? { ...prev, waiting: sec } : prev)
    const t = setInterval(() => {
      setCurrent(prev => {
        if (!prev) { clearInterval(t); return prev }
        if (prev.waiting <= 1) { clearInterval(t); return { ...prev, waiting: 0 } }
        return { ...prev, waiting: prev.waiting - 1 }
      })
    }, 1000)
    waitRef.current = t
  }

  function handleCampaignEvent(p: any) {
    if (p.type === 'progress') {
      setCurrent(prev => prev ? { ...prev, stats: { ...prev.stats, current: p.current, total: p.total, success: p.success, failed: p.failed } } : prev)
      addLog(`⏳ [${p.current}/${p.total}] Enviando para ${p.contact?.number}...`)
    }
    if (p.type === 'result') {
      setCurrent(prev => {
        if (!prev) return prev
        const next = [...prev.results]
        const i = next.findIndex(r => r.number === p.contact?.number)
        if (i >= 0) next[i] = p.contact; else next.push(p.contact)
        return { ...prev, results: next, stats: { ...prev.stats, success: p.success, failed: p.failed } }
      })
      addLog(p.contact?.status === 'success' ? `✅ ${p.contact.number}` : `❌ ${p.contact?.number} — ${p.contact?.error}`)
    }
    if (p.type === 'started') {
      addLog(`🔀 Chips em rotação: ${(p.chips as string[]).join(', ')} (${p.chips.length} chip${p.chips.length !== 1 ? 's' : ''})`)
    }
    if (p.type === 'waiting') {
      setCurrent(prev => prev ? { ...prev, riskLevel: p.risk || prev.riskLevel } : prev)
      startWait(p.delay)
      const nextInfo = p.nextChip ? ` → próximo: ${p.nextChip}` : ''
      addLog(`⏱️ Aguardando ${p.delay}s  (risco: ${p.risk})${nextInfo}`)
    }
    if (p.type === 'skipped') addLog(`⏭️ ${p.number} — já enviado anteriormente`)
    if (p.type === 'cooldown') addLog(`🛑 Cooldown ${p.seconds}s`)
    if (p.type === 'batch_pause') { startWait(p.seconds); addLog(`☕ Pausa de lote (${p.batchCount} enviados) — aguardando ${p.seconds}s`) }
    if (p.type === 'paused') { setCurrent(prev => prev ? { ...prev, paused: true } : prev); addLog(`⏸️ ${p.reason || 'Pausado'}`) }
    if (p.type === 'stopped') { setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev); addLog('🛑 Interrompido.') }
    if (p.type === 'done') {
      addLog(`🏁 Concluído! Sucesso: ${p.success}  Falha: ${p.failed}  Entrega: ${p.stats?.deliveryRate}`)
      setCurrent(prev => prev ? {
        ...prev, status: 'done', paused: false, endedAt: Date.now(),
        riskLevel: p.stats?.riskLevel ?? prev.riskLevel,
      } : prev)
      setTimeout(loadHistory, 1500)
    }
  }

  async function startCampaign(config: ChipCampaignConfig) {
    const body = {
      contacts: config.contacts, messageTemplate: config.message,
      settings: { ...config.settings, greetings: config.greetings, selectedChipIds: config.chipIds },
      mediaData: config.imageB64 ? { type: 'image', base64: config.imageB64 } : null,
    }
    const r = await fetch('/api/chip-campaign/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok) return { ok: false as const, error: d.error, message: d.message }

    const startedAt = Date.now()
    saveCampaignName(startedAt, config.name)
    setCurrent({
      id: `live-${startedAt}`,
      name: config.name,
      status: 'running',
      chipIds: config.chipIds,
      createdAt: startedAt,
      stats: { current: 0, total: d.count, success: 0, failed: 0 },
      log: [`🚀 Campanha iniciada — ${d.count} contatos`],
      results: [],
      finalStats: null,
      riskLevel: 'BAIXO',
      waiting: 0,
      paused: false,
      fromHistory: false,
    })
    return { ok: true as const }
  }

  async function togglePause() {
    await apiFetch('/api/chip-campaign/pause', { method: 'POST' })
    setCurrent(prev => prev ? { ...prev, paused: !prev.paused } : prev)
  }

  async function stop() {
    await apiFetch('/api/chip-campaign/stop', { method: 'POST' })
  }

  async function resetSent() {
    const d = await apiFetch('/api/chip-campaign/reset-sent', { method: 'POST' })
    addLog(`🔄 Histórico limpo: ${d.cleared} número(s)`)
  }

  async function deleteHistory(id: string) {
    if (!confirm('Remover este registro do histórico?')) return
    await fetch(`/api/chip-campaign/history/${id}`, { method: 'DELETE' })
    setHistory(prev => prev.filter(c => c.id !== id))
  }

  function exportResultsCSV(results: ChipCampaignResult[], fileName: string) {
    const csv = ['Número,Nome,Status,Chip,Mensagem,Erro',
      ...results.map(r => `"${r.number}","${r.name}","${r.status}","${r.via}","${(r.message || '').replace(/"/g, '""')}","${r.error || ''}"`)
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = fileName; a.click()
  }

  async function computeFinalStats(item: ChipCampaignItem): Promise<ChipCampaignFinalStats> {
    const sentContacts = item.results.filter(r => r.status === 'success').map(r => ({ number: r.number, sentAt: r.sentAt ?? item.createdAt }))
    const [rs, ir] = await Promise.all([
      fetch('/api/responses/stats').then(r => r.json()).catch(() => ({})),
      fetch('/api/chip-campaign/interaction-rate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentContacts }),
      }).then(r => r.json()).catch(() => ({ interacted: 0, rate: '0%', notInteracted: 0 })),
    ])
    const success = item.results.filter(r => r.status === 'success').length
    const failed = item.results.filter(r => r.status === 'failed').length
    const delivered = item.results.filter(r => (r.ack ?? 0) >= 2).length
    const total = item.stats.total || item.results.length
    return {
      total, success, failed, skipped: Math.max(0, total - success - failed),
      deliveryRate: success > 0 ? ((delivered / success) * 100).toFixed(1) + '%' : '0%',
      riskLevel: item.riskLevel,
      startedAt: new Date(item.createdAt).toLocaleString('pt-BR'),
      endedAt: item.endedAt ? new Date(item.endedAt).toLocaleString('pt-BR') : '—',
      responses: rs.last24h ?? 0,
      responseRate: success > 0 ? (((rs.last24h ?? 0) / success) * 100).toFixed(1) + '%' : '0%',
      interacted: ir.interacted ?? 0,
      interactionRate: ir.rate ?? '0%',
      notInteracted: ir.notInteracted ?? 0,
    }
  }

  async function recalcEngagement(item: ChipCampaignItem) {
    setRecalculatingId(item.id)
    try {
      const stats = await computeFinalStats(item)
      setFinalStatsCache(prev => ({ ...prev, [item.id]: stats }))
      if (current?.id === item.id) setCurrent(prev => prev ? { ...prev, finalStats: stats } : prev)
    } finally {
      setRecalculatingId(null)
    }
  }

  const items: ChipCampaignItem[] = [
    ...(current ? [{ ...current, finalStats: finalStatsCache[current.id] ?? current.finalStats }] : []),
    ...history
      // evita duplicar a campanha corrente assim que ela cai no histórico do backend
      .filter(rec => !current || Math.abs(rec.startedAt - current.createdAt) > 5000)
      .map(rec => {
        const item = historyToItem(rec)
        return { ...item, finalStats: finalStatsCache[item.id] ?? null }
      }),
  ].sort((a, b) => b.createdAt - a.createdAt)

  return {
    items,
    startCampaign, togglePause, stop, resetSent,
    deleteHistory, exportResultsCSV,
    recalcEngagement, computeFinalStats, recalculatingId,
  }
}
