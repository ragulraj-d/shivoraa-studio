/**
 * AI provider storage — deliberately local to this browser.
 *
 * Provider API keys are the one thing that is NOT written to Firestore. There
 * is no server in this deployment, so AI calls are made directly from the
 * browser: putting the key in a database would mean shipping a credential to
 * Google and back on every page load, for no benefit at all. It stays where it
 * is used.
 *
 * The trade-off, stated plainly in the UI: keys live in this browser only. They
 * do not sync across devices, and clearing site data removes them.
 */

import { load, save, uid } from '@/lib/localStore'
import type { Provider } from '@/lib/types'

export class ProviderError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public hint?: string,
  ) {
    super(detail)
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  ollama: 'llama3.2',
  custom: 'gpt-4o-mini',
}

function baseUrlFor(type: string, given: string | null): string {
  if (given) return given.replace(/\/$/, '')
  switch (type) {
    case 'anthropic':
      return 'https://api.anthropic.com'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'groq':
      return 'https://api.groq.com/openai/v1'
    case 'ollama':
      return 'http://localhost:11434/v1'
    default:
      return 'https://api.openai.com/v1'
  }
}

/**
 * Verify a key by actually calling the provider.
 *
 * A key accepted without checking is a key the user discovers is wrong three
 * days later, when it reads as a broken product rather than a typo.
 */
async function testConnection(payload: {
  type?: string
  api_key?: string | null
  base_url?: string | null
  default_model?: string | null
}): Promise<{ ok: boolean; message: string; models: string[] }> {
  const type = payload.type ?? 'openai'
  const key = payload.api_key ?? ''
  const base = baseUrlFor(type, payload.base_url ?? null)

  if (type !== 'ollama' && !key) {
    return { ok: false, message: 'Enter an API key first.', models: [] }
  }

  try {
    if (type === 'anthropic') {
      // Anthropic has no free introspection endpoint, so a one-token
      // completion is the only honest way to prove a key works.
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: payload.default_model || DEFAULT_MODELS.anthropic,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (response.ok) return { ok: true, message: 'Connected', models: [] }
      return { ok: false, message: await describe(response, 'Anthropic'), models: [] }
    }

    if (type === 'gemini') {
      const response = await fetch(`${base}/models?key=${encodeURIComponent(key)}`)
      if (response.ok) {
        const data = await response.json()
        const models = (data.models ?? [])
          .map((m: { name?: string }) => (m.name ?? '').replace('models/', ''))
          .slice(0, 60)
        return { ok: true, message: 'Connected', models }
      }
      return { ok: false, message: await describe(response, 'Gemini'), models: [] }
    }

    const response = await fetch(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    })
    if (response.ok) {
      const data = await response.json()
      const models = (data.data ?? []).map((m: { id?: string }) => m.id ?? '').slice(0, 60)
      return { ok: true, message: 'Connected', models }
    }
    return { ok: false, message: await describe(response, labelFor(type)), models: [] }
  } catch (error) {
    // A browser fetch that fails with no status is almost always the provider
    // refusing a cross-origin call, not a network fault. Say which.
    const isCors = error instanceof TypeError
    return {
      ok: false,
      message: isCors
        ? `${labelFor(type)} blocked the request from this browser.`
        : (error as Error).message || 'Could not reach the provider.',
      models: [],
    }
  }
}

function labelFor(type: string): string {
  const map: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    groq: 'Groq',
    ollama: 'Ollama',
    custom: 'That endpoint',
  }
  return map[type] ?? type
}

async function describe(response: Response, label: string): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return `${label} rejected that API key.`
  }
  if (response.status === 429) return `${label} is rate-limiting you. Try again shortly.`
  if (response.status >= 500) return `${label} is having problems (${response.status}).`

  let detail = ''
  try {
    const body = await response.json()
    detail = body?.error?.message ?? ''
  } catch {
    /* keep it generic */
  }
  return detail ? `${label}: ${detail}` : `${label} returned ${response.status}.`
}

function toResponse(p: Provider & { api_key?: string }): Provider {
  const { api_key: _key, ...safe } = p
  return safe
}

export async function handleProviders<T>(
  method: string,
  path: string,
  body?: Record<string, any>,
): Promise<T> {
  const seg = path.split('?')[0]

  if (seg === '/ai/providers/test') {
    return (await testConnection(body ?? { type: 'openai' })) as T
  }

  if (seg === '/ai/providers' && method === 'GET') {
    return load().providers.map(toResponse) as T
  }

  if (seg === '/ai/providers' && method === 'POST') {
    const type = body?.type ?? 'openai'
    const result = await testConnection(body ?? {})
    if (!result.ok) {
      throw new ProviderError(502, result.message, 'Check the key and base URL, then try again.')
    }

    const created = {
      id: uid(),
      type,
      name: body?.name ?? labelFor(type),
      base_url: body?.base_url || null,
      default_model: body?.default_model || DEFAULT_MODELS[type] || 'gpt-4o-mini',
      enabled: true,
      feature_overrides: {},
      last_health_status: 'ok',
      last_health_message: 'Connected',
      has_key: !!body?.api_key,
      created_at: new Date().toISOString(),
      api_key: body?.api_key ?? undefined,
    } as Provider & { api_key?: string }

    const data = load()
    data.providers.push(created)
    save(data)
    return toResponse(created) as T
  }

  const match = seg.match(/^\/ai\/providers\/([^/]+)$/)
  if (match) {
    const id = match[1]
    const data = load()

    if (method === 'DELETE') {
      data.providers = data.providers.filter((p) => p.id !== id)
      save(data)
      return undefined as T
    }

    if (method === 'PATCH') {
      const provider = data.providers.find((p) => p.id === id)
      if (!provider) throw new ProviderError(404, "That provider isn't configured here.")
      Object.assign(provider, body)
      save(data)
      return toResponse(provider) as T
    }
  }

  if (seg.match(/^\/ai\/providers\/[^/]+\/health$/)) {
    const id = seg.split('/')[3]
    const provider = load().providers.find((p) => p.id === id)
    if (!provider) throw new ProviderError(404, "That provider isn't configured here.")
    return (await testConnection({
      type: provider.type,
      api_key: provider.api_key,
      base_url: provider.base_url,
      default_model: provider.default_model,
    })) as T
  }

  if (seg === '/ai/conversations') return [] as T
  if (seg === '/ai/usage') {
    return { total_cost_usd: '0', total_tokens: 0, calls: 0, by_provider: {}, by_feature: {} } as T
  }

  throw new ProviderError(404, `Not available: ${method} ${seg}`)
}
