/**
 * API client.
 *
 * The access token is held in module memory, never localStorage. localStorage is
 * readable by any XSS; a memory-held token dies with the tab, and the httpOnly
 * refresh cookie restores the session on reload without ever being visible to
 * script. The cost is one refresh round-trip on load, which is worth it.
 */

const BASE = import.meta.env.VITE_API_URL || '/api/v1'

let accessToken: string | null = null
let activeWorkspaceId: string | null = localStorage.getItem('sv_workspace')
let refreshPromise: Promise<boolean> | null = null

export function setAccessToken(token: string | null) {
  accessToken = token
}

export function getAccessToken() {
  return accessToken
}

export function setActiveWorkspace(id: string | null) {
  activeWorkspaceId = id
  if (id) localStorage.setItem('sv_workspace', id)
  else localStorage.removeItem('sv_workspace')
}

export function getActiveWorkspace() {
  return activeWorkspaceId
}

export interface ApiErrorBody {
  code: string
  detail: string
  hint?: string
  fields?: { field: string; message: string }[]
  [key: string]: unknown
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
  ) {
    super(body.detail)
    this.name = 'ApiError'
  }

  get hint() {
    return this.body.hint
  }

  get fields() {
    return this.body.fields ?? []
  }
}

function headers(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...(extra as object) }
  if (accessToken) h.Authorization = `Bearer ${accessToken}`
  if (activeWorkspaceId) h['X-Workspace-Id'] = activeWorkspaceId
  return h
}

/**
 * Refresh the access token.
 *
 * Concurrent 401s share one in-flight refresh. Without this, ten parallel
 * requests expiring together would fire ten rotations — and since refresh
 * tokens rotate with reuse detection, that would look like token theft and log
 * the user out.
 */
async function refresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) return false
      const data = await response.json()
      accessToken = data.access_token
      return true
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: headers(init.headers),
  })

  if (response.status === 401 && retry && !path.startsWith('/auth/refresh')) {
    if (await refresh()) return request<T>(path, init, false)
    accessToken = null
    window.dispatchEvent(new CustomEvent('sv:signed-out'))
  }

  if (!response.ok) {
    let body: ApiErrorBody = { code: 'unknown', detail: `Request failed (${response.status})` }
    try {
      const parsed = await response.json()
      if (parsed?.error) body = parsed.error
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiError(response.status, body)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  refresh,
}

/**
 * Stream an SSE endpoint.
 *
 * EventSource can't send POST bodies or Authorization headers, so this parses
 * the SSE frame format off a fetch stream instead.
 */
export async function streamSSE(
  path: string,
  body: unknown,
  handlers: {
    onEvent: (event: string, data: unknown) => void
    onError?: (error: Error) => void
    signal?: AbortSignal
  },
): Promise<void> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: handlers.signal,
    })

    if (response.status === 401 && (await refresh())) {
      return streamSSE(path, body, handlers)
    }

    if (!response.ok || !response.body) {
      let detail = `Stream failed (${response.status})`
      try {
        const parsed = await response.json()
        detail = parsed?.error?.detail ?? detail
      } catch {
        /* keep the generic message */
      }
      handlers.onError?.(new Error(detail))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; a partial frame stays in the
      // buffer until its terminator arrives.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        let eventName = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (!dataLines.length) continue
        try {
          handlers.onEvent(eventName, JSON.parse(dataLines.join('\n')))
        } catch {
          handlers.onEvent(eventName, dataLines.join('\n'))
        }
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    handlers.onError?.(error as Error)
  }
}
