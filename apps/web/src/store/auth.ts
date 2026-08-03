import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth'
import { create } from 'zustand'
import { api, setActiveWorkspace } from '@/lib/api'
import { auth } from '@/lib/firebase'
import { setWorkspace, writeUserProfile } from '@/lib/firebaseApi'
import type { User, WorkspaceSummary } from '@/lib/types'

interface AuthState {
  user: User | null
  workspaces: WorkspaceSummary[]
  activeWorkspace: WorkspaceSummary | null
  status: 'loading' | 'authenticated' | 'anonymous'

  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  loginAsGuest: () => Promise<void>
  loginWithGoogle: (credential?: string) => Promise<void>
  logout: () => Promise<void>
  switchWorkspace: (id: string) => void
  refreshMe: () => Promise<void>
}

/** Translate Firebase's error codes into something a person can act on. */
function friendly(error: unknown): Error {
  const code = (error as { code?: string })?.code ?? ''
  const map: Record<string, string> = {
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'Email or password is incorrect.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'That password is too short — use at least 6 characters.',
    'auth/invalid-email': 'That email address is not valid.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
    'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups and retry.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/network-request-failed': 'Could not reach the server. Check your connection.',
    'auth/operation-not-allowed':
      'That sign-in method is not enabled yet in the Firebase console.',
    'auth/admin-restricted-operation':
      'Guest sign-in is not enabled yet. Turn on Anonymous auth in the Firebase console.',
  }
  return new Error(map[code] ?? (error as Error)?.message ?? 'Something went wrong.')
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  workspaces: [],
  activeWorkspace: null,
  status: 'loading',

  /**
   * Restore the session.
   *
   * Firebase persists the session in IndexedDB and resolves it asynchronously,
   * so the first onAuthStateChanged callback is the authoritative answer —
   * checking currentUser synchronously would report "signed out" on every
   * reload.
   */
  async bootstrap() {
    await new Promise<void>((resolve) => {
      const unsubscribe = onAuthStateChanged(auth(), async (user) => {
        unsubscribe()
        if (!user) {
          set({ status: 'anonymous' })
          resolve()
          return
        }
        try {
          await get().refreshMe()
        } catch {
          set({ status: 'anonymous' })
        }
        resolve()
      })
    })
  },

  async refreshMe() {
    const data = await api.get<{ user: User; workspaces: WorkspaceSummary[] }>('/auth/me')
    const active = data.workspaces[0] ?? null
    if (active) {
      setActiveWorkspace(active.id)
      setWorkspace(active.id)
    }
    set({
      user: data.user,
      workspaces: data.workspaces,
      activeWorkspace: active,
      status: 'authenticated',
    })
  },

  async login(email, password) {
    try {
      await signInWithEmailAndPassword(auth(), email, password)
      await get().refreshMe()
    } catch (error) {
      throw friendly(error)
    }
  },

  async register(email, password, displayName) {
    try {
      const credential = await createUserWithEmailAndPassword(auth(), email, password)
      await updateProfile(credential.user, { displayName })
      await writeUserProfile(displayName)
      await get().refreshMe()
    } catch (error) {
      throw friendly(error)
    }
  },

  async loginAsGuest() {
    try {
      await signInAnonymously(auth())
      await get().refreshMe()
    } catch (error) {
      throw friendly(error)
    }
  },

  async loginWithGoogle() {
    try {
      const provider = new GoogleAuthProvider()
      // Always show the chooser. Silently reusing whichever Google account the
      // browser last used is disorienting on a shared machine.
      provider.setCustomParameters({ prompt: 'select_account' })
      await signInWithPopup(auth(), provider)
      await get().refreshMe()
    } catch (error) {
      throw friendly(error)
    }
  },

  async logout() {
    try {
      await signOut(auth())
    } finally {
      setActiveWorkspace(null)
      setWorkspace(null)
      set({ user: null, workspaces: [], activeWorkspace: null, status: 'anonymous' })
    }
  },

  switchWorkspace(id) {
    const workspace = get().workspaces.find((w) => w.id === id)
    if (!workspace) return
    setActiveWorkspace(id)
    setWorkspace(id)
    set({ activeWorkspace: workspace })
    // A full reload is the honest way to drop every cached query bound to the
    // previous workspace; selective invalidation risks showing one tenant's
    // data in another's view.
    window.location.reload()
  },
}))
