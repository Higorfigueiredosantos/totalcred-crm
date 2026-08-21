import type { CsvContact, WuzapiCampaignFinalStats, WuzapiCampaignResult } from '../../types'
export type { WuzapiCampaignFinalStats }

// Os 2 formatos são o mesmo endpoint (/chat/send/buttons) do lado do wuzapi —
// só muda se tem Image. Cada botão individualmente escolhe se é normal
// (reply) ou de link (cta_url), então não precisa de um tipo "link" separado.
export type WuzapiMessageType = 'buttons' | 'imageButtons'

export interface WuzapiButton {
  id: string
  text: string
  type?: 'reply' | 'url'
  url?: string
}

export interface WuzapiPayload { text: string; footer?: string; image?: string; buttons: WuzapiButton[] }

export interface WuzapiBatchDelay {
  enabled: boolean
  everyMin: number
  everyMax: number
  pauseMin: number
  pauseMax: number
}

export interface WuzapiCampaignConfig {
  name: string
  payload: WuzapiPayload
  contacts: CsvContact[]
  instanceNames: string[]
  delayMin: number
  delayMax: number
  batchDelay?: WuzapiBatchDelay
  spinWithAI?: boolean
  firstNameOnly?: boolean
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
  finalStats: WuzapiCampaignFinalStats | null
  waiting: number
  paused: boolean
  fromHistory: boolean
  payload?: WuzapiPayload
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
