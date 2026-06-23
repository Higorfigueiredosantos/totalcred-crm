let cachedKey: string | null = null
let fetchPromise: Promise<string> | null = null

async function getApiKey(): Promise<string> {
  if (cachedKey) return cachedKey           // só retorna cache se tiver chave de verdade
  if (fetchPromise) return fetchPromise
  fetchPromise = fetch('/api/settings/apikey')
    .then(r => r.json())
    .then((d: { key?: string }) => {
      cachedKey = d.key || null             // null se vazio, para forçar retry
      return cachedKey ?? ''
    })
    .catch(() => {
      fetchPromise = null                   // limpa promise para tentar novamente depois
      return ''
    })
    .finally(() => {
      if (!cachedKey) fetchPromise = null   // se não veio chave, permite retry
    })
  return fetchPromise
}

export function invalidateApiKeyCache() {
  cachedKey = null
  fetchPromise = null
}

const PROTECTED = ['/api/chips/send', '/api/crm/']

function isProtected(url: string): boolean {
  const path = url.startsWith('http') ? new URL(url).pathname : url
  return PROTECTED.some(p => path.startsWith(p))
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const extraHeaders: Record<string, string> = {}

  if (isProtected(url)) {
    const key = await getApiKey()
    if (key) extraHeaders['x-api-token'] = key
  }

  // Não sobrescreve headers originais — merge seguro
  const merged = options.headers
    ? new Headers(options.headers as HeadersInit)
    : new Headers()

  for (const [k, v] of Object.entries(extraHeaders)) {
    merged.set(k, v)
  }

  // NÃO define Content-Type para FormData — browser precisa auto-detectar com boundary
  const isFormData = options.body instanceof FormData
  if (isFormData) merged.delete('content-type')

  return fetch(url, { ...options, headers: merged })
}
