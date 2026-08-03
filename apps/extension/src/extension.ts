/**
 * Shivoraa Studio — VS Code extension.
 *
 * The web app is the full product. This exists for the one thing a browser
 * structurally cannot do: send a request to http://localhost:8000, which is
 * where a backend engineer's code runs while they are writing it.
 *
 * Data comes from the same Firestore workspace the web app uses, so a request
 * saved in either place appears in the other.
 */

import * as vscode from 'vscode'
import { ShivoraaClient, ShivoraaError } from './lib/firebase'
import { execute, type ExecutionPlan } from './lib/executor'
import { buildPlan, type Environment, type SavedRequest } from './lib/resolver'
import { ResponsePanel } from './panels/response'
import { CollectionsProvider } from './views/collections'

let client: ShivoraaClient
let collections: CollectionsProvider
let statusBar: vscode.StatusBarItem
let activeEnvironment: Environment | undefined
let lastRequest: SavedRequest | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = new ShivoraaClient(context)
  collections = new CollectionsProvider(client)

  vscode.window.registerTreeDataProvider('shivoraa.collections', collections)

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
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
    vscode.commands.registerCommand('shivoraa.pickEnvironment', pickEnvironment),
    vscode.commands.registerCommand('shivoraa.openWeb', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://studio.shivoraa.in')),
    ),
  )
}

export function deactivate(): void {
  statusBar?.dispose()
}

// --------------------------------------------------------------------------- //
// Pairing
// --------------------------------------------------------------------------- //
async function signIn(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'Connect this editor to Shivoraa Studio',
    {
      modal: true,
      detail:
        'On studio.shivoraa.in open Settings → Account → Connect VS Code, then paste the pairing code here.',
    },
    'Open Settings',
    'I have the code',
  )
  if (!choice) return

  if (choice === 'Open Settings') {
    await vscode.env.openExternal(vscode.Uri.parse('https://studio.shivoraa.in/settings/account'))
  }

  const code = await vscode.window.showInputBox({
    prompt: 'Paste your Shivoraa pairing code',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'It looks like a long string of letters and numbers',
    validateInput: (value) => (value.trim().length > 20 ? null : 'That code looks too short.'),
  })
  if (!code) return

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Connecting…' },
      async () => {
        await client.pair(code)
        await client.workspaceId()
      },
    )
    collections.refresh()
    await updateStatusBar()
    vscode.window.showInformationMessage('Connected to Shivoraa Studio.')
  } catch (error) {
    showError(error)
  }
}

async function signOut(): Promise<void> {
  await client.signOut()
  activeEnvironment = undefined
  collections.refresh()
  await updateStatusBar()
  vscode.window.showInformationMessage('Disconnected from Shivoraa Studio.')
}

async function requireAuth(): Promise<boolean> {
  if (await client.isSignedIn()) return true
  const choice = await vscode.window.showWarningMessage(
    'Connect this editor to Shivoraa Studio first.',
    'Sign In',
  )
  if (choice === 'Sign In') await signIn()
  return false
}

// --------------------------------------------------------------------------- //
// Requests
// --------------------------------------------------------------------------- //
async function openRequest(request: SavedRequest): Promise<void> {
  lastRequest = request
  await vscode.commands.executeCommand('setContext', 'shivoraa.hasActiveRequest', true)
  await sendRequest(request)
}

async function sendRequest(request?: SavedRequest): Promise<void> {
  const target = request ?? lastRequest
  if (!target) {
    vscode.window.showInformationMessage('Open a request from the Shivoraa sidebar first.')
    return
  }
  if (!(await requireAuth())) return

  ResponsePanel.showLoading(target.name)

  try {
    const environment = await currentEnvironment()
    const collection = collections.collectionFor(target.collectionId)
    const plan = buildPlan(target, collection, environment)

    if (plan.unresolved.length) {
      const proceed = await vscode.window.showWarningMessage(
        `Undefined variables: ${plan.unresolved.join(', ')}`,
        {
          modal: true,
          detail: 'They will be sent as written. Define them in an environment first?',
        },
        'Send anyway',
      )
      if (proceed !== 'Send anyway') return
    }

    const timeout = vscode.workspace.getConfiguration('shivoraa').get<number>('timeout', 30000)
    const result = await execute({ ...plan, timeout })
    ResponsePanel.show(target.name, result, 'local')

    // Metadata only. The response body stays on this machine — local execution
    // exists partly for people who cannot send internal API data anywhere.
    void client
      .create('history', {
        requestId: target.id,
        method: plan.method,
        url: plan.url,
        statusCode: result.status_code,
        durationMs: result.duration_ms,
        responseSize: result.size_bytes,
        errorMessage: result.error_message,
        createdAt: new Date().toISOString(),
      })
      .catch(() => {
        /* history is never worth failing a successful request over */
      })
  } catch (error) {
    showError(error)
  }
}

async function newRequest(): Promise<void> {
  if (!(await requireAuth())) return

  const url = await vscode.window.showInputBox({
    prompt: 'Request URL',
    placeHolder: 'http://localhost:8000/api/users',
    validateInput: (value) =>
      value.trim() ? null : 'Enter a URL — localhost works, which is the point.',
  })
  if (!url) return

  const method = await vscode.window.showQuickPick(
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    { placeHolder: 'Method' },
  )
  if (!method) return

  try {
    const collectionId = await collections.firstCollectionId()
    const created = await client.create('requests', {
      collectionId,
      name: shortName(url),
      method,
      url,
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      queryParams: [],
      pathParams: [],
      body: { mode: 'none', content: '' },
      auth: null,
      settings: {},
      position: Date.now(),
      version: 1,
      updatedAt: new Date().toISOString(),
    })
    collections.refresh()
    await openRequest({
      id: created.id,
      collectionId,
      name: shortName(url),
      method,
      url,
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      queryParams: [],
      pathParams: [],
      body: { mode: 'none', content: '' },
      auth: null,
    })
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

  const parsed = parseCurl(text.replace(/\\\s*\n/g, ' '))
  if (!parsed) {
    vscode.window.showWarningMessage("Couldn't parse that cURL command.")
    return
  }

  const name = shortName(parsed.url)
  ResponsePanel.showLoading(name)
  const timeout = vscode.workspace.getConfiguration('shivoraa').get<number>('timeout', 30000)
  const result = await execute({ ...parsed, timeout, unresolved: [] } as ExecutionPlan)
  ResponsePanel.show(name, result, 'local')
}

/** Minimal cURL parser — enough for what people paste from devtools and docs. */
function parseCurl(input: string): Omit<ExecutionPlan, 'timeout' | 'unresolved'> | null {
  const tokens = input.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g)
  if (!tokens) return null

  const strip = (s: string) => s.replace(/^['"]|['"]$/g, '')
  let method = ''
  let url = ''
  const headers: Record<string, string> = {}
  let body: string | null = null

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-X' || token === '--request') {
      method = strip(tokens[++i] ?? '').toUpperCase()
    } else if (token === '-H' || token === '--header') {
      const raw = strip(tokens[++i] ?? '')
      const idx = raw.indexOf(':')
      if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
    } else if (['-d', '--data', '--data-raw', '--data-binary'].includes(token)) {
      body = strip(tokens[++i] ?? '')
    } else if (/^https?:\/\//i.test(strip(token))) {
      url = strip(token)
    }
  }

  if (!url) return null
  // curl implies POST when a body is given and no method was set.
  if (!method) method = body ? 'POST' : 'GET'

  return { method, url, headers, body, follow_redirects: true, verify_ssl: true }
}

// --------------------------------------------------------------------------- //
// Environment
// --------------------------------------------------------------------------- //
async function currentEnvironment(): Promise<Environment | undefined> {
  if (activeEnvironment) return activeEnvironment
  try {
    const rows = await client.list('environments')
    const environments = rows.map(toEnvironment)
    activeEnvironment = environments.find((e) => e.isDefault) ?? environments[0]
    await updateStatusBar()
    return activeEnvironment
  } catch {
    return undefined
  }
}

function toEnvironment(row: { id: string; data: Record<string, unknown> }): Environment {
  return {
    id: row.id,
    name: (row.data.name as string) ?? 'Environment',
    isDefault: !!row.data.isDefault,
    variables: (row.data.variables as Environment['variables']) ?? [],
  }
}

async function pickEnvironment(): Promise<void> {
  if (!(await requireAuth())) return

  try {
    const environments = (await client.list('environments')).map(toEnvironment)
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
    statusBar.text = '$(plug) Shivoraa: connect'
    statusBar.tooltip = 'Connect this editor to Shivoraa Studio'
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
  if (error instanceof ShivoraaError) {
    vscode.window.showErrorMessage(
      `Shivoraa: ${error.detail}${error.hint ? ` — ${error.hint}` : ''}`,
    )
    return
  }
  vscode.window.showErrorMessage(`Shivoraa: ${(error as Error).message}`)
}
