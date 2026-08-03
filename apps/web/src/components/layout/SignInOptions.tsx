import { useQuery } from '@tanstack/react-query'
import { Loader2, Zap } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { AuthMethods } from '@/lib/types'
import { useAuth } from '@/store/auth'

/**
 * Google button + guest entry, shared by the sign-in and sign-up pages.
 *
 * Buttons render from the server's reported capabilities rather than being
 * hardcoded, so a deployment without Google configured simply doesn't show one
 * — instead of showing a button that fails when clicked.
 */
export function SignInOptions({ onError }: { onError: (message: string) => void }) {
  const { loginAsGuest, loginWithGoogle } = useAuth()
  const [guestBusy, setGuestBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)

  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<AuthMethods>('/auth/config'),
    staleTime: Infinity,
    retry: false,
  })

  async function onGoogle() {
    setGoogleBusy(true)
    try {
      await loginWithGoogle()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setGoogleBusy(false)
    }
  }

  async function onGuest() {
    setGuestBusy(true)
    try {
      await loginAsGuest()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setGuestBusy(false)
    }
  }

  const showGoogle = config.data?.google_enabled !== false
  const showGuest = config.data?.guest_enabled !== false

  if (!showGoogle && !showGuest) return null

  return (
    <div className="space-y-3">
      {showGoogle && (
        <button
          type="button"
          onClick={onGoogle}
          disabled={googleBusy}
          className="btn-outline w-full py-2"
        >
          {googleBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
          )}
          Continue with Google
        </button>
      )}

      {showGuest && (
        <button
          type="button"
          onClick={onGuest}
          disabled={guestBusy}
          className="btn-outline w-full py-2"
        >
          {guestBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4 text-warning" />
          )}
          {guestBusy ? 'Setting up your workspace…' : 'Continue as guest'}
        </button>
      )}

      {showGuest && (
        <p className="text-center text-2xs text-muted">
          No email needed. You can turn a guest session into a full account later and keep
          everything you made.
        </p>
      )}

      <div className="relative py-1">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-line" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-canvas px-2 text-2xs uppercase tracking-wide text-muted">or</span>
        </div>
      </div>
    </div>
  )
}
