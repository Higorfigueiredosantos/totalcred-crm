import { downloadMediaMessage, getContentType } from 'baileys';
import { config } from '../config.js';
import type { InstanceContext } from '../types/whatsapp.js';

// Extrai o texto de exibição de uma mensagem, cobrindo os formatos comuns
// (texto puro, legenda de mídia, resposta a botão/lista nativos).
function extractText(content: Record<string, unknown> | undefined): string {
  if (!content) return '';
  const c = content as Record<string, any>;
  if (typeof c.conversation === 'string') return c.conversation;
  if (c.extendedTextMessage?.text) return c.extendedTextMessage.text;
  if (c.imageMessage?.caption) return c.imageMessage.caption;
  if (c.videoMessage?.caption) return c.videoMessage.caption;
  if (c.documentMessage?.caption) return c.documentMessage.caption;
  if (c.buttonsResponseMessage?.selectedDisplayText) return c.buttonsResponseMessage.selectedDisplayText;
  if (c.listResponseMessage?.title) return c.listResponseMessage.title;
  if (c.templateButtonReplyMessage?.selectedDisplayText) return c.templateButtonReplyMessage.selectedDisplayText;
  const nativeFlowJson = c.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (typeof nativeFlowJson === 'string') {
    try {
      const parsed = JSON.parse(nativeFlowJson);
      return parsed.display_text || parsed.id || nativeFlowJson;
    } catch {
      return nativeFlowJson;
    }
  }
  return '';
}

type MediaInfo = { type: 'image' | 'video' | 'audio' | 'document'; mimetype: string | null };

function detectMedia(content: Record<string, unknown> | undefined): MediaInfo | null {
  if (!content) return null;
  const c = content as Record<string, any>;
  if (c.imageMessage) return { type: 'image', mimetype: c.imageMessage.mimetype || null };
  if (c.videoMessage) return { type: 'video', mimetype: c.videoMessage.mimetype || null };
  if (c.audioMessage) return { type: 'audio', mimetype: c.audioMessage.mimetype || null };
  if (c.documentMessage) return { type: 'document', mimetype: c.documentMessage.mimetype || null };
  if (c.stickerMessage) return { type: 'image', mimetype: c.stickerMessage.mimetype || null };
  return null;
}

function extractContactNumber(jid: string | undefined): string | null {
  if (!jid) return null;
  if (jid.endsWith('@lid')) return null; // WhatsApp LID — não é o número real
  const digits = jid.split('@')[0];
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export async function handleUpsert(instanceName: string, ctx: InstanceContext, upsert: { messages: any[]; type: string }) {
  if (!config.webhookUrl) return;

  for (const msg of upsert.messages || []) {
    try {
      if (!msg.message || msg.key?.fromMe) continue;

      const remoteJid: string | undefined = msg.key?.remoteJid;
      if (!remoteJid) continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const author = isGroup ? (msg.key?.participant || remoteJid) : remoteJid;
      if (!getContentType(msg.message)) continue;

      const body = extractText(msg.message);
      const media = detectMedia(msg.message);
      if (!body && !media) continue; // tipo de mensagem que não tratamos (ex: reação, recibo)

      let groupName: string | null = null;
      if (isGroup) {
        try {
          const sockAny = ctx.sock as unknown as { groupMetadata?: (jid: string) => Promise<{ subject?: string }> };
          if (typeof sockAny.groupMetadata === 'function') {
            const info = await sockAny.groupMetadata(remoteJid);
            groupName = info?.subject || null;
          }
        } catch {
          // segue sem nome do grupo
        }
      }

      let mediaBase64: string | null = null;
      if (media) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          mediaBase64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : null;
        } catch (e) {
          console.error(`[Infinite:${instanceName}] Erro ao baixar mídia recebida:`, (e as Error).message);
        }
      }

      const payload = {
        kind: 'message',
        instance: instanceName,
        from: remoteJid,
        author,
        isGroup,
        groupName,
        pushname: msg.pushName || null,
        contactNumber: isGroup ? null : extractContactNumber(remoteJid),
        body,
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        msgType: media?.type || 'text',
        mediaBase64,
        mediaMimetype: media?.mimetype || null,
      };

      await postWebhook(payload).catch(e => console.error(`[Infinite:${instanceName}] Falha ao enviar webhook:`, (e as Error).message));
    } catch (e) {
      console.error(`[Infinite:${instanceName}] Erro processando mensagem recebida:`, (e as Error).message);
    }
  }
}

function postWebhook(payload: Record<string, unknown>) {
  return fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}) },
    body: JSON.stringify(payload),
  });
}

// Status do WebMessageInfo (proto.WebMessageInfo.Status): 3=DELIVERY_ACK, 4=READ, 5=PLAYED.
// Baileys já expõe isso via receipts reais do WhatsApp — não é heurística.
export async function handleMessagesUpdate(instanceName: string, updates: Array<{ key: any; update: any }>) {
  console.log(`[Infinite:${instanceName}] messages.update count=${updates?.length} raw=${JSON.stringify(updates)}`);
  if (!config.webhookUrl) return;
  for (const { key, update } of updates || []) {
    try {
      if (!key?.fromMe || !key?.id) continue;
      const status = update?.status;
      if (typeof status !== 'number' || status < 3) continue; // só delivery/read/played interessam
      await postWebhook({
        kind: 'ack',
        instance: instanceName,
        messageId: key.id,
        to: key.remoteJid,
        status,
      }).catch(e => console.error(`[Infinite:${instanceName}] Falha ao enviar webhook de ack:`, (e as Error).message));
    } catch (e) {
      console.error(`[Infinite:${instanceName}] Erro processando ack:`, (e as Error).message);
    }
  }
}
