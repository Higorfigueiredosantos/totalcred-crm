import { useEffect, useState } from 'react'
import { apiFetch } from './useChips'
import type { WuzapiInstance } from '../types'

// Estado das instâncias Wuzapi (BETA, whatsmeow). Sem WS — igual ao Infinite,
// status/QR vêm por polling.
export function useWuzapiInstances() {
  const [instances, setInstances] = useState<WuzapiInstance[]>([])

  const loadInstances = () => apiFetch('/api/wuzapi/instances').then(setInstances).catch(() => {})

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
