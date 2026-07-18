import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useStore } from './store'
import { useAuthStore } from './store/auth'
import Login from './pages/Login'
import Admin from './pages/Admin'

function useHydration() {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (useStore.persist.hasHydrated()) { setHydrated(true); return }
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true))
    return unsub
  }, [])
  return hydrated
}
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Messages from './pages/Messages'
import Contacts from './pages/Contacts'
import Kanban from './pages/Kanban'
import Dispatcher from './pages/Dispatcher'
import Channels from './pages/Channels'
import Settings from './pages/Settings'
import Ferramentas from './pages/Ferramentas'
import Autobot from './pages/Autobot'
import Simulacao from './pages/Simulacao'

export default function App() {
  const theme = useStore(s => s.settings.theme ?? 'dark')
  const hydrated = useHydration()
  const token = useAuthStore(s => s.token)

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
  }, [theme])

  if (!token) return <Login />

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-green-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">Carregando dados...</p>
        </div>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/kanban" element={<Kanban />} />
          <Route path="/dispatcher" element={<Dispatcher />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/ferramentas" element={<Ferramentas />} />
          <Route path="/autobot" element={<Autobot />} />
          <Route path="/simulacao" element={<Simulacao />} />
          <Route path="/admin" element={<Admin />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
