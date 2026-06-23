import { useState } from 'react'
import { Mail, Lock, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { useAuthStore } from '../store/auth'
import logoTotalCred from '../assets/logo-totalcred.png'
import loginBanner from '../assets/login-banner.jpg'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const login = useAuthStore(s => s.login)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const err = await login(email, password)
    setLoading(false)
    if (err) setError(err)
  }

  return (
    <div className="min-h-screen flex bg-[#0a0f1a]">
      {/* ── Painel esquerdo ── */}
      <div className="w-[440px] shrink-0 flex flex-col justify-between p-10 bg-[#0d1320]">
        <div>
          {/* Logo */}
          <div className="flex items-center gap-0 mb-10">
            <img src={logoTotalCred} alt="T" className="w-12 h-12 object-contain" />
            <span className="text-2xl font-bold text-white -ml-4">otal Cred</span>
          </div>

          {/* Título */}
          <h1 className="text-3xl font-bold text-white mb-2">Acesse sua conta</h1>
          <p className="text-gray-400 text-sm mb-8">Entre para continuar no painel.</p>

          {/* Formulário */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label className="text-sm text-gray-300 block mb-2">Email</label>
              <div className="relative">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full bg-[#151d2e] border border-gray-700/60 rounded-xl pl-10 pr-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
                  placeholder="seu@email.com"
                  required
                  autoFocus
                />
              </div>
            </div>

            {/* Senha */}
            <div>
              <label className="text-sm text-gray-300 block mb-2">Senha</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full bg-[#151d2e] border border-gray-700/60 rounded-xl pl-10 pr-11 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Esqueceu a senha */}
            <div className="text-right -mt-2">
              <span className="text-green-500 text-sm cursor-pointer hover:text-green-400 transition-colors">
                Esqueceu a senha?
              </span>
            </div>

            {/* Erro */}
            {error && (
              <p className="text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-2.5">
                {error}
              </p>
            )}

            {/* Botão */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl text-sm transition-colors mt-2"
            >
              {loading ? 'Entrando...' : 'Entrar'}
            </button>
          </form>
        </div>

        {/* Rodapé de segurança */}
        <div className="flex items-start gap-3 mt-8">
          <ShieldCheck size={18} className="text-green-500 shrink-0 mt-0.5" />
          <p className="text-gray-500 text-xs leading-relaxed">
            Segurança de verdade para você focar no que importa.
          </p>
        </div>
      </div>

      {/* ── Painel direito (banner) ── */}
      <div className="flex-1 relative overflow-hidden">
        <img
          src={loginBanner}
          alt="Total Cred"
          className="w-full h-full object-cover object-center"
        />
      </div>
    </div>
  )
}
