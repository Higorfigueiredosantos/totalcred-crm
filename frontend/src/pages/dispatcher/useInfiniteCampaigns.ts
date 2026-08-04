import { useEffect, useState } from 'react'
import { onWSMessage } from '../../api/websocket'
import { apiFetch } from '../../hooks/useChips'
import type { InfiniteCampaignHistoryRecord, InfiniteCampaignResult } from '../../types'
import {
  type InfiniteCampaignConfig, type InfiniteCampaignItem,
  saveCampaignName, lookupCampaignName,
} from './infiniteCampaign'

function historyToItem(rec: InfiniteCampaignHistoryRecord): InfiniteCampaignItem {
  return {
    id: rec.id,
    name: lookupCampaignName(rec.startedAt) ?? rec.name ?? 'Campanha Infinite',
    status: 'done',
    instanceNames: [],
    messageType: rec.messageType,
    createdAt: rec.startedAt,
    endedAt: rec.endedAt,
    stats: { current: rec.total, total: rec.total, success: rec.success, failed: rec.failed },
    log: [],
    results: rec.results ?? [],
    waiting: 0,
    paused: false,
    fromHistory: true,
  }
}

// Estado + ações da campanha via Infinite, no mesmo shape de "lista de itens"
// usado pelas campanhas oficiais e via Chips. Só existe uma campanha Infinite
// ativa por vez (limite do backend em /api/infinite-campaign/*).
export function useInfiniteCampaigns() {
  const [current, setCurrent] = useState<InfiniteCampaignItem | null>(null)
  const [history, setHistory] = useState<InfiniteCampaignHistoryRecord[]>([])

  const loadHistory = () =>
    fetch('/api/infinite-campaign/history').then(r => r.json()).then(setHistory).catch(() => {})

  useEffect(() => { loadHistory() }, [])

  useEffect(() => {
    const off = onWSMessage('infinite_campaign', (p: any) => handleCampaignEvent(p))
    return () => off()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addLog(msg: string) {
    const ts = new Date().toLocaleTimeString('pt-BR')
    setCurrent(prev => prev ? { ...prev, log: [...prev.log.slice(-199), `[${ts}] ${msg}`] } : prev)
  }

  function startWait(sec: number) {
    setCurrent(prev => prev ? { ...prev, waiting: sec } : prev)
    let remaining = sec
    const t = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) { clearInterval(t); setCurrent(prev => prev ? { ...prev, waiting: 0 } : prev); return }
      setCurrent(prev => prev ? { ...prev, waiting: remaining } : prev)
    }, 1000)
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
      addLog(`🔀 Instâncias em rotação: ${(p.instances as string[]).join(', ')}`)
    }
    if (p.type === 'skipped') addLog(`⏭️ ${p.number} — já enviado anteriormente`)
    if (p.type === 'waiting') { startWait(p.delay); addLog(`⏱️ Aguardando ${p.delay}s`) }
    if (p.type === 'paused') { setCurrent(prev => prev ? { ...prev, paused: p.paused } : prev); addLog(p.paused ? '⏸️ Pausado' : '▶️ Retomado') }
    if (p.type === 'stopped') { setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev); addLog('🛑 Interrompido.') }
    if (p.type === 'done') {
      addLog(`🏁 Concluído! Sucesso: ${p.success}  Falha: ${p.failed}`)
      setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev)
      setTimeout(loadHistory, 1500)
    }
  }

  async function startCampaign(config: InfiniteCampaignConfig) {
    const body = {
      name: config.name,
      messageType: config.messageType,
      payload: config.payload,
      instanceNames: config.instanceNames,
      contacts: config.contacts,
      delayMin: config.delayMin,
      delayMax: config.delayMax,
    }
    const r = await fetch('/api/infinite-campaign/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await r.json()
    if (!r.ok) return { ok: false as const, error: d.error }

    const startedAt = Date.now()
    saveCampaignName(startedAt, config.name)
    setCurrent({
      id: `live-${startedAt}`,
      name: config.name,
      status: 'running',
      instanceNames: config.instanceNames,
      messageType: config.messageType,
      createdAt: startedAt,
      stats: { current: 0, total: d.count, success: 0, failed: 0 },
      log: [`🚀 Campanha iniciada — ${d.count} contatos`],
      results: [],
      waiting: 0,
      paused: false,
      fromHistory: false,
    })
    return { ok: true as const }
  }

  async function togglePause() {
    await apiFetch('/api/infinite-campaign/pause', { method: 'POST' })
  }

  async function stop() {
    await apiFetch('/api/infinite-campaign/stop', { method: 'POST' })
  }

  async function deleteHistory(id: string) {
    if (!confirm('Remover este registro do histórico?')) return
    await fetch(`/api/infinite-campaign/history/${id}`, { method: 'DELETE' })
    setHistory(prev => prev.filter(c => c.id !== id))
  }

  function exportResultsCSV(results: InfiniteCampaignResult[], fileName: string) {
    const csv = ['Número,Nome,Status,Instância,Erro',
      ...results.map(r => `"${r.number}","${r.name || ''}","${r.status}","${r.via || ''}","${r.error || ''}"`)
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = fileName; a.click()
  }

  const items: InfiniteCampaignItem[] = [
    ...(current ? [current] : []),
    ...history
      .filter(rec => !current || Math.abs(rec.startedAt - current.createdAt) > 5000)
      .map(historyToItem),
  ].sort((a, b) => b.createdAt - a.createdAt)

  return {
    items,
    startCampaign, togglePause, stop,
    deleteHistory, exportResultsCSV,
  }
}
