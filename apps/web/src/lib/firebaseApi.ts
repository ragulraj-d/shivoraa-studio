/**
 * Firestore-backed API.
 *
 * Implements the same contract as the FastAPI server, so every component works
 * unchanged. Firestore is the database, Auth is identity, and firestore.rules
 * is the authorization layer — there is no server in this deployment, so those
 * rules are the only thing standing between one user's data and another's.
 *
 * Data model — everything a workspace contains lives beneath it, so a single
 * membership check in the rules covers all of it:
 *
 *   users/{uid}
 *   workspaces/{wsId}                     { name, ownerId, members: {uid: role} }
 *     ├── collections/{id}
 *     ├── requests/{id}                   { collectionId, ... }
 *     ├── environments/{id}
 *     └── history/{id}
 */

import {
  addDoc,
  collection as fsCollection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { auth, db } from '@/lib/firebase'
import type { ApiRequest, Collection, Environment, HistoryItem } from '@/lib/types'

export class FirebaseApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public hint?: string,
  ) {
    super(detail)
  }
}

function uid(): string {
  const user = auth().currentUser
  if (!user) throw new FirebaseApiError(401, 'You need to be signed in.', 'Sign in and try again.')
  return user.uid
}

let cachedWorkspaceId: string | null = null

export function setWorkspace(id: string | null): void {
  cachedWorkspaceId = id
}

async function workspaceId(): Promise<string> {
  if (cachedWorkspaceId) return cachedWorkspaceId
  const workspaces = await listWorkspaces()
  if (!workspaces.length) throw new FirebaseApiError(404, 'No workspace found.')
  cachedWorkspaceId = workspaces[0].id
  return cachedWorkspaceId
}

const sub = (id: string, name: string) => fsCollection(db(), 'workspaces', id, name)

// --------------------------------------------------------------------------- //
// Bootstrap
// --------------------------------------------------------------------------- //
interface WorkspaceDoc {
  id: string
  name: string
  ownerId: string
  members: Record<string, string>
}

async function listWorkspaces(): Promise<WorkspaceDoc[]> {
  const rows = await getDocs(
    query(fsCollection(db(), 'workspaces'), where(`members.${uid()}`, 'in', ['owner', 'editor', 'viewer'])),
  )
  return rows.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WorkspaceDoc, 'id'>) }))
}

/**
 * Create the workspace, environment and starter collection a new user needs.
 *
 * Written as one batch so a half-created account is impossible — a user either
 * gets a complete usable workspace or nothing at all.
 */
export async function ensureWorkspace(displayName: string): Promise<WorkspaceDoc> {
  const existing = await listWorkspaces()
  if (existing.length) return existing[0]

  const user = auth().currentUser!
  const batch = writeBatch(db())

  const workspaceRef = doc(fsCollection(db(), 'workspaces'))
  batch.set(workspaceRef, {
    name: `${displayName}'s Workspace`,
    ownerId: user.uid,
    members: { [user.uid]: 'owner' },
    createdAt: serverTimestamp(),
  })

  batch.set(doc(db(), 'users', user.uid), {
    email: user.email ?? null,
    displayName,
    photoURL: user.photoURL ?? null,
    isAnonymous: user.isAnonymous,
    createdAt: serverTimestamp(),
  })

  const envRef = doc(sub(workspaceRef.id, 'environments'))
  batch.set(envRef, {
    name: 'Development',
    color: '#E8721A',
    isDefault: true,
    version: 1,
    variables: [
      {
        id: crypto.randomUUID(),
        key: 'base_url',
        value: 'https://api.github.com',
        is_secret: false,
        enabled: true,
        description: 'Try {{base_url}} in a request URL',
      },
    ],
    createdAt: serverTimestamp(),
  })

  const colRef = doc(sub(workspaceRef.id, 'collections'))
  batch.set(colRef, {
    name: 'Example API',
    description: 'Working requests to try. Edit or delete them freely.',
    baseUrl: null,
    auth: {},
    defaultHeaders: [],
    position: 0,
    version: 1,
    createdAt: serverTimestamp(),
  })

  // Seeded with APIs that send permissive CORS headers, so the first request a
  // new user sends actually succeeds instead of hitting a browser wall.
  const samples: [string, string, string, Record<string, unknown>][] = [
    ['Random developer quote', 'GET', 'https://api.github.com/zen', { mode: 'none', content: '' }],
    ['GitHub user', 'GET', 'https://api.github.com/users/octocat', { mode: 'none', content: '' }],
    [
      'Post some JSON',
      'POST',
      'https://httpbin.org/post',
      { mode: 'json', content: '{\n  "hello": "shivoraa"\n}' },
    ],
  ]
  samples.forEach(([name, method, url, body], index) => {
    batch.set(doc(sub(workspaceRef.id, 'requests')), {
      collectionId: colRef.id,
      name,
      method,
      url,
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      queryParams: [],
      pathParams: [],
      body,
      auth: null,
      settings: {},
      position: index,
      version: 1,
      updatedAt: serverTimestamp(),
    })
  })

  await batch.commit()
  cachedWorkspaceId = workspaceRef.id

  return {
    id: workspaceRef.id,
    name: `${displayName}'s Workspace`,
    ownerId: user.uid,
    members: { [user.uid]: 'owner' },
  }
}

// --------------------------------------------------------------------------- //
// Mapping — Firestore documents to the API shapes the UI already expects
// --------------------------------------------------------------------------- //
function toRequest(id: string, data: Record<string, any>, collectionId: string): ApiRequest {
  return {
    id,
    collection_id: data.collectionId ?? collectionId,
    folder_id: null,
    name: data.name ?? 'Untitled',
    method: data.method ?? 'GET',
    url: data.url ?? '',
    description: data.description ?? null,
    headers: data.headers ?? [],
    query_params: data.queryParams ?? [],
    path_params: data.pathParams ?? [],
    body: data.body ?? { mode: 'none', content: '' },
    auth: data.auth ?? null,
    settings: data.settings ?? {},
    position: data.position ?? 0,
    docs_markdown: data.docsMarkdown ?? null,
    tests_code: data.testsCode ?? null,
    tests_framework: data.testsFramework ?? null,
    version: data.version ?? 1,
    updated_at: data.updatedAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
  }
}

async function loadCollections(): Promise<Collection[]> {
  const id = await workspaceId()

  // Two reads rather than one per collection: Firestore's free tier is metered
  // in document reads, and N+1 queries would burn the daily quota fast.
  const [collectionSnap, requestSnap] = await Promise.all([
    getDocs(query(sub(id, 'collections'), orderBy('position'))),
    getDocs(sub(id, 'requests')),
  ])

  const requestsByCollection = new Map<string, ApiRequest[]>()
  for (const d of requestSnap.docs) {
    const data = d.data()
    const list = requestsByCollection.get(data.collectionId) ?? []
    list.push(toRequest(d.id, data, data.collectionId))
    requestsByCollection.set(data.collectionId, list)
  }

  return collectionSnap.docs.map((d) => {
    const data = d.data()
    return {
      id: d.id,
      workspace_id: id,
      name: data.name ?? 'Untitled',
      description: data.description ?? null,
      base_url: data.baseUrl ?? null,
      auth: data.auth ?? {},
      default_headers: data.defaultHeaders ?? [],
      docs_markdown: data.docsMarkdown ?? null,
      position: data.position ?? 0,
      version: data.version ?? 1,
      created_at: data.createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
      folders: [],
      requests: (requestsByCollection.get(d.id) ?? []).sort((a, b) => a.position - b.position),
    }
  })
}

async function loadEnvironments(): Promise<Environment[]> {
  const id = await workspaceId()
  const snap = await getDocs(sub(id, 'environments'))
  return snap.docs.map((d) => {
    const data = d.data()
    return {
      id: d.id,
      name: data.name ?? 'Environment',
      color: data.color ?? null,
      is_default: data.isDefault ?? false,
      version: data.version ?? 1,
      variables: data.variables ?? [],
      created_at: data.createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
    }
  })
}

// --------------------------------------------------------------------------- //
// Router — same paths the FastAPI server exposes
// --------------------------------------------------------------------------- //
export async function handleFirebase<T>(
  method: string,
  path: string,
  body?: Record<string, any>,
): Promise<T> {
  const seg = path.split('?')[0]

  // --- auth ---
  if (seg === '/auth/config') {
    return { google_enabled: true, guest_enabled: true, google_client_id: null } as T
  }

  if (seg === '/auth/me') {
    const user = auth().currentUser
    if (!user) throw new FirebaseApiError(401, 'Not signed in.')
    const workspace = await ensureWorkspace(user.displayName || 'You')
    cachedWorkspaceId = workspace.id
    return {
      user: {
        id: user.uid,
        email: user.email ?? 'guest@shivoraa',
        display_name: user.displayName || (user.isAnonymous ? 'Guest' : 'You'),
        avatar_url: user.photoURL,
        email_verified: user.emailVerified,
        is_guest: user.isAnonymous,
        ai_trial_used: 0,
        created_at: user.metadata.creationTime ?? new Date().toISOString(),
      },
      workspaces: [
        {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.id,
          is_personal: true,
          role: workspace.members[user.uid] ?? 'owner',
        },
      ],
    } as T
  }

  // --- collections ---
  if (seg === '/collections' && method === 'GET') return (await loadCollections()) as T

  if (seg === '/collections' && method === 'POST') {
    const id = await workspaceId()
    const ref = await addDoc(sub(id, 'collections'), {
      name: body?.name ?? 'New collection',
      description: null,
      baseUrl: null,
      auth: {},
      defaultHeaders: [],
      position: Date.now(),
      version: 1,
      createdAt: serverTimestamp(),
    })
    return {
      id: ref.id,
      workspace_id: id,
      name: body?.name,
      description: null,
      base_url: null,
      auth: {},
      default_headers: [],
      docs_markdown: null,
      position: 0,
      version: 1,
      created_at: new Date().toISOString(),
      folders: [],
      requests: [],
    } as T
  }

  const collectionMatch = seg.match(/^\/collections\/([^/]+)$/)
  if (collectionMatch) {
    const id = await workspaceId()
    const target = collectionMatch[1]

    if (method === 'DELETE') {
      // Requests live in a sibling collection, so deleting the parent does not
      // remove them. They must be cleaned up explicitly or they become
      // unreachable rows that still count against the quota.
      const orphans = await getDocs(query(sub(id, 'requests'), where('collectionId', '==', target)))
      const batch = writeBatch(db())
      orphans.docs.forEach((d) => batch.delete(d.ref))
      batch.delete(doc(db(), 'workspaces', id, 'collections', target))
      await batch.commit()
      return undefined as T
    }

    if (method === 'PATCH') {
      await updateDoc(doc(db(), 'workspaces', id, 'collections', target), {
        ...(body?.name !== undefined && { name: body.name }),
        ...(body?.base_url !== undefined && { baseUrl: body.base_url }),
        ...(body?.description !== undefined && { description: body.description }),
      })
      return { id: target, ...body } as T
    }

    if (method === 'GET') {
      const found = (await loadCollections()).find((c) => c.id === target)
      if (!found) throw new FirebaseApiError(404, "That collection doesn't exist.")
      return found as T
    }
  }

  const requestsMatch = seg.match(/^\/collections\/([^/]+)\/requests$/)
  if (requestsMatch && method === 'POST') {
    const id = await workspaceId()
    const payload = {
      collectionId: requestsMatch[1],
      name: body?.name ?? 'Untitled request',
      method: (body?.method ?? 'GET').toUpperCase(),
      url: body?.url ?? '',
      headers: body?.headers ?? [],
      queryParams: body?.query_params ?? [],
      pathParams: [],
      body: body?.body ?? { mode: 'none', content: '' },
      auth: body?.auth ?? null,
      settings: {},
      position: Date.now(),
      version: 1,
      updatedAt: serverTimestamp(),
    }
    const ref = await addDoc(sub(id, 'requests'), payload)
    return toRequest(ref.id, payload, requestsMatch[1]) as T
  }

  const requestMatch = seg.match(/^\/requests\/([^/]+)$/)
  if (requestMatch) {
    const id = await workspaceId()
    const target = requestMatch[1]
    const ref = doc(db(), 'workspaces', id, 'requests', target)

    if (method === 'DELETE') {
      await deleteDoc(ref)
      return undefined as T
    }

    if (method === 'PATCH') {
      const snap = await getDoc(ref)
      if (!snap.exists()) throw new FirebaseApiError(404, "That request doesn't exist.")
      const current = snap.data()

      const patch: Record<string, unknown> = { updatedAt: serverTimestamp() }
      if (body?.name !== undefined) patch.name = body.name
      if (body?.method !== undefined) patch.method = String(body.method).toUpperCase()
      if (body?.url !== undefined) patch.url = body.url
      if (body?.headers !== undefined) patch.headers = body.headers
      if (body?.query_params !== undefined) patch.queryParams = body.query_params
      if (body?.body !== undefined) patch.body = body.body
      if (body?.auth !== undefined) patch.auth = body.auth
      patch.version = (current.version ?? 1) + 1

      await updateDoc(ref, patch)
      return toRequest(target, { ...current, ...patch }, current.collectionId) as T
    }

    if (method === 'GET') {
      const snap = await getDoc(ref)
      if (!snap.exists()) throw new FirebaseApiError(404, "That request doesn't exist.")
      return toRequest(target, snap.data(), snap.data().collectionId) as T
    }
  }

  // --- environments ---
  if (seg === '/environments' && method === 'GET') return (await loadEnvironments()) as T

  if (seg === '/environments' && method === 'POST') {
    const id = await workspaceId()
    const ref = await addDoc(sub(id, 'environments'), {
      name: body?.name ?? 'New environment',
      color: null,
      isDefault: false,
      version: 1,
      variables: [],
      createdAt: serverTimestamp(),
    })
    return {
      id: ref.id,
      name: body?.name,
      color: null,
      is_default: false,
      version: 1,
      variables: [],
      created_at: new Date().toISOString(),
    } as T
  }

  const envMatch = seg.match(/^\/environments\/([^/]+)$/)
  if (envMatch) {
    const id = await workspaceId()
    const ref = doc(db(), 'workspaces', id, 'environments', envMatch[1])

    if (method === 'DELETE') {
      await deleteDoc(ref)
      return undefined as T
    }

    if (method === 'PATCH') {
      const patch: Record<string, unknown> = {}
      if (body?.name !== undefined) patch.name = body.name
      if (body?.variables !== undefined) {
        patch.variables = body.variables.map((v: Record<string, unknown>) => ({
          id: crypto.randomUUID(),
          key: v.key,
          value: v.value ?? '',
          is_secret: v.is_secret ?? false,
          enabled: v.enabled ?? true,
          description: v.description ?? null,
        }))
      }
      await updateDoc(ref, patch)
      const snap = await getDoc(ref)
      const data = snap.data() ?? {}
      return {
        id: envMatch[1],
        name: data.name,
        color: data.color ?? null,
        is_default: data.isDefault ?? false,
        version: data.version ?? 1,
        variables: data.variables ?? [],
        created_at: new Date().toISOString(),
      } as T
    }
  }

  // --- history ---
  if (seg === '/executions' && method === 'GET') {
    const id = await workspaceId()
    const snap = await getDocs(
      query(sub(id, 'history'), orderBy('createdAt', 'desc'), fsLimit(50)),
    )
    return snap.docs.map((d) => {
      const data = d.data()
      return {
        id: d.id,
        request_id: data.requestId ?? null,
        method: data.method,
        url: data.url,
        status_code: data.statusCode ?? null,
        duration_ms: data.durationMs ?? null,
        response_size: data.responseSize ?? null,
        mode: 'browser',
        status: data.statusCode && data.statusCode < 400 ? 'success' : 'failed',
        error_message: data.errorMessage ?? null,
        created_at: data.createdAt?.toDate?.()?.toISOString() ?? new Date().toISOString(),
      } satisfies HistoryItem
    }) as T
  }

  throw new FirebaseApiError(404, `Not available: ${method} ${seg}`)
}

/** Record an execution. Fire-and-forget — history is never worth failing a
 *  successful request over. */
export async function recordExecution(item: {
  requestId?: string | null
  method: string
  url: string
  statusCode: number | null
  durationMs: number
  responseSize: number
  errorMessage: string | null
}): Promise<void> {
  try {
    const id = await workspaceId()
    await addDoc(sub(id, 'history'), {
      requestId: item.requestId ?? null,
      method: item.method,
      url: item.url,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      responseSize: item.responseSize,
      errorMessage: item.errorMessage,
      createdAt: serverTimestamp(),
    })
  } catch {
    /* history is best-effort */
  }
}

export async function writeUserProfile(displayName: string): Promise<void> {
  const user = auth().currentUser
  if (!user) return
  await setDoc(
    doc(db(), 'users', user.uid),
    {
      email: user.email ?? null,
      displayName,
      photoURL: user.photoURL ?? null,
      isAnonymous: user.isAnonymous,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}
