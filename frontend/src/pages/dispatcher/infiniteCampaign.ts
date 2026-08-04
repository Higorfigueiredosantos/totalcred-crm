import type { CsvContact, InfiniteCampaignResult, InfiniteMessageType } from '../../types'

export interface InfiniteCampaignConfig {
  name: string
  messageType: InfiniteMessageType
  payload: Record<string, unknown>
  contacts: CsvContact[]
  instanceNames: string[]
  delayMin: number
  delayMax: number
}

export interface InfiniteCampaignItem {
  id: string
  name: string
  status: 'running' | 'done'
  instanceNames: string[]
  messageType: InfiniteMessageType
  createdAt: number      // ms timestamp — usado pra desduplicar contra o histórico e ordenar
  endedAt?: number
  stats: { current: number; total: number; success: number; failed: number }
  log: string[]
  results: InfiniteCampaignResult[]
  waiting: number
  paused: boolean
  fromHistory: boolean
}

const NAMES_KEY = 'infinite_campaign_names'

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
