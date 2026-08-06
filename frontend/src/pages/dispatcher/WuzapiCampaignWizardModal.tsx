import { useState } from 'react'
import {
  FlaskConical, Upload, X, AlertCircle, Users, Loader2,
  FileText, Send, Plus, Trash2, RefreshCw, CheckCircle2, Image as ImageIcon,
} from 'lucide-react'
import { useWuzapiInstances } from '../../hooks/useWuzapiInstances'
import type { CsvContact } from '../../types'
import { parseContacts, parseCsvRaw, buildContacts } from './chipCampaign'
import type { WuzapiCampaignConfig, WuzapiMessageType } from './wuzapiCampaign'

interface Props {
  onClose: () => void
  onStart: (config: WuzapiCampaignConfig) => Promise<{ ok: boolean; error?: string }>
  onResetSent: () => Promise<{ ok: boolean; cleared: number }>
}

const MESSAGE_TYPES: { value: WuzapiMessageType; label: string; hint: string }[] = [
  { value: 'buttons', label: 'Botões', hint: 'Até 3 botões de resposta rápida' },
  { value: 'link', label: 'Link no Botão', hint: 'Um botão que abre uma URL' },
  { value: 'imageButtons', label: 'Imagem + Botões', hint: 'Imagem com legenda e até 3 botões' },
  { value: 'imageLink', label: 'Imagem + Link', hint: 'Imagem com legenda e um botão de link' },
]

let uidCounter = 0
const uid = () => `id_${Date.now()}_${uidCounter++}`

// Wizard de campanha via Wuzapi (BETA) — comparar entrega de botões nativos
// (e variações com link/imagem) contra o Infinite/Baileys.
export default function WuzapiCampaignWizardModal({ onClose, onStart, onResetSent }: Props) {
  const [resettingSent, setResettingSent] = useState(false)
  const { instances } = useWuzapiInstances()
  const connected = instances.filter(i => i.status === 'connected')

  const [step, setStep] = useState(1)
  const [starting, setStarting] = useState(false)

  const [name, setName] = useState('')
  const [messageType, setMessageType] = useState<WuzapiMessageType>('buttons')
  const [text, setText] = useState('')
  const [footer, setFooter] = useState('')
  const [imageB64, setImageB64] = useState('')
  const [buttons, setButtons] = useState<{ id: string; text: string }[]>([{ id: 'opt1', text: '' }])
  const [linkButtonText, setLinkButtonText] = useState('Acessar')
  const [linkUrl, setLinkUrl] = useState('')

  const hasImage = messageType === 'imageButtons' || messageType === 'imageLink'
  const hasLink = messageType === 'link' || messageType === 'imageLink'

  const [contactsTab, setContactsTab] = useState<'manual' | 'csv'>('manual')
  const [contactsText, setContactsText] = useState('')
  const [csvContacts, setCsvContacts] = useState<CsvContact[]>([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvRawRows, setCsvRawRows] = useState<Record<string, string>[]>([])
  const [csvAllHeaders, setCsvAllHeaders] = useState<string[]>([])
  const [csvPhoneColumn, setCsvPhoneColumn] = useState('')
  const [csvDups, setCsvDups] = useState(0)

  const [selectedInstanceNames, setSelectedInstanceNames] = useState<string[]>([])
  const [delayMin, setDelayMin] = useState(5)
  const [delayMax, setDelayMax] = useState(15)

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
    const { contacts } = buildContacts(rawRows, allHeaders, phoneCol)
    const seen = new Set<string>()
    let dups = 0
    contacts.forEach(c => { if (seen.has(c.number)) dups++; else seen.add(c.number) })
    setCsvDups(dups)
    setCsvContacts(contacts)
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
    const { contacts } = buildContacts(newRaw, csvAllHeaders, csvPhoneColumn)
    setCsvContacts(contacts)
    setCsvDups(0)
  }

  function messageValid(): string | null {
    if (!text.trim()) return 'Preencha o texto da mensagem.'
    if (hasImage && !imageB64) return 'Adicione uma imagem.'
    if (hasLink) {
      if (!linkButtonText.trim() || !linkUrl.trim()) return 'Preencha o texto do botão e a URL do link.'
    } else if (buttons.filter(b => b.text.trim()).length === 0) {
      return 'Adicione ao menos um botão.'
    }
    return null
  }

  function buildPayload() {
    const base = { text, footer: footer || undefined, image: hasImage ? imageB64 : undefined }
    if (hasLink) {
      return { ...base, buttons: [{ id: 'link', text: linkButtonText, type: 'url' as const, url: linkUrl }] }
    }
    return { ...base, buttons: buttons.filter(b => b.text.trim()).map(b => ({ ...b, type: 'reply' as const })) }
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

  async function handleStart() {
    const contacts = getActiveContacts()
    if (!name.trim()) return alert('Digite o nome da campanha.')
    if (contacts.length === 0) return alert('Adicione pelo menos um número.')
    const msgErr = messageValid()
    if (msgErr) return alert(msgErr)
    if (selectedInstanceNames.length === 0) return alert('Selecione ao menos uma instância Wuzapi conectada.')

    setStarting(true)
    const result = await onStart({
      name: name.trim(),
      payload: buildPayload(),
      contacts,
      instanceNames: selectedInstanceNames,
      delayMin, delayMax,
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
            <FlaskConical size={16} className="text-orange-400" /> Nova Campanha — Wuzapi
            <span className="text-[9px] font-bold uppercase tracking-wide bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">Beta</span>
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex border-b border-gray-800 px-5">
          {(['Mensagem', 'Destinatários', 'Instâncias & Revisar'] as const).map((label, i) => (
            <button key={label} onClick={() => setStep(i + 1)}
              className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                step === i + 1 ? 'border-orange-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>
              {i + 1}. {label}
            </button>
          ))}
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {step === 1 && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Nome da campanha</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="ex: Teste botão Wuzapi"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Tipo de mensagem</label>
                <div className="grid grid-cols-2 gap-2">
                  {MESSAGE_TYPES.map(mt => (
                    <button key={mt.value} onClick={() => setMessageType(mt.value)}
                      className={`text-left p-2.5 rounded-lg border transition-colors ${
                        messageType === mt.value ? 'border-orange-500 bg-orange-900/20' : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                      }`}>
                      <p className="text-xs font-semibold text-white">{mt.label}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{mt.hint}</p>
                    </button>
                  ))}
                </div>
              </div>

              {hasImage && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Imagem</label>
                  {imageB64 ? (
                    <div className="relative inline-block">
                      <img src={imageB64} alt="preview" className="h-32 rounded-lg border border-gray-700" />
                      <button onClick={() => setImageB64('')}
                        className="absolute -top-2 -right-2 bg-red-600 hover:bg-red-500 text-white rounded-full p-1">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <label className="flex items-center justify-center gap-2 border-2 border-dashed border-gray-700 rounded-lg py-6 cursor-pointer hover:border-orange-500 transition-colors">
                      <ImageIcon size={16} className="text-gray-500" />
                      <span className="text-sm text-gray-400">Selecionar imagem</span>
                      <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
                    </label>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1.5">{hasImage ? 'Legenda' : 'Texto da mensagem'}</label>
                <textarea value={text} onChange={e => setText(e.target.value)} rows={hasImage ? 3 : 5}
                  placeholder="Digite a mensagem..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 resize-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Rodapé (opcional)</label>
                <input value={footer} onChange={e => setFooter(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
              </div>

              {hasLink ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5">Texto do botão</label>
                    <input value={linkButtonText} maxLength={20} onChange={e => setLinkButtonText(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5">URL</label>
                    <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
                      placeholder="https://..."
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Botões (até 3)</label>
                  <div className="space-y-2">
                    {buttons.map((btn, i) => (
                      <div key={btn.id} className="flex gap-2">
                        <input value={btn.text} maxLength={20}
                          onChange={e => setButtons(bs => bs.map(b => b.id === btn.id ? { ...b, text: e.target.value } : b))}
                          placeholder={`Botão ${i + 1} (máx. 20 caracteres)`}
                          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500" />
                        {buttons.length > 1 && (
                          <button onClick={() => setButtons(bs => bs.filter(b => b.id !== btn.id))}
                            className="p-2 text-red-400 hover:bg-gray-800 rounded-lg"><Trash2 size={14} /></button>
                        )}
                      </div>
                    ))}
                    {buttons.length < 3 && (
                      <button onClick={() => setButtons(bs => [...bs, { id: uid(), text: '' }])}
                        className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300">
                        <Plus size={12} /> Adicionar botão
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex gap-2 mb-3">
                <button onClick={() => setContactsTab('manual')}
                  className={`flex-1 py-2 text-xs rounded-lg font-medium ${contactsTab === 'manual' ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Manual
                </button>
                <button onClick={() => setContactsTab('csv')}
                  className={`flex-1 py-2 text-xs rounded-lg font-medium ${contactsTab === 'csv' ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  Importar CSV
                </button>
              </div>

              {contactsTab === 'manual' ? (
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Números (um por linha — número,nome)</label>
                  <textarea value={contactsText} onChange={e => setContactsText(e.target.value)} rows={8}
                    placeholder={'5535998000000,João\n5535998000001,Maria'}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 font-mono resize-none" />
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="flex items-center justify-center gap-2 border-2 border-dashed border-gray-700 rounded-lg py-6 cursor-pointer hover:border-orange-500 transition-colors">
                    <Upload size={16} className="text-gray-500" />
                    <span className="text-sm text-gray-400">{csvFileName || 'Selecionar arquivo CSV'}</span>
                    <input type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} />
                  </label>
                  {csvAllHeaders.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5">Coluna do telefone</label>
                      <select value={csvPhoneColumn} onChange={e => handlePhoneColumnChange(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
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
                </div>
              )}

              <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-800/50 rounded-lg px-3 py-2">
                <Users size={12} /> {recipientCount} destinatário(s) prontos
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">Instâncias Wuzapi conectadas</label>
                {connected.length === 0 ? (
                  <div className="flex items-center gap-2 text-yellow-400 text-xs bg-yellow-400/10 rounded-lg px-3 py-2">
                    <AlertCircle size={12} /> Nenhuma instância conectada. Vá em Canais e conecte uma primeiro.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {connected.map(inst => (
                      <label key={inst.name} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={selectedInstanceNames.includes(inst.name)}
                          onChange={e => setSelectedInstanceNames(prev => e.target.checked ? [...prev, inst.name] : prev.filter(n => n !== inst.name))} />
                        <span className="text-sm text-white">{inst.label || inst.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Delay mínimo (s)</label>
                  <input type="number" min={1} value={delayMin} onChange={e => setDelayMin(Number(e.target.value))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Delay máximo (s)</label>
                  <input type="number" min={1} value={delayMax} onChange={e => setDelayMax(Number(e.target.value))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
                </div>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400 space-y-1">
                <p className="flex items-center gap-1.5"><FileText size={11} /> {recipientCount} destinatário(s)</p>
                <p className="flex items-center gap-1.5"><CheckCircle2 size={11} /> Mensagem: {MESSAGE_TYPES.find(m => m.value === messageType)?.label}</p>
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
              className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-sm text-white rounded-lg">
              Próximo →
            </button>
          ) : (
            <button onClick={handleStart} disabled={starting}
              className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-sm text-white rounded-lg">
              {starting ? <><Loader2 size={14} className="animate-spin" /> Iniciando...</> : <><Send size={14} /> Iniciar Campanha</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
