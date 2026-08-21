import type { CsvContact, SmsCampaignResult } from '../../types'
export type { CsvContact }

export interface SmsBatchDelay {
  enabled: boolean
  everyMin: number
  everyMax: number
  pauseMin: number
  pauseMax: number
}

export interface SmsCampaignConfig {
  name: string
  text: string
  contacts: CsvContact[]
  instanceIds: string[]
  delayMin: number
  delayMax: number
  batchDelay?: SmsBatchDelay
  spinWithAI?: boolean
  firstNameOnly?: boolean
}

export interface SmsCampaignItem {
  id: string
  name: string
  status: 'running' | 'done'
  instanceIds: string[]
  createdAt: number
  endedAt?: number
  stats: { current: number; total: number; success: number; failed: number }
  log: string[]
  results: SmsCampaignResult[]
  waiting: number
  paused: boolean
  fromHistory: boolean
  text?: string
}

const NAMES_KEY = 'sms_campaign_names'

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
