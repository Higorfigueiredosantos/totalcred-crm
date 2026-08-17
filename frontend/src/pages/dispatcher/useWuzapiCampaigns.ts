import { useEffect, useState } from 'react'
import { onWSMessage } from '../../api/websocket'
import { apiFetch } from '../../hooks/useChips'
import type { WuzapiCampaignHistoryRecord, WuzapiCampaignResult } from '../../types'
import {
  type WuzapiCampaignConfig, type WuzapiCampaignItem,
  saveCampaignName, lookupCampaignName,
} from './wuzapiCampaign'

function historyToItem(rec: WuzapiCampaignHistoryRecord): WuzapiCampaignItem {
  return {
    id: rec.id,
    name: lookupCampaignName(rec.startedAt) ?? rec.name ?? 'Campanha Wuzapi',
    status: 'done',
    instanceNames: [],
    createdAt: rec.startedAt,
    endedAt: rec.endedAt,
    stats: { current: rec.total, total: rec.total, success: rec.success, failed: rec.failed },
    log: [],
    results: rec.results ?? [],
    waiting: 0,
    paused: false,
    fromHistory: true,
    payload: rec.payload,
  }
}

// Estado + ações da campanha via Wuzapi (BETA), no mesmo shape de "lista de
// itens" usado pelas outras campanhas. Só existe uma campanha Wuzapi ativa
// por vez.
export function useWuzapiCampaigns() {
  const [current, setCurrent] = useState<WuzapiCampaignItem | null>(null)
  const [history, setHistory] = useState<WuzapiCampaignHistoryRecord[]>([])

  const loadHistory = () =>
    fetch('/api/wuzapi-campaign/history').then(r => r.json()).then(setHistory).catch(() => {})

  useEffect(() => { loadHistory() }, [])

  useEffect(() => {
    const off = onWSMessage('wuzapi_campaign', (p: any) => handleCampaignEvent(p))
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
    if (p.type === 'batch_pause') { startWait(p.seconds); addLog(`⏸️ Pausa de segurança (${p.seconds}s) após ${p.batchCount} envios seguidos`) }
    if (p.type === 'circuit_break') {
      setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev)
      addLog(p.reason)
    }
    if (p.type === 'paused') { setCurrent(prev => prev ? { ...prev, paused: p.paused } : prev); addLog(p.paused ? '⏸️ Pausado' : '▶️ Retomado') }
    if (p.type === 'stopped') { setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev); addLog('🛑 Interrompido.') }
    if (p.type === 'done') {
      addLog(`🏁 Concluído! Sucesso: ${p.success}  Falha: ${p.failed}`)
      setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev)
      setTimeout(loadHistory, 1500)
    }
  }

  async function startCampaign(config: WuzapiCampaignConfig) {
    const body = {
      name: config.name,
      payload: config.payload,
      instanceNames: config.instanceNames,
      contacts: config.contacts,
      delayMin: config.delayMin,
      delayMax: config.delayMax,
    }
    const r = await fetch('/api/wuzapi-campaign/start', {
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
      createdAt: startedAt,
      stats: { current: 0, total: d.count, success: 0, failed: 0 },
      log: [`🚀 Campanha iniciada — ${d.count} contatos`],
      results: [],
      waiting: 0,
      paused: false,
      fromHistory: false,
      payload: config.payload,
    })
    return { ok: true as const }
  }

  async function togglePause() {
    await apiFetch('/api/wuzapi-campaign/pause', { method: 'POST' })
  }

  async function stop() {
    await apiFetch('/api/wuzapi-campaign/stop', { method: 'POST' })
  }

  async function resetSent() {
    return apiFetch('/api/wuzapi-campaign/reset-sent', { method: 'POST' }) as Promise<{ ok: boolean; cleared: number }>
  }

  async function deleteHistory(id: string) {
    if (!confirm('Remover este registro do histórico?')) return
    await fetch(`/api/wuzapi-campaign/history/${id}`, { method: 'DELETE' })
    setHistory(prev => prev.filter(c => c.id !== id))
  }

  function exportResultsCSV(results: WuzapiCampaignResult[], fileName: string) {
    const csv = ['Número,Nome,Status,Instância,Erro',
      ...results.map(r => `"${r.number}","${r.name || ''}","${r.status}","${r.via || ''}","${r.error || ''}"`)
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = fileName; a.click()
  }

  const items: WuzapiCampaignItem[] = [
    ...(current ? [current] : []),
    ...history
      .filter(rec => !current || Math.abs(rec.startedAt - current.createdAt) > 5000)
      .map(historyToItem),
  ].sort((a, b) => b.createdAt - a.createdAt)

  return {
    items,
    startCampaign, togglePause, stop, resetSent,
    deleteHistory, exportResultsCSV,
  }
}
