/**
 * Request resolution.
 *
 * Mirrors the web app's resolver exactly — same precedence, same auth
 * inheritance, same `{{variable}}` handling — so a request behaves identically
 * whether it runs here or in the browser. Two resolvers that drift produce the
 * worst class of bug in this product: one that only appears in one surface.
 */

export interface KeyValue {
  key: string
  value: string
  enabled: boolean
}

export interface RequestBody {
  mode: string
  content: string
  form_data?: KeyValue[]
  graphql_variables?: string
}

export interface AuthConfig {
  type: string
  token?: string
  username?: string
  password?: string
  key?: string
  value?: string
  add_to?: string
}

export interface SavedRequest {
  id: string
  collectionId: string
  name: string
  method: string
  url: string
  headers: KeyValue[]
  queryParams: KeyValue[]
  pathParams: KeyValue[]
  body: RequestBody
  auth: AuthConfig | null
}

export interface SavedCollection {
  id: string
  name: string
  baseUrl?: string | null
  auth?: AuthConfig | null
  defaultHeaders?: KeyValue[]
}

export interface Environment {
  id: string
  name: string
  isDefault: boolean
  variables: { key: string; value: string; enabled: boolean; is_secret?: boolean }[]
}

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export interface ResolvedPlan {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  follow_redirects: boolean
  verify_ssl: boolean
  unresolved: string[]
}

export function buildPlan(
  request: SavedRequest,
  collection: SavedCollection | undefined,
  environment: Environment | undefined,
): ResolvedPlan {
  const values: Record<string, string> = {}
  for (const v of environment?.variables ?? []) {
    if (v.enabled && v.value != null) values[v.key] = v.value
  }

  const unresolved: string[] = []
  const interp = (text: string): string =>
    (text || '').replace(VARIABLE_RE, (match, name: string) => {
      if (name in values) return values[name]
      if (!unresolved.includes(name)) unresolved.push(name)
      // Left visible rather than blanked: a URL showing {{api_token}} is
      // diagnosable, an empty string is a mystery 401.
      return match
    })

  const enabled = (rows?: KeyValue[]) => (rows ?? []).filter((r) => r.enabled && r.key)

  let url = interp(request.url)
  if (collection?.baseUrl && !/^https?:\/\//i.test(url)) {
    url = interp(collection.baseUrl).replace(/\/$/, '') + '/' + url.replace(/^\//, '')
  }

  for (const param of enabled(request.pathParams)) {
    url = url.replace(`{${param.key}}`, interp(param.value))
  }

  const headers: Record<string, string> = {}
  for (const h of enabled(collection?.defaultHeaders)) headers[interp(h.key)] = interp(h.value)
  for (const h of enabled(request.headers)) headers[interp(h.key)] = interp(h.value)

  const query = enabled(request.queryParams).map(
    (q) => `${encodeURIComponent(interp(q.key))}=${encodeURIComponent(interp(q.value))}`,
  )
  if (query.length) url += (url.includes('?') ? '&' : '?') + query.join('&')

  const auth =
    request.auth?.type && request.auth.type !== 'inherit' ? request.auth : collection?.auth
  if (auth?.type === 'bearer' && auth.token) {
    headers.Authorization = `Bearer ${interp(auth.token)}`
  } else if (auth?.type === 'basic') {
    const pair = `${interp(auth.username ?? '')}:${interp(auth.password ?? '')}`
    headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`
  } else if (auth?.type === 'api_key' && auth.key) {
    headers[interp(auth.key)] = interp(auth.value ?? '')
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
      let variables = {}
      try {
        variables = JSON.parse(interp(spec.graphql_variables || '{}') || '{}')
      } catch {
        /* a half-typed variables block shouldn't block the send */
      }
      body = JSON.stringify({ query: interp(spec.content), variables })
      headers['Content-Type'] = 'application/json'
    } else {
      body = interp(spec.content)
      headers['Content-Type'] ??= spec.mode === 'json' ? 'application/json' : 'text/plain'
    }
  }

  return {
    method: (request.method || 'GET').toUpperCase(),
    url,
    headers,
    body,
    follow_redirects: true,
    verify_ssl: true,
    unresolved,
  }
}
