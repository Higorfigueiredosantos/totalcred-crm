import { useEffect, useState } from 'react'
import { apiFetch } from './useChips'
import type { InfiniteInstance } from '../types'

// Estado das instâncias Infinite (baileys_interactive). Sem WS — o serviço não
// tem webhook, então status/QR são obtidos por polling, igual à própria
// interface web do baileys_interactive.
export function useInfiniteInstances() {
  const [instances, setInstances] = useState<InfiniteInstance[]>([])

  const loadInstances = () => apiFetch('/api/infinite/instances').then(setInstances).catch(() => {})

  useEffect(() => {
    loadInstances()
  }, [])

  useEffect(() => {
    const pending = instances.some(i => i.status === 'connecting' || i.status === 'qr')
    const t = setTimeout(loadInstances, pending ? 2000 : 10000)
    return () => clearTimeout(t)
  }, [instances])

  return { instances, setInstances, loadInstances }
}
