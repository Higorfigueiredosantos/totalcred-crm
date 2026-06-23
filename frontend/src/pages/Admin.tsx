import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, X, Shield, User, Smartphone, Radio } from 'lucide-react'
import { useAuthStore, type AuthUser, type UserPermissions } from '../store/auth'
import { useStore } from '../store'

interface ChipInfo { id: string; number: string | null; status: string }

interface UserForm {
  name: string
  email: string
  password: string
  permissions: UserPermissions
}

const emptyForm = (): UserForm => ({
  name: '',
  email: '',
  password: '',
  permissions: { dispatcher: false, chipsPage: false, settings: false, channelIds: [], chipIds: [] },
})

export default function Admin() {
  const { token } = useAuthStore()
  const channels = useStore(s => s.channels)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [chips, setChips] = useState<ChipInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<{ open: boolean; editing: AuthUser | null }>({ open: false, editing: null })
  const [form, setForm] = useState<UserForm>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  async function load() {
    setLoading(true)
    try {
      const [usersRes, chipsRes] = await Promise.all([
        fetch('/api/users', { headers }),
        fetch('/api/chips'),
      ])
      if (usersRes.ok) setUsers(await usersRes.json())
      if (chipsRes.ok) {
        const list: ChipInfo[] = await chipsRes.json()
        setChips(list.filter(c => c.status !== 'disconnected' || c.number))
      }
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function openCreate() {
    setForm(emptyForm())
    setError('')
    setModal({ open: true, editing: null })
  }

  function openEdit(user: AuthUser) {
    setForm({
      name: user.name,
      email: user.email,
      password: '',
      permissions: {
        dispatcher: user.permissions.dispatcher ?? false,
        chipsPage: user.permissions.chipsPage ?? false,
        settings: user.permissions.settings ?? false,
        channelIds: user.permissions.channelIds ?? [],
        chipIds: user.permissions.chipIds ?? [],
      },
    })
    setError('')
    setModal({ open: true, editing: user })
  }

  async function handleSave() {
    if (!form.name || !form.email) return setError('Nome e email são obrigatórios')
    if (!modal.editing && !form.password) return setError('Senha obrigatória para novo usuário')
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = { name: form.name, email: form.email, permissions: form.permissions }
      if (form.password) body.password = form.password
      const url = modal.editing ? `/api/users/${modal.editing.id}` : '/api/users'
      const method = modal.editing ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) return setError(data.error || 'Erro ao salvar')
      setModal({ open: false, editing: null })
      load()
    } finally { setSaving(false) }
  }

  async function handleDelete(user: AuthUser) {
    if (!confirm(`Excluir usuário ${user.name}?`)) return
    await fetch(`/api/users/${user.id}`, { method: 'DELETE', headers })
    load()
  }

  function toggleId(field: 'channelIds' | 'chipIds', id: string) {
    setForm(f => {
      const arr = f.permissions[field]
      const next = arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]
      return { ...f, permissions: { ...f.permissions, [field]: next } }
    })
  }

  function toggleBool(field: 'dispatcher' | 'chipsPage' | 'settings') {
    setForm(f => ({ ...f, permissions: { ...f.permissions, [field]: !f.permissions[field] } }))
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Shield size={20} className="text-green-400" /> Painel Administrativo
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">Gerencie usuários e permissões de acesso</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 bg-green-500 hover:bg-green-400 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
          <Plus size={15} /> Novo Usuário
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Carregando...</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Usuário</th>
                <th className="text-left px-4 py-3">Função</th>
                <th className="text-left px-4 py-3">Permissões</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                        <User size={14} className="text-gray-300" />
                      </div>
                      <div>
                        <p className="text-white font-medium">{user.name}</p>
                        <p className="text-gray-500 text-xs">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${user.role === 'admin' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-300'}`}>
                      {user.role === 'admin' ? 'Admin' : 'Usuário'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {user.role === 'admin' ? (
                      <span className="text-xs text-gray-400">Acesso total</span>
                    ) : (
                      <div className="flex gap-1 flex-wrap">
                        {user.permissions.dispatcher && <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">Disparador</span>}
                        {user.permissions.chipsPage && <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">Chips</span>}
                        {user.permissions.settings && <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">Config</span>}
                        {(user.permissions.channelIds?.length ?? 0) > 0 && <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded">{user.permissions.channelIds.length} canal(is)</span>}
                        {(user.permissions.chipIds?.length ?? 0) > 0 && <span className="text-xs bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded">{user.permissions.chipIds.length} chip(s)</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => openEdit(user)} className="text-gray-400 hover:text-white p-1.5 rounded hover:bg-gray-700 transition-colors"><Pencil size={14} /></button>
                      {user.role !== 'admin' && (
                        <button onClick={() => handleDelete(user)} className="text-gray-400 hover:text-red-400 p-1.5 rounded hover:bg-gray-700 transition-colors"><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal.open && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-800">
              <h2 className="text-white font-semibold">{modal.editing ? 'Editar Usuário' : 'Novo Usuário'}</h2>
              <button onClick={() => setModal({ open: false, editing: null })} className="text-gray-400 hover:text-white"><X size={18} /></button>
            </div>

            <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto">
              {/* Dados */}
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1.5">Nome</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                    placeholder="Nome completo" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1.5">Email</label>
                  <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                    placeholder="email@exemplo.com" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1.5">{modal.editing ? 'Nova senha (em branco = manter)' : 'Senha'}</label>
                  <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
                    placeholder="••••••••" />
                </div>
              </div>

              {/* Permissões de página */}
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Acesso às páginas</p>
                <div className="space-y-2">
                  {([
                    { key: 'dispatcher' as const, label: 'Disparador', color: 'text-blue-400' },
                    { key: 'chipsPage' as const, label: 'Gerenciar Chips', color: 'text-purple-400' },
                    { key: 'settings' as const, label: 'Configurações', color: 'text-yellow-400' },
                  ]).map(({ key, label, color }) => (
                    <label key={key} className="flex items-center gap-3 cursor-pointer">
                      <div onClick={() => toggleBool(key)} className={`w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0 ${form.permissions[key] ? 'bg-green-500' : 'bg-gray-700'}`}>
                        <div className={`w-4 h-4 bg-white rounded-full mt-0.5 transition-transform ${form.permissions[key] ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                      </div>
                      <span className={`text-sm ${color}`}>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Canais API Oficial */}
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Radio size={12} /> Canais API Oficial
                </p>
                <p className="text-[11px] text-gray-600 mb-2">Selecione quais canais o usuário verá nas mensagens</p>
                {channels.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">Nenhum canal cadastrado</p>
                ) : (
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {channels.map(ch => (
                      <label key={ch.id} className="flex items-center gap-2.5 cursor-pointer p-2 rounded-lg hover:bg-gray-800">
                        <input type="checkbox" checked={form.permissions.channelIds.includes(ch.id)} onChange={() => toggleId('channelIds', ch.id)} className="accent-green-500 w-3.5 h-3.5" />
                        <span className="text-sm text-gray-300">{ch.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Chips */}
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Smartphone size={12} /> Chips (WhatsApp Não Oficial)
                </p>
                <p className="text-[11px] text-gray-600 mb-2">Selecione quais chips o usuário verá nas mensagens</p>
                {chips.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">Nenhum chip conectado</p>
                ) : (
                  <div className="space-y-1.5 max-h-32 overflow-y-auto">
                    {chips.map(chip => (
                      <label key={chip.id} className="flex items-center gap-2.5 cursor-pointer p-2 rounded-lg hover:bg-gray-800">
                        <input type="checkbox" checked={form.permissions.chipIds.includes(chip.id)} onChange={() => toggleId('chipIds', chip.id)} className="accent-green-500 w-3.5 h-3.5" />
                        <div>
                          <span className="text-sm text-gray-300">{chip.id}</span>
                          {chip.number && <span className="text-xs text-gray-500 ml-2">{chip.number}</span>}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {error && <p className="text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</p>}
            </div>

            <div className="flex gap-3 p-5 border-t border-gray-800">
              <button onClick={() => setModal({ open: false, editing: null })} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-sm py-2 rounded-lg transition-colors">Cancelar</button>
              <button onClick={handleSave} disabled={saving} className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors">
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
