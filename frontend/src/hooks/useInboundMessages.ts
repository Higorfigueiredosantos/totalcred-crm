import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import type { Message } from '../types'
import { v4 as uuid } from '../utils/uuid'
import { markMessageRead } from '../api/whatsapp'
import { onWSMessage } from '../api/websocket'

const CHIP_PREFIX = 'chip:'

// Processa mensagens recebidas/enviadas (Meta API e Chips/Wuzapi) e mantém a
// store atualizada — chamado uma única vez em Layout, que fica montado a
// sessão inteira. Antes esses handlers viviam dentro de Messages.tsx e só
// existiam enquanto essa tela estava aberta: uma mensagem chegando enquanto o
// usuário estava em Disparador/Canais/etc. nunca era processada (o socket
// seguia aberto — Layout já cuida da conexão — mas ninguém no front escutava
// o evento), então a conversa nunca aparecia em Mensagens, mesmo depois de
// voltar pra lá. Hoisted aqui pra ficar sempre ativo, igual a conexão WS.
export function useInboundMessages() {
  const {
    conversations, contacts, channels, messages,
    addMessage, updateMessage, updateConversation, markRead,
    addConversation, addContact, updateContact,
    kanbanCards, kanbanColumns, addKanbanCard,
  } = useStore()

  const messagesRef = useRef(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])

  const contactsRef = useRef(contacts)
  useEffect(() => { contactsRef.current = contacts }, [contacts])
  const conversationsRef = useRef(conversations)
  useEffect(() => { conversationsRef.current = conversations }, [conversations])

  const kanbanCardsRef = useRef(kanbanCards)
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

  // ── Meta API inbound ────────────────────────────────────────────────────────
  const handleMetaInboundImpl = (payload: any) => {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value) continue

        if (!value?.messages) {
          for (const status of value?.statuses ?? []) {
            const m = messagesRef.current.find(m => m.wamid === status.id)
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

          let contact = contactsRef.current.find(c => c.phone === `+${from}` || c.phone === from)
          if (!contact) {
            contact = {
              id: uuid(), name: value.contacts?.[0]?.profile?.name ?? from,
              phone: `+${from}`, tags: [], channelId: channel.id, createdAt: new Date().toISOString(),
            }
            contactsRef.current = [...contactsRef.current, contact]
            addContact(contact)
          }

          let conv = conversationsRef.current.find(c => c.contactId === contact!.id && c.channelId === channel.id)
          if (!conv) {
            conv = {
              id: uuid(), contactId: contact.id, channelId: channel.id,
              status: 'open', unreadCount: 1, lastMessageAt: new Date().toISOString(), tags: [],
            }
            conversationsRef.current = [...conversationsRef.current, conv]
            addConversation(conv)
            addToLeads(conv.id, contact.id, value.contacts?.[0]?.profile?.name ?? from)
          }

          const rawType = msg.type ?? 'text'
          // button/interactive → text para exibir como mensagem normal
          const msgType: Message['type'] = rawType === 'sticker' ? 'image'
            : (rawType === 'button' || rawType === 'interactive') ? 'text'
            : rawType as Message['type']

          // Proxy para baixar mídia da Meta (imagem, vídeo, áudio, doc) via backend
          const metaMediaId = msg.image?.id || msg.audio?.id || msg.video?.id
            || msg.document?.id || msg.sticker?.id
          const mediaUrl = metaMediaId
            ? `/api/media/meta?id=${encodeURIComponent(metaMediaId)}&token=${encodeURIComponent(channel.accessToken)}&phoneId=${encodeURIComponent(channel.phoneNumberId)}`
            : undefined

          // Extrai texto de todos os tipos: texto, botão clicado, lista selecionada, mídia
          const textContent = msg.text?.body
            || msg.button?.text
            || msg.interactive?.button_reply?.title
            || msg.interactive?.list_reply?.title
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

          if (useStore.getState().activeConversationId === conv.id) {
            markRead(conv.id)
            markMessageRead(channel.phoneNumberId, channel.accessToken, msg.id).catch(() => {})
          }
        }

        for (const status of value.statuses ?? []) {
          const m = messagesRef.current.find(m => m.wamid === status.id)
          if (m) updateMessage(m.id, { status: status.status })
        }
      }
    }
  }

  // ── Chip inbound (Chips whatsapp-web.js e Wuzapi) ───────────────────────────
  const seenChipMsgs = useRef(new Set<string>())

  const handleChipInboundImpl = (payload: any) => {
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

    let contact = contactsRef.current.find(c => c.phone === chatId)
    if (!contact) {
      contact = {
        id: uuid(), name: displayName,
        phone: chatId,
        ...(cleanNumber ? { waNumber: cleanNumber } : {}),
        tags: [], channelId, createdAt: new Date().toISOString(),
      }
      contactsRef.current = [...contactsRef.current, contact]
      addContact(contact)
    } else {
      const updates: Record<string, any> = {}
      if (!isGroup && pushname && contact.name !== pushname) updates.name = pushname
      if (isGroup && groupName && contact.name !== groupName) updates.name = groupName
      if (cleanNumber && cleanNumber !== contact.waNumber) updates.waNumber = cleanNumber
      if (Object.keys(updates).length) updateContact(contact.id, updates)
    }

    let conv = conversationsRef.current.find(c => c.contactId === contact!.id && c.channelId === channelId)
    if (!conv) {
      conv = {
        id: uuid(), contactId: contact.id, channelId,
        status: 'open', unreadCount: 1, lastMessageAt: new Date().toISOString(), tags: [],
      }
      conversationsRef.current = [...conversationsRef.current, conv]
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
    const isActive = useStore.getState().activeConversationId === conv.id
    updateConversation(conv.id, {
      unreadCount: isActive ? 0 : (conv.unreadCount ?? 0) + 1,
      lastMessage: lastMsgLabel,
      lastMessageAt: ts,
      status: 'open',
    })
    if (isActive) markRead(conv.id)
  }

  // ── Chip outbound (enviado via API externa ou pela UI) ──────────────────────
  const handleChipOutboundImpl = (payload: any) => {
    const { chipId, to, message, msgId, type, mediaFileName, caption, timestamp, conversationId } = payload
    if (!chipId || !to) return
    // O `conversationId` desse payload é um hash gerado no backend
    // (chipId+chatId), que NUNCA bate com o id (uuid) da conversa local no
    // Zustand — usá-lo pra achar a mensagem otimista sempre falhava e
    // criava uma bolha nova a cada broadcast, duplicando a mensagem na
    // tela. Resolve a conversa de verdade primeiro (mesma lógica de
    // contato/telefone usada pra mensagens recebidas) e casa por ela.
    void conversationId

    const channelId = CHIP_PREFIX + chipId
    const ts = timestamp
      ? new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString()
      : new Date().toISOString()
    const msgType = (type as Message['type']) || 'text'
    const textBody = message || caption || undefined

    // Garante que o contato existe (busca normalizada, suporta formato 8/9 dígitos BR)
    const phoneDigits = (p: string) => p.replace(/@.*$/, '').replace(/\D/g, '')
    const phoneVariants = (d: string): string[] => {
      const vs = [d]
      if (d.startsWith('55') && d.length === 12) vs.push('55' + d.slice(2, 4) + '9' + d.slice(4))
      if (d.startsWith('55') && d.length === 13) vs.push('55' + d.slice(2, 4) + d.slice(5))
      return vs
    }
    const toDigits = phoneDigits(to)
    const toVariants = phoneVariants(toDigits)
    let contact = contactsRef.current.find(c => {
      if (c.phone === to) return true
      const cd = phoneDigits(c.phone)
      if (toVariants.includes(cd)) return true
      if (c.waNumber) {
        const wd = phoneDigits(c.waNumber)
        if (toVariants.includes(wd)) return true
      }
      return false
    })
    if (!contact) {
      const num = to.replace(/@.*$/, '')
      contact = {
        id: uuid(), name: `+${num}`, phone: to,
        tags: [], channelId, createdAt: new Date().toISOString(),
      }
      contactsRef.current = [...contactsRef.current, contact]
      addContact(contact)
    }

    // Garante que a conversa existe
    let conv = conversationsRef.current.find(c => c.contactId === contact!.id && c.channelId === channelId)
    if (!conv) {
      conv = {
        id: uuid(), contactId: contact.id, channelId,
        status: 'open', unreadCount: 0, lastMessageAt: ts, tags: [],
      }
      conversationsRef.current = [...conversationsRef.current, conv]
      addConversation(conv)
    }

    // Se o wamid já existe na store, foi enviado pela UI — só garante que o
    // wamid fique gravado (nunca mexe no status: esse broadcast chega ~300ms
    // depois da resposta HTTP, de propósito, pra avisar outras abas/
    // integrações externas — por essa mesma demora, os eventos de entrega/
    // leitura (chip_ack) costumam chegar primeiro, e sobrescrever o status
    // aqui apagaria esse progresso, voltando a mensagem pra "enviado").
    // Se ainda não existir, cai no fallback: casa pela conversa (agora
    // resolvida corretamente acima) + texto, sem depender de status nem de
    // msgId presente (contas com LID costumam não retornar id nenhum).
    let existing = msgId ? messagesRef.current.find(m => m.wamid === msgId) : undefined
    if (!existing) {
      existing = messagesRef.current.find(m =>
        m.direction === 'outbound' && !m.wamid && m.conversationId === conv!.id && m.text === textBody
      )
    }
    if (existing) {
      if (msgId && !existing.wamid) updateMessage(existing.id, { wamid: msgId })
      return
    }

    const newMsg: Message = {
      id: uuid(), wamid: msgId || undefined,
      conversationId: conv.id, contactId: contact.id, channelId,
      direction: 'outbound', type: msgType,
      text: textBody, fileName: mediaFileName || undefined,
      status: 'sent', timestamp: ts,
    }
    addMessage(newMsg)
    updateConversation(conv.id, {
      lastMessage: textBody || `[${msgType}]`,
      lastMessageAt: ts,
    })
  }

  // Refs sempre atualizados para uso na fila offline
  const handleChipInboundRef = useRef(handleChipInboundImpl)
  useEffect(() => { handleChipInboundRef.current = handleChipInboundImpl })
  const handleMetaInboundRef = useRef(handleMetaInboundImpl)
  useEffect(() => { handleMetaInboundRef.current = handleMetaInboundImpl })
  const handleChipOutboundRef = useRef(handleChipOutboundImpl)
  useEffect(() => { handleChipOutboundRef.current = handleChipOutboundImpl })

  useEffect(() => onWSMessage('whatsapp', (p: any) => handleMetaInboundRef.current(p)), [])
  useEffect(() => onWSMessage('chip_message', (p: any) => handleChipInboundRef.current(p)), [])
  useEffect(() => onWSMessage('chip_outbound', (p: any) => handleChipOutboundRef.current(p)), [])

  // Atualiza status da mensagem (✓ enviado / ✓✓ entregue / ✓✓ azul lido)
  useEffect(() => onWSMessage('chip_ack', (payload: any) => {
    const { msgId, status } = payload
    if (!msgId || !status) return
    const m = messagesRef.current.find(msg => msg.wamid === msgId)
    if (m) updateMessage(m.id, { status })
  }), [updateMessage])

  // ── Busca fila offline ao montar (mensagens recebidas com o app fechado) ────
  // Roda uma vez por sessão (Layout monta uma vez só) em vez de toda vez que
  // a tela de Mensagens é aberta.
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch('/api/offline_queue')
        .then(r => r.json())
        .then((queue: { type: string; payload: any }[]) => {
          if (!Array.isArray(queue) || queue.length === 0) return
          console.log(`[OfflineQueue] Processando ${queue.length} msgs pendentes`)
          queue.forEach(({ type, payload }) => {
            if (type === 'chip_message') handleChipInboundRef.current(payload)
            else if (type === 'whatsapp') handleMetaInboundRef.current(payload)
            else if (type === 'chip_outbound') handleChipOutboundRef.current(payload)
          })
        })
        .catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [])
}
