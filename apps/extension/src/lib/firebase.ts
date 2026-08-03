/**
 * Firebase client for the extension host.
 *
 * The web app is a Firebase deployment with no server of its own, so there is
 * nowhere to run a device-authorization flow and no way to mint a custom token
 * (that needs a service account, which must never ship inside an extension).
 *
 * Instead the user pairs the extension with a token the web app already holds:
 * their own Firebase refresh token, shown once under Settings. The extension
 * exchanges it for short-lived ID tokens against Google's public endpoint and
 * talks to Firestore over REST. No secret of ours is embedded anywhere, and the
 * pairing token can be revoked by signing out on the web.
 */

import * as vscode from 'vscode'

const API_KEY = 'AIzaSyBNkP1uhg9vELIU73Y4gYSZsgTIMQfzFQA'
const PROJECT = 'shivoraa'
const TOKEN_URL = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`

const REFRESH_KEY = 'shivoraa.refreshToken'
const WORKSPACE_KEY = 'shivoraa.workspaceId'

export class ShivoraaError extends Error {
  constructor(
    public detail: string,
    public hint?: string,
  ) {
    super(detail)
  }
}

// --------------------------------------------------------------------------- //
// Firestore value encoding
// --------------------------------------------------------------------------- //
type FsValue = Record<string, unknown>

function toFs(value: unknown): FsValue {
  if (value === null || value === undefined) return { nullValue: null }
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFs) } }
  }
  const fields: Record<string, FsValue> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = toFs(v)
  return { mapValue: { fields } }
}

function fromFs(value: any): unknown {
  if (!value || typeof value !== 'object') return null
  if ('stringValue' in value) return value.stringValue
  if ('booleanValue' in value) return value.booleanValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('timestampValue' in value) return value.timestampValue
  if ('nullValue' in value) return null
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(fromFs)
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {})
  return null
}

function decodeFields(fields: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) out[k] = fromFs(v)
  return out
}

function encodeFields(data: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {}
  for (const [k, v] of Object.entries(data)) out[k] = toFs(v)
  return out
}

// --------------------------------------------------------------------------- //
// Client
// --------------------------------------------------------------------------- //
export interface FsDoc {
  id: string
  data: Record<string, unknown>
}

export class ShivoraaClient {
  private idToken: string | null = null
  private expiresAt = 0
  private refreshing: Promise<string> | null = null

  constructor(private readonly context: vscode.ExtensionContext) {}

  async isSignedIn(): Promise<boolean> {
    return !!(await this.context.secrets.get(REFRESH_KEY))
  }

  async pair(refreshToken: string): Promise<void> {
    // Verify before storing, so a mistyped code fails now with a clear message
    // rather than on the next request with a confusing one.
    await this.exchange(refreshToken.trim())
    await this.context.secrets.store(REFRESH_KEY, refreshToken.trim())
  }

  async signOut(): Promise<void> {
    this.idToken = null
    this.expiresAt = 0
    await this.context.secrets.delete(REFRESH_KEY)
    await this.context.globalState.update(WORKSPACE_KEY, undefined)
  }

  private async exchange(refreshToken: string): Promise<string> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    })

    if (!response.ok) {
      throw new ShivoraaError(
        'That pairing code is not valid any more.',
        'Open Settings → Account on studio.shivoraa.in and copy a fresh one.',
      )
    }

    const data = (await response.json()) as { id_token: string; expires_in: string }
    this.idToken = data.id_token
    // Refresh a minute early so a request never fails on a token that expired
    // between the check and the call.
    this.expiresAt = Date.now() + (Number(data.expires_in) - 60) * 1000
    return data.id_token
  }

  private async token(): Promise<string> {
    if (this.idToken && Date.now() < this.expiresAt) return this.idToken
    if (this.refreshing) return this.refreshing

    this.refreshing = (async () => {
      const stored = await this.context.secrets.get(REFRESH_KEY)
      if (!stored) {
        throw new ShivoraaError(
          'Not connected to Shivoraa Studio.',
          'Run "Shivoraa: Sign In" to pair this editor.',
        )
      }
      try {
        return await this.exchange(stored)
      } finally {
        this.refreshing = null
      }
    })()

    return this.refreshing
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${FIRESTORE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await this.token()}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
      const message = body.error?.message ?? `Request failed (${response.status})`
      if (response.status === 403) {
        throw new ShivoraaError(
          'Shivoraa denied that request.',
          'Your pairing may have been revoked — sign in again.',
        )
      }
      throw new ShivoraaError(message)
    }

    return (await response.json()) as T
  }

  // ------------------------------------------------------------------ //
  // Workspace
  // ------------------------------------------------------------------ //
  async workspaceId(): Promise<string> {
    const cached = this.context.globalState.get<string>(WORKSPACE_KEY)
    if (cached) return cached

    const uid = await this.uid()
    const result = await this.call<any[]>(':runQuery', {
      method: 'POST',
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'workspaces' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'memberIds' },
              op: 'ARRAY_CONTAINS',
              value: { stringValue: uid },
            },
          },
          limit: 1,
        },
      }),
    })

    const found = result.find((row) => row.document)
    if (!found) {
      throw new ShivoraaError(
        'No workspace found for your account.',
        'Open studio.shivoraa.in once to set it up.',
      )
    }

    const id = found.document.name.split('/').pop() as string
    await this.context.globalState.update(WORKSPACE_KEY, id)
    return id
  }

  private async uid(): Promise<string> {
    const token = await this.token()
    const payload = token.split('.')[1]
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    return JSON.parse(json).user_id as string
  }

  // ------------------------------------------------------------------ //
  // Data
  // ------------------------------------------------------------------ //
  async list(collection: string): Promise<FsDoc[]> {
    const wsId = await this.workspaceId()
    const result = await this.call<{ documents?: any[] }>(
      `/workspaces/${wsId}/${collection}?pageSize=300`,
    )
    return (result.documents ?? []).map((d) => ({
      id: d.name.split('/').pop() as string,
      data: decodeFields(d.fields ?? {}),
    }))
  }

  async create(collection: string, data: Record<string, unknown>): Promise<FsDoc> {
    const wsId = await this.workspaceId()
    const result = await this.call<any>(`/workspaces/${wsId}/${collection}`, {
      method: 'POST',
      body: JSON.stringify({ fields: encodeFields(data) }),
    })
    return { id: result.name.split('/').pop(), data }
  }

  async patch(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const wsId = await this.workspaceId()
    // updateMask is required, otherwise Firestore replaces the whole document
    // and every field not sent is silently deleted.
    const mask = Object.keys(data)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&')
    await this.call(`/workspaces/${wsId}/${collection}/${id}?${mask}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encodeFields(data) }),
    })
  }
}
