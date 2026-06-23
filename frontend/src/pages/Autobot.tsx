import { useState, useEffect } from 'react'
import { Bot, Plus, Trash2, Save, Power, Clock, MessageSquare, AlertCircle, X, Users } from 'lucide-react'
import { onWSMessage } from '../api/websocket'
import type { AutobotRule, AutobotConfig } from '../types'
import { v4 as uuid } from '../utils/uuid'

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const DAY_NUM = [7, 1, 2, 3, 4, 5, 6] // index → day number (1=Mon … 7=Sun)

const DEFAULT_CONFIG: AutobotConfig = {
  active: false,
  rules: [],
  workingHours: { enabled: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  antiSpamMinutes: 60,
  aiEnabled: false,
  escalationWord: 'atendente',
  pausedContacts: [],
}

// ── Rule editor modal ─────────────────────────────────────────────────────────

function RuleModal({
  rule, onSave, onClose
}: { rule: Partial<AutobotRule>; onSave: (r: AutobotRule) => void; onClose: () => void }) {
  const [trigger, setTrigger] = useState(rule.trigger || '')
  const [response, setResponse] = useState(rule.response || '')
  const [matchType, setMatchType] = useState<'contains' | 'exact'>(rule.matchType || 'contains')

  function save() {
    if (!trigger.trim()) return alert('O gatilho não pode estar vazio.')
    if (!response.trim()) return alert('A resposta não pode estar vazia.')
    onSave({ id: rule.id || uuid(), trigger: trigger.trim(), response: response.trim(), matchType })
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{rule.id ? 'Editar Regra' : 'Nova Regra'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Gatilho (palavra-chave)</label>
            <input
              value={trigger}
              onChange={e => setTrigger(e.target.value)}
              placeholder="oi | olá | preço | * (qualquer mensagem)"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">Use | para múltiplos gatilhos. Use * para qualquer mensagem.</p>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Tipo de correspondência</label>
            <div className="flex gap-3">
              {(['contains', 'exact'] as const).map(type => (
                <label key={type} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input type="radio" value={type} checked={matchType === type} onChange={() => setMatchType(type)} />
                  {type === 'contains' ? 'Contém' : 'Exato'}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Resposta automática</label>
            <textarea
              value={response}
              onChange={e => setResponse(e.target.value)}
              rows={5}
              placeholder={"Olá! Obrigado por entrar em contato.\n\nVariáveis: {{hora}}, {{data}}"}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-green-500"
            />
            <p className="text-xs text-gray-500 mt-1">Variáveis disponíveis: {'{{hora}}'}, {'{{data}}'}</p>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancelar</button>
          <button onClick={save} className="flex items-center gap-1.5 px-4 py-1.5 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg">
            <Save size={13} /> Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function Autobot() {
  const [config, setConfig] = useState<AutobotConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingRule, setEditingRule] = useState<Partial<AutobotRule> | null>(null)
  const [recentActivity, setRecentActivity] = useState<{ ts: string; type: string; contact: string; text?: string }[]>([])

  // ── Load config ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/autobot/rules')
      .then(r => r.json())
      .then(d => { setConfig(d); setLoading(false) })
      .catch(() => setLoading(false))

    const offs = [
      onWSMessage('autobot', (payload: any) => {
        const ts = new Date().toLocaleTimeString('pt-BR')
        if (payload.type === 'sent') {
          setRecentActivity(prev => [{ ts, type: 'sent', contact: payload.contact, text: payload.response }, ...prev.slice(0, 29)])
        }
        if (payload.type === 'escalation') {
          setRecentActivity(prev => [{ ts, type: 'escalation', contact: payload.contact }, ...prev.slice(0, 29)])
          setConfig(c => ({ ...c, pausedContacts: [...(c.pausedContacts || []), payload.contact] }))
        }
        if (payload.type === 'status') {
          setConfig(c => ({ ...c, active: payload.active }))
        }
      }),
    ]
    return () => offs.forEach(f => f())
  }, [])

  // ── Save all ────────────────────────────────────────────────────────────────

  async function save() {
    setSaving(true)
    await fetch('/api/autobot/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
    setSaving(false)
  }

  // ── Toggle active ───────────────────────────────────────────────────────────

  async function toggleActive() {
    const newActive = !config.active
    setConfig(c => ({ ...c, active: newActive }))
    await fetch('/api/autobot/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: newActive })
    })
  }

  // ── Rule actions ────────────────────────────────────────────────────────────

  function saveRule(rule: AutobotRule) {
    setConfig(c => {
      const exists = c.rules.findIndex(r => r.id === rule.id)
      const rules = exists >= 0
        ? c.rules.map(r => r.id === rule.id ? rule : r)
        : [...c.rules, rule]
      return { ...c, rules }
    })
    setEditingRule(null)
  }

  function deleteRule(id: string) {
    if (!confirm('Excluir esta regra?')) return
    setConfig(c => ({ ...c, rules: c.rules.filter(r => r.id !== id) }))
  }

  async function unpauseContact(contact: string) {
    setConfig(c => ({ ...c, pausedContacts: (c.pausedContacts || []).filter(x => x !== contact) }))
    await fetch('/api/autobot/unpause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact })
    })
  }

  // ── Day toggle ──────────────────────────────────────────────────────────────

  function toggleDay(dayNum: number) {
    setConfig(c => ({
      ...c,
      workingHours: {
        ...c.workingHours,
        days: c.workingHours.days.includes(dayNum)
          ? c.workingHours.days.filter(d => d !== dayNum)
          : [...c.workingHours.days, dayNum]
      }
    }))
  }

  if (loading) return <div className="flex items-center justify-center h-full text-gray-500">Carregando...</div>

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <Bot size={18} className="text-green-400" />
          <div>
            <h1 className="text-lg font-semibold text-white">Autobot</h1>
            <p className="text-xs text-gray-400">Respostas automáticas por palavras-chave</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* On/Off toggle */}
          <button
            onClick={toggleActive}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              config.active
                ? 'bg-green-900/50 text-green-400 border border-green-700 hover:bg-green-800/50'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
            }`}
          >
            <Power size={14} className={config.active ? 'text-green-400' : 'text-gray-500'} />
            {config.active ? 'Ativo' : 'Inativo'}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded-lg"
          >
            <Save size={14} /> {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl space-y-5">

          {/* Status banner */}
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
            config.active
              ? 'bg-green-900/20 border-green-800 text-green-400'
              : 'bg-gray-800 border-gray-700 text-gray-400'
          }`}>
            <div className={`w-2 h-2 rounded-full ${config.active ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
            <p className="text-sm">
              {config.active
                ? 'Autobot ativo — respondendo mensagens automaticamente'
                : 'Autobot inativo — nenhuma resposta automática será enviada'}
            </p>
          </div>

          {/* Rules */}
          <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <MessageSquare size={15} className="text-gray-400" />
                <h2 className="text-sm font-semibold text-white">Regras de Resposta</h2>
                <span className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{config.rules.length}</span>
              </div>
              <button
                onClick={() => setEditingRule({})}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded-lg"
              >
                <Plus size={13} /> Nova Regra
              </button>
            </div>

            {config.rules.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <MessageSquare size={28} className="mx-auto mb-2 opacity-30" />
                <p className="text-xs">Nenhuma regra configurada.</p>
                <p className="text-xs mt-0.5">Adicione regras para responder automaticamente.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-700">
                {config.rules.map(rule => (
                  <div key={rule.id} className="flex items-start gap-3 px-5 py-4 hover:bg-gray-700/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <code className="text-xs bg-gray-900 text-green-400 px-2 py-0.5 rounded font-mono">{rule.trigger}</code>
                        <span className="text-xs text-gray-500">{rule.matchType === 'exact' ? 'exato' : 'contém'}</span>
                      </div>
                      <p className="text-xs text-gray-300 line-clamp-2">{rule.response}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => setEditingRule(rule)} className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded">
                        <Save size={13} />
                      </button>
                      <button onClick={() => deleteRule(rule.id)} className="p-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-900/20 rounded">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Settings */}
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-5">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Clock size={15} className="text-gray-400" /> Configurações</h2>

            {/* Working hours */}
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={config.workingHours.enabled}
                  onChange={e => setConfig(c => ({ ...c, workingHours: { ...c.workingHours, enabled: e.target.checked } }))}
                  className="rounded"
                />
                Horário de atendimento
              </label>

              {config.workingHours.enabled && (
                <div className="pl-5 space-y-3">
                  <div className="flex items-center gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Início</label>
                      <input type="time" value={config.workingHours.start}
                        onChange={e => setConfig(c => ({ ...c, workingHours: { ...c.workingHours, start: e.target.value } }))}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Fim</label>
                      <input type="time" value={config.workingHours.end}
                        onChange={e => setConfig(c => ({ ...c, workingHours: { ...c.workingHours, end: e.target.value } }))}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500" />
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {DAYS.map((label, i) => {
                      const dayNum = DAY_NUM[i]
                      const active = config.workingHours.days.includes(dayNum)
                      return (
                        <button key={label} onClick={() => toggleDay(dayNum)}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                            active ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                          }`}>{label}</button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Anti-spam interval */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-300">Intervalo anti-spam</label>
              <input
                type="number" min={0} max={1440}
                value={config.antiSpamMinutes}
                onChange={e => setConfig(c => ({ ...c, antiSpamMinutes: +e.target.value }))}
                className="w-20 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white text-center focus:outline-none focus:border-green-500"
              />
              <span className="text-xs text-gray-400">minutos (0 = sem limite)</span>
            </div>

            {/* Escalation word */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-300">Palavra de escalada</label>
              <input
                value={config.escalationWord}
                onChange={e => setConfig(c => ({ ...c, escalationWord: e.target.value }))}
                placeholder="atendente"
                className="w-32 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-green-500"
              />
              <span className="text-xs text-gray-400">pausa o bot para esse contato</span>
            </div>

            {/* AI toggle */}
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={config.aiEnabled}
                onChange={e => setConfig(c => ({ ...c, aiEnabled: e.target.checked }))}
                className="rounded"
              />
              Respostas com IA (requer GROQ_API_KEY ou OPENAI_API_KEY no .env)
            </label>
          </div>

          {/* Paused contacts */}
          {(config.pausedContacts || []).length > 0 && (
            <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-3">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Users size={15} className="text-gray-400" />
                Contatos com atendimento humano
                <span className="text-xs bg-yellow-900/50 text-yellow-400 px-1.5 py-0.5 rounded-full">{config.pausedContacts.length}</span>
              </h2>
              <p className="text-xs text-gray-400">O autobot está pausado para estes contatos. Clique em X para reativar.</p>
              <div className="flex flex-wrap gap-2">
                {config.pausedContacts.map(c => (
                  <div key={c} className="flex items-center gap-1.5 bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5">
                    <span className="text-xs font-mono text-gray-300">{c}</span>
                    <button onClick={() => unpauseContact(c)} className="text-gray-500 hover:text-red-400">
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent activity */}
          {recentActivity.length > 0 && (
            <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 space-y-3">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <AlertCircle size={15} className="text-gray-400" /> Atividade Recente
              </h2>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {recentActivity.map((a, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-gray-600 shrink-0">{a.ts}</span>
                    <span className={a.type === 'escalation' ? 'text-yellow-400' : 'text-gray-300'}>
                      {a.type === 'sent' ? `✅ Respondeu ${a.contact}: ${a.text?.slice(0, 60)}...` : `🙋 ${a.contact} pediu atendente`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Rule modal */}
      {editingRule !== null && (
        <RuleModal rule={editingRule} onSave={saveRule} onClose={() => setEditingRule(null)} />
      )}
    </div>
  )
}
