import { useState } from 'react'
import {
  MessageSquare, Upload, X, AlertCircle, Users, Loader2,
  FileText, Send, RefreshCw, CheckCircle2, Eye, Zap,
} from 'lucide-react'
import { useSmsInstances } from '../../hooks/useSmsInstances'
import type { CsvContact } from '../../types'
import { parseContacts, parseCsvRaw, buildContacts } from './chipCampaign'
import type { SmsBatchDelay, SmsCampaignConfig } from './smsCampaign'

interface Props {
  onClose: () => void
  onStart: (config: SmsCampaignConfig) => Promise<{ ok: boolean; error?: string }>
  onResetSent: () => Promise<{ ok: boolean; cleared: number }>
}

function firstNameOf(name?: string) {
  const trimmed = (name || '').trim()
  return trimmed ? trimmed.split(/\s+/)[0] : ''
}

function applyVarsPreview(text: string, contact?: CsvContact, firstNameOnly?: boolean) {
  if (!text.trim()) return ''
  const c = contact ?? { number: '5511999990001', name: 'João Silva', vars: {} }
  const nameValue = (firstNameOnly ? firstNameOf(c.name) : c.name) || 'Nome'
  let msg = text.replace(/\{\{name\}\}/gi, nameValue)
  if (c.vars) for (const [k, v] of Object.entries(c.vars)) msg = msg.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'gi'), v)
  return msg
}

// Wizard de campanha via SMS (BETA) — automação do Google Messages Web,
// texto puro (sem botões/imagem, diferente do Wuzapi). Destinatários vem
// antes da mensagem pelo mesmo motivo do wizard Wuzapi: a base é que define
// quais variáveis ({{name}}, {{coluna}}...) existem pra usar no texto.
export default function SmsCampaignWizardModal({ onClose, onStart, onResetSent }: Props) {
  const [resettingSent, setResettingSent] = useState(false)
  const { instances } = useSmsInstances()
  const connected = instances.filter(i => i.status === 'connected')

  const [step, setStep] = useState(1)
  const [starting, setStarting] = useState(false)

  const [name, setName] = useState('')
  const [text, setText] = useState('')

  const [contactsTab, setContactsTab] = useState<'manual' | 'csv'>('manual')
  const [contactsText, setContactsText] = useState('')
  const [csvContacts, setCsvContacts] = useState<CsvContact[]>([])
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvRawRows, setCsvRawRows] = useState<Record<string, string>[]>([])
  const [csvAllHeaders, setCsvAllHeaders] = useState<string[]>([])
  const [csvPhoneColumn, setCsvPhoneColumn] = useState('')
  const [csvDups, setCsvDups] = useState(0)

  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([])
  const [delayMin, setDelayMin] = useState(5)
  const [delayMax, setDelayMax] = useState(15)
  const [batchDelay, setBatchDelay] = useState<SmsBatchDelay>({ enabled: false, everyMin: 10, everyMax: 20, pauseMin: 90, pauseMax: 240 })
  const [spinWithAI, setSpinWithAI] = useState(false)
  const [firstNameOnly, setFirstNameOnly] = useState(false)

  function getActiveContacts(): CsvContact[] {
    return contactsTab === 'csv' ? csvContacts : parseContacts(contactsText)
  }

  function applyPhoneColumn(rawRows: Record<string, string>[], allHeaders: string[], phoneCol: string) {
    const { contacts, extraHeaders } = buildContacts(rawRows, allHeaders, phoneCol)
    const seen = new Set<string>()
    let dups = 0
    contacts.forEach(c => { if (seen.has(c.number)) dups++; else seen.add(c.number) })
    setCsvDups(dups)
    setCsvContacts(contacts)
    setCsvHeaders(extraHeaders)
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

  function messageValid(): string | null {
    if (!text.trim()) return 'Preencha o texto da mensagem.'
    return null
  }

  async function handleResetSent() {
    setResettingSent(true)
    try {
      const d = await onResetSent()
      alert(`Números já enviados limpos: ${d.cleared}. Campanhas futuras poderão reenviar para os mesmos contatos.`)
    } finally {
      setResettingSent(false)
    }
  }

  const recipientCount = getActiveContacts().length
  const previewContact = getActiveContacts()[0]
  const previewText = applyVarsPreview(text, previewContact, firstNameOnly)

  async function handleStart() {
    const contacts = getActiveContacts()
    if (!name.trim()) return alert('Digite o nome da campanha.')
    if (contacts.length === 0) return alert('Adicione pelo menos um número.')
    const msgErr = messageValid()
    if (msgErr) return alert(msgErr)
    if (selectedInstanceIds.length === 0) return alert('Selecione ao menos uma sessão SMS conectada.')

    setStarting(true)
    const result = await onStart({
      name: name.trim(),
      text,
      contacts,
      instanceIds: selectedInstanceIds,
      delayMin, delayMax,
      batchDelay,
      spinWithAI,
      firstNameOnly,
    })
    setStarting(false)
    if (!result.ok) return alert(result.error || 'Falha ao iniciar campanha.')
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <MessageSquare size={16} className="text-blue-400" /> Nova Campanha — SMS
            <span className="text-[9px] font-bold uppercase tracking-wide bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded">Beta</span>
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex border-b border-gray-800 px-5">
          {(['Destinatários', 'Mensagem', 'Sessões & Revisar'] as const).map((label, i) => (
            <button key={label} onClick={() => setStep(i + 1)}
              className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                step === i + 1 ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>
              {i + 1}. {label}
            </button>
          ))}
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {/* ── STEP 1: Destinatários ── */}
          {step === 1 && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Nome da campanha</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="ex: Campanha SMS Julho"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
              </div>

              <div className="flex gap-2 mb-3">
                <button onClick={() => setContactsTab('manual')}
                  className={`flex-1 py-2 text-xs rounded-lg font-medium ${contactsTab === 'manual' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Manual
                </button>
                <button onClick={() => setContactsTab('csv')}
                  className={`flex-1 py-2 text-xs rounded-lg font-medium ${contactsTab === 'csv' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Importar CSV
                </button>
              </div>

              {contactsTab === 'manual' ? (
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Números (um por linha — número,nome)</label>
                  <textarea value={contactsText} onChange={e => setContactsText(e.target.value)} rows={8}
                    placeholder={'5535998000000,João\n5535998000001,Maria'}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono resize-none" />
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="flex items-center justify-center gap-2 border-2 border-dashed border-gray-700 rounded-lg py-6 cursor-pointer hover:border-blue-500 transition-colors">
                    <Upload size={16} className="text-gray-500" />
                    <span className="text-sm text-gray-400">{csvFileName || 'Selecionar arquivo CSV'}</span>
                    <input type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} />
                  </label>
                  {csvAllHeaders.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5">Coluna do telefone</label>
                      <select value={csvPhoneColumn} onChange={e => handlePhoneColumnChange(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                        {csvAllHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  )}
                  {csvDups > 0 && (
                    <div className="flex items-center justify-between bg-yellow-900/20 border border-yellow-800/40 rounded-lg px-3 py-2">
                      <span className="text-xs text-yellow-300 flex items-center gap-1.5"><AlertCircle size={12} /> {csvDups} duplicado(s)</span>
                      <button onClick={removeDuplicates} className="text-xs text-yellow-400 hover:text-yellow-200 underline">Remover</button>
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
                </div>
              )}

              <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-800/50 rounded-lg px-3 py-2">
                <Users size={12} /> {recipientCount} destinatário(s) prontos
              </div>
            </>
          )}

          {/* ── STEP 2: Mensagem ── */}
          {step === 2 && (
            <>
              {(csvHeaders.length > 0 || contactsTab === 'csv') && (
                <div className="bg-indigo-950/40 border border-indigo-800/30 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] font-medium text-indigo-400">Variáveis disponíveis (da base importada):</p>
                  <div className="flex flex-wrap gap-1.5">
                    <code className="text-[11px] bg-gray-800 text-green-300 px-2 py-0.5 rounded">{'{{name}}'}</code>
                    {csvHeaders.map(h => (
                      <code key={h} className="text-[11px] bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">{`{{${h}}}`}</code>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Texto da mensagem (SMS puro — sem imagem/anexo)</label>
                <textarea value={text} onChange={e => setText(e.target.value)} rows={6}
                  placeholder={"Use {{name}} para nome, {{coluna}} para variáveis do CSV.\nEx: Olá {{name}}, temos uma oferta em {{cidade}}!"}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none" />
              </div>

              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                <input type="checkbox" checked={firstNameOnly}
                  onChange={e => setFirstNameOnly(e.target.checked)} className="rounded" />
                Usar apenas o primeiro nome em {'{{name}}'} <span className="text-gray-500">(ex: "João Silva" → "João")</span>
              </label>

              {previewText && (
                <div className="bg-gray-800 rounded-lg border border-gray-700 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                    <Eye size={11} /> Preview com {previewContact?.name || 'primeiro contato'}
                  </div>
                  <div className="bg-blue-900/20 border border-blue-800/30 rounded-lg px-3 py-2 text-xs text-blue-200 whitespace-pre-wrap leading-relaxed">
                    {previewText}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── STEP 3: Sessões & Revisar ── */}
          {step === 3 && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Sessões SMS conectadas</label>
                {connected.length === 0 ? (
                  <div className="flex items-center gap-2 text-yellow-400 text-xs bg-yellow-400/10 rounded-lg px-3 py-2">
                    <AlertCircle size={12} /> Nenhuma sessão conectada. Vá em Canais e conecte uma primeiro.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {connected.map(inst => (
                      <label key={inst.id} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={selectedInstanceIds.includes(inst.id)}
                          onChange={e => setSelectedInstanceIds(prev => e.target.checked ? [...prev, inst.id] : prev.filter(n => n !== inst.id))} />
                        <span className="text-sm text-white">{inst.label || inst.id}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Delay mínimo (s)</label>
                  <input type="number" min={1} value={delayMin} onChange={e => setDelayMin(Number(e.target.value))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Delay máximo (s)</label>
                  <input type="number" min={1} value={delayMax} onChange={e => setDelayMax(Number(e.target.value))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
              </div>

              <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                <label className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={batchDelay.enabled}
                    onChange={e => setBatchDelay(s => ({ ...s, enabled: e.target.checked }))}
                    className="rounded border-gray-600 bg-gray-900 text-blue-500 focus:ring-0" />
                  <span className="text-xs text-gray-300">☕ Pausa a cada lote de mensagens</span>
                </label>
                {batchDelay.enabled && (
                  <div className="border-t border-gray-700 px-3 pb-3 pt-2 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="text-gray-500 w-20 shrink-0">A cada</span>
                      <input type="number" min={1} value={batchDelay.everyMin}
                        onChange={e => setBatchDelay(s => ({ ...s, everyMin: +e.target.value }))}
                        className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-blue-500" />
                      <span className="text-gray-600">a</span>
                      <input type="number" min={1} value={batchDelay.everyMax}
                        onChange={e => setBatchDelay(s => ({ ...s, everyMax: +e.target.value }))}
                        className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-blue-500" />
                      <span className="text-gray-500">envios</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="text-gray-500 w-20 shrink-0">Pausar</span>
                      <input type="number" min={1} value={batchDelay.pauseMin}
                        onChange={e => setBatchDelay(s => ({ ...s, pauseMin: +e.target.value }))}
                        className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-blue-500" />
                      <span className="text-gray-600">a</span>
                      <input type="number" min={1} value={batchDelay.pauseMax}
                        onChange={e => setBatchDelay(s => ({ ...s, pauseMax: +e.target.value }))}
                        className="w-14 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-blue-500" />
                      <span className="text-gray-500">seg</span>
                    </div>
                    <p className="text-[11px] text-blue-400/70">
                      Ex: a cada {batchDelay.everyMin}–{batchDelay.everyMax} envios, pausa de {batchDelay.pauseMin}–{batchDelay.pauseMax}s para parecer mais humano.
                    </p>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                <input type="checkbox" checked={spinWithAI}
                  onChange={e => setSpinWithAI(e.target.checked)} className="rounded" />
                <Zap size={11} className="text-yellow-400" /> Randomizar início da mensagem com IA (GROQ_API_KEY ou OPENAI_API_KEY)
              </label>
              {spinWithAI && (
                <p className="text-[11px] text-gray-500 -mt-2 pl-5">
                  Muda só as primeiras palavras (cumprimento) a cada envio, pra reduzir a chance de detecção como spam. O resto do texto e as variáveis {'{{...}}'} continuam idênticos.
                </p>
              )}

              <div className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400 space-y-1">
                <p className="flex items-center gap-1.5"><FileText size={11} /> {recipientCount} destinatário(s)</p>
                <p className="flex items-center gap-1.5"><CheckCircle2 size={11} /> SMS puro (texto)</p>
              </div>

              <div className="bg-gray-800 rounded-lg border border-gray-700 p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <Eye size={11} /> Como vai chegar para o cliente {previewContact?.name ? `(ex: ${previewContact.name})` : ''}
                </div>
                <div className="max-w-xs mx-auto bg-gray-100 rounded-xl px-3 py-2.5">
                  <p className="text-sm text-gray-900 whitespace-pre-wrap leading-relaxed">
                    {previewText || <span className="text-gray-500">Escreva a mensagem no passo 2</span>}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                <p className="text-[11px] text-gray-500">Já enviou pra alguém e quer permitir reenvio nesta campanha?</p>
                <button onClick={handleResetSent} disabled={resettingSent}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg disabled:opacity-50">
                  {resettingSent ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Limpar enviados
                </button>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between p-5 border-t border-gray-800">
          <button onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white">
            {step > 1 ? '← Anterior' : 'Cancelar'}
          </button>
          {step < 3 ? (
            <button onClick={() => setStep(step + 1)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-sm text-white rounded-lg">
              Próximo →
            </button>
          ) : (
            <button onClick={handleStart} disabled={starting}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white rounded-lg">
              {starting ? <><Loader2 size={14} className="animate-spin" /> Iniciando...</> : <><Send size={14} /> Iniciar Campanha</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
