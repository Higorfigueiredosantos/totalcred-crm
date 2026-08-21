import { useEffect, useState } from 'react'
import { onWSMessage } from '../../api/websocket'
import { apiFetch } from '../../hooks/useChips'
import type { WuzapiCampaignFinalStats, WuzapiCampaignHistoryRecord, WuzapiCampaignResult } from '../../types'
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
    finalStats: null,
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
  const [finalStatsCache, setFinalStatsCache] = useState<Record<string, WuzapiCampaignFinalStats>>({})
  const [recalculatingId, setRecalculatingId] = useState<string | null>(null)

  const loadHistory = () =>
    fetch('/api/wuzapi-campaign/history').then(r => r.json()).then(setHistory).catch(() => {})

  useEffect(() => { loadHistory() }, [])

  // Reidrata uma campanha que já estava rodando no backend antes desse
  // componente montar (ex.: usuário deu F5 no meio de um disparo). Sem
  // isso, o "current" local ficava null pra sempre (só existe na memória do
  // React), mas o backend continuava recusando iniciar uma campanha nova —
  // o usuário via só o erro "já em andamento", sem nada na tela pra
  // pausar/parar a que já estava rodando de verdade.
  useEffect(() => {
    fetch('/api/wuzapi-campaign/current').then(r => r.json()).then(snap => {
      if (!snap) return
      const results: WuzapiCampaignResult[] = snap.results || []
      const success = results.filter(r => r.status === 'success').length
      const failed = results.filter(r => r.status === 'failed').length
      setCurrent({
        id: `live-${snap.startedAt}`,
        name: snap.name || 'Campanha Wuzapi',
        status: 'running',
        instanceNames: snap.instanceNames || [],
        createdAt: snap.startedAt,
        stats: { current: results.length, total: snap.total, success, failed },
        log: ['🔄 Campanha em andamento recuperada após recarregar a página.'],
        results,
        finalStats: null,
        waiting: 0,
        paused: !!snap.paused,
        fromHistory: false,
        payload: snap.payload,
      })
    }).catch(() => {})
  }, [])

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
      batchDelay: config.batchDelay,
      spinWithAI: config.spinWithAI,
      firstNameOnly: config.firstNameOnly,
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
      finalStats: null,
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

  // "Parar" normal espera o loop no backend notar a flag "stopped" — se a
  // campanha travou de verdade (preso num await que nunca resolve), isso
  // nunca acontece e "já em andamento" trava pra sempre, sem opção de
  // excluir. Isso libera o estado direto, sem esperar o loop.
  async function forceReset() {
    await apiFetch('/api/wuzapi-campaign/force-reset', { method: 'POST' })
    setCurrent(prev => prev ? { ...prev, status: 'done', paused: false, endedAt: Date.now() } : prev)
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

  // Cruza quem recebeu a campanha com quem respondeu ou apertou botão depois
  // do envio — mesma lógica de recalcEngagement da via Chips.
  async function computeFinalStats(item: WuzapiCampaignItem): Promise<WuzapiCampaignFinalStats> {
    const sentContacts = item.results.filter(r => r.status === 'success').map(r => ({ number: r.number, sentAt: r.sentAt ?? item.createdAt }))
    const ir = await fetch('/api/wuzapi-campaign/interaction-rate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentContacts }),
    }).then(r => r.json()).catch(() => ({ interacted: 0, rate: '0%', notInteracted: 0 }))
    return {
      interacted: ir.interacted ?? 0,
      interactionRate: ir.rate ?? '0%',
      notInteracted: ir.notInteracted ?? 0,
    }
  }

  async function recalcEngagement(item: WuzapiCampaignItem) {
    setRecalculatingId(item.id)
    try {
      const stats = await computeFinalStats(item)
      setFinalStatsCache(prev => ({ ...prev, [item.id]: stats }))
      if (current?.id === item.id) setCurrent(prev => prev ? { ...prev, finalStats: stats } : prev)
    } finally {
      setRecalculatingId(null)
    }
  }

  const items: WuzapiCampaignItem[] = [
    ...(current ? [{ ...current, finalStats: finalStatsCache[current.id] ?? current.finalStats }] : []),
    ...history
      .filter(rec => !current || Math.abs(rec.startedAt - current.createdAt) > 5000)
      .map(rec => {
        const item = historyToItem(rec)
        return { ...item, finalStats: finalStatsCache[item.id] ?? null }
      }),
  ].sort((a, b) => b.createdAt - a.createdAt)

  return {
    items,
    startCampaign, togglePause, stop, forceReset, resetSent,
    deleteHistory, exportResultsCSV,
    recalcEngagement, computeFinalStats, recalculatingId,
  }
}
