import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  MessageSquare, Users, Kanban, Send, Settings,
  Radio, BarChart2, Smartphone, Wrench, ChevronLeft, ChevronRight,
  Shield, LogOut, ChevronDown, ChevronUp, Calculator
} from 'lucide-react'
import logoTotalCred from '../assets/logo-totalcred.png'
import { useAuthStore } from '../store/auth'

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const [officialOpen, setOfficialOpen] = useState(true)
  const [unofficialOpen, setUnofficialOpen] = useState(true)
  const [simOpen, setSimOpen] = useState(true)
  const { user, logout, isAdmin, can } = useAuthStore()

  const linkClass = (isActive: boolean) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
      isActive
        ? 'bg-gray-800 text-white font-medium'
        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
    } ${collapsed ? 'justify-center px-2' : ''}`

  function GroupHeader({
    label,
    open,
    onToggle,
  }: {
    label: string
    open: boolean
    onToggle: () => void
  }) {
    if (collapsed) {
      return <div className="my-2 border-t border-gray-800" />
    }
    return (
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-1.5 mt-1 mb-0.5 rounded-lg hover:bg-gray-800/40 transition-colors group"
      >
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider group-hover:text-gray-400 transition-colors">
          {label}
        </span>
        {open
          ? <ChevronUp size={11} className="text-gray-600 group-hover:text-gray-400" />
          : <ChevronDown size={11} className="text-gray-600 group-hover:text-gray-400" />
        }
      </button>
    )
  }

  return (
    <aside className={`${collapsed ? 'w-14' : 'w-56'} bg-gray-900 border-r border-gray-800 flex flex-col h-full shrink-0 transition-all duration-200`}>
      <div className={`h-14 flex items-center ${collapsed ? 'justify-center' : 'gap-0 px-3'} border-b border-gray-800`}>
        <img src={logoTotalCred} alt="T" className="w-12 h-12 shrink-0 object-contain" />
        {!collapsed && <span className="font-semibold text-sm text-white -ml-4">otal Cred</span>}
      </div>

      <nav className="flex-1 p-2 overflow-y-auto">
        {!collapsed && <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider px-3 pt-1 pb-1.5">CRM</p>}
        {collapsed && <div className="mb-1" />}

        <NavLink to="/" end className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Dashboard' : undefined}>
          <BarChart2 size={16} />{!collapsed && 'Dashboard'}
        </NavLink>
        <NavLink to="/messages" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Mensagens' : undefined}>
          <MessageSquare size={16} />{!collapsed && 'Mensagens'}
        </NavLink>
        <NavLink to="/contacts" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Contatos' : undefined}>
          <Users size={16} />{!collapsed && 'Contatos'}
        </NavLink>
        <NavLink to="/kanban" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Pipeline' : undefined}>
          <Kanban size={16} />{!collapsed && 'Pipeline'}
        </NavLink>

        <GroupHeader label="API Oficial" open={officialOpen} onToggle={() => setOfficialOpen(v => !v)} />

        {(collapsed || officialOpen) && (
          <>
            {can('dispatcher') && (
              <NavLink to="/dispatcher" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Disparador' : undefined}>
                <Send size={16} />{!collapsed && 'Disparador'}
              </NavLink>
            )}
            <NavLink to="/channels" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Canais' : undefined}>
              <Radio size={16} />{!collapsed && 'Canais'}
            </NavLink>
          </>
        )}

        <GroupHeader label="API Não Oficial" open={unofficialOpen} onToggle={() => setUnofficialOpen(v => !v)} />

        {(collapsed || unofficialOpen) && (
          <>
            {can('chipsPage') && (
              <NavLink to="/chips" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Chips' : undefined}>
                <Smartphone size={16} />{!collapsed && 'Chips'}
              </NavLink>
            )}
            <NavLink to="/ferramentas" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Ferramentas' : undefined}>
              <Wrench size={16} />{!collapsed && 'Ferramentas'}
            </NavLink>
          </>
        )}

        <GroupHeader label="Simulação" open={simOpen} onToggle={() => setSimOpen(v => !v)} />

        {(collapsed || simOpen) && (
          <>
            <NavLink to="/simulacao?t=fgts" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'FGTS' : undefined}>
              <Calculator size={16} />{!collapsed && 'FGTS'}
            </NavLink>
            <NavLink to="/simulacao?t=clt" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'CLT' : undefined}>
              <Calculator size={16} />{!collapsed && 'CLT'}
            </NavLink>
          </>
        )}
      </nav>

      <div className="p-2 border-t border-gray-800 space-y-1">
        {can('settings') && (
          <NavLink to="/settings" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Configurações' : undefined}>
            <Settings size={16} />{!collapsed && 'Configurações'}
          </NavLink>
        )}

        {isAdmin() && (
          <NavLink to="/admin" className={({ isActive }) => linkClass(isActive)} title={collapsed ? 'Administração' : undefined}>
            <Shield size={16} />{!collapsed && 'Administração'}
          </NavLink>
        )}

        {!collapsed && user && (
          <div className="px-3 py-2 mt-1">
            <p className="text-xs text-gray-400 truncate">{user.name}</p>
            <p className="text-[10px] text-gray-600 truncate">{user.email}</p>
          </div>
        )}

        <button
          onClick={logout}
          className={`w-full flex items-center gap-3 px-3 py-1.5 text-gray-600 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors text-sm ${collapsed ? 'justify-center px-2' : ''}`}
          title={collapsed ? 'Sair' : undefined}
        >
          <LogOut size={15} />{!collapsed && 'Sair'}
        </button>

        <button
          onClick={() => setCollapsed(v => !v)}
          className="w-full flex items-center justify-center py-1.5 text-gray-600 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors"
          title={collapsed ? 'Expandir menu' : 'Recolher menu'}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>
    </aside>
  )
}
