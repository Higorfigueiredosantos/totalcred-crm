import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import type { Blast, BlastMode, BlastRecipient, ColumnMapping, ColumnMappingMode, Template } from '../types'
import { v4 as uuid } from '../utils/uuid'
import {
  Send, Play, RefreshCw, Upload, Image, Flame, Zap,
  X, ChevronDown, ChevronUp, Info, AlertTriangle, FileText, Users, Check,
  BarChart2, Hash, List, Video, File as FileIcon,
} from 'lucide-react'
import { getTemplates, sendTextMessage, sendTemplateMessage, uploadMedia, getTemplateAnalytics } from '../api/whatsapp'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length === 0) return { headers: [], rows: [] }

  function parseLine(line: string): string[] {
    const result: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if ((c === ',' || c === ';') && !inQ) {
        result.push(cur.trim()); cur = ''
      } else cur += c
    }
    result.push(cur.trim())
    return result
  }

  const headers = parseLine(lines[0])
  const rows = lines.slice(1)
    .filter(l => l.trim())
    .map(l => {
      const vals = parseLine(l)
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']))
    })
  return { headers, rows }
}

function extractTemplateVars(template: Template): string[] {
  const body = template.components.find(c => c.type?.toLowerCase() === 'body')?.text ?? ''
  const matches = [...body.matchAll(/\{\{(\d+)\}\}/g)]
  return [...new Set(matches.map(m => m[1]))].sort((a, b) => +a - +b)
}

type MediaHeaderFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT'

function getTemplateHeaderFormat(t: Template): MediaHeaderFormat | null {
  const header = t.components.find(c => c.type?.toUpperCase() === 'HEADER')
  const fmt = header?.format?.toUpperCase()
  return (fmt === 'IMAGE' || fmt === 'VIDEO' || fmt === 'DOCUMENT') ? fmt as MediaHeaderFormat : null
}

// Meta limits: IMAGE 5 MB, VIDEO 16 MB, DOCUMENT 100 MB
const MEDIA_MAX_BYTES: Record<MediaHeaderFormat, number> = {
  IMAGE:    5  * 1024 * 1024,
  VIDEO:    16 * 1024 * 1024,
  DOCUMENT: 100 * 1024 * 1024,
}

const MEDIA_ACCEPT: Record<MediaHeaderFormat, string> = {
  IMAGE:    'image/*',
  VIDEO:    'video/mp4,video/*',
  DOCUMENT: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/*',
}

const MEDIA_LABEL: Record<MediaHeaderFormat, string> = {
  IMAGE:    'Imagem',
  VIDEO:    'Vídeo',
  DOCUMENT: 'Documento',
}


function getFirstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? ''
}

// Resolve {column_name} placeholders — name-like columns use first name only
function resolveMixedTemplate(tpl: string, row: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, col) => {
    const val = row[col] ?? ''
    return /^(nome|name|first|primeiro)/i.test(col) ? getFirstName(val) : val
  })
}

function computeParam(mapping: ColumnMapping, row: Record<string, string>): string {
  switch (mapping.mode) {
    case 'fixed':
      return mapping.fixedValue ?? ''

    case 'csv':
      return row[mapping.csvColumn] ?? ''

    case 'firstname': {
      const col = mapping.firstNameColumn || mapping.csvColumn
      const firstName = getFirstName(row[col] ?? '')
      const extra = mapping.firstNameExtra?.trim()
      return extra
        ? extra.replace(/\{nome\}/gi, firstName)
        : firstName
    }

    case 'mixed': {
      const tpl = mapping.mixedTemplate?.trim()
      if (tpl) return resolveMixedTemplate(tpl, row)
      // legacy fallback: prefix + column + suffix
      return `${mapping.mixedPrefix ?? ''}${row[mapping.csvColumn] ?? ''}${mapping.mixedSuffix ?? ''}`
    }
  }
}

function randomDelay(mode: BlastMode): number {
  return mode === 'warmup'
    ? (180 + Math.random() * 120) * 1000
    : (5 + Math.random() * 85) * 1000
}

function fmtDelay(ms: number) {
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)}s`
}

function renderTemplateText(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => params[n] || `{{${n}}}`)
}

// ═══════════════════════════════════════════════════════════════════
// DUPLICATE REVIEW MODAL
// ═══════════════════════════════════════════════════════════════════

interface DupGroup { phone: string; indices: number[] }

function DuplicateModal({
  groups, rows, phoneCol, excluded, onConfirm, onCancel,
}: {
  groups: DupGroup[]
  rows: Record<string, string>[]
  phoneCol: string
  excluded: Set<number>
  onConfirm: (excluded: Set<number>) => void
  onCancel: () => void
}) {
  const [localExcl, setLocalExcl] = useState<Set<number>>(new Set(excluded))

  function toggleRow(idx: number) {
    setLocalExcl(prev => {
      const n = new Set(prev)
      n.has(idx) ? n.delete(idx) : n.add(idx)
      return n
    })
  }

  function keepFirst() {
    const excl = new Set<number>()
    groups.forEach(g => g.indices.slice(1).forEach(i => excl.add(i)))
    setLocalExcl(excl)
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-amber-600/40 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center gap-3 p-5 border-b border-gray-800">
          <AlertTriangle size={20} className="text-amber-400 shrink-0" />
          <div>
            <h2 className="font-semibold text-white">Revisão de Duplicatas</h2>
            <p className="text-xs text-amber-400 mt-0.5">
              {groups.length} número{groups.length > 1 ? 's' : ''} com ocorrências múltiplas —
              marque as linhas que devem ser <strong>REMOVIDAS</strong> do disparo
            </p>
          </div>
        </div>

        <div className="bg-amber-900/20 border-b border-amber-800/30 px-5 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-amber-300">
              ⚠️ Linhas marcadas abaixo serão excluídas. <strong>Verifique cuidadosamente antes de confirmar.</strong>
            </p>
            <button onClick={keepFirst}
              className="text-xs text-indigo-400 hover:text-indigo-300 px-3 py-1 bg-indigo-900/30 rounded-lg">
              Manter só a 1ª ocorrência de cada
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {groups.map(g => (
            <div key={g.phone} className="bg-gray-800 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 bg-gray-700/60 border-b border-gray-700">
                <span className="text-xs font-mono text-amber-400">{g.phone}</span>
                <span className="text-xs text-gray-500">— {g.indices.length} ocorrências</span>
              </div>
              <div className="divide-y divide-gray-700/50">
                {g.indices.map((rowIdx, occurrence) => {
                  const row = rows[rowIdx]
                  const isMarked = localExcl.has(rowIdx)
                  const headers = Object.keys(row)
                  return (
                    <label key={rowIdx}
                      className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${isMarked ? 'bg-red-900/20' : occurrence === 0 ? 'bg-green-900/10' : ''}`}>
                      <input type="checkbox" checked={isMarked} onChange={() => toggleRow(rowIdx)}
                        className="mt-0.5 w-4 h-4 accent-red-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${isMarked ? 'bg-red-800 text-red-200' : occurrence === 0 ? 'bg-green-800 text-green-200' : 'bg-gray-700 text-gray-300'}`}>
                            {isMarked ? '✗ Excluir' : occurrence === 0 ? '1ª ocorrência' : `${occurrence + 1}ª ocorrência`}
                          </span>
                          <span className="text-xs text-gray-500">Linha {rowIdx + 2}</span>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs">
                          {headers.slice(0, 6).map(h => (
                            <span key={h} className="text-gray-500">
                              <span className="text-gray-600">{h}:</span>{' '}
                              <span className={h === phoneCol ? 'text-amber-400' : 'text-gray-300'}>{row[h] || '—'}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-gray-800 p-5">
          <div className="flex items-center gap-3 mb-4 bg-gray-800 rounded-lg p-3">
            <Info size={14} className="text-gray-500 shrink-0" />
            <p className="text-xs text-gray-400">
              <strong className="text-white">{localExcl.size}</strong> linhas serão removidas.{' '}
              <strong className="text-white">{rows.length - localExcl.size}</strong> destinatários seguirão no disparo.
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 rounded-lg">
              Cancelar
            </button>
            <button onClick={() => onConfirm(localExcl)}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-sm text-white rounded-lg">
              <Check size={14} /> Confirmar e continuar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// COLUMN MAPPING EDITOR
// ═══════════════════════════════════════════════════════════════════

const MODE_LABELS: Record<ColumnMappingMode, string> = {
  csv:       'Coluna CSV',
  fixed:     'Texto fixo',
  mixed:     'Mista',
  firstname: 'Primeiro Nome',
}

function MappingRow({
  mapping, csvHeaders, varIdx, onChange,
}: {
  mapping: ColumnMapping
  csvHeaders: string[]
  varIdx: number
  onChange: (m: ColumnMapping) => void
}) {
  const set = <K extends keyof ColumnMapping>(k: K, v: ColumnMapping[K]) => onChange({ ...mapping, [k]: v })

  // Detect {placeholder}s used in the mixedTemplate to help the user know which columns to reference
  const usedPlaceholders = mapping.mixedTemplate
    ? [...mapping.mixedTemplate.matchAll(/\{(\w+)\}/g)].map(m => m[1])
    : []
  const unknownPlaceholders = usedPlaceholders.filter(p => !csvHeaders.includes(p))

  // Preview what the first_name + extra would produce for a sample name
  const sampleFirstName = 'João'
  const firstNamePreview = mapping.firstNameExtra?.trim()
    ? mapping.firstNameExtra.replace(/\{nome\}/gi, sampleFirstName)
    : sampleFirstName

  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm bg-indigo-900/40 text-indigo-300 px-2.5 py-1 rounded-lg">
          {`{{${mapping.variable}}}`}
        </span>
        <span className="text-[11px] text-gray-500">Variável {varIdx + 1}</span>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 mb-3 bg-gray-900 rounded-lg p-1">
        {(Object.keys(MODE_LABELS) as ColumnMappingMode[]).map(m => (
          <button key={m} onClick={() => set('mode', m)}
            className={`flex-1 py-1 text-xs rounded-md font-medium transition-colors ${
              mapping.mode === m ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
            }`}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {/* ── Coluna CSV ── */}
      {mapping.mode === 'csv' && (
        <div>
          <select value={mapping.csvColumn} onChange={e => set('csvColumn', e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
            <option value="">— Selecionar coluna do CSV —</option>
            {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
          {mapping.csvColumn && (
            <p className="text-[11px] text-gray-500 mt-1">
              Usa o valor bruto da coluna <span className="text-indigo-400 font-mono">"{mapping.csvColumn}"</span> para cada linha.
            </p>
          )}
        </div>
      )}

      {/* ── Texto fixo ── */}
      {mapping.mode === 'fixed' && (
        <div>
          <input value={mapping.fixedValue} onChange={e => set('fixedValue', e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Digite o texto fixo para esta variável" />
          <p className="text-[11px] text-gray-500 mt-1">Mesmo texto para todos os destinatários. Ignora o CSV.</p>
        </div>
      )}

      {/* ── Mista ── */}
      {mapping.mode === 'mixed' && (
        <div className="space-y-2">
          <div>
            <textarea
              value={mapping.mixedTemplate}
              onChange={e => set('mixedTemplate', e.target.value)}
              rows={2}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none font-mono"
              placeholder={`Olá {nome}, seu CPF {cpf} foi aprovado!`}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] text-gray-500">Colunas disponíveis:</span>
            {csvHeaders.map(h => (
              <button key={h} type="button"
                onClick={() => set('mixedTemplate', (mapping.mixedTemplate ?? '') + `{${h}}`)}
                className="text-[10px] px-1.5 py-0.5 bg-indigo-900/30 text-indigo-400 rounded hover:bg-indigo-800/40 font-mono">
                {`{${h}}`}
              </button>
            ))}
          </div>
          {unknownPlaceholders.length > 0 && (
            <p className="text-[11px] text-amber-400">
              ⚠ Coluna(s) não encontrada(s) no CSV: {unknownPlaceholders.map(p => `{${p}}`).join(', ')}
            </p>
          )}
          <p className="text-[11px] text-gray-600">
            Use <span className="font-mono text-gray-500">{`{nome_coluna}`}</span> para inserir valores do CSV.
            Colunas com nome "nome" ou "name" usam apenas o <strong className="text-gray-400">primeiro nome</strong>.
          </p>
        </div>
      )}

      {/* ── Primeiro Nome ── */}
      {mapping.mode === 'firstname' && (
        <div className="space-y-2">
          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Coluna do nome completo</label>
            <select
              value={mapping.firstNameColumn || mapping.csvColumn}
              onChange={e => set('firstNameColumn', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
              <option value="">— Selecionar coluna —</option>
              {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 mb-1">
              Envolver com texto <span className="text-gray-600">(opcional)</span> — use <span className="font-mono text-indigo-400">{`{nome}`}</span> como marcador
            </label>
            <input
              value={mapping.firstNameExtra}
              onChange={e => set('firstNameExtra', e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder={`Bom dia, {nome}!`}
            />
          </div>
          <p className="text-[11px] text-gray-500">
            Preview: <span className="text-green-400">"{firstNamePreview}"</span>
          </p>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE PREVIEW BUBBLE
// ═══════════════════════════════════════════════════════════════════

function MessagePreview({
  template, mappings, row, mediaPreview, mediaFileName,
}: {
  template: Template
  mappings: ColumnMapping[]
  row: Record<string, string>
  mediaPreview: string
  mediaFileName?: string
}) {
  const params: Record<string, string> = {}
  mappings.forEach(m => { params[m.variable] = computeParam(m, row) })

  const body = template.components.find(c => c.type?.toLowerCase() === 'body')?.text ?? ''
  const header = template.components.find(c => c.type?.toLowerCase() === 'header')
  const footer = template.components.find(c => c.type?.toLowerCase() === 'footer')
  const buttons = template.components.find(c => c.type?.toLowerCase() === 'buttons')?.buttons ?? []
  const headerFmt = header?.format?.toUpperCase()

  const renderedBody = renderTemplateText(body, params)

  return (
    <div className="bg-[#0b141a] rounded-xl p-4">
      <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-3 text-center">Prévia da mensagem</p>
      <div className="max-w-xs mx-auto">
        <div className="bg-[#202c33] rounded-xl overflow-hidden shadow-lg">
          {/* Image header */}
          {headerFmt === 'IMAGE' && (
            <div className="bg-gray-700 h-32 flex items-center justify-center overflow-hidden">
              {mediaPreview
                ? <img src={mediaPreview} alt="header" className="w-full h-full object-cover" />
                : <div className="flex flex-col items-center gap-1 text-gray-600">
                    <Image size={24} />
                    <span className="text-xs">Imagem não selecionada</span>
                  </div>
              }
            </div>
          )}
          {/* Video header */}
          {headerFmt === 'VIDEO' && (
            <div className="bg-gray-700 h-32 flex items-center justify-center overflow-hidden">
              {mediaPreview
                ? <video src={mediaPreview} className="w-full h-full object-cover" muted />
                : <div className="flex flex-col items-center gap-1 text-gray-600">
                    <Video size={24} />
                    <span className="text-xs">Vídeo não selecionado</span>
                  </div>
              }
            </div>
          )}
          {/* Document header */}
          {headerFmt === 'DOCUMENT' && (
            <div className="bg-gray-700/60 px-3 py-3 flex items-center gap-3 border-b border-gray-600">
              <div className="w-8 h-8 bg-indigo-600/40 rounded flex items-center justify-center shrink-0">
                <FileIcon size={16} className="text-indigo-300" />
              </div>
              <span className="text-xs text-gray-300 truncate">{mediaFileName || 'Documento não selecionado'}</span>
            </div>
          )}
          {/* Text header */}
          {headerFmt === 'TEXT' && header?.text && (
            <div className="px-3 pt-3 pb-1">
              <p className="text-sm font-bold text-white">{renderTemplateText(header.text, params)}</p>
            </div>
          )}
          {/* Body */}
          <div className="px-3 py-3">
            <p className="text-sm text-gray-100 whitespace-pre-wrap leading-relaxed">{renderedBody}</p>
          </div>
          {/* Footer */}
          {footer?.text && (
            <div className="px-3 pb-2">
              <p className="text-xs text-gray-500">{footer.text}</p>
            </div>
          )}
          {/* Buttons */}
          {buttons.length > 0 && (
            <div className="border-t border-gray-700">
              {buttons.map((btn: any, i: number) => (
                <div key={i} className={`px-3 py-2 text-center text-xs text-[#00a884] font-medium ${i > 0 ? 'border-t border-gray-700' : ''}`}>
                  {btn.text}
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="text-[10px] text-gray-600 text-right mt-1">
          {row[Object.keys(row)[0]] ? `Ex. linha 1 do CSV` : 'nenhuma linha'}
        </p>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// BLAST REPORT MODAL
// ═══════════════════════════════════════════════════════════════════

function BlastReport({
  blast, channels, templates, onClose, onUpdate,
}: {
  blast: Blast
  channels: ReturnType<typeof useStore.getState>['channels']
  templates: Template[]
  onClose: () => void
  onUpdate: (stats: Blast['stats']) => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const s = blast.stats
  const total = s.total || 1

  const funnel = [
    { label: 'Total',      value: s.total,     pct: 100,                             color: 'bg-purple-500',  icon: '👥' },
    { label: 'Processadas',value: s.processed ?? s.total, pct: Math.round((s.processed ?? s.total) / total * 100), color: 'bg-purple-400', icon: '📤' },
    { label: 'Enviadas',   value: s.sent,       pct: Math.round(s.sent / total * 100),  color: 'bg-blue-500',    icon: '✈️' },
    { label: 'Aguardando', value: s.waiting ?? 0, pct: Math.round((s.waiting ?? 0) / total * 100), color: 'bg-yellow-500', icon: '⏳' },
    { label: 'Entregues',  value: s.delivered,  pct: Math.round(s.delivered / total * 100), color: 'bg-green-500',   icon: '✅' },
    { label: 'Lidas',      value: s.read,       pct: Math.round(s.read / total * 100),  color: 'bg-teal-400',    icon: '👁' },
    { label: 'Engajadas',  value: s.engaged ?? 0, pct: Math.round((s.engaged ?? 0) / total * 100), color: 'bg-orange-400', icon: '💬' },
    { label: 'Falhas',     value: s.failed,     pct: Math.round(s.failed / total * 100), color: 'bg-red-500',     icon: '❌' },
  ]

  const failureBreakdown = s.failureBreakdown ? Object.entries(s.failureBreakdown) : []
  const buttonClicks = s.buttonClicks ? Object.entries(s.buttonClicks) : []
  const engagementRate = s.sent > 0 ? Math.round(((s.engaged ?? 0) / s.sent) * 100) : 0
  const deliveryRate = s.sent > 0 ? Math.round((s.delivered / s.sent) * 100) : 0

  const blastChannel = channels.find(c => blast.channelIds?.includes(c.id))
  const blastTemplate = templates.find(t => t.id === blast.templateId)
  const isMetaCampaign = !!blastChannel?.accessToken && !!blastTemplate

  async function fetchMetrics() {
    if (!isMetaCampaign || !blastChannel || !blastTemplate) return
    setRefreshing(true)
    setError('')
    try {
      const sentAt = blast.sentAt ? new Date(blast.sentAt) : new Date(Date.now() - 7 * 86400000)
      const analytics = await getTemplateAnalytics(
        blastChannel.wabaId,
        blastChannel.accessToken,
        blastTemplate.id,
        sentAt,
        new Date()
      )
      onUpdate({
        ...blast.stats,
        delivered: analytics.delivered,
        read: analytics.read,
        engaged: analytics.clicked,
        buttonClicks: analytics.buttonClicks,
      })
    } catch (e: any) {
      setError(e.response?.data?.error?.message ?? e.message ?? 'Erro ao buscar métricas')
    } finally {
      setRefreshing(false)
    }
  }

  // Parse failure breakdown from log if not already stored
  const logFailures: Record<string, number> = {}
  if (!failureBreakdown.length && blast.log) {
    for (const line of blast.log) {
      if (!line.startsWith('✗')) continue
      const reason = line.match(/:\s*(.+)$/)?.[1]?.trim() ?? 'Erro desconhecido'
      const short = reason.length > 40 ? reason.slice(0, 40) + '…' : reason
      logFailures[short] = (logFailures[short] ?? 0) + 1
    }
  }
  const effectiveFailures = failureBreakdown.length
    ? failureBreakdown
    : Object.entries(logFailures)

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-800">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-semibold text-white">{blast.name}</p>
              <span className="text-xs px-2 py-0.5 bg-indigo-900/40 text-indigo-300 rounded-full">Relatório Detalhado</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">Métricas de conversão e lista de destinatários</p>
          </div>
          <div className="flex items-center gap-2">
            {isMetaCampaign && (
              <button onClick={fetchMetrics} disabled={refreshing}
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-xs text-white rounded-lg disabled:opacity-50">
                <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
                Atualizar Métricas
              </button>
            )}
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
                      <div
                        className={`h-full ${row.color} opacity-90 rounded transition-all duration-500 flex items-center`}
                        style={{ width: `${Math.max(row.pct, row.value > 0 ? 3 : 0)}%` }}
                      >
                        {row.pct >= 8 && (
                          <span className="px-2 text-xs font-semibold text-white">{row.pct}%</span>
                        )}
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

              {/* Failure breakdown */}
              {effectiveFailures.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-gray-500 font-medium mb-2">Detalhes das falhas:</p>
                  <div className="flex flex-wrap gap-2">
                    {effectiveFailures.map(([reason, count]) => (
                      <span key={reason} className="text-xs bg-red-900/30 border border-red-800/40 text-red-300 px-2 py-1 rounded-full">
                        {reason} <strong>{count}</strong>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
            </div>

            {/* Side stats */}
            <div className="p-5 space-y-5">
              {/* Engagement */}
              <div className="text-center">
                <p className={`text-4xl font-bold ${engagementRate >= 10 ? 'text-green-400' : 'text-amber-400'}`}>
                  {engagementRate}%
                </p>
                <p className="text-sm text-gray-300 mt-1">Taxa de Engajamento</p>
                <p className="text-xs text-gray-500">{s.engaged ?? 0} de {s.sent} engajaram</p>
              </div>

              <div className="h-px bg-gray-800" />

              {/* Delivery */}
              <div className="text-center">
                <p className={`text-4xl font-bold ${deliveryRate >= 50 ? 'text-green-400' : deliveryRate >= 20 ? 'text-amber-400' : 'text-red-400'}`}>
                  {deliveryRate}%
                </p>
                <p className="text-sm text-gray-300 mt-1">Taxa de Entrega</p>
                <p className="text-xs text-gray-500">{s.delivered} de {s.sent} entregues</p>
              </div>

              {/* Button clicks */}
              {buttonClicks.length > 0 && (
                <>
                  <div className="h-px bg-gray-800" />
                  <div>
                    <p className="text-xs text-gray-500 font-medium mb-2">Cliques por botão (Meta Analytics):</p>
                    <div className="space-y-2">
                      {buttonClicks.map(([label, count]) => (
                        <div key={label} className="flex items-center justify-between">
                          <span className="text-xs font-mono font-bold text-gray-200">{label}</span>
                          <div className="text-right">
                            <span className="text-xs text-green-400 font-semibold">{count} cliques</span>
                            <span className="text-[10px] text-gray-600 ml-1">({s.sent > 0 ? Math.round(count / s.sent * 100) : 0}% dos enviados)</span>
                          </div>
                        </div>
                      ))}
                      <div className="pt-1 border-t border-gray-800 flex justify-between">
                        <span className="text-xs text-gray-500">Total de cliques</span>
                        <span className="text-xs font-bold text-green-400">{s.engaged ?? 0}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Meta info */}
              {blast.sentAt && (
                <>
                  <div className="h-px bg-gray-800" />
                  <div className="text-xs text-gray-600 space-y-1">
                    <p>Disparado em: <span className="text-gray-400">{format(new Date(blast.sentAt), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span></p>
                    <p>Canal: <span className="text-gray-400">{channels.filter(c => blast.channelIds?.includes(c.id)).map(c => c.name).join(', ')}</span></p>
                    {blastTemplate && <p>Template: <span className="text-gray-400">{blastTemplate.name}</span></p>}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Log */}
          {(blast.log?.length ?? 0) > 0 && (
            <div className="border-t border-gray-800 p-5">
              <p className="text-xs text-gray-500 font-medium mb-2">Log de envio ({blast.log!.length} eventos)</p>
              <div className="bg-gray-950 rounded-lg p-3 max-h-40 overflow-y-auto">
                {blast.log!.map((line, i) => (
                  <p key={i} className={`text-xs font-mono mb-0.5 ${
                    line.startsWith('✓') ? 'text-green-400' : line.startsWith('✗') ? 'text-red-400' : line.startsWith('⏳') ? 'text-amber-400' : 'text-gray-500'
                  }`}>{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// BLAST MODAL
// ═══════════════════════════════════════════════════════════════════

type SourceMode = 'crm' | 'numbers' | 'csv'

interface FormState {
  name: string
  channelIds: string[]
  type: 'text' | 'template'
  message: string
  templateId: string
  mediaFile: File | null
  mediaPreview: string   // data URL for image/video preview
  mediaFileName: string  // original filename (for documents)
  mode: BlastMode
  scheduledAt: string
  // CRM
  selectedContacts: string[]
  // Numbers list
  numbersList: string
  // CSV
  sourceMode: SourceMode
  csvHeaders: string[]
  csvRows: Record<string, string>[]
  phoneColumn: string
  nameColumn: string
  excludedRows: Set<number>
  columnMappings: ColumnMapping[]
  dupGroups: Array<{ phone: string; indices: number[] }>
  showDupModal: boolean
}

function BlastModal({ onClose, onSave }: { onClose: () => void; onSave: (b: Blast) => void }) {
  const { channels, contacts, templates, setTemplates } = useStore()
  const [step, setStep] = useState(1)
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const csvInputRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState<FormState>({
    name: '',
    channelIds: channels.length > 0 ? [channels[0].id] : [],
    type: 'template',
    message: '',
    templateId: '',
    mediaFile: null,
    mediaPreview: '',
    mediaFileName: '',
    mode: 'standard',
    scheduledAt: '',
    selectedContacts: [],
    numbersList: '',
    sourceMode: 'crm',
    csvHeaders: [],
    csvRows: [],
    phoneColumn: '',
    nameColumn: '',
    excludedRows: new Set(),
    columnMappings: [],
    dupGroups: [],
    showDupModal: false,
  })

  const setF = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v })), [])

  const selectedChannels = channels.filter(c => form.channelIds.includes(c.id))
  const selectedTemplate = templates.find(t => t.id === form.templateId)
  const templateVars = selectedTemplate ? extractTemplateVars(selectedTemplate) : []

  function toggleChannel(id: string) {
    setF('channelIds', form.channelIds.includes(id)
      ? form.channelIds.filter(c => c !== id)
      : [...form.channelIds, id])
  }

  function toggleContact(id: string) {
    setF('selectedContacts', form.selectedContacts.includes(id)
      ? form.selectedContacts.filter(c => c !== id)
      : [...form.selectedContacts, id])
  }

  function handleMediaPick(e: React.ChangeEvent<HTMLInputElement>, fmt: MediaHeaderFormat) {
    const file = e.target.files?.[0]; if (!file) return
    e.target.value = ''  // reset so same file can be re-selected

    // MIME validation
    const mimeOk =
      fmt === 'IMAGE'    ? file.type.startsWith('image/')
      : fmt === 'VIDEO'  ? file.type.startsWith('video/')
      : true  // DOCUMENT: accept all

    if (!mimeOk) {
      alert(`Arquivo inválido para ${MEDIA_LABEL[fmt]}. Selecione um arquivo do tipo correto.`)
      return
    }

    // Size validation
    const maxBytes = MEDIA_MAX_BYTES[fmt]
    if (file.size > maxBytes) {
      alert(`Arquivo muito grande. Limite para ${MEDIA_LABEL[fmt]}: ${maxBytes / 1024 / 1024} MB. Seu arquivo: ${(file.size / 1024 / 1024).toFixed(1)} MB.`)
      return
    }

    setF('mediaFile', file)
    setF('mediaFileName', file.name)

    if (fmt === 'IMAGE' || fmt === 'VIDEO') {
      const reader = new FileReader()
      reader.onload = ev => setF('mediaPreview', ev.target?.result as string)
      reader.readAsDataURL(file)
    } else {
      setF('mediaPreview', '')  // documents don't need a preview URL
    }
  }

  async function loadTemplates() {
    if (form.channelIds.length === 0) return alert('Selecione ao menos um canal.')
    const ch = channels.find(c => c.id === form.channelIds[0])
    if (!ch) return
    setLoadingTemplates(true)
    try {
      const list = await getTemplates(ch.wabaId, ch.accessToken, ch.proxy)
      setTemplates(list)
    } catch (e: any) {
      alert(`Erro ao carregar templates: ${e.message}`)
    } finally {
      setLoadingTemplates(false)
    }
  }

  useEffect(() => {
    if (form.type === 'template' && form.channelIds.length > 0) loadTemplates()
  }, [form.type])

  useEffect(() => {
    if (!selectedTemplate) return
    const vars = extractTemplateVars(selectedTemplate)
    setF('columnMappings', vars.map(v => ({
      variable: v, mode: 'csv' as ColumnMappingMode,
      csvColumn: '', fixedValue: '',
      mixedTemplate: '', mixedPrefix: '', mixedSuffix: '',
      firstNameColumn: '', firstNameExtra: '',
    })))
  }, [form.templateId])

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const { headers, rows } = parseCSV(text)
      if (headers.length === 0) return alert('CSV inválido ou vazio.')
      const phoneGuess = headers.find(h => /telefon|phone|cel|whats|mobile|fone/i.test(h)) ?? ''
      const nameGuess = headers.find(h => /nome|name/i.test(h)) ?? ''
      setForm(f => ({
        ...f,
        csvHeaders: headers,
        csvRows: rows,
        phoneColumn: phoneGuess,
        nameColumn: nameGuess,
        excludedRows: new Set(),
        dupGroups: [],
      }))
    }
    reader.readAsText(file, 'UTF-8')
  }

  function detectDuplicates() {
    if (!form.phoneColumn) return alert('Selecione a coluna de telefone primeiro.')
    const groups = new Map<string, number[]>()
    form.csvRows.forEach((row, i) => {
      const phone = normalizePhone(row[form.phoneColumn] ?? '')
      if (!phone) return
      if (!groups.has(phone)) groups.set(phone, [])
      groups.get(phone)!.push(i)
    })
    const dups = [...groups.entries()]
      .filter(([, idxs]) => idxs.length > 1)
      .map(([phone, indices]) => ({ phone, indices }))
    if (dups.length === 0) { alert('✅ Nenhum número duplicado encontrado!'); return }
    setF('dupGroups', dups)
    setF('showDupModal', true)
  }

  function updateMapping(idx: number, m: ColumnMapping) {
    const next = [...form.columnMappings]
    next[idx] = m
    setF('columnMappings', next)
  }

  const deduplicatedContacts = (() => {
    const seen = new Set<string>()
    return contacts.filter(c => {
      const p = normalizePhone(c.phone)
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })
  })()

  const validCsvRows = form.csvRows.filter((_, i) => !form.excludedRows.has(i))

  const parsedNumbers = form.numbersList
    .split(/[\n,;]+/)
    .map(n => normalizePhone(n.trim()))
    .filter(n => n.length >= 8)

  const recipientCount = form.sourceMode === 'crm'
    ? form.selectedContacts.length
    : form.sourceMode === 'numbers'
      ? parsedNumbers.length
      : validCsvRows.length

  function buildRecipients(): BlastRecipient[] {
    if (form.sourceMode === 'csv') {
      return validCsvRows.map(row => ({
        phone: normalizePhone(row[form.phoneColumn] ?? ''),
        name: row[form.nameColumn] ?? row[Object.keys(row)[0]] ?? 'Contato',
        templateParams: Object.fromEntries(
          form.columnMappings.map(m => [m.variable, computeParam(m, row)])
        ),
      })).filter(r => r.phone)
    }
    if (form.sourceMode === 'numbers') {
      return parsedNumbers.map(phone => ({ phone, name: phone, templateParams: {} }))
    }
    return []
  }

  function handleSave() {
    if (!form.name) return alert('Digite o nome da campanha.')
    if (form.channelIds.length === 0) return alert('Selecione ao menos um canal.')
    if (form.type === 'text' && !form.message) return alert('Digite a mensagem.')
    if (form.type === 'template' && !form.templateId) return alert('Selecione um template.')
    if (form.sourceMode === 'crm' && form.selectedContacts.length === 0) return alert('Selecione ao menos um contato.')
    if (form.sourceMode === 'csv' && validCsvRows.length === 0) return alert('Nenhum destinatário válido na base CSV.')
    if (form.sourceMode === 'csv' && !form.phoneColumn) return alert('Selecione a coluna de telefone.')
    if (form.sourceMode === 'numbers' && parsedNumbers.length === 0) return alert('Adicione ao menos um número.')

    const recipients = buildRecipients()
    const totalCount = form.sourceMode === 'crm' ? form.selectedContacts.length : recipients.length

    onSave({
      id: uuid(), name: form.name, channelIds: form.channelIds,
      templateId: form.type === 'template' ? form.templateId : undefined,
      templateImageFile: form.mediaPreview || undefined,
      message: form.type === 'text' ? form.message : undefined,
      contacts: form.sourceMode === 'crm' ? form.selectedContacts : [],
      recipients: form.sourceMode !== 'crm' ? recipients : undefined,
      mode: form.mode,
      status: form.scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: form.scheduledAt || undefined,
      stats: { total: totalCount, processed: 0, sent: 0, waiting: 0, delivered: 0, read: 0, engaged: 0, failed: 0 },
      log: [],
    })
    onClose()
  }

  const previewRows = validCsvRows.slice(0, 3)
  const firstCsvRow = validCsvRows[0] ?? {}

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">Nova Campanha</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="flex p-3 gap-1 border-b border-gray-800">
          {['Mensagem', 'Destinatários', 'Modo & Revisar'].map((label, i) => (
            <button key={i} onClick={() => setStep(i + 1)}
              className={`flex-1 py-1.5 text-xs rounded-lg font-medium ${step === i + 1 ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {i + 1}. {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">

          {/* ── STEP 1: Mensagem ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Nome da Campanha *</label>
                <input value={form.name} onChange={e => setF('name', e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="Ex: Promoção Junho 2026" />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-2">Canais *</label>
                <div className="flex flex-wrap gap-2">
                  {channels.map(ch => (
                    <button key={ch.id} onClick={() => toggleChannel(ch.id)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                        form.channelIds.includes(ch.id)
                          ? 'border-indigo-500 bg-indigo-900/30 text-indigo-300'
                          : 'border-gray-700 bg-gray-800 text-gray-400 hover:text-white'
                      }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${ch.status === 'connected' ? 'bg-green-400' : 'bg-red-400'}`} />
                      {ch.name}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Tipo</label>
                <div className="flex gap-2">
                  {(['template', 'text'] as const).map(t => (
                    <button key={t} onClick={() => setF('type', t)}
                      className={`flex-1 py-2 text-sm rounded-lg border ${
                        form.type === t ? 'border-indigo-500 bg-indigo-900/30 text-indigo-300' : 'border-gray-700 bg-gray-800 text-gray-400 hover:text-white'
                      }`}>
                      {t === 'template' ? '📋 Template Aprovado' : '✏️ Texto Livre'}
                    </button>
                  ))}
                </div>
              </div>

              {form.type === 'template' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-gray-400">Template *</label>
                    <button onClick={loadTemplates} disabled={loadingTemplates}
                      className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
                      <RefreshCw size={11} className={loadingTemplates ? 'animate-spin' : ''} />
                      {loadingTemplates ? 'Buscando...' : 'Buscar da Meta'}
                    </button>
                  </div>
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {templates.filter(t => t.status === 'approved').map(t => {
                      const fmt = getTemplateHeaderFormat(t)
                      const FmtIcon = fmt === 'IMAGE' ? Image : fmt === 'VIDEO' ? Video : fmt === 'DOCUMENT' ? FileIcon : null
                      return (
                        <button key={t.id} onClick={() => {
                          setF('templateId', t.id)
                          // Reset media when switching templates
                          setF('mediaFile', null)
                          setF('mediaPreview', '')
                          setF('mediaFileName', '')
                        }}
                          className={`w-full text-left p-3 rounded-lg border ${form.templateId === t.id ? 'border-indigo-500 bg-indigo-900/20' : 'border-gray-700 bg-gray-800 hover:border-gray-600'}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-white">{t.name}</span>
                            <div className="flex gap-2 items-center">
                              {fmt && FmtIcon && (
                                <span className="text-xs text-amber-400 bg-amber-900/30 px-1.5 py-0.5 rounded flex items-center gap-1">
                                  <FmtIcon size={10} /> {MEDIA_LABEL[fmt]}
                                </span>
                              )}
                              <span className="text-xs text-gray-500">{t.language}</span>
                            </div>
                          </div>
                          <p className="text-xs text-gray-400 line-clamp-2">
                            {t.components.find(c => c.type?.toLowerCase() === 'body')?.text ?? ''}
                          </p>
                          {extractTemplateVars(t).length > 0 && (
                            <p className="text-xs text-indigo-400 mt-1">
                              Variáveis: {extractTemplateVars(t).map(v => `{{${v}}}`).join(', ')}
                            </p>
                          )}
                        </button>
                      )
                    })}
                    {templates.filter(t => t.status === 'approved').length === 0 && (
                      <div className="bg-gray-800 rounded-lg p-4 text-center text-sm text-gray-500">
                        Clique em "Buscar da Meta" para carregar templates aprovados
                      </div>
                    )}
                  </div>

                  {/* Dynamic media upload — shown right after selecting a template with media header */}
                  {(() => {
                    const fmt = selectedTemplate ? getTemplateHeaderFormat(selectedTemplate) : null
                    if (!fmt) return null
                    const FmtIcon = fmt === 'IMAGE' ? Image : fmt === 'VIDEO' ? Video : FileIcon
                    const maxMB = MEDIA_MAX_BYTES[fmt] / 1024 / 1024
                    return (
                      <div className="mt-3 border border-dashed border-amber-600/50 bg-amber-900/10 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                            <FmtIcon size={13} /> {MEDIA_LABEL[fmt]} do header obrigatória
                          </p>
                          <span className="text-[10px] text-gray-600">Máx. {maxMB} MB</span>
                        </div>

                        {form.mediaFile ? (
                          <div className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2.5">
                            {fmt === 'IMAGE' && form.mediaPreview && (
                              <img src={form.mediaPreview} alt="preview" className="h-12 w-12 rounded object-cover shrink-0" />
                            )}
                            {fmt === 'VIDEO' && (
                              <div className="w-12 h-12 bg-gray-700 rounded flex items-center justify-center shrink-0">
                                <Video size={20} className="text-indigo-400" />
                              </div>
                            )}
                            {fmt === 'DOCUMENT' && (
                              <div className="w-12 h-12 bg-gray-700 rounded flex items-center justify-center shrink-0">
                                <FileIcon size={20} className="text-indigo-400" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white truncate">{form.mediaFileName}</p>
                              <p className="text-[11px] text-gray-500">{(form.mediaFile.size / 1024 / 1024).toFixed(2)} MB · {MEDIA_LABEL[fmt]}</p>
                            </div>
                            <button
                              onClick={() => { setF('mediaFile', null); setF('mediaPreview', ''); setF('mediaFileName', '') }}
                              className="text-gray-500 hover:text-red-400 shrink-0 p-1"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => fileInputRef.current?.click()}
                            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-dashed border-gray-600 hover:border-amber-600/50 text-xs text-gray-300 rounded-lg transition-colors">
                            <Upload size={14} /> Selecionar {MEDIA_LABEL[fmt].toLowerCase()}
                          </button>
                        )}
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept={MEDIA_ACCEPT[fmt]}
                          className="hidden"
                          onChange={e => handleMediaPick(e, fmt)}
                        />
                      </div>
                    )
                  })()}
                </div>
              )}

              {form.type === 'text' && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Mensagem *</label>
                  <textarea value={form.message} onChange={e => setF('message', e.target.value)} rows={5}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
                    placeholder="Digite sua mensagem..." />
                  <p className="text-xs text-amber-400 mt-1">⚠️ Texto livre exige janela de atendimento ativa de 24h.</p>
                </div>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1">Agendar (opcional)</label>
                <input type="datetime-local" value={form.scheduledAt} onChange={e => setF('scheduledAt', e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
              </div>
            </div>
          )}

          {/* ── STEP 2: Destinatários ── */}
          {step === 2 && (
            <div className="space-y-4">
              {/* Source mode */}
              <div>
                <label className="block text-xs text-gray-400 mb-2">Público da campanha *</label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['crm',     <Users size={18} />,    'Filtro por contato', 'Utilize sua base de leads para disparar esta campanha'],
                    ['numbers', <List size={18} />,     'Lista de números',   'Cole uma lista de números para disparar'],
                    ['csv',     <FileText size={18} />, 'Importar CSV',       'Importe um arquivo CSV com números e variáveis'],
                  ] as const).map(([src, icon, label, desc]) => (
                    <button key={src} onClick={() => setF('sourceMode', src)}
                      className={`flex flex-col items-center gap-2 p-4 rounded-xl border text-center transition-colors ${
                        form.sourceMode === src
                          ? 'border-green-500 bg-green-900/10 text-green-300'
                          : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
                      }`}>
                      <div className={form.sourceMode === src ? 'text-green-400' : 'text-gray-500'}>{icon}</div>
                      <span className="text-xs font-medium">{label}</span>
                      <span className="text-[11px] text-gray-600 leading-tight">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* CRM contacts */}
              {form.sourceMode === 'crm' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-gray-300"><span className="text-white font-medium">{form.selectedContacts.length}</span> selecionados</p>
                    <div className="flex gap-2">
                      <button onClick={() => setF('selectedContacts', deduplicatedContacts.map(c => c.id))}
                        className="text-xs text-indigo-400 hover:text-indigo-300">Todos</button>
                      <button onClick={() => setF('selectedContacts', [])}
                        className="text-xs text-gray-500 hover:text-gray-300">Limpar</button>
                    </div>
                  </div>
                  <div className="space-y-0.5 max-h-72 overflow-y-auto">
                    {deduplicatedContacts.map(c => (
                      <label key={c.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-800 cursor-pointer">
                        <input type="checkbox" checked={form.selectedContacts.includes(c.id)}
                          onChange={() => toggleContact(c.id)} className="w-4 h-4 accent-indigo-500" />
                        <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-300 shrink-0">
                          {c.name[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white">{c.name}</p>
                          <p className="text-xs text-gray-500">{c.phone}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Numbers list */}
              {form.sourceMode === 'numbers' && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Lista de números <span className="text-gray-600">(um por linha ou separados por vírgula)</span>
                  </label>
                  <textarea
                    value={form.numbersList}
                    onChange={e => setF('numbersList', e.target.value)}
                    rows={8}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500 resize-none"
                    placeholder={"5511999998888\n5511999997777\n5511999996666"}
                  />
                  {parsedNumbers.length > 0 && (
                    <p className="text-xs text-green-400 mt-1">✓ {parsedNumbers.length} números válidos detectados</p>
                  )}
                </div>
              )}

              {/* CSV upload */}
              {form.sourceMode === 'csv' && (
                <div className="space-y-4">
                  {form.csvRows.length === 0 ? (
                    <button onClick={() => csvInputRef.current?.click()}
                      className="w-full border-2 border-dashed border-gray-700 hover:border-indigo-600 rounded-xl p-8 text-center transition-colors">
                      <FileText size={28} className="text-gray-600 mx-auto mb-2" />
                      <p className="text-sm text-gray-400 mb-1">Clique para selecionar um arquivo CSV</p>
                      <p className="text-xs text-gray-600">Suporta separadores , e ; — codificação UTF-8</p>
                    </button>
                  ) : (
                    <div className="bg-green-900/20 border border-green-700/40 rounded-lg px-4 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText size={16} className="text-green-400" />
                        <span className="text-sm text-green-300">
                          {form.csvRows.length} linhas carregadas
                        </span>
                        <span className="text-xs text-gray-500">
                          Colunas: {form.csvHeaders.join(', ')}
                        </span>
                        {form.excludedRows.size > 0 && <span className="text-amber-400 text-xs">· {form.excludedRows.size} excluídas</span>}
                      </div>
                      <button onClick={() => { setForm(f => ({ ...f, csvRows: [], csvHeaders: [], phoneColumn: '', nameColumn: '', excludedRows: new Set(), dupGroups: [] })); if (csvInputRef.current) csvInputRef.current.value = '' }}
                        className="text-xs text-gray-500 hover:text-red-400"><X size={14} /></button>
                    </div>
                  )}
                  <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvUpload} />

                  {form.csvHeaders.length > 0 && (
                    <>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Coluna de Telefone *</label>
                        <select value={form.phoneColumn} onChange={e => setF('phoneColumn', e.target.value)}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                          <option value="">— Selecionar —</option>
                          {form.csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>

                      <div className="flex items-center gap-3">
                        <button onClick={detectDuplicates}
                          className="flex items-center gap-2 px-4 py-2 bg-amber-700 hover:bg-amber-600 text-sm text-white rounded-lg">
                          <AlertTriangle size={14} /> Verificar Duplicatas
                        </button>
                        {form.dupGroups.length > 0 && (
                          <span className="text-sm text-amber-400">
                            {form.dupGroups.length} duplicado{form.dupGroups.length > 1 ? 's' : ''}
                            <button onClick={() => setF('showDupModal', true)} className="ml-2 text-indigo-400 underline">Revisar</button>
                          </span>
                        )}
                      </div>

                      {/* Variable mapping */}
                      {form.type === 'template' && templateVars.length > 0 && (
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Hash size={13} className="text-indigo-400" />
                            <h3 className="text-xs font-semibold text-gray-300">Mapeamento de variáveis</h3>
                            <span className="text-[11px] text-gray-600">Associe cada variável do template a uma coluna do CSV, texto fixo ou mista (texto + coluna)</span>
                          </div>
                          <div className="space-y-3">
                            {form.columnMappings.map((m, i) => (
                              <MappingRow key={m.variable} mapping={m}
                                csvHeaders={form.csvHeaders}
                                varIdx={i}
                                onChange={updated => updateMapping(i, updated)} />
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Message preview */}
                      {form.type === 'template' && selectedTemplate && (
                        <MessagePreview
                          template={selectedTemplate}
                          mappings={form.columnMappings}
                          row={firstCsvRow}
                          mediaPreview={form.mediaPreview}
                          mediaFileName={form.mediaFileName}
                        />
                      )}

                      {/* Preview table */}
                      {previewRows.length > 0 && (
                        <div>
                          <h3 className="text-xs font-medium text-gray-400 mb-2">Prévia — primeiros {previewRows.length} registros</h3>
                          <div className="overflow-x-auto rounded-lg border border-gray-700">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-gray-800 border-b border-gray-700">
                                  <th className="px-3 py-2 text-left text-gray-500 font-medium">Telefone</th>
                                  {templateVars.map(v => (
                                    <th key={v} className="px-3 py-2 text-left text-indigo-400 font-medium">{`{{${v}}}`}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {previewRows.map((row, i) => (
                                  <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/30">
                                    <td className="px-3 py-2 font-mono text-green-400">{normalizePhone(row[form.phoneColumn] ?? '—')}</td>
                                    {form.columnMappings.map(m => (
                                      <td key={m.variable} className="px-3 py-2 text-indigo-300">{computeParam(m, row) || '—'}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            Total válido: <strong className="text-white">{validCsvRows.length}</strong> destinatários
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 3: Modo & Revisar ── */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs text-gray-400 mb-3">Modo de Disparo</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['standard', <Zap size={16} />, 'Padrão', '5s a 1min 30s', 'Para canais já estabelecidos', 'border-indigo-500 bg-indigo-900/20', 'text-indigo-300'],
                    ['warmup', <Flame size={16} />, 'Aquecimento', '3 a 5 minutos', 'Para números novos ou baixa reputação', 'border-amber-500 bg-amber-900/10', 'text-amber-300'],
                  ] as const).map(([m, icon, label, delay, desc, border, textCls]) => (
                    <button key={m} onClick={() => setF('mode', m as BlastMode)}
                      className={`p-4 rounded-xl border text-left transition-all ${form.mode === m ? border : 'border-gray-700 bg-gray-800 hover:border-gray-600'}`}>
                      <div className={`flex items-center gap-2 mb-2 ${form.mode === m ? textCls : 'text-gray-400'}`}>
                        {icon} <span className="text-sm font-medium">{label}</span>
                      </div>
                      <p className="text-xs text-gray-500">Delay: <strong className="text-gray-300">{delay}</strong></p>
                      <p className="text-xs text-gray-600 mt-1">{desc}</p>
                    </button>
                  ))}
                </div>
                {recipientCount > 0 && (
                  <div className="mt-3 bg-gray-800 rounded-lg p-3 text-xs text-gray-400 flex gap-2">
                    <Info size={13} className="shrink-0 mt-0.5 text-gray-500" />
                    <span>
                      <strong className="text-white">{recipientCount}</strong> destinatários · Tempo estimado:{' '}
                      <strong className="text-white">{fmtDelay(recipientCount * (form.mode === 'warmup' ? 180000 : 5000))}</strong>
                      {' '}a{' '}
                      <strong className="text-white">{fmtDelay(recipientCount * (form.mode === 'warmup' ? 300000 : 90000))}</strong>
                    </span>
                  </div>
                )}
              </div>

              <div className="bg-gray-800 rounded-xl p-4 space-y-3 text-sm">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">Resumo</p>
                {[
                  ['Nome', form.name || '—'],
                  ['Canais', selectedChannels.map(c => c.name).join(', ') || '—'],
                  ['Tipo', form.type === 'text' ? 'Texto livre' : `Template: ${selectedTemplate?.name ?? '—'}`],
                  ['Base', form.sourceMode === 'crm' ? `${form.selectedContacts.length} contatos do CRM`
                    : form.sourceMode === 'numbers' ? `${parsedNumbers.length} números`
                    : `${validCsvRows.length} linhas do CSV`],
                  ['Modo', form.mode === 'warmup' ? '🔥 Aquecimento (3-5 min)' : '⚡ Padrão (5s-1m30s)'],
                  ...(form.scheduledAt ? [['Agendado', format(new Date(form.scheduledAt), "dd/MM/yyyy HH:mm", { locale: ptBR })]] : []),
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-gray-400">{k}</span><span className="text-white text-right max-w-xs">{v}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 p-5 border-t border-gray-800">
          {step > 1 && <button onClick={() => setStep(s => s - 1)} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 rounded-lg">← Anterior</button>}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          {step < 3
            ? <button onClick={() => setStep(s => s + 1)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">Próximo →</button>
            : <button onClick={handleSave} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-sm text-white rounded-lg">
                <Send size={14} /> {form.scheduledAt ? 'Agendar' : 'Salvar Campanha'}
              </button>}
        </div>
      </div>

      {form.showDupModal && form.dupGroups.length > 0 && (
        <DuplicateModal
          groups={form.dupGroups}
          rows={form.csvRows}
          phoneCol={form.phoneColumn}
          excluded={form.excludedRows}
          onConfirm={excl => setForm(f => ({ ...f, excludedRows: excl, showDupModal: false }))}
          onCancel={() => setF('showDupModal', false)}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// BLAST EXECUTION
// ═══════════════════════════════════════════════════════════════════

const runningBlasts = new Map<string, boolean>()

async function executeBlast(
  blast: Blast,
  channels: ReturnType<typeof useStore.getState>['channels'],
  contacts: ReturnType<typeof useStore.getState>['contacts'],
  templates: ReturnType<typeof useStore.getState>['templates'],
  onProgress: (sent: number, failed: number, log: string, failureBreakdown?: Record<string, number>) => void,
  onDone: () => void
) {
  runningBlasts.set(blast.id, true)

  interface QueueItem { phone: string; name: string; channel: typeof channels[0]; params?: Record<string, string> }
  const queue: QueueItem[] = []
  const seenPhones = new Set<string>()

  if (blast.recipients && blast.recipients.length > 0) {
    for (const r of blast.recipients) {
      const phone = normalizePhone(r.phone)
      if (!phone || seenPhones.has(phone)) continue
      seenPhones.add(phone)
      const channel =
        (r.preferredChannelId ? channels.find(c => c.id === r.preferredChannelId && blast.channelIds.includes(c.id)) : null) ??
        channels.find(c => blast.channelIds.includes(c.id))
      if (!channel) continue
      queue.push({ phone, name: r.name, channel, params: r.templateParams })
    }
  } else {
    for (const contactId of blast.contacts) {
      const contact = contacts.find(c => c.id === contactId)
      if (!contact) continue
      const phone = normalizePhone(contact.phone)
      if (seenPhones.has(phone)) continue
      seenPhones.add(phone)
      const channel =
        channels.find(c => blast.channelIds.includes(c.id) && c.id === contact.channelId) ??
        channels.find(c => blast.channelIds.includes(c.id))
      if (!channel) continue
      queue.push({ phone, name: contact.name, channel, params: {} })
    }
  }

  const template = blast.templateId ? templates.find((t: Template) => t.id === blast.templateId) : null
  let sent = 0, failed = 0
  const failureBreakdown: Record<string, number> = {}

  for (let i = 0; i < queue.length; i++) {
    if (!runningBlasts.get(blast.id)) break
    const { phone, name, channel, params } = queue[i]

    try {
      let mediaId: string | undefined
      const headerFmt = template ? getTemplateHeaderFormat(template) : null
      if (template && headerFmt && blast.templateImageFile) {
        try {
          const blob = await fetch(blast.templateImageFile).then(r => r.blob())
          const ext = headerFmt === 'IMAGE' ? 'jpg' : headerFmt === 'VIDEO' ? 'mp4' : 'pdf'
          const file = new File([blob], `header.${ext}`, { type: blob.type })
          mediaId = await uploadMedia(channel.phoneNumberId, channel.accessToken, file, channel.proxy)
        } catch {}
      }

      if (template) {
        const components: object[] = []
        if (mediaId && headerFmt) {
          const mediaType = headerFmt.toLowerCase() as 'image' | 'video' | 'document'
          components.push({ type: 'header', parameters: [{ type: mediaType, [mediaType]: { id: mediaId } }] })
        }
        if (params && Object.keys(params).length > 0) {
          components.push({
            type: 'body',
            parameters: Object.entries(params)
              .sort(([a], [b]) => +a - +b)
              .map(([, v]) => ({ type: 'text', text: v }))
          })
        }
        await sendTemplateMessage(channel.phoneNumberId, channel.accessToken, phone, template.name, template.language, components, channel.proxy)
      } else if (blast.message) {
        await sendTextMessage(channel.phoneNumberId, channel.accessToken, phone, blast.message, channel.proxy)
      }

      sent++
      onProgress(sent, failed, `✓ ${name} (${phone}) via ${channel.name}`)
    } catch (e: any) {
      failed++
      const errMsg = e.response?.data?.error?.message ?? e.message ?? 'Erro desconhecido'
      const category = errMsg.includes('Invalid') || errMsg.includes('invalid') ? 'Número inválido'
        : errMsg.includes('undeliverable') ? 'Message undeliverable'
        : errMsg.includes('rate') || errMsg.includes('limit') ? 'Rate limit'
        : errMsg.slice(0, 35)
      failureBreakdown[category] = (failureBreakdown[category] ?? 0) + 1
      onProgress(sent, failed, `✗ ${name} (${phone}): ${errMsg}`, { ...failureBreakdown })
    }

    if (i < queue.length - 1 && runningBlasts.get(blast.id)) {
      const delay = randomDelay(blast.mode)
      onProgress(sent, failed, `⏳ Aguardando ${fmtDelay(delay)} antes do próximo...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }

  runningBlasts.delete(blast.id)
  onDone()
}

// ═══════════════════════════════════════════════════════════════════
// DISPATCHER PAGE
// ═══════════════════════════════════════════════════════════════════

export default function Dispatcher() {
  const { blasts, addBlast, updateBlast, channels, contacts, templates } = useStore()
  const [modal, setModal] = useState(false)
  const [reportBlastId, setReportBlastId] = useState<string | null>(null)
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  const reportBlast = blasts.find(b => b.id === reportBlastId)

  async function runBlast(blast: Blast) {
    if (runningBlasts.has(blast.id)) return
    updateBlast(blast.id, {
      status: 'running',
      sentAt: new Date().toISOString(),
      log: [],
      stats: { ...blast.stats, processed: 0, sent: 0, waiting: 0, failed: 0, engaged: 0 },
    })

    await executeBlast(blast, channels, contacts, templates,
      (sent, failed, log, failureBreakdown) => {
        const cur = useStore.getState().blasts.find(b => b.id === blast.id)
        updateBlast(blast.id, {
          stats: {
            ...(cur?.stats ?? blast.stats),
            total: blast.stats.total,
            processed: sent + failed,
            sent,
            failed,
            ...(failureBreakdown ? { failureBreakdown } : {}),
          },
          log: [...(cur?.log ?? []), log].slice(-200),
        })
      },
      () => {
        const cur = useStore.getState().blasts.find(b => b.id === blast.id)
        updateBlast(blast.id, { status: 'done', stats: cur?.stats ?? blast.stats })
      }
    )
  }

  function stopBlast(id: string) {
    runningBlasts.set(id, false)
    updateBlast(id, { status: 'done' })
  }

  const statusStyle: Record<string, string> = {
    draft: 'text-gray-400 bg-gray-800', scheduled: 'text-amber-400 bg-amber-900/30',
    running: 'text-blue-400 bg-blue-900/30', done: 'text-green-400 bg-green-900/30', failed: 'text-red-400 bg-red-900/30',
  }
  const statusLabel: Record<string, string> = {
    draft: 'Rascunho', scheduled: 'Agendado', running: 'Executando', done: 'Concluído', failed: 'Falhou',
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Disparador em Massa</h1>
          <p className="text-sm text-gray-400 mt-1">CSV, mapeamento de variáveis, deduplicação e delay inteligente</p>
        </div>
        <button onClick={() => setModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
          <Send size={15} /> Nova Campanha
        </button>
      </div>

      {blasts.length === 0 ? (
        <div className="border-2 border-dashed border-gray-800 rounded-xl p-12 text-center">
          <Send size={32} className="text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400 mb-4">Nenhuma campanha criada</p>
          <button onClick={() => setModal(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
            Criar Campanha
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {[...blasts].reverse().map(blast => {
            const isRunning = runningBlasts.has(blast.id)
            const progress = blast.stats.total > 0
              ? Math.round(((blast.stats.sent + blast.stats.failed) / blast.stats.total) * 100)
              : 0
            const blastChannels = channels.filter(c => blast.channelIds?.includes(c.id))
            const isLogsOpen = expandedLog === blast.id

            return (
              <div key={blast.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-white">{blast.name}</p>
                        {blast.mode === 'warmup'
                          ? <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-amber-900/30 text-amber-400 rounded-full"><Flame size={10} /> Aquecimento</span>
                          : <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-indigo-900/30 text-indigo-400 rounded-full"><Zap size={10} /> Padrão</span>}
                        {blast.recipients && <span className="text-xs px-2 py-0.5 bg-green-900/30 text-green-400 rounded-full">CSV</span>}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {blastChannels.map(c => c.name).join(', ')}
                        {blast.sentAt && ` · ${format(new Date(blast.sentAt), "dd/MM HH:mm", { locale: ptBR })}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusStyle[blast.status]}`}>
                        {statusLabel[blast.status]}
                      </span>
                      <button
                        onClick={() => setReportBlastId(blast.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 rounded-lg border border-gray-700"
                        title="Relatório detalhado"
                      >
                        <BarChart2 size={12} /> Relatório
                      </button>
                      {(blast.status === 'draft' || blast.status === 'scheduled') && !isRunning && (
                        <button onClick={() => runBlast(blast)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-700 hover:bg-green-600 text-xs text-white rounded-lg">
                          <Play size={12} /> Enviar
                        </button>
                      )}
                      {isRunning && (
                        <button onClick={() => stopBlast(blast.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-800 hover:bg-red-700 text-xs text-white rounded-lg">
                          <X size={12} /> Parar
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mb-3">
                    {[
                      { label: 'Total',     value: blast.stats.total,          color: 'text-gray-300' },
                      { label: 'Enviados',  value: blast.stats.sent,           color: 'text-blue-400' },
                      { label: 'Entregues', value: blast.stats.delivered,      color: 'text-green-400' },
                      { label: 'Lidos',     value: blast.stats.read,           color: 'text-teal-400' },
                      { label: 'Engajados', value: blast.stats.engaged ?? 0,   color: 'text-orange-400' },
                      { label: 'Falhas',    value: blast.stats.failed,         color: 'text-red-400' },
                    ].map(s => (
                      <div key={s.label} className="bg-gray-800 rounded-lg p-2 text-center col-span-2 sm:col-span-1">
                        <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                        <p className="text-[10px] text-gray-500">{s.label}</p>
                      </div>
                    ))}
                  </div>

                  {(blast.status === 'running' || blast.status === 'done') && blast.stats.total > 0 && (
                    <div className="mb-2">
                      <div className="flex justify-between text-xs text-gray-500 mb-1">
                        <span>{isRunning ? 'Enviando...' : 'Concluído'}</span>
                        <span>{progress}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className={`h-full transition-all duration-500 ${isRunning ? 'bg-blue-500' : 'bg-green-500'}`}
                          style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  )}

                  {(blast.log?.length ?? 0) > 0 && (
                    <button onClick={() => setExpandedLog(isLogsOpen ? null : blast.id)}
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 mt-2">
                      {isLogsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {isLogsOpen ? 'Ocultar log' : `Ver log (${blast.log!.length} eventos)`}
                    </button>
                  )}
                </div>

                {isLogsOpen && blast.log && (
                  <div className="border-t border-gray-800 bg-gray-950 p-3 max-h-48 overflow-y-auto">
                    {blast.log.map((line, i) => (
                      <p key={i} className={`text-xs font-mono mb-0.5 ${
                        line.startsWith('✓') ? 'text-green-400' : line.startsWith('✗') ? 'text-red-400' : line.startsWith('⏳') ? 'text-amber-400' : 'text-gray-500'
                      }`}>{line}</p>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {modal && <BlastModal onClose={() => setModal(false)} onSave={b => { addBlast(b); setModal(false) }} />}

      {reportBlast && (
        <BlastReport
          blast={reportBlast}
          channels={channels}
          templates={templates}
          onClose={() => setReportBlastId(null)}
          onUpdate={stats => updateBlast(reportBlast.id, { stats })}
        />
      )}
    </div>
  )
}
