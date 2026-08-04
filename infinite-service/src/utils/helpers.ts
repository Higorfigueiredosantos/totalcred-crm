import type { WASocketLike } from '../types/whatsapp.js';

/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export function toJid(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length < 10) return null;
  if (phone.includes('@')) return phone;
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Números brasileiros têm o 9º dígito extra (13 dígitos com DDI) que nem
 * sempre bate com o JID real cadastrado no WhatsApp (12 dígitos, sem o 9).
 * Gera a variante alternativa (com/sem o 9) pra tentar caso a primeira não exista.
 */
export function brazilianNinthDigitVariant(jid: string): string | null {
  const [digits, domain = 's.whatsapp.net'] = jid.split('@');
  if (!digits.startsWith('55')) return null;
  const rest = digits.slice(2); // DDD + número, sem DDI
  if (rest.length === 11 && rest[2] === '9') {
    // 13 dígitos com DDI (DDD + 9 + 8 dígitos) → remove o 9
    return `55${rest.slice(0, 2)}${rest.slice(3)}@${domain}`;
  }
  if (rest.length === 10) {
    // 12 dígitos com DDI (DDD + 8 dígitos) → adiciona o 9
    return `55${rest.slice(0, 2)}9${rest.slice(2)}@${domain}`;
  }
  return null;
}

/**
 * Resolve o JID real de um número via sock.onWhatsApp (confirma existência na
 * rede), tentando a variante alternativa do 9º dígito (padrão BR) se a
 * primeira não existir. Sem sock.onWhatsApp ou em caso de erro, cai no JID
 * "ingênuo" (toJid) — melhor tentar enviar do que travar a mensagem.
 */
export async function resolveJid(
  sock: WASocketLike,
  phone: string | null | undefined
): Promise<string | null> {
  const naive = toJid(phone);
  if (!naive) return null;
  if (typeof sock.onWhatsApp !== 'function') return naive;

  try {
    const [primary] = await sock.onWhatsApp(naive);
    if (primary?.exists) return primary.jid || naive;

    const alt = brazilianNinthDigitVariant(naive);
    if (alt) {
      const [altResult] = await sock.onWhatsApp(alt);
      if (altResult?.exists) return altResult.jid || alt;
    }
  } catch {
    // API indisponível/erro de rede — segue com o JID ingênuo
  }
  return naive;
}

/**
 * Verifica se a instância está conectada
 */
export function isConnected(ctx: { sock?: unknown; status?: string } | null): boolean {
  return Boolean(ctx?.sock && ctx.status === 'connected');
}

/**
 * Decodifica uma imagem em base64 (com ou sem prefixo data:URL) para Buffer.
 */
export function decodeImage(input: string | null | undefined): Buffer | null {
  if (!input || typeof input !== 'string') return null;
  const base64 = input.includes(',') ? input.split(',')[1] : input;
  try {
    const buf = Buffer.from(base64, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Verifica se string é URL
 */
export function isUrl(str: unknown): str is string {
  if (typeof str !== 'string') return false;
  return /^https?:\/\//i.test(str.trim());
}
