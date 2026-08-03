/**
 * Browser request execution.
 *
 * Firestore holds the data; this sends the actual HTTP request. It is the one
 * operation that can never be a database call — the user's browser reaches the
 * target API directly.
 *
 * Resolution mirrors the server's resolver exactly, so a request behaves the
 * same whether it runs here or through the FastAPI proxy.
 */

import { uid } from '@/lib/localStore'
import type {
  ApiRequest,
  Collection,
  Environment,
  ExecutionResult,
  KeyValue,
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
export interface ExecuteInput {
  request: Partial<ApiRequest>
  collection?: Collection
  environment?: Environment
  requestId?: string
}

async function execute(input: ExecuteInput): Promise<ExecutionResult> {
  const { request, collection, environment } = input
  const payload = { request_id: input.requestId }

  if (!request) {
    throw new LocalApiError(400, 'Nothing to send.', 'Pick a request or enter a URL.')
  }

  const plan = buildPlan(request, collection, environment)
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
          ? `${hostOf(plan.url)} did not return an Access-Control-Allow-Origin header for ` +
            'this site, so the browser discarded the response. Your request was fine — ' +
            'the API has to opt in.'
          : 'Check the URL and your network connection.',
      final_url: null,
      redirect_count: 0,
      unresolved_variables: plan.unresolved,
      // A CORS refusal is not a private-network problem, and conflating the two
      // showed the user the wrong explanation entirely.
      requires_local: false,
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
  // Fire-and-forget into Firestore. History is never worth failing a
  // successful request over.
  void import('@/lib/firebaseApi').then(({ recordExecution }) =>
    recordExecution({
      requestId,
      method: plan.method,
      url: plan.url,
      statusCode: result.status_code,
      durationMs: Math.round(result.timing.total_ms),
      responseSize: result.size_bytes,
      errorMessage: result.error_message,
    }),
  )
}

export { LocalApiError }
export const executeInBrowser = execute
