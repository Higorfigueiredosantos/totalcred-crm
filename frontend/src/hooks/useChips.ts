import { useEffect, useState } from 'react'
import { onWSMessage } from '../api/websocket'
import type { Chip, ChipTemperature } from '../types'

export async function apiFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts)
  return r.json()
}

// Estado de conexão dos chips (API não oficial), compartilhado entre
// Canais (gerenciar conexões) e Disparador (seleção de chips na campanha).
export function useChips() {
  const [chips, setChips] = useState<Chip[]>([])

  const loadChips = () => apiFetch('/api/chips').then(setChips).catch(() => {})

  useEffect(() => {
    loadChips()

    const offs = [
      onWSMessage('chips_status', (p: Chip[]) => setChips(p)),
      onWSMessage('chip_qr', (p: { chipId: string; qr: string }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, status: 'qr', qr: p.qr } : c))
      }),
      onWSMessage('chip_ready', (p: { chipId: string; number: string }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, status: 'connected', isReady: true, number: p.number, qr: null } : c))
      }),
      onWSMessage('chip_disconnected', (p: { chipId: string }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, status: 'disconnected', isReady: false, qr: null } : c))
      }),
      onWSMessage('chip_temperature', (p: { chipId: string; temperature: ChipTemperature }) => {
        setChips(prev => prev.map(c => c.id === p.chipId ? { ...c, temperature: p.temperature } : c))
      }),
    ]

    return () => offs.forEach(f => f())
  }, [])

  // Auto-poll enquanto algum chip está conectando sem QR ainda
  useEffect(() => {
    const pending = chips.some(c => (c.status === 'connecting' || c.status === 'init') && !c.qr)
    if (!pending) return
    const t = setTimeout(loadChips, 2000)
    return () => clearTimeout(t)
  }, [chips])

  return { chips, setChips, loadChips }
}
