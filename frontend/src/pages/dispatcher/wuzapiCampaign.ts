import type { CsvContact, WuzapiCampaignResult } from '../../types'

export interface WuzapiCampaignConfig {
  name: string
  payload: { text: string; footer?: string; buttons: { id: string; text: string }[] }
  contacts: CsvContact[]
  instanceNames: string[]
  delayMin: number
  delayMax: number
}

export interface WuzapiCampaignItem {
  id: string
  name: string
  status: 'running' | 'done'
  instanceNames: string[]
  createdAt: number
  endedAt?: number
  stats: { current: number; total: number; success: number; failed: number }
  log: string[]
  results: WuzapiCampaignResult[]
  waiting: number
  paused: boolean
  fromHistory: boolean
}

const NAMES_KEY = 'wuzapi_campaign_names'

export function saveCampaignName(startedAtMs: number, name: string) {
  try {
    const map = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}')
    map[String(startedAtMs)] = name
    localStorage.setItem(NAMES_KEY, JSON.stringify(map))
  } catch { /* noop */ }
}

export function lookupCampaignName(startedAtMs: number): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}')
    return map[String(startedAtMs)] ?? null
  } catch { return null }
}
