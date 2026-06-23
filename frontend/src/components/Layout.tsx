import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import { connectWS } from '../api/websocket'

export default function Layout() {
  useEffect(() => { connectWS() }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
