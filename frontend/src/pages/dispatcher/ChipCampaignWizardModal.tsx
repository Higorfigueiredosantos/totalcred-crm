import { useState, useMemo, useEffect } from 'react'
import {
  Smartphone, Upload, X, ChevronDown, ChevronUp, AlertCircle, Users, Loader2,
  Eye, FileText, MessageSquare, Globe, Zap, Send,
} from 'lucide-react'
import { onWSMessage } from '../../api/websocket'
import { useChips } from '../../hooks/useChips'
import type { ChipCampaignSettings, CsvContact } from '../../types'
import { ALL_GREETINGS, parseContacts, parseCsvRaw, buildContacts, type ChipCampaignConfig } from './chipCampaign'

interface Props {
  onClose: () => void
  onStart: (config: ChipCampaignConfig) => Promise<{ ok: boolean; error?: string; message?: string }>
}

export default function ChipCampaignWizardModal({ onClose, onStart }: Props) {
  const { chips } = useChips()
  const [step, setStep] = useState(1)
  const [starting, setStarting] = useState(false)

  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [selectedGreetings, setSelectedGreetings] = useState<string[]>([...ALL_GREETINGS])
  const [showGreetingPicker, setShowGreetingPicker] = useState(false)
  const [imageB64, setImageB64] = useState('')

  const [contactsTab, setContactsTab] = useState<'manual' | 'csv'>('manual')
  const [contactsText, setContactsText] = useState('')
  const [csvContacts, setCsvContacts] = useState<CsvContact[]>([])
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvRawRows, setCsvRawRows] = useState<Record<string, string>[]>([])
  const [csvAllHeaders, setCsvAllHeaders] = useState<string[]>([])
  const [csvPhoneColumn, setCsvPhoneColumn] = useState('')
  const [csvDups, setCsvDups] = useState(0)
  const [waFilterState, setWaFilterState] = useState<'idle' | 'running' | 'done'>('idle')
  const [waFilterProgress, setWaFilterProgress] = useState({ checked: 0, total: 0, hasWa: 0, noWa: 0 })
  const [noWaNumbers, setNoWaNumbers] = useState<Set<string>>(new Set())

  const [selectedChipIds, setSelectedChipIds] = useState<string[]>([])
  const [settings, setSettings] = useState<ChipCampaignSettings>({
    delayMin: 5, delayMax: 30, useAIHumanize: false, tone: 'amigavel',
    batchDelay: { enabled: false, everyMin: 10, everyMax: 20, pauseMin: 60, pauseMax: 120 },
  })

  useEffect(() => {
    const offs = [
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
  }, [])

  function getActiveContacts(): CsvContact[] {
    return contactsTab === 'csv' ? csvContacts : parseContacts(contactsText)
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
    setSelectedGreetings(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g])
  }

  const previewMessage = useMemo(() => {
    if (!message.trim()) return ''
    const contacts = getActiveContacts()
    const c = contacts[0] ?? { number: '5511999990001', name: 'João', vars: {} }
    let msg = message.replace(/\{\{name\}\}/gi, c.name || 'Nome')
    if (c.vars) for (const [k, v] of Object.entries(c.vars)) msg = msg.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'gi'), v)
    const greeting = selectedGreetings[0] ?? 'Oi, tudo bem?'
    return `${greeting}\n\n${msg}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, contactsText, csvContacts, contactsTab, selectedGreetings])

  const recipientCount = getActiveContacts().length
  const readyChips = chips.filter(c => c.isReady)
  const activeChipCount = selectedChipIds.length === 0 ? readyChips.length : selectedChipIds.filter(id => readyChips.some(c => c.id === id)).length

  async function handleStart(force = false) {
    const contacts = getActiveContacts()
    if (!name.trim()) return alert('Digite o nome da campanha.')
    if (contacts.length === 0) return alert('Adicione pelo menos um número.')
    if (!message.trim()) return alert('Escreva a mensagem.')
    const chipsToUse = selectedChipIds.length > 0 ? selectedChipIds : readyChips.map(c => c.id)
    if (chipsToUse.length === 0) return alert('Nenhum chip conectado disponível.')

    setStarting(true)
    const result = await onStart({
      name: name.trim(), message, greetings: selectedGreetings, imageB64,
      contacts, chipIds: chipsToUse, settings: { ...settings, force },
    })
    setStarting(false)

    if (!result.ok) {
      if (result.error === 'RISK_TIME' && confirm((result.message || '') + '\n\nContinuar mesmo assim?')) return handleStart(true)
      if (result.error !== 'RISK_TIME') alert(result.error)
      return
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-white">Nova Campanha</h2>
            <span className="text-xs px-2 py-0.5 bg-green-900/40 text-green-300 rounded-full">Via Chips</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="flex p-3 gap-1 border-b border-gray-800">
          {['Mensagem', 'Destinatários', 'Chips & Revisar'].map((label, i) => (
            <button key={i} onClick={() => setStep(i + 1)}
              className={`flex-1 py-1.5 text-xs rounded-lg font-medium ${step === i + 1 ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
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
                <input value={name} onChange={e => setName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500"
                  placeholder="Ex: Promoção Junho 2026" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Template da mensagem *</label>
                <textarea value={message} onChange={e => setMessage(e.target.value)} rows={5}
                  placeholder={"Use {{name}} para nome, {{1}} {{2}}... para colunas do CSV.\nEx: Olá {{name}}, temos uma oferta em {{cidade}}!"}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-green-500" />
              </div>

              <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                <button type="button" onClick={() => setShowGreetingPicker(s => !s)}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-700/60 transition-colors text-left">
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
                        <input type="checkbox" checked={selectedGreetings.includes(g)} onChange={() => toggleGreeting(g)}
                          className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-0 focus:ring-offset-0" />
                        <span className={`text-xs ${selectedGreetings.includes(g) ? 'text-gray-200' : 'text-gray-600 line-through'}`}>{g}</span>
                      </label>
                    ))}
                    <div className="flex gap-2 mt-1 pt-1 border-t border-gray-800">
                      <button type="button" onClick={() => setSelectedGreetings([...ALL_GREETINGS])} className="text-[11px] text-indigo-400 hover:text-indigo-300">Marcar todos</button>
                      <button type="button" onClick={() => setSelectedGreetings([])} className="text-[11px] text-red-400 hover:text-red-300">Desmarcar todos</button>
                    </div>
                  </div>
                )}
              </div>

              {previewMessage && (
                <div className="bg-gray-800 rounded-lg border border-gray-700 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                    <Eye size={11} /> Preview com {getActiveContacts()[0]?.name || 'primeiro contato'} · cumprimento: "{selectedGreetings[0] ?? '—'}"
                  </div>
                  <div className="bg-green-900/20 border border-green-800/30 rounded-lg px-3 py-2 text-xs text-green-200 whitespace-pre-wrap leading-relaxed">
                    {previewMessage}
                  </div>
                </div>
              )}

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
            </div>
          )}

          {/* ── STEP 2: Destinatários ── */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="flex gap-1 bg-gray-800 rounded-lg p-1 w-fit">
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
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono resize-none focus:outline-none focus:border-green-500" />
                  <p className="text-xs text-gray-500 mt-1">{parseContacts(contactsText).length} contato(s) · formato: número,nome</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className={`flex items-center gap-3 border rounded-xl px-4 py-3 cursor-pointer transition-colors ${csvContacts.length > 0 ? 'border-green-700/50 bg-green-900/10 hover:bg-green-900/20' : 'border-dashed border-gray-700 bg-gray-800 hover:border-gray-500'}`}>
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

                  {csvAllHeaders.length > 0 && (
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-gray-500 shrink-0">Coluna de telefone:</label>
                      <select value={csvPhoneColumn} onChange={e => handlePhoneColumnChange(e.target.value)}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500">
                        {csvAllHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  )}

                  {csvContacts.length > 0 && (
                    <div className="rounded-xl border border-gray-700 bg-gray-800 overflow-hidden">
                      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-700">
                        <AlertCircle size={13} className={csvDups > 0 ? 'text-yellow-400 shrink-0' : 'text-gray-600 shrink-0'} />
                        <span className="text-xs flex-1">
                          {csvDups > 0
                            ? <span className="text-yellow-400">{csvDups} número{csvDups !== 1 ? 's' : ''} duplicado{csvDups !== 1 ? 's' : ''}</span>
                            : <span className="text-gray-500">Sem duplicatas detectadas</span>}
                        </span>
                        <button onClick={removeDuplicates} disabled={csvDups === 0}
                          className="text-[11px] bg-yellow-800 hover:bg-yellow-700 disabled:opacity-30 disabled:cursor-not-allowed text-white px-2.5 py-1 rounded-md transition-colors shrink-0">
                          Remover duplicados
                        </button>
                      </div>
                      <div className="px-3 py-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                          <Globe size={13} className="text-blue-400 shrink-0" />
                          <span className="text-xs text-gray-400 flex-1">Verificar WhatsApp</span>
                          {waFilterState === 'idle' && (
                            <button onClick={startWaFilter} className="text-[11px] bg-blue-700 hover:bg-blue-600 text-white px-2.5 py-1 rounded-md transition-colors shrink-0">
                              Verificar ({csvContacts.length})
                            </button>
                          )}
                          {waFilterState === 'running' && (
                            <span className="text-[11px] text-blue-400 flex items-center gap-1 shrink-0">
                              <Loader2 size={10} className="animate-spin" /> Verificando…
                            </span>
                          )}
                          {waFilterState === 'done' && (
                            <button onClick={() => { setWaFilterState('idle'); setNoWaNumbers(new Set()) }} className="text-[11px] text-gray-500 hover:text-gray-300 shrink-0">Refazer</button>
                          )}
                        </div>
                        {waFilterState === 'running' && (
                          <div className="space-y-1">
                            <div className="w-full bg-gray-900 rounded-full h-1">
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
                                <button onClick={removeNoWa} className="text-[11px] bg-red-800 hover:bg-red-700 text-white px-2.5 py-1 rounded-md transition-colors">Remover inválidos</button>
                              </div>
                        )}
                      </div>
                    </div>
                  )}

                  {csvHeaders.length > 0 && (
                    <div className="bg-indigo-950/40 border border-indigo-800/30 rounded-xl p-3 space-y-2">
                      <p className="text-[11px] font-medium text-indigo-400">Variáveis disponíveis no template:</p>
                      <div className="flex flex-wrap gap-1.5">
                        <code className="text-[11px] bg-gray-800 text-green-300 px-2 py-0.5 rounded">{'{{name}}'}</code>
                        {csvHeaders.map(h => (
                          <code key={h} className="text-[11px] bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">{`{{${h}}}`}</code>
                        ))}
                      </div>
                    </div>
                  )}

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
                                  <td className={`px-3 py-1.5 font-mono ${noWa ? 'text-red-400 line-through' : 'text-gray-300'}`}>{c.number}</td>
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
          )}

          {/* ── STEP 3: Chips & Revisar ── */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-400">Chips para disparo *</label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setSelectedChipIds(readyChips.map(c => c.id))} className="text-[11px] text-green-400 hover:text-green-300">Todos</button>
                    <button type="button" onClick={() => setSelectedChipIds([])} className="text-[11px] text-red-400 hover:text-red-300">Nenhum</button>
                  </div>
                </div>
                <div className="bg-gray-800 rounded-lg border border-gray-700 divide-y divide-gray-700">
                  {readyChips.length === 0 ? (
                    <p className="px-3 py-2.5 text-xs text-red-400">Nenhum chip conectado</p>
                  ) : readyChips.map(chip => {
                    const checked = selectedChipIds.length === 0 || selectedChipIds.includes(chip.id)
                    return (
                      <label key={chip.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none hover:bg-gray-700/40">
                        <input type="checkbox" checked={checked}
                          onChange={() => {
                            const all = readyChips.map(c => c.id)
                            const cur = selectedChipIds.length === 0 ? all : selectedChipIds
                            setSelectedChipIds(cur.includes(chip.id) ? cur.filter(id => id !== chip.id) : [...cur, chip.id])
                          }}
                          className="rounded border-gray-600 bg-gray-900 text-green-500 focus:ring-0 focus:ring-offset-0" />
                        <Smartphone size={11} className="text-green-400 shrink-0" />
                        <span className="text-xs text-gray-300 flex-1">{chip.id}</span>
                        {chip.number && <span className="text-[11px] text-gray-500">{chip.number}</span>}
                      </label>
                    )
                  })}
                </div>
                {activeChipCount > 1 ? (
                  <p className="text-[11px] text-green-400/70">Rotação entre {activeChipCount} chips — nunca o mesmo chip em disparos seguidos.</p>
                ) : activeChipCount === 1 ? (
                  <p className="text-[11px] text-yellow-400/70">1 chip selecionado — todos os disparos usarão este chip.</p>
                ) : (
                  <p className="text-[11px] text-red-400">Selecione pelo menos 1 chip.</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-400">Delay entre envios (segundos)</label>
                <div className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="number" min={1} value={settings.delayMin}
                    onChange={e => setSettings(s => ({ ...s, delayMin: +e.target.value }))}
                    className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center focus:outline-none focus:border-green-500" />
                  <span className="text-gray-500">até</span>
                  <input type="number" min={1} value={settings.delayMax}
                    onChange={e => setSettings(s => ({ ...s, delayMax: +e.target.value }))}
                    className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center focus:outline-none focus:border-green-500" />
                  <span className="text-gray-500">seg</span>
                </div>

                <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                  <label className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none">
                    <input type="checkbox" checked={settings.batchDelay?.enabled ?? false}
                      onChange={e => setSettings(s => ({ ...s, batchDelay: { ...(s.batchDelay!), enabled: e.target.checked } }))}
                      className="rounded border-gray-600 bg-gray-900 text-orange-500 focus:ring-0" />
                    <span className="text-xs text-gray-300">☕ Pausa a cada lote de mensagens</span>
                  </label>
                  {settings.batchDelay?.enabled && (
                    <div className="border-t border-gray-700 px-3 pb-3 pt-2 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <span className="text-gray-500 w-20 shrink-0">A cada</span>
                        <input type="number" min={1} value={settings.batchDelay.everyMin}
                          onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, everyMin: +e.target.value } }))}
                          className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                        <span className="text-gray-600">a</span>
                        <input type="number" min={1} value={settings.batchDelay.everyMax}
                          onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, everyMax: +e.target.value } }))}
                          className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                        <span className="text-gray-500">envios</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <span className="text-gray-500 w-20 shrink-0">Pausar</span>
                        <input type="number" min={1} value={settings.batchDelay.pauseMin}
                          onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, pauseMin: +e.target.value } }))}
                          className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
                        <span className="text-gray-600">a</span>
                        <input type="number" min={1} value={settings.batchDelay.pauseMax}
                          onChange={e => setSettings(s => ({ ...s, batchDelay: { ...s.batchDelay!, pauseMax: +e.target.value } }))}
                          className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-orange-500" />
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

              {recipientCount > 0 && (
                <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-400 flex gap-2">
                  <AlertCircle size={13} className="shrink-0 mt-0.5 text-gray-500" />
                  <span>
                    <strong className="text-white">{recipientCount}</strong> destinatários · Delay:{' '}
                    <strong className="text-white">{settings.delayMin}s</strong> a <strong className="text-white">{settings.delayMax}s</strong>
                  </span>
                </div>
              )}

              <div className="bg-gray-800 rounded-xl p-4 space-y-3 text-sm">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">Resumo</p>
                {[
                  ['Nome', name || '—'],
                  ['Chips', activeChipCount > 0 ? `${activeChipCount} chip(s) em rotação` : '—'],
                  ['Destinatários', `${recipientCount} contato(s)`],
                  ['Saudações', `${selectedGreetings.length} ativa(s)`],
                  ['Humanização IA', settings.useAIHumanize ? 'Ativada' : 'Desativada'],
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
            ? <button onClick={() => setStep(s => s + 1)} className="px-4 py-2 bg-green-600 hover:bg-green-500 text-sm text-white rounded-lg">Próximo →</button>
            : <button onClick={() => handleStart()} disabled={starting}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-sm text-white rounded-lg">
                {starting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Iniciar Campanha
              </button>}
        </div>
      </div>
    </div>
  )
}
