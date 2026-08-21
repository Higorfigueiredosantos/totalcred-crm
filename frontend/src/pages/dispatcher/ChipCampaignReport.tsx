import { useEffect } from 'react'
import {
  X, RefreshCw, BarChart2, CheckCircle, XCircle, Clock,
  Pause, Play, Square, Trash2, Download,
} from 'lucide-react'
import type { ChipCampaignItem } from './chipCampaign'

interface Props {
  item: ChipCampaignItem
  recalculating: boolean
  onClose: () => void
  onRecalc: (item: ChipCampaignItem) => void
  onExportCSV: (item: ChipCampaignItem) => void
  onDeleteHistory?: (id: string) => void
  onTogglePause?: () => void
  onStop?: () => void
}

export default function ChipCampaignReport({
  item, recalculating, onClose, onRecalc, onExportCSV, onDeleteHistory, onTogglePause, onStop,
}: Props) {
  // Calcula o funil assim que o relatório abre, se ainda não tiver métricas
  useEffect(() => {
    if (!item.finalStats && item.results.length > 0) onRecalc(item)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const total = item.stats.total || item.results.length || 1
  const success = item.results.filter(r => r.status === 'success').length
  const failed = item.results.filter(r => r.status === 'failed').length
  const delivered = item.results.filter(r => (r.ack ?? 0) >= 2).length
  const read = item.results.filter(r => (r.ack ?? 0) >= 3).length
  const responded = item.finalStats?.interacted ?? 0

  const funnel = [
    { label: 'Total',        value: total,     pct: 100,                                    color: 'bg-purple-500',  icon: '👥' },
    { label: 'Processados',  value: item.stats.current || total, pct: Math.round(((item.stats.current || total) / total) * 100), color: 'bg-purple-400', icon: '📤' },
    { label: 'Enviados',     value: success,   pct: Math.round((success / total) * 100),     color: 'bg-blue-500',    icon: '✈️' },
    { label: 'Entregues',    value: delivered, pct: Math.round((delivered / total) * 100),   color: 'bg-green-500',   icon: '✅' },
    { label: 'Lidos',        value: read,      pct: Math.round((read / total) * 100),        color: 'bg-teal-400',    icon: '👁' },
    { label: 'Respondidos',  value: responded, pct: Math.round((responded / total) * 100),   color: 'bg-orange-400',  icon: '💬' },
    { label: 'Falhas',       value: failed,    pct: Math.round((failed / total) * 100),      color: 'bg-red-500',     icon: '❌' },
  ]

  const deliveryRate = success > 0 ? Math.round((delivered / success) * 100) : 0
  const interactionRatePct = item.finalStats ? parseFloat(item.finalStats.interactionRate) || 0 : 0

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-800">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-semibold text-white">{item.name}</p>
              <span className="text-xs px-2 py-0.5 bg-green-900/40 text-green-300 rounded-full">Relatório · Via Chips</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">Métricas de conversão e lista de destinatários</p>
          </div>
          <div className="flex items-center gap-2">
            {item.status === 'running' && onTogglePause && (
              <button onClick={onTogglePause}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs text-white rounded-lg ${item.paused ? 'bg-green-700 hover:bg-green-600' : 'bg-yellow-700 hover:bg-yellow-600'}`}>
                {item.paused ? <><Play size={12} /> Retomar</> : <><Pause size={12} /> Pausar</>}
              </button>
            )}
            {item.status === 'running' && onStop && (
              <button onClick={onStop} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-800 hover:bg-red-700 text-xs text-white rounded-lg">
                <Square size={12} /> Parar
              </button>
            )}
            <button onClick={() => onRecalc(item)} disabled={recalculating}
              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-xs text-white rounded-lg disabled:opacity-50">
              <RefreshCw size={12} className={recalculating ? 'animate-spin' : ''} />
              Atualizar Métricas
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white p-1"><X size={18} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-0">
            {/* Funnel */}
            <div className="lg:col-span-2 p-5 border-b lg:border-b-0 lg:border-r border-gray-800">
              <div className="flex items-center gap-2 mb-4">
                <BarChart2 size={14} className="text-indigo-400" />
                <p className="text-sm font-medium text-white">Funil de conversão</p>
                <p className="text-xs text-gray-500">Confira a efetividade desta campanha</p>
              </div>

              <div className="space-y-2">
                {funnel.map(row => (
                  <div key={row.label} className="flex items-center gap-3">
                    <span className="text-xs text-gray-400 w-24 shrink-0">{row.label}</span>
                    <div className="flex-1 relative h-7 bg-gray-800 rounded overflow-hidden">
                      <div className={`h-full ${row.color} opacity-90 rounded transition-all duration-500 flex items-center`}
                        style={{ width: `${Math.max(row.pct, row.value > 0 ? 3 : 0)}%` }}>
                        {row.pct >= 8 && <span className="px-2 text-xs font-semibold text-white">{row.pct}%</span>}
                      </div>
                      {row.pct < 8 && row.value > 0 && (
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-400">{row.pct}%</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 w-12 shrink-0 justify-end">
                      <span className="text-xs font-bold text-white">{row.value}</span>
                      <span className="text-xs">{row.icon}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Results table */}
              {item.results.length > 0 && (
                <div className="mt-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-500 font-medium">Destinatários ({item.results.length})</p>
                    <button onClick={() => onExportCSV(item)}
                      className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 px-2 py-1 rounded border border-green-700 hover:border-green-500">
                      <Download size={11} /> Exportar CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-gray-700 max-h-56 overflow-y-auto">
                    <table className="w-full text-xs text-gray-300">
                      <thead className="bg-gray-800 sticky top-0">
                        <tr className="text-gray-500">
                          <th className="text-left px-3 py-2">Número</th>
                          <th className="text-left px-3 py-2">Nome</th>
                          <th className="text-left px-3 py-2">Chip</th>
                          <th className="text-left px-3 py-2">Status</th>
                          <th className="text-left px-3 py-2">Ack</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.results.map((r, i) => (
                          <tr key={i} className="border-t border-gray-800/60">
                            <td className="px-3 py-1.5 font-mono">{r.number}</td>
                            <td className="px-3 py-1.5 max-w-[100px] truncate">{r.name || '—'}</td>
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
                                  : r.ack >= 1 ? <span className="text-gray-500">Enviado</span> : '—'
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

            {/* Side stats */}
            <div className="p-5 space-y-5">
              <div className="space-y-3">
                <div className="text-center">
                  <p className={`text-4xl font-bold ${interactionRatePct >= 10 ? 'text-green-400' : 'text-amber-400'}`}>
                    {item.finalStats?.interactionRate ?? '—'}
                  </p>
                  <p className="text-sm text-gray-300 mt-1">Taxa de Interação</p>
                  <p className="text-xs text-gray-500">{responded} de {success} responderam</p>
                </div>
              </div>

              <div className="h-px bg-gray-800" />

              <div className="text-center">
                <p className={`text-4xl font-bold ${deliveryRate >= 50 ? 'text-green-400' : deliveryRate >= 20 ? 'text-amber-400' : 'text-red-400'}`}>
                  {deliveryRate}%
                </p>
                <p className="text-sm text-gray-300 mt-1">Taxa de Entrega (ACK)</p>
                <p className="text-xs text-gray-500">{delivered} de {success} entregues</p>
              </div>

              <div className="h-px bg-gray-800" />

              <div className="text-xs text-gray-600 space-y-1">
                <p>Risco de ban: <span className="text-gray-400">{item.riskLevel}</span></p>
                <p>Início: <span className="text-gray-400">{new Date(item.createdAt).toLocaleString('pt-BR')}</span></p>
                {item.endedAt && <p>Fim: <span className="text-gray-400">{new Date(item.endedAt).toLocaleString('pt-BR')}</span></p>}
              </div>

              {item.fromHistory && onDeleteHistory && (
                <button onClick={() => { onDeleteHistory(item.id); onClose() }}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded-lg bg-red-900/30 hover:bg-red-900/50 border border-red-800/40 text-red-300 transition-colors">
                  <Trash2 size={11} /> Remover do histórico
                </button>
              )}
            </div>
          </div>

          {/* Log */}
          {item.log.length > 0 && (
            <div className="border-t border-gray-800 p-5">
              <p className="text-xs text-gray-500 font-medium mb-2">Log de envio ({item.log.length} eventos)</p>
              <div className="bg-gray-950 rounded-lg p-3 max-h-40 overflow-y-auto">
                {item.log.map((line, i) => (
                  <p key={i} className="text-xs font-mono mb-0.5 text-gray-500">{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
