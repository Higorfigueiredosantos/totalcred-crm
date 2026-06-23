import { useState, useMemo } from 'react'
import { useStore } from '../store'
import type { Contact } from '../types'
import { Plus, Search, Trash2, Edit2, Phone, Tag, X, FileDown, Loader2 } from 'lucide-react'
import { v4 as uuid } from '../utils/uuid'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { exportChatToPDF, exportAllChatsToPDF } from '../utils/exportChat'

// Exibe o número limpo de um contato (sem @c.us / @g.us)
function cleanPhone(contact: Contact): string {
  if (contact.waNumber) return contact.waNumber
  return contact.phone.replace(/@.*$/, '')
}

function ContactModal({ contact, onClose, onSave }: { contact?: Contact; onClose: () => void; onSave: (c: Contact) => void }) {
  const { channels } = useStore()

  // Para edição mostra número limpo; para novo começa vazio
  const [form, setForm] = useState<Contact>(contact ?? {
    id: uuid(), name: '', phone: '', email: '', tags: [], channelId: channels[0]?.id ?? '', notes: '', createdAt: new Date().toISOString(),
  })
  // Campo de digitação do número exibe sempre o número limpo
  const [phoneInput, setPhoneInput] = useState(contact ? cleanPhone(contact) : '')
  const [tagInput, setTagInput] = useState('')
  const set = (k: keyof Contact, v: any) => setForm(f => ({ ...f, [k]: v }))

  function addTag() {
    const t = tagInput.trim()
    if (t && !form.tags.includes(t)) set('tags', [...form.tags, t])
    setTagInput('')
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">{contact ? 'Editar Contato' : 'Novo Contato'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Nome *</label>
            <input value={form.name} onChange={e => set('name', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="João Silva" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">WhatsApp *</label>
            <input value={phoneInput} onChange={e => setPhoneInput(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="5511999999999" />
            <p className="text-[10px] text-gray-600 mt-1">Somente números (ex: 5511999999999)</p>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Email</label>
            <input value={form.email} onChange={e => set('email', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="joao@empresa.com" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Canal</label>
            <select value={form.channelId} onChange={e => set('channelId', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
              {channels.map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Tags</label>
            <div className="flex gap-2">
              <input value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTag()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                placeholder="Adicionar tag..." />
              <button onClick={addTag} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white text-sm">+</button>
            </div>
            {form.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {form.tags.map(tag => (
                  <span key={tag} className="flex items-center gap-1 px-2 py-0.5 bg-indigo-900/50 text-indigo-300 rounded-full text-xs">
                    {tag}
                    <button onClick={() => set('tags', form.tags.filter(t => t !== tag))}><X size={10} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Notas</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
              placeholder="Observações sobre o contato..." />
          </div>
        </div>
        <div className="flex gap-2 p-5 border-t border-gray-800">
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={() => {
              if (!form.name || !phoneInput.trim()) return
              // Converte número digitado → ID de envio (@c.us) e número limpo (waNumber)
              const digits = phoneInput.trim().replace(/\D/g, '')
              const withCountry = digits.startsWith('55') ? digits : '55' + digits
              const sendId = withCountry + '@c.us'
              onSave({ ...form, phone: sendId, waNumber: digits })
            }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Contacts() {
  const { contacts, addContact, updateContact, removeContact, conversations, messages } = useStore()
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [modal, setModal] = useState<{ open: boolean; contact?: Contact }>({ open: false })
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; name: string } | null>(null)

  const allTags = useMemo(() => Array.from(new Set(contacts.flatMap(c => c.tags))), [contacts])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return contacts.filter(c =>
      (c.name.toLowerCase().includes(q) ||
       c.phone.includes(search) ||
       c.tags.some(t => t.toLowerCase().includes(q))) &&
      (!tagFilter || c.tags.includes(tagFilter))
    )
  }, [contacts, search, tagFilter])

  function handleSave(c: Contact) {
    if (contacts.find(x => x.id === c.id)) updateContact(c.id, c)
    else addContact(c)
    setModal({ open: false })
  }

  async function handleExportOne(contact: Contact) {
    const conv = conversations.find(cv => cv.contactId === contact.id)
    const msgs = conv ? messages.filter(m => m.conversationId === conv.id) : []
    setExportingId(contact.id)
    try { await exportChatToPDF(contact, msgs) }
    finally { setExportingId(null) }
  }

  async function handleExportAll() {
    setBulkProgress({ done: 0, total: 0, name: '' })
    try {
      await exportAllChatsToPDF(contacts, conversations, messages, (done, total, name) => {
        setBulkProgress({ done, total, name })
      })
    } finally { setBulkProgress(null) }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Contatos</h1>
          <p className="text-sm text-gray-400 mt-1">{contacts.length} contatos cadastrados</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportAll}
            disabled={!!bulkProgress}
            title="Exportar todas as conversas em PDF"
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-sm text-gray-300 hover:text-white rounded-lg transition-colors border border-gray-700"
          >
            {bulkProgress ? (
              <><Loader2 size={15} className="animate-spin" /> {bulkProgress.done}/{bulkProgress.total}</>
            ) : (
              <><FileDown size={15} /> Exportar conversas</>
            )}
          </button>
          <button onClick={() => setModal({ open: true })}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm text-white rounded-lg">
            <Plus size={16} /> Novo Contato
          </button>
        </div>

        {bulkProgress && bulkProgress.total > 0 && (
          <div className="mt-3 flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-xs text-gray-400">
            <Loader2 size={13} className="animate-spin text-indigo-400 shrink-0" />
            <div className="flex-1">
              <div className="flex justify-between mb-1">
                <span>Gerando PDFs... <span className="text-white">{bulkProgress.name}</span></span>
                <span className="text-gray-500">{bulkProgress.done}/{bulkProgress.total}</span>
              </div>
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all"
                  style={{ width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            placeholder="Buscar por nome, telefone ou etiqueta..." />
        </div>
        <select value={tagFilter} onChange={e => setTagFilter(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500">
          <option value="">Todas as tags</option>
          {allTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Nome</th>
              <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">WhatsApp</th>
              <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Tags</th>
              <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium">Cadastrado em</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-500">Nenhum contato encontrado</td></tr>
            ) : (
              filtered.map(contact => (
                <tr key={contact.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full bg-indigo-900 flex items-center justify-center text-xs font-medium text-indigo-300">
                        {contact.name[0]?.toUpperCase()}
                      </div>
                      <div>
                        <p className="text-white font-medium">{contact.name}</p>
                        {contact.email && <p className="text-xs text-gray-500">{contact.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-gray-300">
                      <Phone size={12} className="text-gray-500" />
                      {cleanPhone(contact)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags.map(tag => (
                        <span key={tag} className="flex items-center gap-1 px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full text-xs">
                          <Tag size={9} />{tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {format(new Date(contact.createdAt), 'dd/MM/yyyy', { locale: ptBR })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => handleExportOne(contact)}
                        disabled={exportingId === contact.id}
                        title="Exportar conversa como PDF"
                        className="p-1.5 text-gray-500 hover:text-indigo-400 hover:bg-gray-800 rounded disabled:opacity-40 transition-colors"
                      >
                        {exportingId === contact.id
                          ? <Loader2 size={13} className="animate-spin" />
                          : <FileDown size={13} />}
                      </button>
                      <button onClick={() => setModal({ open: true, contact })}
                        className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => removeContact(contact.id)}
                        className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal.open && (
        <ContactModal contact={modal.contact} onClose={() => setModal({ open: false })} onSave={handleSave} />
      )}
    </div>
  )
}
