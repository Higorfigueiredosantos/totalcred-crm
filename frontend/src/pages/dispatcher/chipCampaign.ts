import type { ChipCampaignResult, ChipCampaignSettings, CsvContact } from '../../types'

// ── Greeting pool (mirrors backend openingPhrases) ────────────────────────────
export const ALL_GREETINGS = [
  'Oi, tudo bem?', 'Olá! Tudo certo?', 'E aí, como vai?', 'Oi! Espero que esteja bem.',
  'Bom dia! 😊', 'Boa tarde!', 'Boa noite!', 'Oi! 👋', 'Olá! 😊', 'E aí! Tudo na paz?'
]

export function parseContacts(text: string): CsvContact[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [num, ...rest] = l.split(/[,;\t]/)
    return { number: (num || '').replace(/\D/g, ''), name: rest.join(' ').trim(), vars: {} }
  }).filter(c => c.number.length >= 8)
}

export function parseCsvRaw(text: string): { allHeaders: string[]; rawRows: Record<string, string>[] } {
  const splitLine = (l: string): string[] => {
    const result: string[] = []; let cur = ''; let inQ = false
    for (const ch of l) {
      if (ch === '"') { inQ = !inQ; continue }
      if ((ch === ',' || ch === ';' || ch === '|' || ch === '\t') && !inQ) { result.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    result.push(cur.trim())
    return result
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return { allHeaders: [], rawRows: [] }
  const firstCols = splitLine(lines[0])
  const firstIsHeader = !/^\d{8,}/.test(firstCols[0].replace(/\D/g, ''))
  let allHeaders: string[]
  let dataRows: string[]
  if (firstIsHeader) {
    allHeaders = firstCols.map(h => h.toLowerCase().trim())
    dataRows = lines.slice(1)
  } else {
    allHeaders = firstCols.map((_, i) => i === 0 ? 'telefone' : i === 1 ? 'nome' : `coluna${i}`)
    dataRows = lines
  }
  const rawRows = dataRows.map(line => {
    const parts = splitLine(line)
    const row: Record<string, string> = {}
    allHeaders.forEach((h, i) => { row[h] = (parts[i] || '').trim() })
    return row
  })
  return { allHeaders, rawRows }
}

export function buildContacts(rawRows: Record<string, string>[], allHeaders: string[], phoneCol: string): { contacts: CsvContact[]; extraHeaders: string[] } {
  const nameCol = allHeaders.find(h => h !== phoneCol && /nome|name/i.test(h))
    ?? allHeaders.find(h => h !== phoneCol)
    ?? ''
  const extraHeaders = allHeaders.filter(h => h !== phoneCol && h !== nameCol)
  const contacts: CsvContact[] = rawRows.map(row => {
    const number = (row[phoneCol] ?? '').replace(/\D/g, '')
    const name = (row[nameCol] ?? '').trim()
    const vars: Record<string, string> = {}
    extraHeaders.forEach((h, i) => {
      vars[h] = row[h] ?? ''
      vars[String(i + 1)] = row[h] ?? ''
    })
    return { number, name, vars }
  }).filter(c => c.number.length >= 8)
  return { contacts, extraHeaders }
}

// ── Shared types for the unified campaigns list ───────────────────────────────

export interface ChipCampaignConfig {
  name: string
  message: string
  greetings: string[]
  imageB64: string
  contacts: CsvContact[]
  chipIds: string[]
  settings: ChipCampaignSettings
}

export interface ChipCampaignFinalStats {
  total: number; success: number; failed: number; skipped: number
  deliveryRate: string; riskLevel: string; startedAt: string; endedAt: string
  responses: number; responseRate: string
  interacted: number; interactionRate: string; notInteracted: number
}

export interface ChipCampaignItem {
  id: string
  name: string
  status: 'running' | 'done'
  chipIds: string[]
  createdAt: number      // ms timestamp — used to dedupe against history and to sort
  endedAt?: number
  stats: { current: number; total: number; success: number; failed: number }
  log: string[]
  results: ChipCampaignResult[]
  finalStats: ChipCampaignFinalStats | null
  riskLevel: string
  waiting: number
  paused: boolean
  fromHistory: boolean
}

const NAMES_KEY = 'chip_campaign_names'

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
