import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Search, CheckCircle, AlertCircle, Loader2, Key, Send
} from 'lucide-react'

const TABELAS = [
  { id: 'cb563029-ba93-4b53-8d53-4ac145087212', label: 'Normal' },
  { id: '61c9fb2f-c902-4992-b8f5-b0ee368c45b0', label: 'Cometa' },
]


const PIX_TYPES = [
  { value: 'cpf',             label: 'CPF',             placeholder: '12345678901 (11 dígitos)' },
  { value: 'email',           label: 'E-mail',          placeholder: 'nome@email.com' },
  { value: 'phone',           label: 'Telefone',        placeholder: '+5511999999999' },
  { value: 'chave_aleatoria', label: 'Chave Aleatória', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
]

function formatCurrency(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function maskCpf(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0,3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6)}`
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`
}

export default function Simulacao() {
  const location = useLocation()
  const [tab, setTab] = useState<'fgts' | 'clt'>(() => {
    const t = new URLSearchParams(location.search).get('t')
    return t === 'clt' ? 'clt' : 'fgts'
  })

  useEffect(() => {
    const t = new URLSearchParams(location.search).get('t')
    if (t === 'clt' || t === 'fgts') setTab(t)
  }, [location.search])

  // Step 1 — Consultar
  const [cpf, setCpf] = useState('')
  const [tabelaId, setTabelaId] = useState(TABELAS[0].id)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Step 2 — Resultado consulta
  type ConsultaResult = { balance: Record<string, any>; simulation: Record<string, any> }
  const [resultado, setResultado] = useState<ConsultaResult | null>(null)

  // Step 3 — Proposta
  const [pixKey, setPixKey] = useState('')
  const [pixKeyType, setPixKeyType] = useState('cpf')
  const [proposalLoading, setProposalLoading] = useState(false)
  const [proposalError, setProposalError] = useState('')
  const [proposalResult, setProposalResult] = useState<Record<string, any> | null>(null)

  async function handleConsultar() {
    const rawCpf = cpf.replace(/\D/g, '')
    if (rawCpf.length !== 11) return setError('CPF deve ter 11 dígitos.')
    setError('')
    setResultado(null)
    setProposalResult(null)
    setProposalError('')
    setLoading(true)
    setLoadingMsg('Limpando cache e consultando saldo...')
    try {
      const res = await fetch('/api/fgts/consultar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpf: rawCpf, tabelaId }),
      })
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) {
        throw new Error(`Erro do servidor (${res.status}) — tente novamente`)
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setResultado(data)
    } catch (e: any) {
      setError(e.message || 'Erro ao consultar')
    } finally {
      setLoading(false)
      setLoadingMsg('')
    }
  }

  async function handleProposta() {
    if (!pixKey.trim()) return setProposalError('Informe a chave PIX.')
    if (!resultado) return
    setProposalError('')
    setProposalResult(null)
    setProposalLoading(true)
    try {
      const sim = resultado.simulation
      const periods = sim?.periods || sim?.installments || sim?.fgtsProposalsPeriods || []
      const simulationId = sim?.id || sim?.simulationId || sim?.data?.id || ''

      const res = await fetch('/api/fgts/proposta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cpf: cpf.replace(/\D/g, ''),
          tabelaId,
          pixKey: pixKey.trim(),
          pixKeyType,
          simulationId,
          fgtsProposalsPeriods: periods,
        }),
      })
      const ct2 = res.headers.get('content-type') || ''
      if (!ct2.includes('json')) throw new Error(`Erro do servidor (${res.status}) — tente novamente`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setProposalResult(data)
    } catch (e: any) {
      setProposalError(e.message || 'Erro ao digitar proposta')
    } finally {
      setProposalLoading(false)
    }
  }

  function parseSimulation(sim: Record<string, any>) {
    const raw = sim?.data ?? sim
    const periods: any[] = raw?.periods || raw?.installments || raw?.fgtsProposalsPeriods || []
    const netValue = raw?.netValue ?? raw?.net_value ?? raw?.totalNetValue ?? raw?.valorLiquido ?? null
    const totalValue = raw?.totalValue ?? raw?.total_value ?? raw?.valorBruto ?? null
    const count = periods.length || raw?.periodsCount || raw?.total || 0
    return { periods, netValue, totalValue, count, id: raw?.id || '' }
  }

  const simParsed = resultado ? parseSimulation(resultado.simulation) : null
  const balanceParsed = resultado?.balance

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950 p-6">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-white">Simulação</h1>
          <p className="text-sm text-gray-500 mt-0.5">Consulte saldo FGTS e simule propostas</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-900 rounded-xl p-1 mb-6 border border-gray-800">
          {(['fgts', 'clt'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors ${
                tab === t
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t === 'fgts' ? 'FGTS' : 'CLT'}
            </button>
          ))}
        </div>

        {tab === 'clt' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-10 text-center">
            <p className="text-gray-500 text-sm">Simulação CLT em breve</p>
          </div>
        )}

        {tab === 'fgts' && (
          <div className="space-y-4">

            {/* Consultar card */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Search size={15} className="text-indigo-400" />
                <p className="text-sm font-semibold text-white">Consultar FGTS</p>
              </div>

              <div className="flex gap-3 flex-wrap">
                {/* CPF */}
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-xs text-gray-500 mb-1.5">CPF</label>
                  <input
                    type="text"
                    value={cpf}
                    onChange={e => setCpf(maskCpf(e.target.value))}
                    placeholder="000.000.000-00"
                    maxLength={14}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                {/* Tabela */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Tabela</label>
                  <div className="flex gap-1.5">
                    {TABELAS.map(t => (
                      <button
                        key={t.id}
                        onClick={() => setTabelaId(t.id)}
                        className={`px-3 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                          tabelaId === t.id
                            ? 'bg-indigo-600 border-indigo-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Botão */}
                <div className="flex items-end">
                  <button
                    onClick={handleConsultar}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                    {loading ? 'Consultando...' : 'Consultar'}
                  </button>
                </div>
              </div>

              {loading && loadingMsg && (
                <div className="flex items-center gap-2 text-xs text-indigo-400">
                  <Loader2 size={12} className="animate-spin" />
                  {loadingMsg} — pode levar até 2 min (buscando no provider)
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2.5">
                  <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              )}
            </div>

            {/* Resultado */}
            {resultado && simParsed && (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-800 bg-green-900/10">
                  <CheckCircle size={14} className="text-green-400" />
                  <p className="text-sm font-semibold text-green-300">Simulação aprovada</p>
                </div>

                <div className="p-5 space-y-4">
                  {/* Summary cards */}
                  <div className="grid grid-cols-3 gap-3">
                    {balanceParsed?.availableBalance != null && (
                      <div className="bg-gray-800 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-gray-500 mb-1">Saldo FGTS</p>
                        <p className="text-lg font-bold text-white">{formatCurrency(Number(balanceParsed.availableBalance))}</p>
                      </div>
                    )}
                    {simParsed.netValue != null && (
                      <div className="bg-gray-800 rounded-xl p-3 text-center">
                        <p className="text-[10px] text-gray-500 mb-1">Valor Líquido</p>
                        <p className="text-lg font-bold text-green-400">{formatCurrency(Number(simParsed.netValue))}</p>
                      </div>
                    )}
                    <div className="bg-gray-800 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-gray-500 mb-1">Parcelas</p>
                      <p className="text-lg font-bold text-indigo-400">{simParsed.count}</p>
                    </div>
                  </div>

                  {/* Installments table */}
                  {simParsed.periods.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 font-medium mb-2">{simParsed.periods.length} parcelas na simulação</p>
                      <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-800">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-800/80">
                              <th className="px-3 py-2 text-left text-gray-500 font-medium">Período</th>
                              <th className="px-3 py-2 text-right text-gray-500 font-medium">Valor</th>
                              <th className="px-3 py-2 text-right text-gray-500 font-medium">Taxa</th>
                            </tr>
                          </thead>
                          <tbody>
                            {simParsed.periods.map((p: any, i: number) => (
                              <tr key={i} className="border-t border-gray-800/50">
                                <td className="px-3 py-2 text-gray-300">{p.year ?? p.period ?? p.installment ?? i + 1}</td>
                                <td className="px-3 py-2 text-right text-green-400 font-mono">
                                  {p.netValue != null ? formatCurrency(Number(p.netValue))
                                    : p.value != null ? formatCurrency(Number(p.value)) : '—'}
                                </td>
                                <td className="px-3 py-2 text-right text-gray-500">
                                  {p.fees != null ? `${Number(p.fees).toFixed(2)}%`
                                    : p.rate != null ? `${Number(p.rate).toFixed(2)}%` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Proposta */}
                  <div className="border-t border-gray-800 pt-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Key size={14} className="text-indigo-400" />
                      <p className="text-sm font-semibold text-white">Digitar Proposta</p>
                    </div>

                    <div className="flex gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1.5">Tipo da chave</label>
                        <select
                          value={pixKeyType}
                          onChange={e => setPixKeyType(e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                        >
                          {PIX_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1.5">Chave PIX</label>
                        <input
                          type="text"
                          value={pixKey}
                          onChange={e => setPixKey(e.target.value)}
                          placeholder={PIX_TYPES.find(t => t.value === pixKeyType)?.placeholder}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 font-mono"
                        />
                      </div>
                    </div>

                    {proposalError && (
                      <div className="flex items-start gap-2 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2.5">
                        <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-red-400">{proposalError}</p>
                      </div>
                    )}

                    <button
                      onClick={handleProposta}
                      disabled={proposalLoading || !pixKey.trim()}
                      className="w-full flex items-center justify-center gap-2 py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors"
                    >
                      {proposalLoading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                      {proposalLoading ? 'Digitando proposta...' : 'Digitar Proposta'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Proposta resultado */}
            {proposalResult && (
              <div className="bg-gray-900 border border-green-800/40 rounded-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-5 py-3 border-b border-green-800/30 bg-green-900/20">
                  <CheckCircle size={14} className="text-green-400" />
                  <p className="text-sm font-semibold text-green-300">Proposta digitada com sucesso!</p>
                </div>
                <div className="p-5 space-y-2">
                  {proposalResult.pessoa && (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-gray-800 rounded-lg p-2.5">
                        <p className="text-gray-500 mb-0.5">Nome</p>
                        <p className="text-white font-medium">{proposalResult.pessoa.nome}</p>
                      </div>
                      <div className="bg-gray-800 rounded-lg p-2.5">
                        <p className="text-gray-500 mb-0.5">Nascimento</p>
                        <p className="text-white font-medium">{proposalResult.pessoa.dataNasc || '—'}</p>
                      </div>
                    </div>
                  )}
                  {proposalResult.proposal?.id && (
                    <div className="bg-gray-800 rounded-lg p-2.5 text-xs">
                      <p className="text-gray-500 mb-0.5">ID da Proposta</p>
                      <p className="text-indigo-300 font-mono break-all">{proposalResult.proposal.id}</p>
                    </div>
                  )}
                  {proposalResult.proposal?.status && (
                    <div className="bg-gray-800 rounded-lg p-2.5 text-xs">
                      <p className="text-gray-500 mb-0.5">Status</p>
                      <p className="text-white">{proposalResult.proposal.status}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  )
}
