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

// Tipos que usam o formato experimental (native_flow) — só esses ficam
// "travados em enviado" quando o WhatsApp descarta do lado do destinatário
// (confirmado: acontece consistentemente em iPhone, nunca em Menu/Lista/Enquete,
// que usam formatos nativos/legados do protocolo).
const UNRELIABLE_TYPES: InfiniteMessageType[] = ['buttons', 'imageButtons', 'imageLink', 'interactive', 'carousel']

// Tempo de espera antes de considerar que um envio "sucesso" sem confirmação de
// entrega provavelmente não chegou — recibos de entrega normalmente chegam em
// segundos quando o destinatário tem alguma conectividade.
const UNDELIVERED_THRESHOLD_MS = 5 * 60 * 1000

export function isLikelyUndelivered(result: InfiniteCampaignResult, messageType: InfiniteMessageType): boolean {
  if (result.status !== 'success') return false
  if (!UNRELIABLE_TYPES.includes(messageType)) return false
  if ((result.ack ?? 0) >= 3) return false
  if (!result.sentAt) return false
  return Date.now() - result.sentAt > UNDELIVERED_THRESHOLD_MS
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
