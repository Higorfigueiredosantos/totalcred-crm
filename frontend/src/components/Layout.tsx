import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import { connectWS } from '../api/websocket'
import { useInboundMessages } from '../hooks/useInboundMessages'

export default function Layout() {
  useEffect(() => { connectWS() }, [])
  // Processa mensagens recebidas/enviadas (Meta e Chips/Wuzapi) globalmente,
  // não só quando a tela de Mensagens está aberta — ver useInboundMessages.
  useInboundMessages()

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
