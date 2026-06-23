import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

let _saveTimeout: ReturnType<typeof setTimeout> | null = null

const backendStorage = {
  getItem: async (_name: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/db/state')
      if (!res.ok) return null
      const data = await res.json()
      return data ? JSON.stringify(data) : null
    } catch {
      return null
    }
  },
  setItem: async (_name: string, value: string): Promise<void> => {
    if (_saveTimeout) clearTimeout(_saveTimeout)
    _saveTimeout = setTimeout(async () => {
      try {
        await fetch('/api/db/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: value,
        })
      } catch {}
    }, 1000)
  },
  removeItem: async (_name: string): Promise<void> => {
    try { await fetch('/api/db/state', { method: 'DELETE' }) } catch {}
  },
}
import type {
  Channel, Contact, Conversation, Message, KanbanColumn,
  KanbanCard, Template, Blast, Settings, QuickReply, Label
} from '../types'

interface CRMState {
  channels: Channel[]
  contacts: Contact[]
  conversations: Conversation[]
  messages: Message[]
  kanbanColumns: KanbanColumn[]
  kanbanCards: KanbanCard[]
  templates: Template[]
  blasts: Blast[]
  settings: Settings
  activeConversationId: string | null

  // channels
  addChannel: (c: Channel) => void
  updateChannel: (id: string, data: Partial<Channel>) => void
  removeChannel: (id: string) => void

  // contacts
  addContact: (c: Contact) => void
  updateContact: (id: string, data: Partial<Contact>) => void
  removeContact: (id: string) => void

  // conversations
  addConversation: (c: Conversation) => void
  updateConversation: (id: string, data: Partial<Conversation>) => void
  setActiveConversation: (id: string | null) => void

  // messages
  addMessage: (m: Message) => void
  updateMessage: (id: string, data: Partial<Message>) => void
  markRead: (conversationId: string) => void

  // kanban
  addKanbanColumn: (col: KanbanColumn) => void
  updateKanbanColumn: (id: string, data: Partial<KanbanColumn>) => void
  removeKanbanColumn: (id: string) => void
  addKanbanCard: (card: KanbanCard) => void
  updateKanbanCard: (id: string, data: Partial<KanbanCard>) => void
  removeKanbanCard: (id: string) => void
  moveCard: (cardId: string, columnId: string, order: number) => void

  // templates
  setTemplates: (t: Template[]) => void

  // blasts
  addBlast: (b: Blast) => void
  updateBlast: (id: string, data: Partial<Blast>) => void

  // settings
  updateSettings: (data: Partial<Settings>) => void

  // quick replies
  addQuickReply: (qr: QuickReply) => void
  updateQuickReply: (id: string, data: Partial<QuickReply>) => void
  removeQuickReply: (id: string) => void

  // labels
  addLabel: (l: Label) => void
  updateLabel: (id: string, data: Partial<Label>) => void
  removeLabel: (id: string) => void

  // chip cleanup
  removeChipData: (chipId: string) => void

  // test utils
  clearConversations: () => void
  clearAllTestData: () => void
}

const defaultSettings: Settings = {
  businessName: 'Meu Negócio',
  timezone: 'America/Sao_Paulo',
  theme: 'dark',
  autoReply: false,
  autoReplyMessage: 'Olá! Recebemos sua mensagem e responderemos em breve.',
  businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1,2,3,4,5] },
  outsideHoursMessage: 'Nosso horário de atendimento é de segunda a sexta, das 9h às 18h.',
  quickReplies: [],
  labels: [],
}

const defaultColumns: KanbanColumn[] = [
  { id: 'col-1', title: 'Leads', color: '#6366f1', order: 0 },
  { id: 'col-2', title: 'Em Contato', color: '#f59e0b', order: 1 },
  { id: 'col-3', title: 'Proposta', color: '#3b82f6', order: 2 },
  { id: 'col-4', title: 'Fechado', color: '#10b981', order: 3 },
]

export const useStore = create<CRMState>()(
  persist(
    (set) => ({
      channels: [],
      contacts: [],
      conversations: [],
      messages: [],
      kanbanColumns: defaultColumns,
      kanbanCards: [],
      templates: [],
      blasts: [],
      settings: defaultSettings,
      activeConversationId: null,

      addChannel: (c) => set((s) => ({ channels: [...s.channels, c] })),
      updateChannel: (id, data) => set((s) => ({ channels: s.channels.map(c => c.id === id ? { ...c, ...data } : c) })),
      removeChannel: (id) => set((s) => ({ channels: s.channels.filter(c => c.id !== id) })),

      addContact: (c) => set((s) => ({ contacts: [...s.contacts, c] })),
      updateContact: (id, data) => set((s) => ({ contacts: s.contacts.map(c => c.id === id ? { ...c, ...data } : c) })),
      removeContact: (id) => set((s) => ({ contacts: s.contacts.filter(c => c.id !== id) })),

      addConversation: (c) => set((s) => ({ conversations: [...s.conversations, c] })),
      updateConversation: (id, data) => set((s) => ({
        conversations: s.conversations.map(c => c.id === id ? { ...c, ...data } : c)
      })),
      setActiveConversation: (id) => set({ activeConversationId: id }),

      addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
      updateMessage: (id, data) => set((s) => ({
        messages: s.messages.map(m => m.id === id ? { ...m, ...data } : m)
      })),
      markRead: (conversationId) => set((s) => ({
        conversations: s.conversations.map(c =>
          c.id === conversationId ? { ...c, unreadCount: 0 } : c
        ),
        messages: s.messages.map(m =>
          m.conversationId === conversationId && m.direction === 'inbound' ? { ...m, status: 'read' } : m
        )
      })),

      addKanbanColumn: (col) => set((s) => ({ kanbanColumns: [...s.kanbanColumns, col] })),
      updateKanbanColumn: (id, data) => set((s) => ({
        kanbanColumns: s.kanbanColumns.map(c => c.id === id ? { ...c, ...data } : c)
      })),
      removeKanbanColumn: (id) => set((s) => ({
        kanbanColumns: s.kanbanColumns.filter(c => c.id !== id),
        kanbanCards: s.kanbanCards.filter(card => card.columnId !== id),
      })),
      addKanbanCard: (card) => set((s) => ({ kanbanCards: [...s.kanbanCards, card] })),
      updateKanbanCard: (id, data) => set((s) => ({
        kanbanCards: s.kanbanCards.map(c => c.id === id ? { ...c, ...data } : c)
      })),
      removeKanbanCard: (id) => set((s) => ({ kanbanCards: s.kanbanCards.filter(c => c.id !== id) })),
      moveCard: (cardId, columnId, order) => set((s) => ({
        kanbanCards: s.kanbanCards.map(c => c.id === cardId ? { ...c, columnId, order } : c)
      })),

      setTemplates: (t) => set({ templates: t }),

      addBlast: (b) => set((s) => ({ blasts: [...s.blasts, b] })),
      updateBlast: (id, data) => set((s) => ({
        blasts: s.blasts.map(b => b.id === id ? { ...b, ...data } : b)
      })),

      updateSettings: (data) => set((s) => ({ settings: { ...s.settings, ...data } })),

      addQuickReply: (qr) => set((s) => ({ settings: { ...s.settings, quickReplies: [...(s.settings.quickReplies || []), qr] } })),
      updateQuickReply: (id, data) => set((s) => ({ settings: { ...s.settings, quickReplies: (s.settings.quickReplies || []).map(q => q.id === id ? { ...q, ...data } : q) } })),
      removeQuickReply: (id) => set((s) => ({ settings: { ...s.settings, quickReplies: (s.settings.quickReplies || []).filter(q => q.id !== id) } })),

      addLabel: (l) => set((s) => ({ settings: { ...s.settings, labels: [...(s.settings.labels || []), l] } })),
      updateLabel: (id, data) => set((s) => ({ settings: { ...s.settings, labels: (s.settings.labels || []).map(l => l.id === id ? { ...l, ...data } : l) } })),
      removeLabel: (id) => set((s) => ({ settings: { ...s.settings, labels: (s.settings.labels || []).filter(l => l.id !== id) } })),

      removeChipData: (chipId) => set((s) => {
        const channelId = 'chip:' + chipId
        const convIds = new Set(s.conversations.filter(c => c.channelId === channelId).map(c => c.id))
        return {
          conversations: s.conversations.filter(c => c.channelId !== channelId),
          messages: s.messages.filter(m => !convIds.has(m.conversationId)),
          contacts: s.contacts.filter(c => c.channelId !== channelId),
          activeConversationId: convIds.has(s.activeConversationId ?? '') ? null : s.activeConversationId,
        }
      }),

      clearConversations: () => set({ conversations: [], messages: [], activeConversationId: null }),
      clearAllTestData: () => set({ contacts: [], conversations: [], messages: [], activeConversationId: null }),
    }),
    {
      name: 'crm-whatsapp-store',
      storage: createJSONStorage(() => backendStorage),
    }
  )
)
