/**
 * Shivoraa API client for the extension host.
 *
 * Tokens live in VS Code SecretStorage, which is backed by the OS keychain —
 * never in settings.json, never in a log line, never in the workspace folder.
 */

import * as vscode from 'vscode'

const ACCESS = 'shivoraa.accessToken'
const REFRESH = 'shivoraa.refreshToken'
const WORKSPACE = 'shivoraa.workspaceId'

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public hint?: string,
  ) {
    super(detail)
  }
}

export class ShivoraaClient {
  private accessToken: string | null = null
  private refreshing: Promise<boolean> | null = null

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get baseUrl(): string {
    return vscode.workspace
      .getConfiguration('shivoraa')
      .get<string>('apiUrl', 'https://api.shivoraa.in/api/v1')
      .replace(/\/$/, '')
  }

  async workspaceId(): Promise<string | undefined> {
    return this.context.globalState.get<string>(WORKSPACE)
  }

  async setWorkspaceId(id: string): Promise<void> {
    await this.context.globalState.update(WORKSPACE, id)
  }

  async isSignedIn(): Promise<boolean> {
    return !!(await this.context.secrets.get(REFRESH))
  }

  async storeTokens(access: string, refresh: string): Promise<void> {
    this.accessToken = access
    await this.context.secrets.store(ACCESS, access)
    await this.context.secrets.store(REFRESH, refresh)
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null
    await this.context.secrets.delete(ACCESS)
    await this.context.secrets.delete(REFRESH)
    await this.context.globalState.update(WORKSPACE, undefined)
  }

  /** Concurrent 401s share one refresh — parallel rotations would look like
   *  token theft to the server's reuse detection and sign the user out. */
  private async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing

    this.refreshing = (async () => {
      try {
        const stored = await this.context.secrets.get(REFRESH)
        if (!stored) return false

        const response = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body_token: stored }),
        })
        if (!response.ok) return false

        const data = (await response.json()) as { access_token: string; refresh_token?: string }
        this.accessToken = data.access_token
        await this.context.secrets.store(ACCESS, data.access_token)
        if (data.refresh_token) await this.context.secrets.store(REFRESH, data.refresh_token)
        return true
      } catch {
        return false
      } finally {
        this.refreshing = null
      }
    })()

    return this.refreshing
  }

  async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    if (!this.accessToken) {
      this.accessToken = (await this.context.secrets.get(ACCESS)) ?? null
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    }
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    const workspace = await this.workspaceId()
    if (workspace) headers['X-Workspace-Id'] = workspace

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers })

    if (response.status === 401 && retry) {
      if (await this.refresh()) return this.request<T>(path, init, false)
      await this.clearTokens()
      throw new ApiError(401, 'Your Shivoraa session expired.', 'Run "Shivoraa: Sign In" again.')
    }

    if (!response.ok) {
      let detail = `Request failed (${response.status})`
      let hint: string | undefined
      try {
        const body = (await response.json()) as { error?: { detail: string; hint?: string } }
        detail = body.error?.detail ?? detail
        hint = body.error?.hint
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(response.status, detail, hint)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  // ------------------------------------------------------------------ //
  // Device authorization
  // ------------------------------------------------------------------ //
  async startDeviceFlow(): Promise<{
    device_code: string
    user_code: string
    verification_uri_complete: string
    interval: number
    expires_in: number
  }> {
    const response = await fetch(`${this.baseUrl}/auth/device/code?client=vscode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) {
      throw new ApiError(
        response.status,
        "Couldn't reach Shivoraa.",
        'Check your connection, or the shivoraa.apiUrl setting if you self-host.',
      )
    }
    return (await response.json()) as never
  }

  /** Poll until the user approves in the browser, or the code expires. */
  async pollDeviceToken(
    deviceCode: string,
    intervalSeconds: number,
    expiresIn: number,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const deadline = Date.now() + expiresIn * 1000

    while (Date.now() < deadline) {
      if (token.isCancellationRequested) return false
      await new Promise((r) => setTimeout(r, intervalSeconds * 1000))

      const response = await fetch(`${this.baseUrl}/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })

      if (response.ok) {
        const data = (await response.json()) as { access_token: string; refresh_token: string }
        await this.storeTokens(data.access_token, data.refresh_token)
        return true
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; detail?: string }
      }
      const code = body.error?.code

      // Expected while waiting — keep polling rather than treating it as failure.
      if (code === 'authorization_pending') continue
      if (code === 'access_denied') throw new ApiError(403, 'Sign-in was denied.')
      if (code === 'expired_token') throw new ApiError(408, 'That code expired. Try again.')
    }

    throw new ApiError(408, 'Sign-in timed out.', 'Run "Shivoraa: Sign In" to try again.')
  }
}
