/**
 * Browser-resident data store for local mode.
 *
 * Local mode exists so Shivoraa works with no server at all: collections,
 * environments and history live in this browser, requests are sent with fetch(),
 * and AI calls go straight to the provider. Nothing leaves the machine except
 * the requests the user explicitly sends.
 *
 * localStorage rather than IndexedDB: the entire dataset is small (a few hundred
 * KB of JSON at most), and synchronous reads keep the UI code identical to the
 * server-backed path. IndexedDB would add async plumbing for no benefit at this
 * size.
 */

import type {
  ApiRequest,
  Collection,
  Environment,
  HistoryItem,
  Provider,
  Variable,
} from '@/lib/types'

const KEY = 'sv_local_v1'

export interface LocalData {
  collections: Collection[]
  environments: Environment[]
  history: HistoryItem[]
  providers: (Provider & { api_key?: string })[]
  activeEnvironmentId: string | null
}

export function uid(): string {
  return crypto.randomUUID()
}

function seed(): LocalData {
  const now = new Date().toISOString()
  const collectionId = uid()

  const mk = (
    name: string,
    method: string,
    url: string,
    position: number,
    body: ApiRequest['body'] = { mode: 'none', content: '' },
  ): ApiRequest => ({
    id: uid(),
    collection_id: collectionId,
    folder_id: null,
    name,
    method,
    url,
    description: null,
    headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
    query_params: [],
    path_params: [],
    body,
    auth: null,
    settings: {},
    position,
    docs_markdown: null,
    tests_code: null,
    tests_framework: null,
    version: 1,
    updated_at: now,
  })

  return {
    // Seeded with APIs that send permissive CORS headers, so the first request
    // a new visitor sends actually succeeds rather than hitting a browser wall.
    collections: [
      {
        id: collectionId,
        workspace_id: 'local',
        name: 'Example API',
        description: 'Working requests to try. Edit or delete them freely.',
        base_url: null,
        auth: {},
        default_headers: [],
        docs_markdown: null,
        position: 0,
        version: 1,
        created_at: now,
        folders: [],
        requests: [
          mk('Shivoraa Studio status', 'GET', 'https://studio.shivoraa.in/api/status.json', 0),
          mk('Random developer quote', 'GET', 'https://api.github.com/zen', 1),
          mk('GitHub user', 'GET', 'https://api.github.com/users/octocat', 2),
          mk('Post some JSON', 'POST', 'https://jsonplaceholder.typicode.com/posts', 3, {
            mode: 'json',
            content: '{\n  "title": "Hello from Shivoraa",\n  "userId": 1\n}',
          }),
        ],
      },
    ],
    environments: [
      {
        id: uid(),
        name: 'Development',
        color: '#22c55e',
        is_default: true,
        version: 1,
        created_at: now,
        variables: [
          {
            id: uid(),
            key: 'base_url',
            value: 'https://api.github.com',
            is_secret: false,
            enabled: true,
            description: 'Try {{base_url}} in a request URL',
          } as Variable,
        ],
      },
    ],
    history: [],
    providers: [],
    activeEnvironmentId: null,
  }
}

export function load(): LocalData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      const fresh = seed()
      save(fresh)
      return fresh
    }
    const parsed = JSON.parse(raw) as LocalData
    // Defensive: a partially written or hand-edited blob shouldn't brick the app.
    return {
      collections: parsed.collections ?? [],
      environments: parsed.environments ?? [],
      history: parsed.history ?? [],
      providers: parsed.providers ?? [],
      activeEnvironmentId: parsed.activeEnvironmentId ?? null,
    }
  } catch {
    const fresh = seed()
    save(fresh)
    return fresh
  }
}

export function save(data: LocalData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch (error) {
    // Quota exceeded — almost always a huge response saved into history.
    if (error instanceof DOMException) {
      data.history = data.history.slice(0, 20)
      try {
        localStorage.setItem(KEY, JSON.stringify(data))
      } catch {
        /* give up rather than throw into a click handler */
      }
    }
  }
}

export function update(fn: (data: LocalData) => void): LocalData {
  const data = load()
  fn(data)
  save(data)
  return data
}

export function reset(): void {
  localStorage.removeItem(KEY)
}

export function exportAll(): string {
  return JSON.stringify(load(), null, 2)
}

export function importAll(json: string): void {
  const parsed = JSON.parse(json) as LocalData
  save(parsed)
}
