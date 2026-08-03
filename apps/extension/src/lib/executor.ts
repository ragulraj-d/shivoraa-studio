/**
 * Local request execution.
 *
 * This is the extension's reason to exist. A cloud API client cannot reach
 * localhost:8000, and that is precisely where a backend engineer's code runs.
 * Here the request originates from the developer's own machine, so private
 * hosts, VPN-only services and self-signed certificates all work.
 *
 * The server resolves the request into an ExecutionPlan and this sends it, so
 * both execution paths share one resolver and cannot drift apart.
 */

import { lookup } from 'node:dns/promises'
import { performance } from 'node:perf_hooks'

export interface ExecutionPlan {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  timeout: number
  follow_redirects: boolean
  verify_ssl: boolean
  unresolved: string[]
}

export interface ExecutionResult {
  ok: boolean
  status_code: number | null
  status_text: string
  headers: Record<string, string>
  body: string | null
  content_type: string | null
  size_bytes: number
  duration_ms: number
  error_code: string | null
  error_message: string | null
  error_hint: string | null
  final_url: string | null
}

const PRIVATE_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa']

/** Would this target be unreachable from a cloud server? */
export async function isPrivateTarget(url: string): Promise<boolean> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }

  const lower = host.toLowerCase()
  if (lower === 'localhost' || PRIVATE_SUFFIXES.some((s) => lower.endsWith(s))) return true

  try {
    const { address } = await lookup(host)
    return isPrivateIp(address)
  } catch {
    return false
  }
}

function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
    return true
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export async function execute(plan: ExecutionPlan): Promise<ExecutionResult> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), plan.timeout || 30000)

  // Self-signed certificates are normal on a dev machine. This is scoped to a
  // single request and restored immediately, never left switched on globally.
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  if (!plan.verify_ssl) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  try {
    const response = await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body ?? undefined,
      signal: controller.signal,
      redirect: plan.follow_redirects ? 'follow' : 'manual',
    })

    const text = await response.text()
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => (headers[k] = v))

    return {
      ok: true,
      status_code: response.status,
      status_text: response.statusText,
      headers,
      body: text,
      content_type: response.headers.get('content-type'),
      size_bytes: Buffer.byteLength(text),
      duration_ms: Math.round(performance.now() - started),
      error_code: null,
      error_message: null,
      error_hint: null,
      final_url: response.url,
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { name: string; cause?: NodeJS.ErrnoException }
    const code = err.cause?.code ?? err.code
    const aborted = err.name === 'AbortError'

    // Each failure names what happened and what to do — a bare "fetch failed"
    // sends the user hunting for a cause the runtime already knows.
    let message = err.message || 'The request failed.'
    let hint = 'Check the URL and try again.'

    if (aborted) {
      message = `The request timed out after ${plan.timeout}ms.`
      hint = 'Raise shivoraa.timeout, or check whether the server is responding.'
    } else if (code === 'ECONNREFUSED') {
      message = `Nothing is listening on ${hostOf(plan.url)}.`
      hint = 'Is your dev server running? Check the port matches.'
    } else if (code === 'ENOTFOUND') {
      message = `Couldn't resolve ${hostOf(plan.url)}.`
      hint = 'Check the hostname for typos.'
    } else if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      message = 'The TLS certificate was rejected.'
      hint = 'For a local dev server, turn off SSL verification in request settings.'
    } else if (code === 'ECONNRESET') {
      message = 'The connection was reset by the server.'
      hint = 'The server may have crashed mid-request — check its logs.'
    }

    return {
      ok: false,
      status_code: null,
      status_text: '',
      headers: {},
      body: null,
      content_type: null,
      size_bytes: 0,
      duration_ms: Math.round(performance.now() - started),
      error_code: aborted ? 'timeout' : (code ?? 'request_failed'),
      error_message: message,
      error_hint: hint,
      final_url: null,
    }
  } finally {
    clearTimeout(timer)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
  }
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return url
  }
}
