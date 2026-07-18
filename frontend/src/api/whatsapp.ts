import axios from 'axios'
import type { Template, ProxyConfig } from '../types'

const GRAPH = 'https://graph.facebook.com/v20.0'
const BACKEND = '/api'

// ─── axios instances ──────────────────────────────────────────────────────────

function directGraph(accessToken: string) {
  return axios.create({
    baseURL: GRAPH,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
}

function backendPost(path: string, body: object) {
  return axios.post(`${BACKEND}${path}`, body)
}

// ─── Routing: direct when no proxy, via backend when proxy is set ─────────────

async function graphPost(
  urlPath: string,
  payload: object,
  accessToken: string,
  proxy?: ProxyConfig
): Promise<any> {
  try {
    if (proxy?.enabled) {
      const res = await backendPost('/send', {
        phoneNumberId: urlPath.split('/')[1],
        accessToken,
        payload,
        proxy,
      })
      return res.data
    }
    const res = await directGraph(accessToken).post(urlPath, payload)
    return res.data
  } catch (err: any) {
    const apiErr = err?.response?.data?.error
    const msg = apiErr?.message || err?.message || 'Erro desconhecido'
    throw new Error(msg)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendTextMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
  proxy?: ProxyConfig
): Promise<string> {
  const data = await graphPost(
    `/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    },
    accessToken,
    proxy
  )
  return data.messages[0].id
}

export async function sendTemplateMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  language: string,
  components: object[] = [],
  proxy?: ProxyConfig
): Promise<string> {
  const data = await graphPost(
    `/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: language }, components },
    },
    accessToken,
    proxy
  )
  return data.messages[0].id
}

export async function sendMediaMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  type: 'image' | 'document' | 'audio' | 'video',
  mediaId: string,
  caption?: string,
  proxy?: ProxyConfig
): Promise<string> {
  const data = await graphPost(
    `/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      [type]: { id: mediaId, caption },
    },
    accessToken,
    proxy
  )
  return data.messages[0].id
}

export async function markMessageRead(
  phoneNumberId: string,
  accessToken: string,
  wamid: string,
  proxy?: ProxyConfig
) {
  await graphPost(
    `/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
    accessToken,
    proxy
  )
}

export async function getTemplates(
  wabaId: string,
  accessToken: string,
  proxy?: ProxyConfig
): Promise<Template[]> {
  let data: any
  if (proxy?.enabled) {
    const res = await backendPost('/templates', { wabaId, accessToken, proxy })
    data = res.data
  } else {
    const res = await directGraph(accessToken).get(`/${wabaId}/message_templates`, {
      params: { fields: 'name,language,status,category,components', limit: 100 },
    })
    data = res.data
  }
  return (data.data ?? []).map((t: any) => ({
    id: t.id,
    name: t.name,
    language: t.language,
    status: (t.status as string).toLowerCase(),
    category: (t.category as string).toLowerCase(),
    // Normalize component type to lowercase so all comparisons work regardless of Meta's casing
    components: (t.components ?? []).map((c: any) => ({
      ...c,
      type: (c.type as string)?.toLowerCase() ?? c.type,
    })),
  }))
}

export async function uploadMedia(
  phoneNumberId: string,
  accessToken: string,
  file: File,
  proxy?: ProxyConfig
): Promise<string> {
  // Media upload via multipart — only supported direct (no proxy) for now
  // When proxy is needed, user should pre-upload via backend separately
  if (proxy?.enabled) {
    // Route through backend generic graph endpoint would require multipart support there
    // For now, fall through to direct (media upload is less sensitive than message content)
  }
  const form = new FormData()
  form.append('file', file)
  form.append('type', file.type)
  form.append('messaging_product', 'whatsapp')
  const res = await axios.post(`${GRAPH}/${phoneNumberId}/media`, form, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'multipart/form-data' },
  })
  return res.data.id
}

export interface TemplateAnalytics {
  sent: number
  delivered: number
  read: number
  clicked: number
  buttonClicks: Record<string, number>
}

export async function getTemplateAnalytics(
  wabaId: string,
  accessToken: string,
  templateId: string,
  dateFrom: Date,
  dateTo: Date
): Promise<TemplateAnalytics> {
  const start = Math.floor(dateFrom.getTime() / 1000)
  const end = Math.floor(dateTo.getTime() / 1000)
  const res = await directGraph(accessToken).get(`/${wabaId}/template_analytics`, {
    params: {
      start,
      end,
      granularity: 'DAILY',
      metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ', 'CLICKED']),
      template_ids: JSON.stringify([templateId]),
    },
  })
  const data = res.data?.data?.[0]?.analytics?.data ?? []
  const result: TemplateAnalytics = { sent: 0, delivered: 0, read: 0, clicked: 0, buttonClicks: {} }
  for (const day of data) {
    result.sent += day.sent ?? 0
    result.delivered += day.delivered ?? 0
    result.read += day.read ?? 0
    for (const btn of (day.clicked ?? [])) {
      const label = btn.button_content ?? btn.type ?? 'botão'
      result.clicked += btn.count ?? 0
      result.buttonClicks[label] = (result.buttonClicks[label] ?? 0) + (btn.count ?? 0)
    }
  }
  return result
}
