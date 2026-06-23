import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useStore } from '../store'
import { useAuthStore } from '../store/auth'
import type { Message } from '../types'
import { v4 as uuid } from '../utils/uuid'
import { format } from 'date-fns'
import {
  Send, Search, Check, CheckCheck, Clock, AlertCircle, Archive,
  Smartphone, Lock, Tag, User, Phone, Calendar, ChevronRight, ChevronLeft, X, Edit2,
  Paperclip, FileText, Image, Video, Users, Download, Mic,
  Smile, StopCircle, Trash2,
} from 'lucide-react'
import { sendTextMessage, markMessageRead, uploadMedia, sendMediaMessage } from '../api/whatsapp'
import { onWSMessage, connectWS } from '../api/websocket'
import { apiFetch } from '../api/client'

// ── Emoji data ────────────────────────────────────────────────────────────────
const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Recentes & Rostos', emojis: ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','😉','😍','🥰','😘','😋','😛','😜','🤪','😎','🥸','😏','😒','😔','😟','😢','😭','😤','😠','🤬','😳','😱','🤗','🤔','🤭','😶','😬','🙄','😴','🤢','🤧','😷','🤒','😵'] },
  { label: 'Gestos', emojis: ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','🙏','👏','🙌','👐','🤝','✊','👊','🤛','🤜','🫶','💪','🫂'] },
  { label: 'Corações', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','🔥','✨','⭐','🌟','💫'] },
  { label: 'Natureza', emojis: ['🌹','🌺','🌸','🌻','🌼','🌷','💐','🍀','🌿','🌱','🌲','🌳','🍁','🍂','🌊','🌈','⚡','❄️','☀️','🌙','⭐','🌟','💧','🔥'] },
  { label: 'Comida', emojis: ['🍕','🍔','🌮','🌯','🍜','🍝','🍣','🍱','🥗','🍚','🍛','🥪','🧆','🥞','☕','🍺','🍷','🥂','🍾','🧃','🥤','🍹','🎂','🍰','🍫','🍬','🍭'] },
  { label: 'Viagem & Objetos', emojis: ['🚀','✈️','🚗','🏠','🏆','🎉','🎊','🎈','🎁','🎀','🏅','🥇','🎯','💡','📱','💻','📞','🔔','💬','📸','🎵','🎶','🎸','🎤','📺','🎮','⚽','🏀','🎾','⚾'] },
]

const CHIP_PREFIX = 'chip:'
const isChipConv = (channelId: string) => channelId?.startsWith(CHIP_PREFIX)
const chipIdFromChannelId = (channelId: string) => channelId?.slice(CHIP_PREFIX.length)

function statusIcon(status: string) {
  if (status === 'sending')   return <Clock size={13} className="text-white/50" />
  if (status === 'sent')      return <Check size={13} className="text-white/70" />
  if (status === 'delivered') return <CheckCheck size={13} className="text-white/80" />
  if (status === 'read')      return <CheckCheck size={13} className="text-sky-300" />
  if (status === 'failed')    return <AlertCircle size={13} className="text-red-300" />
  return null
}

function getMediaType(file: File): 'image' | 'audio' | 'video' | 'document' {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  return 'document'
}

// Parse group message format "[senderNum] body"
function parseGroupMsg(text: string): { sender: string; body: string } | null {
  const m = text?.match(/^\[(\d+)\] ([\s\S]*)$/)
  return m ? { sender: m[1], body: m[2] } : null
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

// ── Message bubble media renderer ─────────────────────────────────────────────

function MediaBubble({ msg, outbound }: { msg: Message; outbound: boolean }) {
  const cls = outbound ? 'text-indigo-200' : 'text-gray-300'
  switch (msg.type) {
    case 'image':
      return msg.mediaUrl ? (
        <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer">
          <img src={msg.mediaUrl} alt={msg.fileName ?? 'imagem'} className="max-w-[220px] rounded-lg mb-1" />
        </a>
      ) : (
        <div className={`flex items-center gap-2 py-1 ${cls}`}>
          <Image size={18} /> <span className="text-xs">{msg.fileName ?? 'Imagem'}</span>
        </div>
      )
    case 'audio':
      return msg.mediaUrl ? (
        <audio controls src={msg.mediaUrl} className="max-w-[220px] w-full h-9 my-1"
          style={{ colorScheme: 'dark' }} />
      ) : (
        <div className={`flex items-center gap-2 py-1 ${cls}`}>
          <Mic size={18} />
          <span className="text-xs">{msg.fileName ?? '🎵 Nota de voz'}</span>
        </div>
      )
    case 'video':
      return msg.mediaUrl ? (
        <video controls src={msg.mediaUrl} className="max-w-[220px] rounded-lg mb-1" />
      ) : (
        <div className={`flex items-center gap-2 py-1 ${cls}`}>
          <Video size={18} /> <span className="text-xs">{msg.fileName ?? 'Vídeo'}</span>
        </div>
      )
    case 'document':
      return (
        <div className={`flex items-center gap-2 py-1 ${cls}`}>
          <FileText size={18} />
          <div className="flex-1 min-w-0">
            <p className="text-xs truncate">{msg.fileName ?? 'Arquivo'}</p>
          </div>
          {msg.mediaUrl && (
            <a href={msg.mediaUrl} download={msg.fileName} target="_blank" rel="noopener noreferrer"
              className="p-1 rounded hover:bg-white/10">
              <Download size={13} />
            </a>
          )}
        </div>
      )
    default:
      return null
  }
}

export default function Messages() {
  const {
    conversations, contacts, channels, messages, settings,
    activeConversationId, setActiveConversation,
    addMessage, updateMessage, updateConversation, markRead,
    addConversation, addContact, updateContact, removeChipData,
    kanbanCards, kanbanColumns, addKanbanCard,
  } = useStore()

  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [channelFilter, setChannelFilter] = useState<string[]>([])
  const [labelFilter, setLabelFilter] = useState<string[]>([])
  const [filterPanelOpen, setFilterPanelOpen] = useState(true)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [isPrivateMode, setIsPrivateMode] = useState(false)
  const [showInfoPanel, setShowInfoPanel] = useState(true)
  const [quickReplySuggestions, setQuickReplySuggestions] = useState<typeof settings.quickReplies>([])
  const [mediaPending, setMediaPending] = useState<{ file: File; previewUrl: string } | null>(null)
  const [groupMembers, setGroupMembers] = useState<string[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [isRecording, setIsRecording]     = useState(false)
  const [recordingSecs, setRecordingSecs] = useState(0)
  const [showEmoji, setShowEmoji]         = useState(false)

  const messagesRef       = useRef(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])

  const kanbanCardsRef   = useRef(kanbanCards)
  useEffect(() => { kanbanCardsRef.current = kanbanCards }, [kanbanCards])
  const kanbanColumnsRef = useRef(kanbanColumns)
  useEffect(() => { kanbanColumnsRef.current = kanbanColumns }, [kanbanColumns])

  // Adiciona conversa nova ao primeiro colunas do Pipeline (Leads), ignorando grupos
  function addToLeads(convId: string, contactId: string, title: string) {
    if (kanbanCardsRef.current.some(c => c.conversationId === convId)) return
    const leadsCol = [...kanbanColumnsRef.current].sort((a, b) => a.order - b.order)[0]
    if (!leadsCol) return
    addKanbanCard({ id: uuid(), conversationId: convId, contactId, columnId: leadsCol.id, title, tags: [], order: Date.now() })
  }

  const messagesEndRef    = useRef<HTMLDivElement>(null)
  const textareaRef       = useRef<HTMLTextAreaElement>(null)
  const fileInputRef      = useRef<HTMLInputElement>(null)
  const audioInputRef     = useRef<HTMLInputElement>(null)
  const emojiRef          = useRef<HTMLDivElement>(null)
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null)
  const audioChunksRef    = useRef<Blob[]>([])
  const recTimerRef       = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { connectWS() }, [])

  // ── Cleanup orphaned chip data on mount ─────────────────────────────────────
  useEffect(() => {
    fetch('/api/chips')
      .then(r => r.json())
      .then((chips: { id: string }[]) => {
        if (!Array.isArray(chips) || chips.length === 0) return
        const activeIds = new Set(chips.map((c: { id: string }) => c.id))
        const chipChannelIds = new Set(
          conversations
            .filter(c => isChipConv(c.channelId))
            .map(c => chipIdFromChannelId(c.channelId))
        )
        chipChannelIds.forEach(chipId => {
          if (!activeIds.has(chipId)) removeChipData(chipId)
        })
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Meta API inbound ────────────────────────────────────────────────────────
  const handleMetaInbound = useCallback((payload: any) => {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value) continue

    if (!value?.messages) {
      for (const status of value?.statuses ?? []) {
        const m = messages.find(m => m.wamid === status.id)
        if (m) updateMessage(m.id, { status: status.status })
      }
      continue
    }

    for (const msg of value.messages) {
      const from = msg.from
      const channelPhoneId = value.metadata?.phone_number_id
      const channel = channels.find(ch => String(ch.phoneNumberId).trim() === String(channelPhoneId).trim())
      if (!channel) {
        console.warn('[Meta] Canal não encontrado para phoneNumberId:', channelPhoneId, '| Canais cadastrados:', channels.map(c => c.phoneNumberId))
        continue
      }

      let contact = contacts.find(c => c.phone === `+${from}` || c.phone === from)
      if (!contact) {
        contact = {
          id: uuid(), name: value.contacts?.[0]?.profile?.name ?? from,
          phone: `+${from}`, tags: [], channelId: channel.id, createdAt: new Date().toISOString(),
        }
        addContact(contact)
      }

      let conv = conversations.find(c => c.contactId === contact!.id && c.channelId === channel.id)
      if (!conv) {
        conv = {
          id: uuid(), contactId: contact.id, channelId: channel.id,
          status: 'open', unreadCount: 1, lastMessageAt: new Date().toISOString(), tags: [],
        }
        addConversation(conv)
        addToLeads(conv.id, contact.id, value.contacts?.[0]?.profile?.name ?? from)
      }

      const rawType = msg.type ?? 'text'
      // sticker → image para compatibilidade com MediaBubble
      const msgType: Message['type'] = rawType === 'sticker' ? 'image' : rawType

      // Proxy para baixar mídia da Meta (imagem, vídeo, áudio, doc) via backend
      const metaMediaId = msg.image?.id || msg.audio?.id || msg.video?.id
        || msg.document?.id || msg.sticker?.id
      const mediaUrl = metaMediaId
        ? `/api/media/meta?id=${encodeURIComponent(metaMediaId)}&token=${encodeURIComponent(channel.accessToken)}&phoneId=${encodeURIComponent(channel.phoneNumberId)}`
        : undefined

      const textContent = msg.text?.body
        || msg.image?.caption || msg.video?.caption
        || msg.document?.caption || msg.document?.filename
        || undefined

      const fileNameContent = msg.document?.filename || msg.image?.filename
        || msg.audio?.filename || undefined

      const newMsg: Message = {
        id: uuid(), wamid: msg.id, conversationId: conv.id,
        contactId: contact.id, channelId: channel.id,
        direction: 'inbound', type: msgType,
        text: textContent,
        fileName: fileNameContent,
        mediaUrl,
        status: 'delivered', timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
      }
      addMessage(newMsg)

      const lastMsgLabel = msgType !== 'text'
        ? (msgType === 'image' ? '📷 Imagem' : msgType === 'audio' ? '🎵 Áudio' : msgType === 'video' ? '🎬 Vídeo' : `📄 ${fileNameContent ?? 'Arquivo'}`)
        : (textContent ?? `[${msgType}]`)

      updateConversation(conv.id, {
        unreadCount: (conv.unreadCount ?? 0) + 1,
        lastMessage: lastMsgLabel,
        lastMessageAt: newMsg.timestamp,
        status: 'open',
      })

      if (activeConversationId === conv.id) {
        markRead(conv.id)
        markMessageRead(channel.phoneNumberId, channel.accessToken, msg.id).catch(() => {})
      }
    }

    for (const status of value.statuses ?? []) {
      const m = messages.find(m => m.wamid === status.id)
      if (m) updateMessage(m.id, { status: status.status })
    }
      } // end for change
    } // end for entry
  }, [channels, contacts, conversations, messages, activeConversationId,
      addContact, addConversation, addMessage, updateMessage, updateConversation, markRead])

  // ── Chip inbound ────────────────────────────────────────────────────────────
  const seenChipMsgs = useRef(new Set<string>())

  const handleChipInbound = useCallback((payload: any) => {
    const { chipId, from, author, body, timestamp, isGroup, groupName, pushname, contactNumber,
            msgType, mediaUrl, mediaFileName } = payload
    if (!chipId || !from) return

    const msgKey = `${from}:${timestamp}:${body || mediaFileName || msgType}`
    if (seenChipMsgs.current.has(msgKey)) return
    seenChipMsgs.current.add(msgKey)
    if (seenChipMsgs.current.size > 500) seenChipMsgs.current.clear()

    // Bloqueia grupos se a opção estiver desativada para este chip
    if (isGroup) {
      try {
        const groupSettings = JSON.parse(localStorage.getItem('chip_group_settings') || '{}')
        if (!groupSettings[chipId]) return
      } catch { return }
    }

    const channelId = CHIP_PREFIX + chipId
    const chatId = from

    const fromUser = from.replace(/@.*$/, '')
    const isLid = from.includes('@lid') || fromUser.length > 13
    const cleanNumber = contactNumber || (isLid ? null : fromUser) || null

    const displayName = isGroup
      ? (groupName || fromUser)
      : (pushname || cleanNumber || fromUser)

    let contact = contacts.find(c => c.phone === chatId)
    if (!contact) {
      contact = {
        id: uuid(), name: displayName,
        phone: chatId,
        ...(cleanNumber ? { waNumber: cleanNumber } : {}),
        tags: [], channelId, createdAt: new Date().toISOString(),
      }
      addContact(contact)
    } else {
      const updates: Record<string, any> = {}
      if (!isGroup && pushname && contact.name !== pushname) updates.name = pushname
      if (isGroup && groupName && contact.name !== groupName) updates.name = groupName
      if (cleanNumber && cleanNumber !== contact.waNumber) updates.waNumber = cleanNumber
      if (Object.keys(updates).length) updateContact(contact.id, updates)
    }

    let conv = conversations.find(c => c.contactId === contact!.id && c.channelId === channelId)
    if (!conv) {
      conv = {
        id: uuid(), contactId: contact.id, channelId,
        status: 'open', unreadCount: 1, lastMessageAt: new Date().toISOString(), tags: [],
      }
      addConversation(conv)
      if (!isGroup) addToLeads(conv.id, contact.id, displayName)
    }

    const ts = timestamp
      ? new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString()
      : new Date().toISOString()

    const senderNum = author ? author.replace(/@.*$/, '') : ''
    const type = (msgType as Message['type']) || 'text'
    const textBody = body || ''
    const displayBody = isGroup && senderNum && textBody ? `[${senderNum}] ${textBody}` : textBody

    const lastMsgLabel = type !== 'text'
      ? (type === 'image' ? '📷 Imagem' : type === 'audio' ? '🎵 Áudio' : type === 'video' ? '🎬 Vídeo' : '📄 Arquivo')
      : displayBody

    const newMsg: Message = {
      id: uuid(), conversationId: conv.id,
      contactId: contact.id, channelId,
      direction: 'inbound',
      type,
      text: displayBody || undefined,
      mediaUrl: mediaUrl || undefined,
      fileName: mediaFileName || undefined,
      status: 'delivered', timestamp: ts,
    }
    addMessage(newMsg)
    updateConversation(conv.id, {
      unreadCount: activeConversationId === conv.id ? 0 : (conv.unreadCount ?? 0) + 1,
      lastMessage: lastMsgLabel,
      lastMessageAt: ts,
      status: 'open',
    })
    if (activeConversationId === conv.id) markRead(conv.id)
  }, [contacts, conversations, activeConversationId,
      addContact, updateContact, addConversation, addMessage, updateConversation, markRead])

  useEffect(() => onWSMessage('whatsapp', handleMetaInbound), [handleMetaInbound])
  useEffect(() => onWSMessage('chip_message', handleChipInbound), [handleChipInbound])

  // Atualiza status da mensagem (✓ enviado / ✓✓ entregue / ✓✓ azul lido)
  // Usa ref para sempre ler as mensagens atuais sem re-registrar o listener
  useEffect(() => onWSMessage('chip_ack', (payload: any) => {
    const { msgId, status } = payload
    if (!msgId || !status) return
    const m = messagesRef.current.find(msg => msg.wamid === msgId)
    if (m) updateMessage(m.id, { status })
  }), [updateMessage])

  useEffect(() => {
    if (activeConversationId) {
      markRead(activeConversationId)
      const conv = conversations.find(c => c.id === activeConversationId)
      if (conv && !isChipConv(conv.channelId)) {
        const ch = channels.find(c => c.id === conv.channelId)
        if (ch) {
          const unread = messages.filter(m => m.conversationId === activeConversationId && m.direction === 'inbound' && m.wamid)
          unread.forEach(m => markMessageRead(ch.phoneNumberId, ch.accessToken, m.wamid!).catch(() => {}))
        }
      }
    }
  }, [activeConversationId])

  // Reset group members when conversation changes
  useEffect(() => {
    setGroupMembers([])
  }, [activeConversationId])

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmoji) return
    function onDown(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmoji(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showEmoji])

  // ── Audio recording ─────────────────────────────────────────────────────────
  function getBestMime() {
    const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4']
    return types.find(t => MediaRecorder.isTypeSupported(t)) || ''
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = getBestMime()
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      mediaRecorderRef.current = mr
      audioChunksRef.current = []

      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' })
        const ext  = mr.mimeType.includes('ogg') ? 'ogg' : mr.mimeType.includes('mp4') ? 'mp4' : 'webm'
        const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: blob.type })
        setMediaPending({ file, previewUrl: URL.createObjectURL(file) })
        stream.getTracks().forEach(t => t.stop())
      }

      mr.start(100)
      setIsRecording(true)
      setRecordingSecs(0)
      recTimerRef.current = setInterval(() => setRecordingSecs(s => s + 1), 1000)
    } catch (e: any) {
      setSendError('Microfone não disponível: ' + e.message)
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    setIsRecording(false)
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    setRecordingSecs(0)
  }

  function cancelRecording() {
    const mr = mediaRecorderRef.current
    if (mr) {
      mr.ondataavailable = null
      mr.onstop = () => { mr.stream?.getTracks().forEach(t => t.stop()) }
      mr.stop()
    }
    setIsRecording(false)
    audioChunksRef.current = []
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    setRecordingSecs(0)
  }

  function fmtSecs(s: number) {
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeConversationId])

  // ── Quick replies ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (text.startsWith('/')) {
      const query = text.slice(1).toLowerCase()
      setQuickReplySuggestions((settings.quickReplies || []).filter(qr =>
        qr.shortcut.toLowerCase().includes(query) || qr.message.toLowerCase().includes(query)
      ))
    } else {
      setQuickReplySuggestions([])
    }
  }, [text, settings.quickReplies])

  // ── Available channels ──────────────────────────────────────────────────────
  const availableChannels = useMemo(() => {
    const seen = new Set<string>()
    const result: { id: string; name: string }[] = []
    for (const conv of conversations) {
      if (!seen.has(conv.channelId)) {
        seen.add(conv.channelId)
        if (isChipConv(conv.channelId)) {
          result.push({ id: conv.channelId, name: `Chip: ${chipIdFromChannelId(conv.channelId)}` })
        } else {
          const ch = channels.find(c => c.id === conv.channelId)
          result.push({ id: conv.channelId, name: ch?.name ?? conv.channelId.slice(0, 10) + '…' })
        }
      }
    }
    return result
  }, [conversations, channels])

  // ── Permission filter ────────────────────────────────────────────────────────
  const { isAdmin, allowedChannelIds, allowedChipIds } = useAuthStore()
  const allowedConversations = useMemo(() => {
    if (isAdmin()) return conversations
    const cIds = allowedChannelIds()
    const sIds = allowedChipIds()
    return conversations.filter(c => {
      if (c.channelId?.startsWith('chip:')) {
        const chipId = c.channelId.replace('chip:', '')
        return sIds.includes(chipId)
      }
      return cIds.includes(c.channelId)
    })
  }, [conversations, isAdmin, allowedChannelIds, allowedChipIds])

  // ── Filtered conversations ──────────────────────────────────────────────────
  const sortedConvs = useMemo(() => [...allowedConversations]
    .filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (channelFilter.length > 0 && !channelFilter.includes(c.channelId)) return false
      if (labelFilter.length > 0 && !labelFilter.some(lid => (c.tags || []).includes(lid))) return false
      const contact = contacts.find(x => x.id === c.contactId)
      if (search) {
        const q = search.toLowerCase()
        if (!contact?.name.toLowerCase().includes(q) &&
            !contact?.phone.includes(search) &&
            !(c.tags || []).some(tagId => (settings.labels || []).find(l => l.id === tagId)?.name.toLowerCase().includes(q)))
          return false
      }
      return true
    })
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()),
  [allowedConversations, contacts, statusFilter, channelFilter, labelFilter, search])

  const activeConv    = conversations.find(c => c.id === activeConversationId)
  const activeContact = contacts.find(c => c.id === activeConv?.contactId)
  const activeChannel = channels.find(c => c.id === activeConv?.channelId)
  const activeChipId  = activeConv && isChipConv(activeConv.channelId) ? chipIdFromChannelId(activeConv.channelId) : null
  const isGroupConv   = activeContact?.phone?.endsWith('@g.us') ?? false

  const convMessages = useMemo(() =>
    messages.filter(m => m.conversationId === activeConversationId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [messages, activeConversationId])

  // ── Phone formatting ────────────────────────────────────────────────────────
  function formatWaNumber(raw: string | null | undefined): string {
    if (!raw) return '—'
    const num = raw.replace(/@.*$/, '').trim()
    if (num.length > 13) return '—'
    const m13 = num.match(/^(\d{2})(\d{2})(\d{5})(\d{4})$/)
    if (m13) return `+${m13[1]} (${m13[2]}) ${m13[3]}-${m13[4]}`
    const m12 = num.match(/^(\d{2})(\d{2})(\d{4})(\d{4})$/)
    if (m12) return `+${m12[1]} (${m12[2]}) ${m12[3]}-${m12[4]}`
    return num
  }
  const displayPhone = activeContact?.waNumber
    ? formatWaNumber(activeContact.waNumber)
    : formatWaNumber(activeContact?.phone)

  // ── Phone edit ──────────────────────────────────────────────────────────────
  const [editingPhone, setEditingPhone] = useState(false)
  const [phoneEditValue, setPhoneEditValue] = useState('')

  function savePhoneEdit() {
    if (!activeContact) return
    const raw = phoneEditValue.trim().replace(/\D/g, '')
    if (!raw) { setEditingPhone(false); return }
    const withCountry = raw.startsWith('55') ? raw : '55' + raw
    updateContact(activeContact.id, { waNumber: raw, phone: withCountry + '@c.us' })
    setEditingPhone(false)
  }

  // ── Group members ───────────────────────────────────────────────────────────
  async function fetchGroupMembers() {
    if (!activeChipId || !activeContact?.phone) return
    setLoadingMembers(true)
    try {
      const r = await fetch('/api/tools/groups/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chipId: activeChipId, groupId: activeContact.phone })
      })
      const d = await r.json()
      if (Array.isArray(d.members)) {
        setGroupMembers(d.members.map((m: any) => m.id?.user || m.number || String(m)))
      }
    } catch {}
    setLoadingMembers(false)
  }

  // ── Send text ───────────────────────────────────────────────────────────────
  async function handleSend() {
    // If media is pending, send media (text becomes caption)
    if (mediaPending) {
      await handleSendMedia(mediaPending.file, text.trim() || undefined)
      setText('')
      return
    }

    if (!text.trim() || !activeConv || sending) return
    setSendError(null)

    const msgText = text.trim()
    const msgId = uuid()
    setText('')
    setIsPrivateMode(false)

    if (isPrivateMode) {
      addMessage({
        id: msgId, conversationId: activeConv.id,
        contactId: activeConv.contactId, channelId: activeConv.channelId,
        direction: 'outbound', type: 'text', text: msgText,
        status: 'sent', timestamp: new Date().toISOString(), private: true,
      })
      return
    }

    setSending(true)
    const msg: Message = {
      id: msgId, conversationId: activeConv.id,
      contactId: activeConv.contactId, channelId: activeConv.channelId,
      direction: 'outbound', type: 'text', text: msgText,
      status: 'sending', timestamp: new Date().toISOString(),
    }
    addMessage(msg)
    updateConversation(activeConv.id, { lastMessage: msgText, lastMessageAt: msg.timestamp })

    try {
      if (activeChipId) {
        const chatId = activeContact?.phone ?? ''
        if (!chatId) throw new Error('ID do contato não encontrado')
        const r = await apiFetch('/api/chips/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chipId: activeChipId, to: chatId, message: msgText })
        })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Erro ao enviar via chip')
        updateMessage(msgId, { status: 'sent', wamid: d.msgId })
      } else if (activeChannel) {
        const wamid = await sendTextMessage(
          activeChannel.phoneNumberId, activeChannel.accessToken,
          activeContact!.phone, msgText, activeChannel.proxy
        )
        updateMessage(msgId, { status: 'sent', wamid })
      } else {
        throw new Error('Nenhum canal disponível para envio')
      }
    } catch (e: any) {
      updateMessage(msgId, { status: 'failed', errorMessage: e.message })
      setSendError(e.message)
    } finally {
      setSending(false)
    }
  }

  // ── Send media ──────────────────────────────────────────────────────────────
  async function handleSendMedia(file: File, caption?: string) {
    if (!activeConv || sending) return
    setSendError(null)
    setSending(true)
    setMediaPending(null)

    const msgId    = uuid()
    const type     = getMediaType(file)
    const localUrl = URL.createObjectURL(file)

    const msg: Message = {
      id: msgId, conversationId: activeConv.id,
      contactId: activeConv.contactId, channelId: activeConv.channelId,
      direction: 'outbound', type, text: caption || undefined,
      mediaUrl: localUrl, fileName: file.name,
      status: 'sending', timestamp: new Date().toISOString(),
    }
    addMessage(msg)
    updateConversation(activeConv.id, {
      lastMessage: `[${type === 'image' ? '🖼' : type === 'audio' ? '🎵' : type === 'video' ? '🎬' : '📄'}] ${file.name}`,
      lastMessageAt: msg.timestamp,
    })

    try {
      if (activeChipId) {
        const chatId = activeContact?.phone ?? ''
        if (!chatId) throw new Error('ID do contato não encontrado')
        const fd = new FormData()
        fd.append('chipId', activeChipId)
        fd.append('to', chatId)
        if (caption) fd.append('caption', caption)
        fd.append('file', file)
        const r = await apiFetch('/api/chips/send-media', { method: 'POST', body: fd })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Erro ao enviar mídia via chip')
        updateMessage(msgId, { status: 'sent', wamid: d.msgId })
      } else if (activeChannel) {
        // Converte audio/webm para audio/ogg via backend (Meta não aceita webm)
        if (type === 'audio') {
          const mime = file.type.split(';')[0].trim()
          const metaAudioOk = ['audio/ogg','audio/aac','audio/mp4','audio/mpeg','audio/amr'].includes(mime)
          if (!metaAudioOk) {
            const formData = new FormData()
            formData.append('file', file, 'audio.webm')
            const convRes = await fetch('/api/media/convert-audio', { method: 'POST', body: formData })
            if (!convRes.ok) throw new Error('Falha ao converter áudio para formato compatível com Meta')
            const blob = await convRes.blob()
            file = new File([blob], 'audio.ogg', { type: 'audio/ogg' })
          }
        }
        const mediaId = await uploadMedia(activeChannel.phoneNumberId, activeChannel.accessToken, file, activeChannel.proxy)
        // Meta API não aceita caption em mensagens de áudio
        const wamid = await sendMediaMessage(
          activeChannel.phoneNumberId, activeChannel.accessToken,
          activeContact!.phone, type, mediaId,
          type === 'audio' ? undefined : caption,
          activeChannel.proxy
        )
        updateMessage(msgId, { status: 'sent', wamid, mediaId })
      } else {
        throw new Error('Nenhum canal disponível para envio')
      }
    } catch (e: any) {
      updateMessage(msgId, { status: 'failed', errorMessage: e.message })
      setSendError(e.message)
    } finally {
      setSending(false)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (mediaPending) URL.revokeObjectURL(mediaPending.previewUrl)
    setMediaPending({ file, previewUrl: URL.createObjectURL(file) })
    e.target.value = ''
  }

  function clearMedia() {
    if (mediaPending) URL.revokeObjectURL(mediaPending.previewUrl)
    setMediaPending(null)
  }

  function applyQuickReply(message: string) {
    setText(message)
    setQuickReplySuggestions([])
    textareaRef.current?.focus()
  }

  function toggleConvLabel(labelId: string) {
    if (!activeConv) return
    const current = activeConv.tags || []
    updateConversation(activeConv.id, {
      tags: current.includes(labelId) ? current.filter(t => t !== labelId) : [...current, labelId]
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Filter side panel (Canais + Etiquetas) ──────────────────────────── */}
      <div className={`${filterPanelOpen ? 'w-44' : 'w-0'} transition-all duration-200 overflow-hidden shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col`}>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-4 min-w-[11rem]">

          {/* Canais */}
          <div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-1 mb-1.5">Canais</p>
            <button
              onClick={() => setChannelFilter([])}
              className={`w-full text-left px-2 py-1.5 text-xs rounded-lg mb-0.5 transition-colors ${channelFilter.length === 0 ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}>
              Todos
            </button>
            {availableChannels.map(ch => {
              const active = channelFilter.includes(ch.id)
              const isChip = isChipConv(ch.id)
              return (
                <button key={ch.id}
                  onClick={() => setChannelFilter(prev => active ? prev.filter(c => c !== ch.id) : [...prev, ch.id])}
                  className={`w-full text-left flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-lg mb-0.5 transition-colors truncate ${active ? (isChip ? 'bg-green-700/80 text-white' : 'bg-blue-700/80 text-white') : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}>
                  {isChip ? <Smartphone size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />}
                  <span className="truncate">{ch.name}</span>
                </button>
              )
            })}
          </div>

          {/* Etiquetas */}
          {(settings.labels || []).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-1 mb-1.5">Etiquetas</p>
              <button
                onClick={() => setLabelFilter([])}
                className={`w-full text-left px-2 py-1.5 text-xs rounded-lg mb-0.5 transition-colors ${labelFilter.length === 0 ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}>
                Todas
              </button>
              {(settings.labels || []).map(label => {
                const active = labelFilter.includes(label.id)
                return (
                  <button key={label.id}
                    onClick={() => setLabelFilter(prev => active ? prev.filter(id => id !== label.id) : [...prev, label.id])}
                    className={`w-full text-left flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-lg mb-0.5 transition-colors truncate ${active ? 'text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                    style={active ? { background: label.color + 'aa' } : {}}>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: label.color }} />
                    <span className="truncate">{label.name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Minimizar painel */}
        <div className="border-t border-gray-800 p-1 min-w-[11rem]">
          <button onClick={() => setFilterPanelOpen(false)}
            className="w-full flex items-center justify-center py-1.5 text-gray-600 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors text-xs gap-1">
            <ChevronLeft size={13} /> Recolher
          </button>
        </div>
      </div>

      {/* Botão para reabrir painel quando fechado */}
      {!filterPanelOpen && (
        <button onClick={() => setFilterPanelOpen(true)}
          className="shrink-0 w-6 flex flex-col items-center justify-center bg-gray-900 border-r border-gray-800 text-gray-600 hover:text-gray-300 hover:bg-gray-800/50 transition-colors"
          title="Abrir filtros">
          <ChevronRight size={13} />
        </button>
      )}

      {/* ── Conversation list ─────────────────────────────────────────────── */}
      <div className="w-72 border-r border-gray-800 flex flex-col bg-gray-900 shrink-0">
        <div className="p-3 border-b border-gray-800 space-y-2">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-xs text-white focus:outline-none"
              placeholder="Buscar conversas..." />
          </div>
          <div className="flex gap-1">
            {(['all','open','pending','resolved'] as const).map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`flex-1 px-2 py-1 text-xs rounded-lg ${statusFilter === s ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                {s === 'all' ? 'Todas' : s === 'open' ? 'Abertas' : s === 'pending' ? 'Pend.' : 'Resol.'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sortedConvs.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-xs">Nenhuma conversa</div>
          ) : sortedConvs.map(conv => {
            const contact = contacts.find(c => c.id === conv.contactId)
            const isActive = conv.id === activeConversationId
            const isChip = isChipConv(conv.channelId)
            const chipId = isChip ? chipIdFromChannelId(conv.channelId) : null
            const channel = !isChip ? channels.find(c => c.id === conv.channelId) : null
            const convLabels = (conv.tags || []).map(t => (settings.labels || []).find(l => l.id === t)).filter(Boolean)
            const isGroup = contact?.phone?.endsWith('@g.us')
            return (
              <button key={conv.id} onClick={() => setActiveConversation(conv.id)}
                className={`w-full text-left px-3 py-3 border-b border-gray-800/50 hover:bg-gray-800/50 ${isActive ? 'bg-gray-800' : ''}`}>
                <div className="flex items-center gap-3">
                  <div className="relative shrink-0">
                    <div className="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-300">
                      {isGroup ? <Users size={16} /> : (contact?.name[0]?.toUpperCase() ?? '?')}
                    </div>
                    {isChip && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-600 flex items-center justify-center">
                        <Smartphone size={9} className="text-white" />
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-white truncate">{contact?.name ?? contact?.phone ?? 'Desconhecido'}</p>
                      <span className="text-xs text-gray-500 shrink-0 ml-1">
                        {format(new Date(conv.lastMessageAt), 'HH:mm')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <p className="text-xs text-gray-500 truncate flex-1">{conv.lastMessage ?? '...'}</p>
                      {conv.unreadCount > 0 && (
                        <span className="ml-1 w-4 h-4 rounded-full bg-green-500 text-white text-[10px] flex items-center justify-center font-medium shrink-0">
                          {conv.unreadCount > 9 ? '9+' : conv.unreadCount}
                        </span>
                      )}
                    </div>
                    {convLabels.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {convLabels.map(l => l && (
                          <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                            style={{ background: l.color + '33', color: l.color }}>
                            {l.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-gray-600 truncate mt-0.5">
                      {isGroup ? '👥 Grupo' : ''}{isChip ? ` 📱 chip:${chipId}` : channel ? ` 🔗 ${channel.name}` : ''}
                    </p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Chat area ─────────────────────────────────────────────────────── */}
      {!activeConv ? (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          <div className="text-center">
            <p className="text-lg font-medium mb-1">Selecione uma conversa</p>
            <p className="text-sm">ou aguarde novas mensagens chegarem</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 flex flex-col min-w-0">

            {/* ── Chat header ────────────────────────────────────────────── */}
            <div className="h-14 border-b border-gray-800 flex items-center justify-between px-4 shrink-0 bg-gray-900">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-white ${isGroupConv ? 'bg-emerald-700' : 'bg-indigo-700'}`}>
                  {isGroupConv ? <Users size={16} /> : (activeContact?.name[0]?.toUpperCase() ?? '?')}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white">{activeContact?.name ?? activeContact?.phone}</p>
                    {isGroupConv && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-emerald-900/50 text-emerald-400 rounded-full font-medium">Grupo</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 flex items-center gap-1">
                    {isGroupConv
                      ? (groupMembers.length > 0 ? `${groupMembers.length} membros` : 'Grupo do WhatsApp')
                      : formatWaNumber(activeContact?.waNumber || activeContact?.phone)
                    }
                    {activeChipId
                      ? <span className="flex items-center gap-1 text-green-400 ml-1"><Smartphone size={10} /> chip:{activeChipId}</span>
                      : activeChannel && <span className="ml-1 text-gray-500">· {activeChannel.name}</span>
                    }
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => updateConversation(activeConv.id, { status: 'resolved' })}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-emerald-900/40 text-emerald-400 hover:bg-emerald-900/60 rounded-lg">
                  <Check size={12} /> Resolver
                </button>
                <button onClick={() => updateConversation(activeConv.id, { status: 'archived' })}
                  className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg">
                  <Archive size={15} />
                </button>
                <button onClick={() => setShowInfoPanel(v => !v)}
                  className={`p-1.5 rounded-lg ${showInfoPanel ? 'text-indigo-400 bg-indigo-900/40' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
                  <ChevronRight size={15} className={`transition-transform ${showInfoPanel ? 'rotate-180' : ''}`} />
                </button>
              </div>
            </div>

            {/* ── Messages ───────────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-950">
              {convMessages.map(msg => {
                if (msg.private) {
                  return (
                    <div key={msg.id} className="flex justify-center">
                      <div className="max-w-xs lg:max-w-md rounded-xl px-3 py-2 bg-amber-950/60 border border-amber-800/50">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Lock size={10} className="text-amber-400" />
                          <span className="text-[10px] text-amber-400 font-medium">Nota privada</span>
                        </div>
                        <p className="text-sm text-amber-100 whitespace-pre-wrap break-words">{msg.text}</p>
                        <p className="text-[10px] text-amber-700 mt-1 text-right">{format(new Date(msg.timestamp), 'HH:mm')}</p>
                      </div>
                    </div>
                  )
                }

                const isOut = msg.direction === 'outbound'
                const parsed = !isOut && isGroupConv ? parseGroupMsg(msg.text ?? '') : null
                const isMedia = msg.type !== 'text' && msg.type !== 'template' && msg.type !== 'interactive'

                return (
                  <div key={msg.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-xs lg:max-w-md rounded-xl px-3 py-2 ${
                      isOut
                        ? 'bg-indigo-600 text-white rounded-br-sm'
                        : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                    }`}>
                      {/* Group sender name */}
                      {parsed && (
                        <p className="text-[10px] font-semibold text-emerald-400 mb-0.5">+{parsed.sender}</p>
                      )}

                      {/* Media or text content */}
                      {isMedia ? (
                        <MediaBubble msg={msg} outbound={isOut} />
                      ) : (
                        <p className="text-sm whitespace-pre-wrap break-words">
                          {parsed ? parsed.body : (msg.text ?? `[${msg.type}]`)}
                        </p>
                      )}

                      {/* Caption for media */}
                      {isMedia && msg.text && (
                        <p className="text-xs mt-1 whitespace-pre-wrap break-words opacity-90">{msg.text}</p>
                      )}

                      <div className="flex items-center justify-end gap-1 mt-1">
                        <span className="text-[10px] opacity-60">{format(new Date(msg.timestamp), 'HH:mm')}</span>
                        {isOut && statusIcon(msg.status)}
                      </div>
                      {msg.status === 'failed' && (
                        <p className="text-[10px] text-red-300 mt-0.5">{msg.errorMessage ?? 'Falha no envio'}</p>
                      )}
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Input ──────────────────────────────────────────────────── */}
            <div className="border-t border-gray-800 bg-gray-900">
              {quickReplySuggestions.length > 0 && (
                <div className="border-b border-gray-800 max-h-48 overflow-y-auto">
                  {quickReplySuggestions.map(qr => (
                    <button key={qr.id} onClick={() => applyQuickReply(qr.message)}
                      className="w-full text-left px-4 py-2.5 hover:bg-gray-800 flex items-start gap-3 border-b border-gray-800/50 last:border-0">
                      <span className="text-xs font-mono text-indigo-400 shrink-0 mt-0.5">/{qr.shortcut}</span>
                      <span className="text-xs text-gray-300 truncate">{qr.message}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="p-3">
                {sendError && (
                  <div className="flex items-center justify-between gap-2 mb-2 px-3 py-2 bg-red-900/50 border border-red-700 rounded-lg text-xs text-red-300">
                    <span className="flex items-center gap-1.5"><AlertCircle size={12} /> {sendError}</span>
                    <button onClick={() => setSendError(null)} className="text-red-400 hover:text-red-200 shrink-0"><X size={12} /></button>
                  </div>
                )}

                {activeConv.status === 'resolved' || activeConv.status === 'archived' ? (
                  <div className="flex items-center justify-center gap-3 py-2">
                    <span className="text-sm text-gray-500">Conversa encerrada.</span>
                    <button onClick={() => updateConversation(activeConv.id, { status: 'open' })}
                      className="text-sm text-indigo-400 hover:text-indigo-300">Reabrir</button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Mode toggle */}
                    <div className="flex gap-1.5">
                      <button type="button" onClick={() => setIsPrivateMode(false)}
                        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-colors ${!isPrivateMode ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}>
                        <Send size={11} /> Mensagem
                      </button>
                      <button type="button" onClick={() => setIsPrivateMode(true)}
                        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-colors ${isPrivateMode ? 'bg-amber-700 text-amber-100' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}>
                        <Lock size={11} /> Nota oculta
                      </button>
                    </div>

                    {/* Media preview */}
                    {mediaPending && (
                      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
                        {mediaPending.file.type.startsWith('audio/') ? (
                          /* ── Audio preview com player ── */
                          <div className="px-3 py-2.5 space-y-2">
                            <div className="flex items-center gap-2">
                              <Mic size={13} className="text-blue-400 shrink-0" />
                              <span className="text-xs text-gray-300 flex-1 truncate">{mediaPending.file.name}</span>
                              <span className="text-[10px] text-gray-500">{fmtBytes(mediaPending.file.size)}</span>
                              <button onClick={clearMedia} className="text-gray-500 hover:text-red-400 transition-colors shrink-0 p-0.5">
                                <X size={13} />
                              </button>
                            </div>
                            <audio
                              controls
                              src={mediaPending.previewUrl}
                              className="w-full h-8"
                              style={{ colorScheme: 'dark' }}
                            />
                            <p className="text-[10px] text-gray-500">Ouça antes de enviar — clique em Enviar quando estiver pronto.</p>
                          </div>
                        ) : (
                          /* ── Outros tipos de mídia ── */
                          <div className="flex items-center gap-3 px-3 py-2">
                            {mediaPending.file.type.startsWith('image/') ? (
                              <img src={mediaPending.previewUrl} alt="preview" className="w-10 h-10 rounded object-cover shrink-0" />
                            ) : mediaPending.file.type.startsWith('video/') ? (
                              <Video size={20} className="text-purple-400 shrink-0" />
                            ) : (
                              <FileText size={20} className="text-gray-400 shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white truncate">{mediaPending.file.name}</p>
                              <p className="text-[10px] text-gray-500">{fmtBytes(mediaPending.file.size)}</p>
                            </div>
                            <button onClick={clearMedia} className="text-gray-500 hover:text-red-400 transition-colors shrink-0">
                              <X size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Recording UI ─────────────────────────────────── */}
                    {isRecording && (
                      <div className="flex items-center gap-3 px-3 py-2.5 bg-red-900/30 border border-red-800/60 rounded-xl mb-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                        <span className="text-sm font-mono text-red-300 tabular-nums">{fmtSecs(recordingSecs)}</span>
                        <span className="text-xs text-gray-400 flex-1">Gravando...</span>
                        <button onClick={cancelRecording} title="Cancelar"
                          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/40 rounded-lg">
                          <Trash2 size={15} />
                        </button>
                        <button onClick={stopRecording} title="Parar e usar"
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-lg">
                          <StopCircle size={13} /> Parar
                        </button>
                      </div>
                    )}

                    <div className="flex gap-1.5 items-end">
                      {/* Emoji picker */}
                      <div className="relative shrink-0" ref={emojiRef}>
                        <button type="button" onClick={() => setShowEmoji(v => !v)} disabled={isPrivateMode}
                          title="Emojis"
                          className={`p-2.5 rounded-xl transition-colors disabled:opacity-30 ${showEmoji ? 'text-yellow-400 bg-gray-800' : 'text-gray-500 hover:text-yellow-400 hover:bg-gray-800'}`}>
                          <Smile size={16} />
                        </button>
                        {showEmoji && (
                          <div className="absolute bottom-12 left-0 z-50 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
                            <div className="max-h-64 overflow-y-auto p-2 space-y-2">
                              {EMOJI_GROUPS.map(group => (
                                <div key={group.label}>
                                  <p className="text-[10px] text-gray-500 font-medium px-1 mb-1">{group.label}</p>
                                  <div className="flex flex-wrap gap-0.5">
                                    {group.emojis.map(em => (
                                      <button key={em} type="button"
                                        onClick={() => { setText(t => t + em); textareaRef.current?.focus() }}
                                        className="w-8 h-8 flex items-center justify-center text-lg hover:bg-gray-800 rounded-lg transition-colors">
                                        {em}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Attachment: files */}
                      <button type="button" onClick={() => fileInputRef.current?.click()}
                        disabled={isPrivateMode || isRecording}
                        title="Enviar imagem / vídeo / documento"
                        className="p-2.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-xl transition-colors disabled:opacity-30 shrink-0">
                        <Paperclip size={16} />
                      </button>
                      <input ref={fileInputRef} type="file"
                        accept="image/*,video/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
                        className="hidden" onChange={handleFileSelect} />

                      {/* Mic: record audio */}
                      <button type="button"
                        onClick={isRecording ? stopRecording : startRecording}
                        disabled={isPrivateMode || !!mediaPending}
                        title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
                        className={`p-2.5 rounded-xl transition-colors disabled:opacity-30 shrink-0 ${
                          isRecording ? 'bg-red-600 text-white animate-pulse' : 'text-gray-500 hover:text-red-400 hover:bg-gray-800'
                        }`}>
                        <Mic size={16} />
                      </button>
                      <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileSelect} />

                      <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
                          if (e.key === 'Escape') setQuickReplySuggestions([])
                        }}
                        rows={1}
                        style={{ maxHeight: 120 }}
                        className={`flex-1 border rounded-xl px-3 py-2 text-sm text-white focus:outline-none resize-none ${
                          isPrivateMode
                            ? 'bg-amber-950/40 border-amber-800/60 focus:border-amber-600 placeholder-amber-800'
                            : 'bg-gray-800 border-gray-700 focus:border-indigo-500 placeholder-gray-600'
                        }`}
                        placeholder={
                          mediaPending
                            ? 'Legenda (opcional)…'
                            : isPrivateMode
                              ? '📝 Nota interna (não enviada ao contato)...'
                              : (text.startsWith('/') ? 'Digite / para ver respostas rápidas...' : (activeChipId ? `Responder via chip ${activeChipId}… (Enter)` : 'Mensagem… (Enter)'))
                        }
                      />
                      <button onClick={handleSend}
                        disabled={sending || (!text.trim() && !mediaPending)}
                        className={`p-2.5 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl shrink-0 ${
                          isPrivateMode ? 'bg-amber-700 hover:bg-amber-600' : 'bg-indigo-600 hover:bg-indigo-500'
                        }`}>
                        {isPrivateMode ? <Lock size={16} /> : <Send size={16} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Info panel ──────────────────────────────────────────────────── */}
          {showInfoPanel && (
            <div className="w-64 border-l border-gray-800 bg-gray-900 flex flex-col shrink-0 overflow-y-auto">

              {/* Contact / Group header */}
              <div className="p-4 border-b border-gray-800">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold text-white shrink-0 ${isGroupConv ? 'bg-emerald-700' : 'bg-indigo-700'}`}>
                    {isGroupConv ? <Users size={22} /> : (activeContact?.name[0]?.toUpperCase() ?? '?')}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{activeContact?.name ?? '—'}</p>
                    <p className="text-[11px] text-gray-500">{isGroupConv ? 'Grupo do WhatsApp' : 'Contato'}</p>
                  </div>
                </div>

                {isGroupConv ? (
                  /* Group info */
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <Users size={12} className="text-gray-500 mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="text-[10px] text-gray-500">ID do grupo</p>
                        <p className="text-xs text-gray-400 break-all">{activeContact?.phone}</p>
                      </div>
                    </div>
                    {activeChipId && (
                      <button
                        onClick={fetchGroupMembers}
                        disabled={loadingMembers}
                        className="w-full text-xs py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg disabled:opacity-50"
                      >
                        {loadingMembers ? 'Carregando...' : groupMembers.length > 0 ? `${groupMembers.length} membros — atualizar` : 'Ver membros'}
                      </button>
                    )}
                    {groupMembers.length > 0 && (
                      <div className="max-h-40 overflow-y-auto space-y-1 mt-1">
                        {groupMembers.map(num => (
                          <div key={num} className="flex items-center gap-2 py-1 px-2 bg-gray-800 rounded-lg">
                            <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                              <User size={10} className="text-gray-400" />
                            </div>
                            <span className="text-[10px] text-gray-300 font-mono">{num}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  /* Individual contact info */
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <Phone size={12} className="text-gray-500 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-gray-500">Telefone</p>
                        {editingPhone && activeContact ? (
                          <div className="flex items-center gap-1 mt-0.5">
                            <input autoFocus value={phoneEditValue}
                              onChange={e => setPhoneEditValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') savePhoneEdit(); if (e.key === 'Escape') setEditingPhone(false) }}
                              placeholder="5511999999999"
                              className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-green-500" />
                            <button onClick={savePhoneEdit} className="text-green-400 hover:text-green-300 p-0.5 shrink-0"><Check size={11} /></button>
                            <button onClick={() => setEditingPhone(false)} className="text-gray-500 hover:text-gray-300 p-0.5 shrink-0"><X size={11} /></button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 group">
                            <p className="text-xs text-gray-300 break-all">{displayPhone}</p>
                            <button onClick={() => { setPhoneEditValue(activeContact?.waNumber || activeContact?.phone?.replace(/@.*$/, '') || ''); setEditingPhone(true) }}
                              className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-gray-400 transition-opacity shrink-0">
                              <Edit2 size={10} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <User size={12} className="text-gray-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-[10px] text-gray-500">Canal</p>
                        <p className="text-xs text-gray-300">
                          {activeChipId ? `📱 Chip: ${activeChipId}` : activeChannel?.name ?? '—'}
                        </p>
                      </div>
                    </div>
                    {activeContact?.createdAt && (
                      <div className="flex items-start gap-2">
                        <Calendar size={12} className="text-gray-500 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-[10px] text-gray-500">Primeiro contato</p>
                          <p className="text-xs text-gray-300">{format(new Date(activeContact.createdAt), 'dd/MM/yyyy')}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Labels */}
              <div className="p-4 border-b border-gray-800">
                <div className="flex items-center gap-2 mb-3">
                  <Tag size={12} className="text-gray-500" />
                  <p className="text-xs font-medium text-gray-400">Etiquetas</p>
                </div>
                {(settings.labels || []).length === 0 ? (
                  <p className="text-[11px] text-gray-600">Nenhuma etiqueta. Crie em Configurações.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(settings.labels || []).map(label => {
                      const active = (activeConv.tags || []).includes(label.id)
                      return (
                        <button key={label.id} type="button" onClick={() => toggleConvLabel(label.id)}
                          className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-all ${active ? 'border-transparent font-medium' : 'border-gray-700 text-gray-500 hover:border-gray-500'}`}
                          style={active ? { background: label.color + '33', color: label.color, borderColor: label.color + '66' } : {}}>
                          {active && <Check size={9} />}
                          {label.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Conversation status */}
              <div className="p-4">
                <p className="text-xs font-medium text-gray-400 mb-2">Status da conversa</p>
                <div className="flex flex-col gap-1.5">
                  {(['open','pending','resolved'] as const).map(s => (
                    <button key={s} type="button" onClick={() => updateConversation(activeConv.id, { status: s })}
                      className={`text-xs px-3 py-1.5 rounded-lg text-left transition-colors ${
                        activeConv.status === s
                          ? s === 'open' ? 'bg-green-900/50 text-green-400' : s === 'pending' ? 'bg-yellow-900/50 text-yellow-400' : 'bg-gray-700 text-gray-300'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                      }`}>
                      {s === 'open' ? '🟢 Aberta' : s === 'pending' ? '🟡 Pendente' : '⚪ Resolvida'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
