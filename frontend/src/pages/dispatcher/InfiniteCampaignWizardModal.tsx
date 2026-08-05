import { useState, useMemo } from 'react'
import {
  Zap, Upload, X, AlertCircle, Users, Loader2,
  FileText, Send, Plus, Trash2, RefreshCw,
} from 'lucide-react'
import { useInfiniteInstances } from '../../hooks/useInfiniteInstances'
import type { CsvContact, InfiniteMessageType } from '../../types'
import { parseContacts, parseCsvRaw, buildContacts } from './chipCampaign'
import type { InfiniteCampaignConfig } from './infiniteCampaign'

interface Props {
  onClose: () => void
  onStart: (config: InfiniteCampaignConfig) => Promise<{ ok: boolean; error?: string }>
  onResetSent: () => Promise<{ ok: boolean; cleared: number }>
}

const MESSAGE_TYPES: { value: InfiniteMessageType; label: string; hint: string }[] = [
  { value: 'buttons', label: 'Botões', hint: 'Até 3 botões de resposta rápida' },
  { value: 'imageButtons', label: 'Imagem + Botões', hint: 'Imagem com legenda e até 3 botões abaixo' },
  { value: 'imageLink', label: 'Imagem + Link', hint: 'Imagem com descrição e um botão de link (CTA)' },
  { value: 'interactive', label: 'CTA', hint: 'Botões de URL, copiar ou ligar' },
  { value: 'list', label: 'Lista', hint: 'Lista dropdown com seções' },
  { value: 'poll', label: 'Enquete', hint: 'Enquete com opções' },
  { value: 'carousel', label: 'Carrossel', hint: 'Cards com imagem e botões' },
  { value: 'menu', label: 'Menu', hint: 'Menu numerado em texto puro' },
]

type CtaButton = { type: 'url' | 'copy' | 'call'; text: string; url?: string; copyCode?: string; phoneNumber?: string }
type ListRow = { id: string; title: string; description?: string }
type ListSection = { title: string; rows: ListRow[] }
type CarouselCard = { title?: string; body?: string; footer?: string; imageUrl?: string; buttons: { id: string; text: string }[] }

let uidCounter = 0
const uid = () => `id_${Date.now()}_${uidCounter++}`

export default function InfiniteCampaignWizardModal({ onClose, onStart, onResetSent }: Props) {
  const [resettingSent, setResettingSent] = useState(false)
  const { instances } = useInfiniteInstances()
  const connected = instances.filter(i => i.status === 'connected')

  const [step, setStep] = useState(1)
  const [starting, setStarting] = useState(false)

  const [name, setName] = useState('')
  const [messageType, setMessageType] = useState<InfiniteMessageType>('buttons')

  // Campos comuns
  const [text, setText] = useState('')
  const [footer, setFooter] = useState('')
  const [title, setTitle] = useState('')

  // Botões (quick reply) / Imagem + Botões
  const [buttons, setButtons] = useState<{ id: string; text: string }[]>([{ id: 'opt1', text: '' }])
  const [imageB64, setImageB64] = useState('')

  // Imagem + Link (um único botão CTA de URL)
  const [linkButtonText, setLinkButtonText] = useState('Acessar')
  const [linkUrl, setLinkUrl] = useState('')

  // CTA
  const [ctaButtons, setCtaButtons] = useState<CtaButton[]>([{ type: 'url', text: '', url: '' }])

  // Lista
  const [buttonText, setButtonText] = useState('Ver opções')
  const [sections, setSections] = useState<ListSection[]>([{ title: 'Opções', rows: [{ id: 'row1', title: '', description: '' }] }])

  // Enquete
  const [pollName, setPollName] = useState('')
  const [pollOptions, setPollOptions] = useState<string[]>(['', ''])
  const [selectableCount, setSelectableCount] = useState(1)

  // Menu
  const [menuOptions, setMenuOptions] = useState<string[]>([''])

  // Carrossel
  const [cards, setCards] = useState<CarouselCard[]>([{ title: '', body: '', imageUrl: '', buttons: [] }])

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

  const payload = useMemo(() => {
    switch (messageType) {
      case 'menu':
        return { title: title || undefined, text: text || undefined, options: menuOptions.filter(Boolean), footer: footer || undefined }
      case 'buttons':
        return { text, footer: footer || undefined, buttons: buttons.filter(b => b.text.trim()) }
      case 'imageButtons':
        return { image: imageB64, caption: text || undefined, footer: footer || undefined, buttons: buttons.filter(b => b.text.trim()) }
      case 'imageLink':
        return { image: imageB64, caption: text || undefined, footer: footer || undefined, buttons: [{ type: 'url', text: linkButtonText, url: linkUrl }] }
      case 'interactive':
        return { text, footer: footer || undefined, buttons: ctaButtons.filter(b => b.text.trim()) }
      case 'list':
        return { text, footer: footer || undefined, buttonText, sections }
      case 'poll':
        return { name: pollName, options: pollOptions.filter(Boolean), selectableCount }
      case 'carousel':
        return { text: text || undefined, footer: footer || undefined, cards }
      default:
        return {}
    }
  }, [messageType, title, text, footer, menuOptions, buttons, imageB64, linkButtonText, linkUrl, ctaButtons, buttonText, sections, pollName, pollOptions, selectableCount, cards])

  function messageValid(): string | null {
    if (messageType === 'menu' && menuOptions.filter(Boolean).length === 0) return 'Adicione ao menos uma opção do menu.'
    if (messageType === 'buttons' && (!text.trim() || buttons.filter(b => b.text.trim()).length === 0)) return 'Preencha o texto e ao menos um botão.'
    if (messageType === 'imageButtons' && (!imageB64 || buttons.filter(b => b.text.trim()).length === 0)) return 'Adicione uma imagem e ao menos um botão.'
    if (messageType === 'imageLink' && (!imageB64 || !linkButtonText.trim() || !linkUrl.trim())) return 'Adicione uma imagem, o texto do botão e a URL do link.'
    if (messageType === 'interactive' && (!text.trim() || ctaButtons.filter(b => b.text.trim()).length === 0)) return 'Preencha o texto e ao menos um botão CTA.'
    if (messageType === 'list' && (!text.trim() || !buttonText.trim() || sections.every(s => s.rows.filter(r => r.title.trim()).length === 0))) return 'Preencha o texto, o texto do botão e ao menos um item de lista.'
    if (messageType === 'poll' && (!pollName.trim() || pollOptions.filter(Boolean).length < 2)) return 'Preencha o nome da enquete e ao menos 2 opções.'
    if (messageType === 'carousel' && cards.filter(c => c.title?.trim() || c.body?.trim()).length === 0) return 'Adicione ao menos um card com título ou texto.'
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

  async function handleStart() {
    const contacts = getActiveContacts()
    if (!name.trim()) return alert('Digite o nome da campanha.')
    if (contacts.length === 0) return alert('Adicione pelo menos um número.')
    const msgErr = messageValid()
    if (msgErr) return alert(msgErr)
    if (selectedInstanceNames.length === 0) return alert('Selecione ao menos uma instância Infinite conectada.')

    setStarting(true)
    const result = await onStart({
      name: name.trim(), messageType, payload, contacts,
      instanceNames: selectedInstanceNames, delayMin, delayMax,
    })
    setStarting(false)

    if (!result.ok) { alert(result.error); return }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-white">Nova Campanha</h2>
            <span className="text-xs px-2 py-0.5 bg-yellow-900/40 text-yellow-300 rounded-full">Via Infinite</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="flex p-3 gap-1 border-b border-gray-800">
          {['Tipo & Mensagem', 'Destinatários', 'Instâncias & Revisar'].map((label, i) => (
            <button key={i} onClick={() => setStep(i + 1)}
              className={`flex-1 py-1.5 text-xs rounded-lg font-medium ${step === i + 1 ? 'bg-yellow-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {i + 1}. {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">

          {/* ── STEP 1: Tipo & Mensagem ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Nome da Campanha *</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500"
                  placeholder="Ex: Promoção Junho 2026" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Tipo de mensagem</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {MESSAGE_TYPES.map(t => (
                    <button key={t.value} type="button" onClick={() => setMessageType(t.value)}
                      title={t.hint}
                      className={`px-2 py-2 text-xs rounded-lg font-medium transition-colors ${messageType === t.value ? 'bg-yellow-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">{MESSAGE_TYPES.find(t => t.value === messageType)?.hint}</p>
              </div>

              <p className="text-[11px] text-gray-500 -mb-2">Use {'{{name}}'} para o nome do contato nos campos de texto.</p>

              {/* Menu */}
              {messageType === 'menu' && (
                <div className="space-y-3">
                  <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Título (opcional)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500" />
                  <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="Texto de introdução (opcional)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-yellow-500" />
                  <ListEditor items={menuOptions} onChange={setMenuOptions} placeholder="Opção do menu" />
                  <input value={footer} onChange={e => setFooter(e.target.value)} placeholder="Rodapé (opcional)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500" />
                </div>
              )}

              {/* Botões / Imagem+Botões / Imagem+Link / CTA / Carrossel usam texto (legenda no caso da imagem) */}
              {(messageType === 'buttons' || messageType === 'imageButtons' || messageType === 'imageLink' || messageType === 'interactive' || messageType === 'carousel') && (
                <textarea value={text} onChange={e => setText(e.target.value)} rows={8}
                  placeholder={messageType === 'carousel' ? 'Texto de introdução (opcional)' : (messageType === 'imageButtons' || messageType === 'imageLink') ? 'Legenda/descrição da imagem (opcional)' : 'Texto da mensagem *'}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white resize-y focus:outline-none focus:border-yellow-500" />
              )}

              {(messageType === 'imageButtons' || messageType === 'imageLink') && (
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">Imagem *</label>
                  {imageB64 ? (
                    <div className="flex items-center gap-2">
                      <img src={imageB64} alt="" className="w-16 h-16 object-cover rounded" />
                      <button onClick={() => setImageB64('')} className="text-red-400 hover:text-red-300"><X size={14} /></button>
                    </div>
                  ) : (
                    <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer hover:text-gray-200">
                      <Upload size={11} /> Carregar imagem
                      <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
                    </label>
                  )}
                </div>
              )}

              {messageType === 'imageLink' && (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-400">Botão de link (CTA)</label>
                  <div className="flex gap-2">
                    <input value={linkButtonText} onChange={e => setLinkButtonText(e.target.value)}
                      placeholder="Texto do botão (ex: Acessar)"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-yellow-500" />
                    <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
                      placeholder="https://..."
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-yellow-500" />
                  </div>
                </div>
              )}

              {(messageType === 'buttons' || messageType === 'imageButtons') && (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-400">Botões (até 3)</label>
                  {buttons.map((b, i) => (
                    <div key={b.id} className="flex gap-2">
                      <input value={b.text} onChange={e => setButtons(prev => prev.map((x, xi) => xi === i ? { ...x, text: e.target.value } : x))}
                        placeholder={`Botão ${i + 1}`}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-yellow-500" />
                      <button onClick={() => setButtons(prev => prev.filter((_, xi) => xi !== i))} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
                    </div>
                  ))}
                  {buttons.length < 3 && (
                    <button type="button" onClick={() => setButtons(prev => [...prev, { id: `opt${prev.length + 1}`, text: '' }])}
                      className="text-[11px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1"><Plus size={11} /> Adicionar botão</button>
                  )}
                </div>
              )}

              {messageType === 'interactive' && (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-gray-400">Botões CTA</label>
                  {ctaButtons.map((b, i) => (
                    <div key={i} className="bg-gray-800 border border-gray-700 rounded-lg p-2.5 space-y-1.5">
                      <div className="flex gap-2">
                        <select value={b.type} onChange={e => setCtaButtons(prev => prev.map((x, xi) => xi === i ? { ...x, type: e.target.value as CtaButton['type'] } : x))}
                          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white">
                          <option value="url">URL</option>
                          <option value="copy">Copiar</option>
                          <option value="call">Ligar</option>
                        </select>
                        <input value={b.text} onChange={e => setCtaButtons(prev => prev.map((x, xi) => xi === i ? { ...x, text: e.target.value } : x))}
                          placeholder="Texto do botão"
                          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                        <button onClick={() => setCtaButtons(prev => prev.filter((_, xi) => xi !== i))} className="text-gray-500 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                      {b.type === 'url' && (
                        <input value={b.url || ''} onChange={e => setCtaButtons(prev => prev.map((x, xi) => xi === i ? { ...x, url: e.target.value } : x))}
                          placeholder="https://..."
                          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                      )}
                      {b.type === 'copy' && (
                        <input value={b.copyCode || ''} onChange={e => setCtaButtons(prev => prev.map((x, xi) => xi === i ? { ...x, copyCode: e.target.value } : x))}
                          placeholder="Código a copiar"
                          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                      )}
                      {b.type === 'call' && (
                        <input value={b.phoneNumber || ''} onChange={e => setCtaButtons(prev => prev.map((x, xi) => xi === i ? { ...x, phoneNumber: e.target.value } : x))}
                          placeholder="5511999999999"
                          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setCtaButtons(prev => [...prev, { type: 'url', text: '', url: '' }])}
                    className="text-[11px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1"><Plus size={11} /> Adicionar botão</button>
                </div>
              )}

              {messageType === 'list' && (
                <div className="space-y-3">
                  <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="Texto da mensagem *"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-yellow-500" />
                  <input value={buttonText} onChange={e => setButtonText(e.target.value)} placeholder="Texto do botão que abre a lista"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500" />
                  {sections.map((sec, si) => (
                    <div key={si} className="bg-gray-800 border border-gray-700 rounded-lg p-2.5 space-y-2">
                      <div className="flex gap-2">
                        <input value={sec.title} onChange={e => setSections(prev => prev.map((s, xi) => xi === si ? { ...s, title: e.target.value } : s))}
                          placeholder="Título da seção"
                          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                        {sections.length > 1 && (
                          <button onClick={() => setSections(prev => prev.filter((_, xi) => xi !== si))} className="text-gray-500 hover:text-red-400"><Trash2 size={13} /></button>
                        )}
                      </div>
                      {sec.rows.map((row, ri) => (
                        <div key={row.id} className="flex gap-2 pl-3">
                          <input value={row.title} onChange={e => setSections(prev => prev.map((s, xi) => xi === si ? { ...s, rows: s.rows.map((r, rxi) => rxi === ri ? { ...r, title: e.target.value } : r) } : s))}
                            placeholder="Item"
                            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                          <input value={row.description || ''} onChange={e => setSections(prev => prev.map((s, xi) => xi === si ? { ...s, rows: s.rows.map((r, rxi) => rxi === ri ? { ...r, description: e.target.value } : r) } : s))}
                            placeholder="Descrição (opcional)"
                            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                          <button onClick={() => setSections(prev => prev.map((s, xi) => xi === si ? { ...s, rows: s.rows.filter((_, rxi) => rxi !== ri) } : s))}
                            className="text-gray-500 hover:text-red-400"><Trash2 size={12} /></button>
                        </div>
                      ))}
                      <button type="button"
                        onClick={() => setSections(prev => prev.map((s, xi) => xi === si ? { ...s, rows: [...s.rows, { id: uid(), title: '', description: '' }] } : s))}
                        className="text-[11px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1 pl-3"><Plus size={11} /> Adicionar item</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setSections(prev => [...prev, { title: '', rows: [{ id: uid(), title: '', description: '' }] }])}
                    className="text-[11px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1"><Plus size={11} /> Adicionar seção</button>
                  <input value={footer} onChange={e => setFooter(e.target.value)} placeholder="Rodapé (opcional)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500" />
                </div>
              )}

              {messageType === 'poll' && (
                <div className="space-y-3">
                  <input value={pollName} onChange={e => setPollName(e.target.value)} placeholder="Pergunta da enquete *"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500" />
                  <ListEditor items={pollOptions} onChange={setPollOptions} placeholder="Opção da enquete" min={2} />
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span>Máximo de opções selecionáveis:</span>
                    <input type="number" min={1} value={selectableCount} onChange={e => setSelectableCount(+e.target.value)}
                      className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-white focus:outline-none focus:border-yellow-500" />
                  </div>
                </div>
              )}

              {messageType === 'carousel' && (
                <div className="space-y-3">
                  {cards.map((card, ci) => (
                    <div key={ci} className="bg-gray-800 border border-gray-700 rounded-lg p-2.5 space-y-1.5">
                      <div className="flex gap-2">
                        <input value={card.title || ''} onChange={e => setCards(prev => prev.map((c, xi) => xi === ci ? { ...c, title: e.target.value } : c))}
                          placeholder={`Título do card ${ci + 1}`}
                          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                        {cards.length > 1 && (
                          <button onClick={() => setCards(prev => prev.filter((_, xi) => xi !== ci))} className="text-gray-500 hover:text-red-400"><Trash2 size={13} /></button>
                        )}
                      </div>
                      <input value={card.body || ''} onChange={e => setCards(prev => prev.map((c, xi) => xi === ci ? { ...c, body: e.target.value } : c))}
                        placeholder="Texto do card"
                        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                      <input value={card.imageUrl || ''} onChange={e => setCards(prev => prev.map((c, xi) => xi === ci ? { ...c, imageUrl: e.target.value } : c))}
                        placeholder="URL da imagem (opcional)"
                        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-yellow-500" />
                    </div>
                  ))}
                  <button type="button" onClick={() => setCards(prev => [...prev, { title: '', body: '', imageUrl: '', buttons: [] }])}
                    className="text-[11px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1"><Plus size={11} /> Adicionar card</button>
                  <input value={footer} onChange={e => setFooter(e.target.value)} placeholder="Rodapé (opcional)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500" />
                </div>
              )}
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
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono resize-none focus:outline-none focus:border-yellow-500" />
                  <p className="text-xs text-gray-500 mt-1">{parseContacts(contactsText).length} contato(s) · formato: número,nome</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className={`flex items-center gap-3 border rounded-xl px-4 py-3 cursor-pointer transition-colors ${csvContacts.length > 0 ? 'border-yellow-700/50 bg-yellow-900/10 hover:bg-yellow-900/20' : 'border-dashed border-gray-700 bg-gray-800 hover:border-gray-500'}`}>
                    <Upload size={18} className={csvContacts.length > 0 ? 'text-yellow-400 shrink-0' : 'text-gray-500 shrink-0'} />
                    <div className="flex-1 min-w-0">
                      {csvContacts.length > 0 ? (
                        <>
                          <p className="text-xs font-medium text-yellow-300 truncate">{csvFileName}</p>
                          <p className="text-[11px] text-yellow-600 mt-0.5">{csvContacts.length} contatos · clique para trocar</p>
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
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-yellow-500">
                        {csvAllHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  )}

                  {csvContacts.length > 0 && (
                    <div className="rounded-xl border border-gray-700 bg-gray-800 overflow-hidden">
                      <div className="flex items-center gap-3 px-3 py-2.5">
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
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-800">
                            {csvContacts.slice(0, 5).map((c, i) => (
                              <tr key={i} className="hover:bg-gray-800/30">
                                <td className="px-3 py-1.5 font-mono text-gray-300">{c.number}</td>
                                <td className="px-3 py-1.5 text-gray-400">{c.name || '—'}</td>
                              </tr>
                            ))}
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

          {/* ── STEP 3: Instâncias & Revisar ── */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-400">Instâncias para disparo *</label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setSelectedInstanceNames(connected.map(i => i.name))} className="text-[11px] text-yellow-400 hover:text-yellow-300">Todas</button>
                    <button type="button" onClick={() => setSelectedInstanceNames([])} className="text-[11px] text-red-400 hover:text-red-300">Nenhuma</button>
                  </div>
                </div>
                <div className="bg-gray-800 rounded-lg border border-gray-700 divide-y divide-gray-700">
                  {connected.length === 0 ? (
                    <p className="px-3 py-2.5 text-xs text-red-400">Nenhuma instância Infinite conectada</p>
                  ) : connected.map(inst => {
                    const checked = selectedInstanceNames.includes(inst.name)
                    return (
                      <label key={inst.name} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none hover:bg-gray-700/40">
                        <input type="checkbox" checked={checked}
                          onChange={() => setSelectedInstanceNames(prev => prev.includes(inst.name) ? prev.filter(n => n !== inst.name) : [...prev, inst.name])}
                          className="rounded border-gray-600 bg-gray-900 text-yellow-500 focus:ring-0 focus:ring-offset-0" />
                        <Zap size={11} className="text-yellow-400 shrink-0" />
                        <span className="text-xs text-gray-300 flex-1">{inst.label || inst.name}</span>
                      </label>
                    )
                  })}
                </div>
                {selectedInstanceNames.length > 1 && (
                  <p className="text-[11px] text-yellow-400/70">Rotação (round-robin) entre {selectedInstanceNames.length} instâncias.</p>
                )}
              </div>

              <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-3 flex items-center justify-between gap-3">
                <div className="text-[11px] text-yellow-200/90">
                  <p className="font-medium">Testando com o mesmo número várias vezes?</p>
                  <p className="text-yellow-300/70 mt-0.5">Depois do 1º envio bem-sucedido a um número, campanhas seguintes pulam esse número automaticamente (sem enviar, sem erro).</p>
                </div>
                <button type="button" onClick={handleResetSent} disabled={resettingSent}
                  className="flex items-center gap-1.5 px-3 py-2 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-white text-xs rounded-lg shrink-0 whitespace-nowrap">
                  {resettingSent ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  Limpar já enviados
                </button>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-400">Delay entre envios (segundos)</label>
                <div className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="number" min={1} value={delayMin} onChange={e => setDelayMin(+e.target.value)}
                    className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center focus:outline-none focus:border-yellow-500" />
                  <span className="text-gray-500">até</span>
                  <input type="number" min={1} value={delayMax} onChange={e => setDelayMax(+e.target.value)}
                    className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center focus:outline-none focus:border-yellow-500" />
                  <span className="text-gray-500">seg</span>
                </div>
              </div>

              {recipientCount > 0 && (
                <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-400 flex gap-2">
                  <AlertCircle size={13} className="shrink-0 mt-0.5 text-gray-500" />
                  <span>
                    <strong className="text-white">{recipientCount}</strong> destinatários · Delay:{' '}
                    <strong className="text-white">{delayMin}s</strong> a <strong className="text-white">{delayMax}s</strong>
                  </span>
                </div>
              )}

              <div className="bg-gray-800 rounded-xl p-4 space-y-3 text-sm">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">Resumo</p>
                {[
                  ['Nome', name || '—'],
                  ['Tipo', MESSAGE_TYPES.find(t => t.value === messageType)?.label || '—'],
                  ['Instâncias', selectedInstanceNames.length > 0 ? `${selectedInstanceNames.length} em rotação` : '—'],
                  ['Destinatários', `${recipientCount} contato(s)`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-gray-400">{k}</span><span className="text-white text-right max-w-xs">{v}</span></div>
                ))}
              </div>

              <div className="bg-yellow-900/10 border border-yellow-800/30 rounded-lg p-3 text-[11px] text-yellow-300/80 flex gap-2">
                <AlertCircle size={13} className="shrink-0 mt-0.5" />
                Instâncias Infinite não recebem confirmação de entrega/leitura — o relatório mostra apenas enviado/falhou.
              </div>

              {messageType !== 'menu' && (
                <div className="bg-orange-900/10 border border-orange-800/30 rounded-lg p-3 text-[11px] text-orange-300/80 flex gap-2">
                  <AlertCircle size={13} className="shrink-0 mt-0.5" />
                  Botões, CTA, lista, enquete e carrossel usam um formato marcado como experimental pelo próprio Baileys
                  (fora da Cloud API oficial) — risco de banimento do número conectado, avisado pela própria lib. Testes
                  confirmam que a entrega também é inconsistente: funciona para alguns contatos e falha silenciosamente
                  para outros, sem padrão previsível. O tipo "Menu" (texto puro) é o único com entrega confiável.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 p-5 border-t border-gray-800">
          {step > 1 && <button onClick={() => setStep(s => s - 1)} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 rounded-lg">← Anterior</button>}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          {step < 3
            ? <button onClick={() => setStep(s => s + 1)} className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-sm text-white rounded-lg">Próximo →</button>
            : <button onClick={handleStart} disabled={starting}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-sm text-white rounded-lg">
                {starting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Iniciar Campanha
              </button>}
        </div>
      </div>
    </div>
  )
}

function ListEditor({ items, onChange, placeholder, min = 1 }: { items: string[]; onChange: (v: string[]) => void; placeholder: string; min?: number }) {
  return (
    <div className="space-y-1.5">
      {items.map((v, i) => (
        <div key={i} className="flex gap-2">
          <input value={v} onChange={e => onChange(items.map((x, xi) => xi === i ? e.target.value : x))}
            placeholder={`${placeholder} ${i + 1}`}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-yellow-500" />
          {items.length > min && (
            <button onClick={() => onChange(items.filter((_, xi) => xi !== i))} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, ''])}
        className="text-[11px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1"><Plus size={11} /> Adicionar</button>
    </div>
  )
}
