/**
 * Collection importers.
 *
 * Import is what removes the cost of switching tools. Someone with two years of
 * Postman collections will not retype them, so anything that fails to import is
 * a user who never starts.
 *
 * These parse into the app's own shapes rather than storing a foreign format,
 * so an imported request behaves exactly like one created here. Every parser is
 * tolerant: unknown fields are ignored, and anything unsupported is reported
 * rather than silently dropped.
 */

import type { AuthConfig, KeyValue, RequestBody } from '@/lib/types'

export interface ParsedRequest {
  name: string
  method: string
  url: string
  description?: string | null
  headers: KeyValue[]
  query_params: KeyValue[]
  body: RequestBody
  auth: AuthConfig | null
}

export interface ParsedVariable {
  key: string
  value: string
  is_secret: boolean
  enabled: boolean
  description: string | null
}

export interface ParsedEnvironment {
  name: string
  variables: ParsedVariable[]
}

export interface ParsedCollection {
  name: string
  description: string | null
  baseUrl: string | null
  requests: ParsedRequest[]
  /** An environment to create alongside the collection, when the source has one. */
  environment: ParsedEnvironment | null
  /** Things we could not represent — surfaced so nothing vanishes quietly. */
  warnings: string[]
}

export type ImportFormat =
  | 'postman'
  | 'postman_env'
  | 'openapi'
  | 'curl'
  | 'har'
  | 'unknown'

const kv = (key: string, value: string, enabled = true): KeyValue => ({
  key,
  value,
  enabled,
  description: null,
})

const emptyBody = (): RequestBody => ({ mode: 'none', content: '' })

/** Identify the format so the user does not have to tell us. */
export function detectFormat(text: string): ImportFormat {
  const trimmed = text.trim()
  if (/^\s*curl\s/i.test(trimmed)) return 'curl'

  try {
    const parsed = JSON.parse(trimmed)
    // A Postman environment export has values but no items.
    if (parsed?._postman_variable_scope === 'environment') return 'postman_env'
    if (Array.isArray(parsed?.values) && !parsed?.item) return 'postman_env'
    if (parsed?.info?.schema?.includes('getpostman.com')) return 'postman'
    if (parsed?.log?.entries) return 'har'
    if (parsed?.openapi || parsed?.swagger) return 'openapi'
    if (parsed?.item) return 'postman'
  } catch {
    // YAML has no cheap parser here, but OpenAPI's marker lines are distinctive.
    if (/^\s*(openapi|swagger)\s*:/m.test(trimmed)) return 'openapi'
  }
  return 'unknown'
}

// --------------------------------------------------------------------------- //
// Postman v2.1
// --------------------------------------------------------------------------- //
interface PostmanItem {
  name?: string
  item?: PostmanItem[]
  request?: any
  description?: string
}

export function importPostman(text: string): ParsedCollection {
  const doc = JSON.parse(text)
  const warnings: string[] = []
  const requests: ParsedRequest[] = []

  // Postman nests folders arbitrarily deep. Shivoraa has one level of
  // collection, so the folder path is folded into the request name — the
  // structure is visible and nothing is lost.
  function walk(items: PostmanItem[], prefix: string[]): void {
    for (const item of items ?? []) {
      if (item.item) {
        walk(item.item, [...prefix, item.name ?? 'Folder'])
        continue
      }
      if (!item.request) continue

      const req = item.request
      const rawUrl = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '')
      const name = [...prefix, item.name ?? 'Untitled'].join(' / ')

      const headers: KeyValue[] = (req.header ?? [])
        .filter((h: any) => !h.disabled)
        .map((h: any) => kv(h.key ?? '', h.value ?? ''))

      const query: KeyValue[] = (req.url?.query ?? [])
        .filter((q: any) => !q.disabled)
        .map((q: any) => kv(q.key ?? '', q.value ?? ''))

      requests.push({
        name,
        method: (req.method ?? 'GET').toUpperCase(),
        url: postmanUrl(rawUrl),
        description: typeof req.description === 'string' ? req.description : null,
        headers,
        query_params: query,
        body: postmanBody(req.body, warnings, name),
        auth: postmanAuth(req.auth),
      })
    }
  }

  walk(doc.item ?? [], [])

  // Collection variables become an environment rather than being dropped —
  // without them every {{placeholder}} in the imported requests is dead.
  const environment: ParsedEnvironment | null = doc.variable?.length
    ? {
        name: `${doc.info?.name ?? 'Imported'} variables`,
        variables: doc.variable.map((v: any) => ({
          key: v.key ?? '',
          value: String(v.value ?? ''),
          is_secret: v.type === 'secret',
          enabled: !v.disabled,
          description: typeof v.description === 'string' ? v.description : null,
        })),
      }
    : null

  return {
    name: doc.info?.name ?? 'Imported collection',
    description: doc.info?.description?.content ?? doc.info?.description ?? null,
    baseUrl: null,
    requests,
    environment,
    warnings,
  }
}

// --------------------------------------------------------------------------- //
// Postman environment export
// --------------------------------------------------------------------------- //
export function importPostmanEnvironment(text: string): ParsedCollection {
  const doc = JSON.parse(text)
  const warnings: string[] = []

  const variables: ParsedVariable[] = (doc.values ?? []).map((v: any) => ({
    key: v.key ?? '',
    // Postman marks these "secret" but still writes the value into the export
    // file. Importing them as secret keeps them masked from here on.
    is_secret: v.type === 'secret',
    value: String(v.value ?? ''),
    enabled: v.enabled !== false,
    description: null,
  }))

  const secrets = variables.filter((v) => v.is_secret).length
  if (secrets) {
    warnings.push(
      `${secrets} variable(s) marked secret — their values were in the export file and are now masked here.`,
    )
  }
  if (!variables.length) warnings.push('That environment file has no variables.')

  return {
    name: doc.name ?? 'Imported environment',
    description: null,
    baseUrl: null,
    requests: [],
    environment: { name: doc.name ?? 'Imported environment', variables },
    warnings,
  }
}

/** Postman writes `{{var}}` too, so the syntax carries over unchanged. */
function postmanUrl(raw: string): string {
  return (raw || '').replace(/^\{\{([^}]+)\}\}/, '{{$1}}')
}

function postmanBody(body: any, warnings: string[], name: string): RequestBody {
  if (!body || body.mode === 'none') return emptyBody()

  if (body.mode === 'raw') {
    const language = body.options?.raw?.language
    return {
      mode: language === 'json' || looksLikeJson(body.raw) ? 'json' : 'raw',
      content: body.raw ?? '',
    }
  }

  if (body.mode === 'urlencoded') {
    return {
      mode: 'urlencoded',
      content: '',
      form_data: (body.urlencoded ?? [])
        .filter((f: any) => !f.disabled)
        .map((f: any) => kv(f.key ?? '', f.value ?? '')),
    }
  }

  if (body.mode === 'formdata') {
    const hasFiles = (body.formdata ?? []).some((f: any) => f.type === 'file')
    if (hasFiles) {
      warnings.push(`"${name}" uploads a file — re-attach it after importing.`)
    }
    return {
      mode: 'urlencoded',
      content: '',
      form_data: (body.formdata ?? [])
        .filter((f: any) => !f.disabled && f.type !== 'file')
        .map((f: any) => kv(f.key ?? '', f.value ?? '')),
    }
  }

  if (body.mode === 'graphql') {
    return {
      mode: 'graphql',
      content: body.graphql?.query ?? '',
      graphql_variables: body.graphql?.variables ?? '',
    }
  }

  warnings.push(`"${name}" uses an unsupported body type (${body.mode}).`)
  return emptyBody()
}

function postmanAuth(auth: any): AuthConfig | null {
  if (!auth?.type || auth.type === 'noauth') return null
  const pick = (list: any[], key: string) =>
    (list ?? []).find((x: any) => x.key === key)?.value ?? ''

  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', token: pick(auth.bearer, 'token') }
    case 'basic':
      return {
        type: 'basic',
        username: pick(auth.basic, 'username'),
        password: pick(auth.basic, 'password'),
      }
    case 'apikey':
      return {
        type: 'api_key',
        key: pick(auth.apikey, 'key'),
        value: pick(auth.apikey, 'value'),
        add_to: pick(auth.apikey, 'in') === 'query' ? 'query' : 'header',
      }
    default:
      return null
  }
}

// --------------------------------------------------------------------------- //
// OpenAPI 3.x / Swagger 2.0
// --------------------------------------------------------------------------- //
export function importOpenApi(text: string): ParsedCollection {
  const doc = JSON.parse(text)
  const warnings: string[] = []
  const requests: ParsedRequest[] = []

  const baseUrl: string | null =
    doc.servers?.[0]?.url ??
    (doc.host ? `${doc.schemes?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}` : null)

  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

  for (const [path, operations] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = operations?.[method]
      if (!op) continue

      const params = [...(operations.parameters ?? []), ...(op.parameters ?? [])]
      const headers: KeyValue[] = []
      const query: KeyValue[] = []

      for (const raw of params) {
        const param = raw.$ref ? resolveRef(doc, raw.$ref) : raw
        if (!param?.name) continue
        // Required parameters are enabled; optional ones come in switched off,
        // so the request is runnable immediately without sending empty values.
        if (param.in === 'header') headers.push(kv(param.name, '', !!param.required))
        else if (param.in === 'query') query.push(kv(param.name, '', !!param.required))
      }

      requests.push({
        name: op.summary || op.operationId || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: `${baseUrl ? '' : ''}${path}`,
        description: op.description ?? null,
        headers,
        query_params: query,
        body: openApiBody(doc, op, warnings),
        auth: doc.components?.securitySchemes || doc.securityDefinitions
          ? { type: 'inherit' }
          : null,
      })
    }
  }

  if (!requests.length) warnings.push('No operations found in that specification.')

  // Extra servers become environment variables, so switching between staging
  // and production is a dropdown rather than an edit.
  const servers: string[] = (doc.servers ?? []).map((s: any) => s.url).filter(Boolean)
  const environment: ParsedEnvironment | null = servers.length
    ? {
        name: `${doc.info?.title ?? 'API'} servers`,
        variables: servers.map((url: string, index: number) => ({
          key: index === 0 ? 'base_url' : `base_url_${index + 1}`,
          value: url,
          is_secret: false,
          enabled: index === 0,
          description: doc.servers?.[index]?.description ?? null,
        })),
      }
    : null

  return {
    name: doc.info?.title ?? 'Imported API',
    description: doc.info?.description ?? null,
    baseUrl,
    requests,
    environment,
    warnings,
  }
}

function resolveRef(doc: any, ref: string): any {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, key) => node?.[key], doc)
}

function openApiBody(doc: any, op: any, warnings: string[]): RequestBody {
  const content = op.requestBody?.content ?? {}
  const json = content['application/json']
  if (!json) {
    if (Object.keys(content).length) {
      warnings.push(`"${op.summary ?? op.operationId}" uses a non-JSON body.`)
    }
    return emptyBody()
  }

  const schema = json.schema?.$ref ? resolveRef(doc, json.schema.$ref) : json.schema
  return { mode: 'json', content: JSON.stringify(sampleFromSchema(doc, schema), null, 2) }
}

/**
 * Build a realistic sample body from a schema.
 *
 * An example the user can edit beats an empty box: it shows the shape without
 * making them read the spec.
 */
function sampleFromSchema(doc: any, schema: any, depth = 0): unknown {
  if (!schema || depth > 6) return null
  if (schema.$ref) return sampleFromSchema(doc, resolveRef(doc, schema.$ref), depth + 1)
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (schema.enum?.length) return schema.enum[0]

  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries<any>(schema.properties ?? {})) {
        out[key] = sampleFromSchema(doc, value, depth + 1)
      }
      return out
    }
    case 'array':
      return [sampleFromSchema(doc, schema.items, depth + 1)]
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return true
    case 'string':
      if (schema.format === 'date-time') return new Date().toISOString()
      if (schema.format === 'email') return 'user@example.com'
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
      return 'string'
    default:
      return schema.properties ? sampleFromSchema(doc, { ...schema, type: 'object' }, depth) : null
  }
}

// --------------------------------------------------------------------------- //
// cURL
// --------------------------------------------------------------------------- //
export function importCurl(text: string): ParsedCollection {
  const warnings: string[] = []
  const requests: ParsedRequest[] = []

  // Several commands can be pasted at once; blank lines separate them.
  for (const block of text.split(/\n\s*\n/)) {
    const parsed = parseCurl(block.replace(/\\\s*\n/g, ' '))
    if (parsed) requests.push(parsed)
  }

  if (!requests.length) warnings.push("That doesn't look like a cURL command.")

  return {
    name: 'Imported from cURL',
    description: null,
    baseUrl: null,
    requests,
    environment: null,
    warnings,
  }
}

function parseCurl(input: string): ParsedRequest | null {
  if (!/curl\s/i.test(input)) return null
  const tokens = input.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)
  if (!tokens) return null

  const strip = (s: string) => s.replace(/^['"]|['"]$/g, '')
  let method = ''
  let url = ''
  const headers: KeyValue[] = []
  let body = ''

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-X' || token === '--request') {
      method = strip(tokens[++i] ?? '').toUpperCase()
    } else if (token === '-H' || token === '--header') {
      const raw = strip(tokens[++i] ?? '')
      const idx = raw.indexOf(':')
      if (idx > 0) headers.push(kv(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()))
    } else if (['-d', '--data', '--data-raw', '--data-binary'].includes(token)) {
      body = strip(tokens[++i] ?? '')
    } else if (token === '-u' || token === '--user') {
      const [user, ...rest] = strip(tokens[++i] ?? '').split(':')
      headers.push(kv('Authorization', `Basic ${btoa(`${user}:${rest.join(':')}`)}`))
    } else if (/^https?:\/\//i.test(strip(token))) {
      url = strip(token)
    }
  }

  if (!url) return null

  // curl implies POST when a body is present and no method was given.
  if (!method) method = body ? 'POST' : 'GET'

  const query: KeyValue[] = []
  try {
    const parsed = new URL(url)
    parsed.searchParams.forEach((value, key) => query.push(kv(key, value)))
    if (query.length) url = `${parsed.origin}${parsed.pathname}`
  } catch {
    /* leave the URL as typed */
  }

  return {
    name: nameFromUrl(url),
    method,
    url,
    description: null,
    headers,
    query_params: query,
    body: body
      ? { mode: looksLikeJson(body) ? 'json' : 'raw', content: body }
      : emptyBody(),
    auth: null,
  }
}

// --------------------------------------------------------------------------- //
// HAR
// --------------------------------------------------------------------------- //
export function importHar(text: string): ParsedCollection {
  const doc = JSON.parse(text)
  const warnings: string[] = []
  const requests: ParsedRequest[] = []
  const skipHeaders = new Set(['cookie', 'host', 'content-length', 'connection'])

  for (const entry of doc.log?.entries ?? []) {
    const req = entry.request
    if (!req?.url) continue
    // Browser recordings are dominated by asset fetches; keeping them would
    // bury the API calls the user actually wants.
    if (/\.(png|jpe?g|gif|svg|css|js|woff2?|ico|map)(\?|$)/i.test(req.url)) continue

    let url = req.url
    const query: KeyValue[] = (req.queryString ?? []).map((q: any) => kv(q.name, q.value))
    try {
      const parsed = new URL(url)
      if (query.length) url = `${parsed.origin}${parsed.pathname}`
    } catch {
      /* leave as-is */
    }

    requests.push({
      name: nameFromUrl(req.url),
      method: (req.method ?? 'GET').toUpperCase(),
      url,
      description: null,
      headers: (req.headers ?? [])
        .filter((h: any) => !h.name?.startsWith(':') && !skipHeaders.has(h.name?.toLowerCase()))
        .map((h: any) => kv(h.name, h.value)),
      query_params: query,
      body: req.postData?.text
        ? {
            mode: looksLikeJson(req.postData.text) ? 'json' : 'raw',
            content: req.postData.text,
          }
        : emptyBody(),
      auth: null,
    })
  }

  if (!requests.length) warnings.push('No API requests found in that HAR file.')

  return {
    name: 'Imported from HAR',
    description: null,
    baseUrl: null,
    requests,
    environment: null,
    warnings,
  }
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //
export function importAny(text: string): ParsedCollection {
  const format = detectFormat(text)
  switch (format) {
    case 'postman':
      return importPostman(text)
    case 'postman_env':
      return importPostmanEnvironment(text)
    case 'openapi':
      return importOpenApi(text)
    case 'curl':
      return importCurl(text)
    case 'har':
      return importHar(text)
    default:
      throw new Error(
        "Couldn't recognise that format. Supported: Postman v2.1, OpenAPI 3.x, Swagger 2.0, HAR, and cURL.",
      )
  }
}

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  postman: 'Postman collection',
  postman_env: 'Postman environment',
  openapi: 'OpenAPI / Swagger',
  curl: 'cURL command',
  har: 'HAR recording',
  unknown: 'Unknown',
}

function looksLikeJson(text: string): boolean {
  const trimmed = (text ?? '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/$/, '')
    return path && path !== '/' ? path : parsed.hostname
  } catch {
    return url.slice(0, 60)
  }
}
