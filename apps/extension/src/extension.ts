/**
 * Shivoraa Studio — VS Code extension.
 *
 * The web app is the full product. This is the part that has to be next to
 * your code: sending requests to localhost, and asking about an error without
 * copying it into another window.
 */

import * as vscode from 'vscode'
import { ApiError, ShivoraaClient } from './lib/client'
import { execute, isPrivateTarget, type ExecutionPlan } from './lib/executor'
import { ResponsePanel } from './panels/response'
import { CollectionsProvider, type ApiRequest } from './views/collections'

let client: ShivoraaClient
let collections: CollectionsProvider
let statusBar: vscode.StatusBarItem

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = new ShivoraaClient(context)
  collections = new CollectionsProvider(client)

  vscode.window.registerTreeDataProvider('shivoraa.collections', collections)

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'shivoraa.pickEnvironment'
  context.subscriptions.push(statusBar)
  await updateStatusBar()

  context.subscriptions.push(
    vscode.commands.registerCommand('shivoraa.signIn', signIn),
    vscode.commands.registerCommand('shivoraa.signOut', signOut),
    vscode.commands.registerCommand('shivoraa.refresh', () => collections.refresh()),
    vscode.commands.registerCommand('shivoraa.openRequest', openRequest),
    vscode.commands.registerCommand('shivoraa.sendRequest', sendRequest),
    vscode.commands.registerCommand('shivoraa.newRequest', newRequest),
    vscode.commands.registerCommand('shivoraa.sendFromCurl', sendFromCurl),
    vscode.commands.registerCommand('shivoraa.explainError', explainError),
    vscode.commands.registerCommand('shivoraa.generateTests', generateTests),
    vscode.commands.registerCommand('shivoraa.pickEnvironment', pickEnvironment),
    vscode.commands.registerCommand('shivoraa.useLocal', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://studio.shivoraa.in')),
    ),
  )
}

export function deactivate(): void {
  statusBar?.dispose()
}

// --------------------------------------------------------------------------- //
// Auth
// --------------------------------------------------------------------------- //
async function signIn(): Promise<void> {
  try {
    const flow = await client.startDeviceFlow()

    // The code is shown here and must be confirmed in the browser. That step is
    // what stops an attacker starting their own device flow and talking someone
    // into approving it.
    const choice = await vscode.window.showInformationMessage(
      `Your sign-in code is ${flow.user_code}`,
      { modal: true, detail: 'Check this code matches the one shown in your browser.' },
      'Open browser',
    )
    if (choice !== 'Open browser') return

    await vscode.env.openExternal(vscode.Uri.parse(flow.verification_uri_complete))

    const signedIn = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Waiting for you to approve in the browser…',
        cancellable: true,
      },
      (_progress, token) =>
        client.pollDeviceToken(flow.device_code, flow.interval, flow.expires_in, token),
    )

    if (!signedIn) return

    const me = await client.request<{ workspaces: { id: string; name: string }[] }>('/auth/me')
    if (me.workspaces[0]) await client.setWorkspaceId(me.workspaces[0].id)

    collections.refresh()
    await updateStatusBar()
    vscode.window.showInformationMessage('Signed in to Shivoraa Studio.')
  } catch (error) {
    showError(error)
  }
}

async function signOut(): Promise<void> {
  await client.clearTokens()
  collections.refresh()
  await updateStatusBar()
  vscode.window.showInformationMessage('Signed out of Shivoraa Studio.')
}

async function requireAuth(): Promise<boolean> {
  if (await client.isSignedIn()) return true
  const choice = await vscode.window.showWarningMessage(
    'Sign in to Shivoraa Studio first.',
    'Sign In',
  )
  if (choice === 'Sign In') await signIn()
  return false
}

// --------------------------------------------------------------------------- //
// Requests
// --------------------------------------------------------------------------- //
async function openRequest(request: ApiRequest): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'shivoraa.hasActiveRequest', true)
  lastRequest = request
  await sendRequest(request)
}

let lastRequest: ApiRequest | undefined

async function sendRequest(request?: ApiRequest): Promise<void> {
  const target = request ?? lastRequest
  if (!target) {
    vscode.window.showInformationMessage('Open a request from the Shivoraa sidebar first.')
    return
  }
  if (!(await requireAuth())) return

  ResponsePanel.showLoading(target.name)

  try {
    const environmentId = await currentEnvironmentId()

    // The server resolves variables, auth and inherited headers. Both execution
    // paths use this same plan, so a request cannot behave differently
    // depending on where it ran.
    const plan = await client.request<ExecutionPlan>('/executions/plan', {
      method: 'POST',
      body: JSON.stringify({ request_id: target.id, environment_id: environmentId }),
    })

    const mode = await resolveMode(plan.url)

    if (plan.unresolved.length) {
      const proceed = await vscode.window.showWarningMessage(
        `Undefined variables: ${plan.unresolved.join(', ')}`,
        { modal: true, detail: 'They will be sent as-is. Define them in your environment first?' },
        'Send anyway',
      )
      if (proceed !== 'Send anyway') return
    }

    if (mode === 'local') {
      const timeout = vscode.workspace.getConfiguration('shivoraa').get<number>('timeout', 30000)
      const result = await execute({ ...plan, timeout })
      ResponsePanel.show(target.name, result, 'local')

      // Metadata only — the body stays on this machine unless explicitly saved.
      await client
        .request('/executions/record', {
          method: 'POST',
          body: JSON.stringify({
            request_id: target.id,
            environment_id: environmentId,
            method: plan.method,
            url: plan.url,
            status_code: result.status_code,
            duration_ms: result.duration_ms,
            size_bytes: result.size_bytes,
            error_message: result.error_message,
          }),
        })
        .catch(() => {
          /* history is not worth failing a successful request over */
        })
      return
    }

    const server = await client.request<{
      ok: boolean
      status_code: number | null
      headers: Record<string, string>
      body: string | null
      content_type: string | null
      size_bytes: number
      timing: { total_ms: number }
      error_message: string | null
      error_hint: string | null
      requires_local: boolean
    }>('/executions', {
      method: 'POST',
      body: JSON.stringify({ request_id: target.id, environment_id: environmentId }),
    })

    // The server refuses private targets by design. Rather than surfacing that
    // as a failure, retry locally — which is exactly what the extension is for.
    if (server.requires_local) {
      const timeout = vscode.workspace.getConfiguration('shivoraa').get<number>('timeout', 30000)
      const result = await execute({ ...plan, timeout })
      ResponsePanel.show(target.name, result, 'local')
      return
    }

    ResponsePanel.show(
      target.name,
      {
        ok: server.ok,
        status_code: server.status_code,
        status_text: '',
        headers: server.headers,
        body: server.body,
        content_type: server.content_type,
        size_bytes: server.size_bytes,
        duration_ms: Math.round(server.timing.total_ms),
        error_code: null,
        error_message: server.error_message,
        error_hint: server.error_hint,
        final_url: null,
      },
      'server',
    )
  } catch (error) {
    showError(error)
  }
}

async function resolveMode(url: string): Promise<'local' | 'server'> {
  const setting = vscode.workspace
    .getConfiguration('shivoraa')
    .get<'auto' | 'local' | 'server'>('execution', 'auto')
  if (setting !== 'auto') return setting
  return (await isPrivateTarget(url)) ? 'local' : 'server'
}

async function newRequest(): Promise<void> {
  if (!(await requireAuth())) return

  const url = await vscode.window.showInputBox({
    prompt: 'Request URL',
    placeHolder: 'http://localhost:8000/api/users',
    validateInput: (value) =>
      value.trim() ? null : 'Enter a URL — localhost works, that is the point.',
  })
  if (!url) return

  const method = await vscode.window.showQuickPick(
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    { placeHolder: 'Method' },
  )
  if (!method) return

  const collectionId = collections.firstCollectionId()
  if (!collectionId) {
    vscode.window.showWarningMessage('Create a collection in the web app first.')
    return
  }

  try {
    const created = await client.request<ApiRequest>(`/collections/${collectionId}/requests`, {
      method: 'POST',
      body: JSON.stringify({ name: shortName(url), method, url }),
    })
    collections.refresh()
    await openRequest(created)
  } catch (error) {
    showError(error)
  }
}

async function sendFromCurl(): Promise<void> {
  const text = await vscode.env.clipboard.readText()
  if (!/^\s*curl\s/i.test(text)) {
    vscode.window.showInformationMessage('Copy a cURL command first, then run this again.')
    return
  }

  const parsed = parseCurl(text)
  if (!parsed) {
    vscode.window.showWarningMessage("Couldn't parse that cURL command.")
    return
  }

  ResponsePanel.showLoading(shortName(parsed.url))
  const timeout = vscode.workspace.getConfiguration('shivoraa').get<number>('timeout', 30000)
  const result = await execute({
    method: parsed.method,
    url: parsed.url,
    headers: parsed.headers,
    body: parsed.body,
    timeout,
    follow_redirects: true,
    verify_ssl: true,
    unresolved: [],
  })
  ResponsePanel.show(shortName(parsed.url), result, 'local')
}

/** Minimal cURL parser — enough for what people actually paste from browser
 *  devtools and API docs. */
function parseCurl(input: string): {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
} | null {
  const tokens = input.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)
  if (!tokens) return null

  let method = 'GET'
  let url = ''
  const headers: Record<string, string> = {}
  let body: string | null = null

  const strip = (s: string) => s.replace(/^['"]|['"]$/g, '')

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-X' || token === '--request') {
      method = strip(tokens[++i] ?? 'GET').toUpperCase()
    } else if (token === '-H' || token === '--header') {
      const [key, ...rest] = strip(tokens[++i] ?? '').split(':')
      if (key) headers[key.trim()] = rest.join(':').trim()
    } else if (token === '-d' || token === '--data' || token === '--data-raw') {
      body = strip(tokens[++i] ?? '')
      if (method === 'GET') method = 'POST' // curl implies POST with a body
    } else if (/^https?:\/\//i.test(strip(token))) {
      url = strip(token)
    }
  }

  return url ? { method, url, headers, body } : null
}

// --------------------------------------------------------------------------- //
// AI
// --------------------------------------------------------------------------- //
async function explainError(): Promise<void> {
  await askAboutSelection(
    'debug',
    'Explain this error and how to fix it',
    'Explaining…',
  )
}

async function generateTests(): Promise<void> {
  await askAboutSelection(
    'generate_tests',
    'Write tests for this code',
    'Generating tests…',
  )
}

async function askAboutSelection(
  feature: string,
  instruction: string,
  progressTitle: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  const selection = editor?.document.getText(editor.selection)
  if (!selection?.trim()) {
    vscode.window.showInformationMessage('Select some code first.')
    return
  }
  if (!(await requireAuth())) return

  const language = editor!.document.languageId
  const message = `${instruction}.\n\nLanguage: ${language}\n\n\`\`\`${language}\n${selection}\n\`\`\``

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: false },
    async () => {
      try {
        const answer = await streamChat(message, feature)
        const document = await vscode.workspace.openTextDocument({
          content: answer,
          language: 'markdown',
        })
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside })
      } catch (error) {
        showError(error)
      }
    },
  )
}

/** Consume the SSE stream and return the assembled answer. */
async function streamChat(message: string, feature: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('shivoraa')
  const baseUrl = config.get<string>('apiUrl', 'https://api.shivoraa.in/api/v1').replace(/\/$/, '')

  const response = await fetch(`${baseUrl}/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${await tokenForStream()}`,
      ...(await workspaceHeader()),
    },
    body: JSON.stringify({ message, feature }),
  })

  if (!response.ok || !response.body) {
    throw new ApiError(response.status, 'The AI request failed.', 'Check your provider settings.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue

      try {
        const payload = JSON.parse(dataLines.join('\n'))
        if (event === 'token') answer += payload.text ?? ''
        else if (event === 'error') {
          throw new ApiError(502, payload.detail ?? 'AI failed', payload.hint)
        }
      } catch (error) {
        if (error instanceof ApiError) throw error
      }
    }
  }

  return answer || '_No response._'
}

async function tokenForStream(): Promise<string> {
  // Round-trip a cheap authenticated call so the client refreshes if needed.
  await client.request('/auth/me')
  return (await (client as unknown as { context: vscode.ExtensionContext }).context.secrets.get(
    'shivoraa.accessToken',
  )) ?? ''
}

async function workspaceHeader(): Promise<Record<string, string>> {
  const id = await client.workspaceId()
  return id ? { 'X-Workspace-Id': id } : {}
}

// --------------------------------------------------------------------------- //
// Environment
// --------------------------------------------------------------------------- //
interface Environment {
  id: string
  name: string
  is_default: boolean
  variables: unknown[]
}

let activeEnvironment: Environment | undefined

async function currentEnvironmentId(): Promise<string | undefined> {
  if (activeEnvironment) return activeEnvironment.id
  try {
    const environments = await client.request<Environment[]>('/environments')
    activeEnvironment = environments.find((e) => e.is_default) ?? environments[0]
    await updateStatusBar()
    return activeEnvironment?.id
  } catch {
    return undefined
  }
}

async function pickEnvironment(): Promise<void> {
  if (!(await requireAuth())) return

  try {
    const environments = await client.request<Environment[]>('/environments')
    if (!environments.length) {
      vscode.window.showInformationMessage('No environments yet — create one in the web app.')
      return
    }

    const picked = await vscode.window.showQuickPick(
      environments.map((e) => ({
        label: e.name,
        description: `${e.variables.length} variables`,
        environment: e,
      })),
      { placeHolder: 'Select environment' },
    )
    if (!picked) return

    activeEnvironment = picked.environment
    await updateStatusBar()
  } catch (error) {
    showError(error)
  }
}

async function updateStatusBar(): Promise<void> {
  if (!(await client.isSignedIn())) {
    statusBar.text = '$(cloud) Shivoraa: sign in'
    statusBar.tooltip = 'Sign in to Shivoraa Studio'
    statusBar.command = 'shivoraa.signIn'
  } else {
    statusBar.text = `$(globe) ${activeEnvironment?.name ?? 'Environment'}`
    statusBar.tooltip = 'Shivoraa Studio — click to switch environment'
    statusBar.command = 'shivoraa.pickEnvironment'
  }
  statusBar.show()
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
function shortName(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname === '/' ? parsed.hostname : parsed.pathname
  } catch {
    return url.slice(0, 40)
  }
}

function showError(error: unknown): void {
  if (error instanceof ApiError) {
    vscode.window.showErrorMessage(
      `Shivoraa: ${error.detail}${error.hint ? ` — ${error.hint}` : ''}`,
    )
    return
  }
  vscode.window.showErrorMessage(`Shivoraa: ${(error as Error).message}`)
}
