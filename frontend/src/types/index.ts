export interface ProxyConfig {
  enabled: boolean
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

export interface Channel {
  id: string
  name: string
  phoneNumberId: string
  accessToken: string
  wabaId: string
  webhookVerifyToken: string
  status: 'connected' | 'disconnected' | 'error'
  phoneNumber: string
  proxy?: ProxyConfig
}

export interface Contact {
  id: string
  name: string
  phone: string        // chat ID do WhatsApp (ex: "5511999999999@c.us") — usado para envio
  waNumber?: string    // número limpo sem sufixo (ex: "5511999999999") — para exibição
  email?: string
  tags: string[]
  channelId: string
  notes?: string
  createdAt: string
  lastMessageAt?: string
}

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type MessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'template' | 'interactive'

export interface Message {
  id: string
  wamid?: string
  conversationId: string
  contactId: string
  channelId: string
  direction: 'inbound' | 'outbound'
  type: MessageType
  text?: string
  mediaUrl?: string
  mediaId?: string
  fileName?: string
  templateName?: string
  status: MessageStatus
  timestamp: string
  errorCode?: string
  errorMessage?: string
  private?: boolean  // nota interna — não enviada ao contato
}

export interface QuickReply {
  id: string
  shortcut: string   // atalho digitado após /
  message: string
}

export interface Label {
  id: string
  name: string
  color: string
}

export interface Conversation {
  id: string
  contactId: string
  channelId: string
  status: 'open' | 'pending' | 'resolved' | 'archived'
  unreadCount: number
  lastMessageAt: string
  lastMessage?: string
  assignedTo?: string
  tags: string[]
  kanbanColumnId?: string
  dealValue?: number
}

export interface KanbanColumn {
  id: string
  title: string
  color: string
  order: number
}

export interface KanbanCard {
  id: string
  conversationId: string
  contactId: string
  columnId: string
  title: string
  value?: number
  dueDate?: string
  tags: string[]
  order: number
}

export interface Template {
  id: string
  name: string
  language: string
  status: 'approved' | 'pending' | 'rejected'
  category: 'marketing' | 'utility' | 'authentication'
  components: TemplateComponent[]
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'footer' | 'buttons'
  text?: string
  format?: string
  buttons?: TemplateButton[]
}

export interface TemplateButton {
  type: 'quick_reply' | 'url' | 'phone_number'
  text: string
  url?: string
  phone?: string
}

export type BlastMode = 'standard' | 'warmup'

export type ColumnMappingMode = 'fixed' | 'csv' | 'firstname' | 'mixed'

export interface ColumnMapping {
  variable: string        // '1', '2', '3' → {{1}}, {{2}}, {{3}}
  mode: ColumnMappingMode
  // csv mode
  csvColumn: string
  // fixed mode
  fixedValue: string
  // mixed mode — free text with {column_name} placeholders
  mixedTemplate: string   // ex: "Olá {nome}, seu CPF {cpf}"
  // firstname mode
  firstNameColumn: string // column with full name
  firstNameExtra: string  // optional wrapper ex: "Oi {nome}!"
  // legacy compat (kept so old blasts don't break)
  mixedPrefix: string
  mixedSuffix: string
}

export interface BlastRecipient {
  phone: string
  name: string
  contactId?: string
  preferredChannelId?: string
  templateParams: Record<string, string>  // variable → resolved value
}

export interface Blast {
  id: string
  name: string
  channelIds: string[]
  templateId?: string
  templateImageFile?: string
  message?: string
  contacts: string[]          // CRM contact IDs
  recipients?: BlastRecipient[] // pre-computed (CSV)
  mode: BlastMode
  status: 'draft' | 'scheduled' | 'running' | 'done' | 'failed'
  scheduledAt?: string
  sentAt?: string
  stats: {
    total: number
    processed: number
    sent: number
    waiting: number
    delivered: number
    read: number
    engaged: number
    failed: number
    buttonClicks?: Record<string, number>
    failureBreakdown?: Record<string, number>
  }
  log?: string[]
}

export interface Settings {
  businessName: string
  timezone: string
  theme?: 'dark' | 'light'
  autoReply: boolean
  autoReplyMessage: string
  businessHours: {
    enabled: boolean
    start: string
    end: string
    days: number[]
  }
  outsideHoursMessage: string
  quickReplies: QuickReply[]
  labels: Label[]
}

// ── Chip (whatsapp-web.js) types ─────────────────────────────────────────────

export type ChipStatus = 'init' | 'connecting' | 'qr' | 'connected' | 'disconnected' | 'error' | 'auth_failure'
export type ChipTemperature = 'frio' | 'morno' | 'quente'

export interface Chip {
  id: string
  status: ChipStatus
  number: string | null
  isReady: boolean
  reconnectAttempts: number
  qr: string | null
  errorMsg?: string | null
  temperature: ChipTemperature
  proxy?: string | null
}

export interface AutobotRule {
  id: string
  trigger: string        // keyword(s) separated by |, or * for any
  response: string
  matchType: 'contains' | 'exact'
}

export interface AutobotConfig {
  active: boolean
  rules: AutobotRule[]
  workingHours: {
    enabled: boolean
    start: string
    end: string
    days: number[]       // 1=Mon … 7=Sun
  }
  antiSpamMinutes: number
  aiEnabled: boolean
  escalationWord: string
  pausedContacts: string[]
}

export interface ChipContact {
  number: string
  name: string
}

export interface ChipCampaignResult {
  index: number
  number: string
  name: string
  status: 'success' | 'failed' | 'sending'
  message?: string
  error?: string
  via: string
  ack?: number
  sentAt?: number  // ms timestamp of successful dispatch
}

export interface CampaignHistoryRecord {
  id: string
  startedAt: number
  endedAt: number
  total: number
  success: number
  failed: number
  skipped: number
  results: ChipCampaignResult[]
}

export interface ChipCampaignSettings {
  delayMin: number
  delayMax: number
  useAIHumanize: boolean
  tone: 'amigavel' | 'profissional' | 'casual'
  force?: boolean
  greetings?: string[]
  selectedChipIds?: string[]
  batchDelay?: {
    enabled: boolean
    everyMin: number
    everyMax: number
    pauseMin: number
    pauseMax: number
  }
}

export interface CsvContact {
  number: string
  name: string
  vars: Record<string, string>
}
