import { useEffect, useState } from 'react'
import { onWSMessage } from '../api/websocket'
import { apiFetch } from './useChips'
import type { SmsInstance } from '../types'

// Estado das sessões SMS (BETA, Google Messages Web) — WS-driven (mesmo
// padrão do useChips), com polling de reforço enquanto uma sessão está
// pareando sem QR ainda (cobre o caso de uma mensagem WS perdida).
export function useSmsInstances() {
  const [instances, setInstances] = useState<SmsInstance[]>([])

  const loadInstances = () => apiFetch('/api/sms/instances').then(setInstances).catch(() => {})

  useEffect(() => {
    loadInstances()

    const offs = [
      onWSMessage('sms_status', (p: SmsInstance[]) => setInstances(p)),
      onWSMessage('sms_qr', (p: { id: string; qr: string }) => {
        setInstances(prev => prev.map(i => i.id === p.id ? { ...i, status: 'qr', qr: p.qr } : i))
      }),
      onWSMessage('sms_ready', (p: { id: string; number: string | null }) => {
        setInstances(prev => prev.map(i => i.id === p.id ? { ...i, status: 'connected', number: p.number, qr: null } : i))
      }),
      onWSMessage('sms_disconnected', (p: { id: string }) => {
        setInstances(prev => prev.map(i => i.id === p.id ? { ...i, status: 'disconnected', qr: null } : i))
      }),
    ]

    return () => offs.forEach(f => f())
  }, [])

  useEffect(() => {
    const pending = instances.some(i => i.status === 'connecting' && !i.qr)
    if (!pending) return
    const t = setTimeout(loadInstances, 2000)
    return () => clearTimeout(t)
  }, [instances])

  return { instances, loadInstances }
}
