/**
 * Local-mode API.
 *
 * Implements the same request/response contract as the FastAPI server, so every
 * component in the app works unchanged whether it is talking to a real backend
 * or to this. That is the whole design: one UI, two backends, no branching in
 * feature code.
 */

import { load, uid, update } from '@/lib/localStore'
import type {
  ApiRequest,
  Collection,
  Environment,
  ExecutionResult,
  HistoryItem,
  KeyValue,
  Provider,
} from '@/lib/types'

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

class LocalApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public hint?: string,
  ) {
    super(detail)
  }
}

// --------------------------------------------------------------------------- //
// Request resolution — mirrors the server's resolver so behaviour matches
// --------------------------------------------------------------------------- //
function resolveVariables(env: Environment | undefined) {
  const values: Record<string, string> = {}
  for (const v of env?.variables ?? []) {
    if (v.enabled && v.value != null) values[v.key] = v.value
  }
  return values
}

function interpolate(text: string, values: Record<string, string>, unresolved: string[]): string {
  return (text || '').replace(VARIABLE_RE, (match, name: string) => {
    if (name in values) return values[name]
    if (!unresolved.includes(name)) unresolved.push(name)
    // Left visible rather than blanked: a URL showing {{api_token}} is
    // diagnosable, an empty string is a mystery 401.
    return match
  })
}

function enabled(rows: KeyValue[] | undefined) {
  return (rows ?? []).filter((r) => r.enabled && r.key)
}

interface Plan {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  unresolved: string[]
}

export function buildPlan(
  request: Partial<ApiRequest>,
  collection: Collection | undefined,
  env: Environment | undefined,
): Plan {
  const values = resolveVariables(env)
  const unresolved: string[] = []
  const interp = (t: string) => interpolate(t, values, unresolved)

  let url = interp(request.url ?? '')
  if (collection?.base_url && !/^https?:\/\//i.test(url)) {
    url = interp(collection.base_url).replace(/\/$/, '') + '/' + url.replace(/^\//, '')
  }

  for (const p of enabled(request.path_params)) {
    url = url.replace(`{${p.key}}`, interp(p.value))
  }

  const headers: Record<string, string> = {}
  for (const h of enabled(collection?.default_headers)) headers[interp(h.key)] = interp(h.value)
  for (const h of enabled(request.headers)) headers[interp(h.key)] = interp(h.value)

  const query = enabled(request.query_params).map(
    (q) => `${encodeURIComponent(interp(q.key))}=${encodeURIComponent(interp(q.value))}`,
  )
  if (query.length) url += (url.includes('?') ? '&' : '?') + query.join('&')

  const auth = request.auth?.type && request.auth.type !== 'inherit' ? request.auth : collection?.auth
  if (auth && typeof auth === 'object' && 'type' in auth) {
    if (auth.type === 'bearer' && auth.token) {
      headers.Authorization = `Bearer ${interp(auth.token)}`
    } else if (auth.type === 'basic') {
      headers.Authorization = `Basic ${btoa(`${interp(auth.username ?? '')}:${interp(auth.password ?? '')}`)}`
    } else if (auth.type === 'api_key' && auth.key) {
      headers[interp(auth.key)] = interp(auth.value ?? '')
    }
  }

  let body: string | null = null
  const spec = request.body
  if (spec && spec.mode !== 'none') {
    if (spec.mode === 'urlencoded') {
      body = enabled(spec.form_data)
        .map((f) => `${encodeURIComponent(interp(f.key))}=${encodeURIComponent(interp(f.value))}`)
        .join('&')
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
    } else if (spec.mode === 'graphql') {
      let vars = {}
      try {
        vars = JSON.parse(interp(spec.graphql_variables || '{}') || '{}')
      } catch {
        /* a half-typed variables block shouldn't block the send */
      }
      body = JSON.stringify({ query: interp(spec.content), variables: vars })
      headers['Content-Type'] = 'application/json'
    } else {
      body = interp(spec.content)
      headers['Content-Type'] ??= spec.mode === 'json' ? 'application/json' : 'text/plain'
    }
  }

  return { method: (request.method ?? 'GET').toUpperCase(), url, headers, body, unresolved }
}

// --------------------------------------------------------------------------- //
// Execution — fetch() straight from the browser
// --------------------------------------------------------------------------- //
async function execute(payload: {
  request_id?: string
  adhoc?: Partial<ApiRequest>
  environment_id?: string | null
}): Promise<ExecutionResult> {
  const data = load()
  const env =
    data.environments.find((e) => e.id === payload.environment_id) ??
    data.environments.find((e) => e.is_default)

  let request: Partial<ApiRequest> | undefined = payload.adhoc
  let collection: Collection | undefined

  if (payload.request_id) {
    for (const c of data.collections) {
      const found = c.requests.find((r) => r.id === payload.request_id)
      if (found) {
        request = found
        collection = c
        break
      }
    }
  }

  if (!request) {
    throw new LocalApiError(400, 'Nothing to send.', 'Pick a request or enter a URL.')
  }

  const plan = buildPlan(request, collection, env)
  if (!plan.url.trim()) {
    throw new LocalApiError(422, 'This request has no URL.', 'Enter a URL and try again.')
  }

  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const response = await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      signal: controller.signal,
      // No cookies: this is the user's browser calling a third-party API, and
      // silently attaching their session cookies would be a real hazard.
      credentials: 'omit',
      redirect: 'follow',
    })

    const text = await response.text()
    const total = performance.now() - started
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => (headers[k] = v))

    const result: ExecutionResult = {
      id: uid(),
      ok: true,
      mode: 'browser',
      status_code: response.status,
      headers,
      body: text,
      content_type: response.headers.get('content-type'),
      size_bytes: new Blob([text]).size,
      timing: { dns_ms: null, connect_ms: null, tls_ms: null, ttfb_ms: null, total_ms: total },
      error_code: null,
      error_message: null,
      error_hint: null,
      final_url: response.url,
      redirect_count: 0,
      unresolved_variables: plan.unresolved,
      requires_local: false,
    }

    recordHistory(plan, result, payload.request_id)
    return result
  } catch (error) {
    const total = performance.now() - started
    const aborted = (error as Error).name === 'AbortError'

    // A CORS rejection surfaces as an opaque TypeError with no detail — the
    // browser deliberately withholds it. Naming it explicitly saves the user
    // from debugging a network error that is actually a policy decision.
    const isCors = !aborted && error instanceof TypeError

    const result: ExecutionResult = {
      id: uid(),
      ok: false,
      mode: 'browser',
      status_code: null,
      headers: {},
      body: null,
      content_type: null,
      size_bytes: 0,
      timing: { dns_ms: null, connect_ms: null, tls_ms: null, ttfb_ms: null, total_ms: total },
      error_code: aborted ? 'timeout' : isCors ? 'cors_blocked' : 'request_failed',
      error_message: aborted
        ? 'The request timed out after 60 seconds.'
        : isCors
          ? `The browser blocked this request to ${hostOf(plan.url)}.`
          : (error as Error).message || 'The request failed.',
      error_hint: aborted
        ? 'The server may be slow or unreachable.'
        : isCors
          ? "That API doesn't allow calls from other websites (no CORS headers). " +
            'Nothing is wrong with your request — run Shivoraa locally to send it ' +
            'through a server instead.'
          : 'Check the URL and your network connection.',
      final_url: null,
      redirect_count: 0,
      unresolved_variables: plan.unresolved,
      requires_local: isCors,
    }

    recordHistory(plan, result, payload.request_id)
    return result
  } finally {
    clearTimeout(timeout)
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function recordHistory(plan: Plan, result: ExecutionResult, requestId?: string) {
  update((data) => {
    const item: HistoryItem = {
      id: result.id ?? uid(),
      request_id: requestId ?? null,
      method: plan.method,
      url: plan.url,
      status_code: result.status_code,
      duration_ms: result.timing.total_ms,
      response_size: result.size_bytes,
      mode: 'browser',
      status: result.ok ? 'success' : 'failed',
      error_message: result.error_message,
      created_at: new Date().toISOString(),
    }
    data.history.unshift(item)
    data.history = data.history.slice(0, 100)
  })
}

// --------------------------------------------------------------------------- //
// Router — same paths the server exposes
// --------------------------------------------------------------------------- //
export async function handleLocal<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const data = load()
  const seg = path.split('?')[0]

  // --- auth ---
  if (seg === '/auth/config') {
    return { google_enabled: false, guest_enabled: true, google_client_id: null } as T
  }
  if (seg === '/auth/guest' || seg === '/auth/refresh') {
    return { access_token: 'local', expires_in: 86400 } as T
  }
  if (seg === '/auth/me') {
    return {
      user: {
        id: 'local-user',
        email: 'you@thisbrowser',
        display_name: 'You',
        avatar_url: null,
        email_verified: true,
        is_guest: false,
        ai_trial_used: 0,
        created_at: new Date().toISOString(),
      },
      workspaces: [
        { id: 'local', name: 'Local Workspace', slug: 'local', is_personal: true, role: 'owner' },
      ],
    } as T
  }
  if (seg === '/auth/logout') return undefined as T

  // --- collections ---
  if (seg === '/collections' && method === 'GET') return data.collections as T
  if (seg === '/collections' && method === 'POST') {
    const created: Collection = {
      id: uid(),
      workspace_id: 'local',
      name: (body as { name: string }).name,
      description: null,
      base_url: null,
      auth: {},
      default_headers: [],
      docs_markdown: null,
      position: data.collections.length,
      version: 1,
      created_at: new Date().toISOString(),
      folders: [],
      requests: [],
    }
    update((d) => void d.collections.push(created))
    return created as T
  }

  const collectionMatch = seg.match(/^\/collections\/([^/]+)$/)
  if (collectionMatch) {
    const id = collectionMatch[1]
    if (method === 'GET') {
      const found = data.collections.find((c) => c.id === id)
      if (!found) throw new LocalApiError(404, "That collection doesn't exist.")
      return found as T
    }
    if (method === 'DELETE') {
      update((d) => void (d.collections = d.collections.filter((c) => c.id !== id)))
      return undefined as T
    }
    if (method === 'PATCH') {
      let out: Collection | undefined
      update((d) => {
        const c = d.collections.find((x) => x.id === id)
        if (c) {
          Object.assign(c, body as object)
          c.version += 1
          out = c
        }
      })
      return out as T
    }
  }

  const requestsMatch = seg.match(/^\/collections\/([^/]+)\/requests$/)
  if (requestsMatch && method === 'POST') {
    const payload = body as Partial<ApiRequest>
    const created: ApiRequest = {
      id: uid(),
      collection_id: requestsMatch[1],
      folder_id: null,
      name: payload.name ?? 'Untitled request',
      method: (payload.method ?? 'GET').toUpperCase(),
      url: payload.url ?? '',
      description: null,
      headers: payload.headers ?? [],
      query_params: payload.query_params ?? [],
      path_params: [],
      body: payload.body ?? { mode: 'none', content: '' },
      auth: payload.auth ?? null,
      settings: {},
      position: 0,
      docs_markdown: null,
      tests_code: null,
      tests_framework: null,
      version: 1,
      updated_at: new Date().toISOString(),
    }
    update((d) => {
      const c = d.collections.find((x) => x.id === requestsMatch[1])
      if (c) {
        created.position = c.requests.length
        c.requests.push(created)
      }
    })
    return created as T
  }

  const requestMatch = seg.match(/^\/requests\/([^/]+)$/)
  if (requestMatch) {
    const id = requestMatch[1]
    if (method === 'PATCH') {
      let out: ApiRequest | undefined
      update((d) => {
        for (const c of d.collections) {
          const r = c.requests.find((x) => x.id === id)
          if (r) {
            Object.assign(r, body as object)
            r.version += 1
            r.updated_at = new Date().toISOString()
            out = r
            break
          }
        }
      })
      if (!out) throw new LocalApiError(404, "That request doesn't exist.")
      return out as T
    }
    if (method === 'DELETE') {
      update((d) => {
        for (const c of d.collections) c.requests = c.requests.filter((r) => r.id !== id)
      })
      return undefined as T
    }
    if (method === 'GET') {
      for (const c of data.collections) {
        const r = c.requests.find((x) => x.id === id)
        if (r) return r as T
      }
      throw new LocalApiError(404, "That request doesn't exist.")
    }
  }

  // --- environments ---
  if (seg === '/environments' && method === 'GET') return data.environments as T
  if (seg === '/environments' && method === 'POST') {
    const created: Environment = {
      id: uid(),
      name: (body as { name: string }).name,
      color: null,
      is_default: data.environments.length === 0,
      version: 1,
      created_at: new Date().toISOString(),
      variables: [],
    }
    update((d) => void d.environments.push(created))
    return created as T
  }

  const envMatch = seg.match(/^\/environments\/([^/]+)$/)
  if (envMatch) {
    const id = envMatch[1]
    if (method === 'DELETE') {
      update((d) => void (d.environments = d.environments.filter((e) => e.id !== id)))
      return undefined as T
    }
    if (method === 'PATCH') {
      let out: Environment | undefined
      update((d) => {
        const e = d.environments.find((x) => x.id === id)
        if (!e) return
        const payload = body as { name?: string; variables?: { key: string; value: string; is_secret: boolean; enabled: boolean; description?: string | null }[] }
        if (payload.name) e.name = payload.name
        if (payload.variables) {
          e.variables = payload.variables.map((v) => ({
            id: uid(),
            key: v.key,
            value: v.value,
            is_secret: v.is_secret,
            enabled: v.enabled,
            description: v.description ?? null,
          }))
        }
        e.version += 1
        out = e
      })
      return out as T
    }
  }

  // --- execution ---
  if (seg === '/executions' && method === 'POST') {
    return (await execute(body as Parameters<typeof execute>[0])) as T
  }
  if (seg === '/executions' && method === 'GET') return data.history as T

  // --- providers ---
  if (seg === '/ai/providers' && method === 'GET') {
    return data.providers.map(({ api_key: _key, ...p }) => p) as T
  }
  if (seg === '/ai/providers' && method === 'POST') {
    const payload = body as { type: Provider['type']; name: string; api_key?: string; base_url?: string; default_model?: string }
    const created = {
      id: uid(),
      type: payload.type,
      name: payload.name,
      base_url: payload.base_url ?? null,
      default_model: payload.default_model ?? 'gpt-4o-mini',
      enabled: true,
      feature_overrides: {},
      last_health_status: 'ok',
      last_health_message: 'Saved in this browser',
      has_key: !!payload.api_key,
      created_at: new Date().toISOString(),
      api_key: payload.api_key,
    }
    update((d) => void d.providers.push(created))
    const { api_key: _k, ...safe } = created
    return safe as T
  }
  if (seg === '/ai/providers/test') {
    return { ok: true, message: 'Key will be used directly from this browser.', models: [] } as T
  }
  const providerMatch = seg.match(/^\/ai\/providers\/([^/]+)$/)
  if (providerMatch && method === 'DELETE') {
    update((d) => void (d.providers = d.providers.filter((p) => p.id !== providerMatch[1])))
    return undefined as T
  }

  if (seg === '/ai/conversations') return [] as T
  if (seg === '/workspaces/current/members') {
    return [
      {
        id: 'local',
        user_id: 'local-user',
        email: 'you@thisbrowser',
        display_name: 'You',
        avatar_url: null,
        role: 'owner',
        joined_at: new Date().toISOString(),
      },
    ] as T
  }

  throw new LocalApiError(404, `Not available in local mode: ${method} ${seg}`)
}

export { LocalApiError }
