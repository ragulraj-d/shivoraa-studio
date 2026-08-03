import { create } from 'zustand'
import type { ApiRequest, ExecutionResult, KeyValue, RequestBody, AuthConfig } from '@/lib/types'
import { emptyKeyValue } from '@/lib/utils'

/**
 * Draft state for the request being edited.
 *
 * This is deliberately Zustand rather than React Query: it changes on every
 * keystroke, is unsaved, and belongs to this tab only. Server-known state lives
 * in React Query. Mixing the two produces either lost keystrokes or a re-render
 * storm across the whole builder.
 */
export interface RequestDraft {
  id: string | null
  collectionId: string | null
  name: string
  method: string
  url: string
  headers: KeyValue[]
  queryParams: KeyValue[]
  body: RequestBody
  auth: AuthConfig | null
  version: number
  dirty: boolean
}

function blankDraft(): RequestDraft {
  return {
    id: null,
    collectionId: null,
    name: 'Untitled request',
    method: 'GET',
    url: '',
    headers: [emptyKeyValue()],
    queryParams: [emptyKeyValue()],
    body: { mode: 'none', content: '' },
    auth: null,
    version: 1,
    dirty: false,
  }
}

interface WorkspaceState {
  draft: RequestDraft
  result: ExecutionResult | null
  sending: boolean
  activeEnvironmentId: string | null
  aiPanelOpen: boolean
  sidebarOpen: boolean
  activeConversationId: string | null

  loadRequest: (request: ApiRequest) => void
  newRequest: (collectionId?: string) => void
  patchDraft: (patch: Partial<RequestDraft>) => void
  markSaved: (version: number, id?: string) => void
  setResult: (result: ExecutionResult | null) => void
  setSending: (sending: boolean) => void
  setEnvironment: (id: string | null) => void
  toggleAiPanel: () => void
  toggleSidebar: () => void
  setConversation: (id: string | null) => void
}

const STORAGE_KEY = 'sv_ui'

function loadUiPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

const prefs = loadUiPrefs()

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  draft: blankDraft(),
  result: null,
  sending: false,
  activeEnvironmentId: localStorage.getItem('sv_env'),
  aiPanelOpen: prefs.aiPanelOpen ?? true,
  sidebarOpen: prefs.sidebarOpen ?? true,
  activeConversationId: null,

  loadRequest(request) {
    set({
      draft: {
        id: request.id,
        collectionId: request.collection_id,
        name: request.name,
        method: request.method,
        url: request.url,
        headers: request.headers?.length ? request.headers : [emptyKeyValue()],
        queryParams: request.query_params?.length ? request.query_params : [emptyKeyValue()],
        body: request.body?.mode ? request.body : { mode: 'none', content: '' },
        auth: request.auth,
        version: request.version,
        dirty: false,
      },
      result: null,
    })
  },

  newRequest(collectionId) {
    set({ draft: { ...blankDraft(), collectionId: collectionId ?? null }, result: null })
  },

  patchDraft(patch) {
    set({ draft: { ...get().draft, ...patch, dirty: true } })
  },

  markSaved(version, id) {
    const draft = get().draft
    set({ draft: { ...draft, version, id: id ?? draft.id, dirty: false } })
  },

  setResult: (result) => {
    // Local-mode AI reads this to build context without a server round-trip.
    ;(window as { __sv_last_result?: unknown }).__sv_last_result = result
    set({ result })
  },
  setSending: (sending) => set({ sending }),

  setEnvironment(id) {
    if (id) localStorage.setItem('sv_env', id)
    else localStorage.removeItem('sv_env')
    set({ activeEnvironmentId: id })
  },

  toggleAiPanel() {
    const next = !get().aiPanelOpen
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadUiPrefs(), aiPanelOpen: next }))
    set({ aiPanelOpen: next })
  },

  toggleSidebar() {
    const next = !get().sidebarOpen
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadUiPrefs(), sidebarOpen: next }))
    set({ sidebarOpen: next })
  },

  setConversation: (id) => set({ activeConversationId: id }),
}))
