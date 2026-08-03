import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** HTTP method colours match the conventions developers already know. */
export const METHOD_COLORS: Record<string, string> = {
  GET: 'text-info',
  POST: 'text-success',
  PUT: 'text-accent-bright',
  PATCH: 'text-warning',
  DELETE: 'text-danger',
  HEAD: 'text-muted',
  OPTIONS: 'text-muted',
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export function statusColor(status: number | null): string {
  if (status === null) return 'text-muted'
  if (status < 200) return 'text-info'
  if (status < 300) return 'text-success'
  if (status < 400) return 'text-warning'
  return 'text-danger'
}

export function statusText(status: number): string {
  const map: Record<number, string> = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
    429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  }
  return map[status] ?? ''
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Pretty-print JSON, leaving non-JSON untouched rather than mangling it. */
export function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function isJsonContent(contentType: string | null): boolean {
  return !!contentType && /json/i.test(contentType)
}

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export function findVariables(text: string): string[] {
  return [...text.matchAll(VARIABLE_RE)].map((m) => m[1])
}

/**
 * Resolve `{{vars}}` for the live preview under the URL bar.
 *
 * This is display-only — the server resolves authoritatively at send time. Its
 * job is to let the user see an unresolved variable before they send, rather
 * than diagnosing it from a 401 afterwards.
 */
export function interpolatePreview(
  text: string,
  variables: Record<string, string>,
): { resolved: string; unresolved: string[] } {
  const unresolved: string[] = []
  const resolved = text.replace(VARIABLE_RE, (match, name: string) => {
    if (name in variables) return variables[name]
    if (!unresolved.includes(name)) unresolved.push(name)
    return match
  })
  return { resolved, unresolved }
}

export function buildCurl(
  method: string,
  url: string,
  headers: { key: string; value: string; enabled: boolean }[],
  body: string | null,
): string {
  const parts = [`curl -X ${method} '${url}'`]
  for (const h of headers) {
    if (h.enabled && h.key) parts.push(`  -H '${h.key}: ${h.value}'`)
  }
  if (body) parts.push(`  -d '${body.replace(/'/g, "'\\''")}'`)
  return parts.join(' \\\n')
}

export function emptyKeyValue() {
  return { key: '', value: '', enabled: true, description: '' }
}
