import { useMemo } from 'react'
import { useStore } from '../store'
import { MessageSquare, Users, TrendingUp, CheckCircle, Clock, AlertCircle } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts'
import { subDays, format, isSameDay } from 'date-fns'
import { ptBR } from 'date-fns/locale'

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number | string; color: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${color}`}>
        <Icon size={18} className="text-white" />
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-sm text-gray-400 mt-1">{label}</p>
    </div>
  )
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>{p.name}: <span className="text-white font-medium">{p.value}</span></p>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const { conversations, contacts, channels, messages, kanbanColumns, kanbanCards, blasts } = useStore()

  const open = conversations.filter(c => c.status === 'open').length
  const pending = conversations.filter(c => c.status === 'pending').length
  const resolved = conversations.filter(c => c.status === 'resolved').length
  const unread = conversations.reduce((a, c) => a + c.unreadCount, 0)
  const outbound = messages.filter(m => m.direction === 'outbound').length
  const delivered = messages.filter(m => m.status === 'delivered' || m.status === 'read').length
  const deliveryRate = outbound > 0 ? Math.round((delivered / outbound) * 100) : 0

  const recent = [...conversations]
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
    .slice(0, 5)

  // Gráfico de atendimentos — últimos 14 dias
  const attendanceData = useMemo(() => {
    const days = Array.from({ length: 14 }, (_, i) => {
      const day = subDays(new Date(), 13 - i)
      return { day, label: format(day, 'dd/MM', { locale: ptBR }) }
    })
    return days.map(({ day, label }) => ({
      data: label,
      Abertas: conversations.filter(c => isSameDay(new Date(c.lastMessageAt), day) && c.status === 'open').length,
      Resolvidas: conversations.filter(c => isSameDay(new Date(c.lastMessageAt), day) && c.status === 'resolved').length,
      Recebidas: messages.filter(m => m.direction === 'inbound' && isSameDay(new Date(m.timestamp), day)).length,
      Enviadas: messages.filter(m => m.direction === 'outbound' && isSameDay(new Date(m.timestamp), day)).length,
    }))
  }, [conversations, messages])

  // Gráfico de vendas — valor por coluna do kanban
  const salesData = useMemo(() => {
    return [...kanbanColumns]
      .sort((a, b) => a.order - b.order)
      .map(col => ({
        coluna: col.title,
        'Valor (R$)': kanbanCards.filter(c => c.columnId === col.id).reduce((s, c) => s + (c.value ?? 0), 0),
        Negócios: kanbanCards.filter(c => c.columnId === col.id).length,
        fill: col.color,
      }))
  }, [kanbanColumns, kanbanCards])

  // Gráfico de disparos — taxa de entrega por campanha (últimas 5)
  const blastData = useMemo(() =>
    [...blasts]
      .filter(b => b.stats.total > 0)
      .slice(-6)
      .map(b => ({
        nome: b.name.length > 12 ? b.name.slice(0, 12) + '…' : b.name,
        Enviados: b.stats.sent,
        Entregues: b.stats.delivered,
        Lidos: b.stats.read,
        Falhas: b.stats.failed,
      }))
  , [blasts])

  const totalPipelineValue = kanbanCards.reduce((s, c) => s + (c.value ?? 0), 0)

  return (
    <div className="p-6 overflow-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white">Dashboard</h1>
        <p className="text-sm text-gray-400 mt-1">Visão geral do atendimento e vendas</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard icon={MessageSquare} label="Conversas Abertas" value={open} color="bg-indigo-500" />
        <StatCard icon={Clock} label="Aguardando" value={pending} color="bg-amber-500" />
        <StatCard icon={CheckCircle} label="Resolvidas" value={resolved} color="bg-emerald-500" />
        <StatCard icon={AlertCircle} label="Não Lidas" value={unread} color="bg-red-500" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Users} label="Total Contatos" value={contacts.length} color="bg-purple-500" />
        <StatCard icon={MessageSquare} label="Msgs Enviadas" value={outbound} color="bg-blue-500" />
        <StatCard icon={TrendingUp} label="Taxa de Entrega" value={`${deliveryRate}%`} color="bg-green-500" />
        <StatCard icon={TrendingUp} label="Pipeline Total" value={`R$ ${(totalPipelineValue/1000).toFixed(1)}k`} color="bg-pink-500" />
      </div>

      {/* Gráfico de Atendimento */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-white">Atendimentos — últimos 14 dias</h2>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-500 inline-block"/>Recebidas</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"/>Enviadas</span>
          </div>
        </div>
        {attendanceData.every(d => d.Recebidas === 0 && d.Enviadas === 0) ? (
          <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
            Nenhuma mensagem ainda. Os dados aparecerão aqui ao receber/enviar mensagens.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={attendanceData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorRecv" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorSent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="data" tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="Recebidas" stroke="#6366f1" fill="url(#colorRecv)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="Enviadas" stroke="#10b981" fill="url(#colorSent)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        {/* Gráfico de Vendas / Pipeline */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-4">Pipeline de Vendas por Coluna</h2>
          {salesData.every(d => d['Valor (R$)'] === 0) ? (
            <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
              Nenhum negócio com valor no pipeline ainda.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={salesData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis dataKey="coluna" tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false}
                  tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} />
                <Tooltip content={<CustomTooltip />} formatter={(v: any) => [`R$ ${Number(v).toLocaleString('pt-BR', {minimumFractionDigits:2})}`, 'Valor']} />
                <Bar dataKey="Valor (R$)" radius={[4,4,0,0]}>
                  {salesData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {salesData.map(col => (
              <div key={col.coluna} className="flex items-center gap-1.5 text-xs">
                <span className="w-2 h-2 rounded-sm" style={{ background: col.fill }} />
                <span className="text-gray-400">{col.coluna}</span>
                <span className="text-gray-300 font-medium">{col.Negócios}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Gráfico de Disparos */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-4">Últimas Campanhas — Métricas</h2>
          {blastData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
              Nenhuma campanha disparada ainda.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={blastData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis dataKey="nome" tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
                <Bar dataKey="Enviados" fill="#6366f1" radius={[2,2,0,0]} />
                <Bar dataKey="Entregues" fill="#10b981" radius={[2,2,0,0]} />
                <Bar dataKey="Lidos" fill="#3b82f6" radius={[2,2,0,0]} />
                <Bar dataKey="Falhas" fill="#ef4444" radius={[2,2,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Conversas recentes + Canais */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-4">Conversas Recentes</h2>
          {recent.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">Nenhuma conversa ainda</p>
          ) : (
            <div className="space-y-3">
              {recent.map(conv => {
                const contact = contacts.find(c => c.id === conv.contactId)
                return (
                  <div key={conv.id} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-300 shrink-0">
                      {contact?.name[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{contact?.name ?? 'Desconhecido'}</p>
                      <p className="text-xs text-gray-500 truncate">{conv.lastMessage ?? '—'}</p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      conv.status === 'open' ? 'bg-green-900/50 text-green-400' :
                      conv.status === 'pending' ? 'bg-amber-900/50 text-amber-400' :
                      'bg-gray-800 text-gray-400'
                    }`}>
                      {conv.status === 'open' ? 'Aberta' : conv.status === 'pending' ? 'Pendente' : 'Resolvida'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-4">Canais Conectados</h2>
          {channels.length === 0 ? (
            <div className="py-4 text-center">
              <p className="text-sm text-gray-500">Nenhum canal configurado</p>
              <a href="/channels" className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 inline-block">
                Adicionar canal →
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              {channels.map(ch => (
                <div key={ch.id} className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${ch.status === 'connected' ? 'bg-green-400' : 'bg-red-400'}`} />
                  <div className="flex-1">
                    <p className="text-sm text-white">{ch.name}</p>
                    <p className="text-xs text-gray-500">{ch.phoneNumber}</p>
                  </div>
                  <span className={`text-xs ${ch.status === 'connected' ? 'text-green-400' : 'text-red-400'}`}>
                    {ch.status === 'connected' ? 'Conectado' : 'Desconectado'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
