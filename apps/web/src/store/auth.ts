import { create } from 'zustand'
import { api, setAccessToken, setActiveWorkspace } from '@/lib/api'
import type { User, WorkspaceSummary } from '@/lib/types'

interface AuthState {
  user: User | null
  workspaces: WorkspaceSummary[]
  activeWorkspace: WorkspaceSummary | null
  status: 'loading' | 'authenticated' | 'anonymous'

  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
  switchWorkspace: (id: string) => void
  refreshMe: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  workspaces: [],
  activeWorkspace: null,
  status: 'loading',

  /**
   * Restore the session on page load.
   *
   * The access token lives in memory and is gone after a reload, so the refresh
   * cookie is what carries the session across. A failure here is the normal
   * "not signed in" path, not an error worth surfacing.
   */
  async bootstrap() {
    try {
      const ok = await api.refresh()
      if (!ok) {
        set({ status: 'anonymous' })
        return
      }
      await get().refreshMe()
    } catch {
      set({ status: 'anonymous' })
    }
  },

  async refreshMe() {
    const data = await api.get<{ user: User; workspaces: WorkspaceSummary[] }>('/auth/me')
    const stored = localStorage.getItem('sv_workspace')
    const active =
      data.workspaces.find((w) => w.id === stored) ?? data.workspaces[0] ?? null

    if (active) setActiveWorkspace(active.id)
    set({
      user: data.user,
      workspaces: data.workspaces,
      activeWorkspace: active,
      status: 'authenticated',
    })
  },

  async login(email, password) {
    const data = await api.post<{ access_token: string }>('/auth/login', { email, password })
    setAccessToken(data.access_token)
    await get().refreshMe()
  },

  async register(email, password, displayName) {
    const data = await api.post<{ access_token: string }>('/auth/register', {
      email,
      password,
      display_name: displayName,
    })
    setAccessToken(data.access_token)
    await get().refreshMe()
  },

  async logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      setAccessToken(null)
      setActiveWorkspace(null)
      set({ user: null, workspaces: [], activeWorkspace: null, status: 'anonymous' })
    }
  },

  switchWorkspace(id) {
    const workspace = get().workspaces.find((w) => w.id === id)
    if (!workspace) return
    setActiveWorkspace(id)
    set({ activeWorkspace: workspace })
    // A full reload is the honest way to drop every cached query bound to the
    // previous workspace; selectively invalidating risks leaking one tenant's
    // data into another's view.
    window.location.reload()
  },
}))
