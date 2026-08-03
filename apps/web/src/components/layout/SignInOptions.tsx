import { useQuery } from '@tanstack/react-query'
import { Loader2, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { renderGoogleButton } from '@/lib/google'
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
  const googleRef = useRef<HTMLDivElement>(null)
  const [guestBusy, setGuestBusy] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [googleFailed, setGoogleFailed] = useState(false)

  const config = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<AuthMethods>('/auth/config'),
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    const clientId = config.data?.google_client_id
    if (!clientId || !googleRef.current) return

    let cancelled = false
    renderGoogleButton(googleRef.current, clientId, (credential) => {
      if (cancelled) return
      setGoogleBusy(true)
      loginWithGoogle(credential)
        .catch((err) =>
          onError(
            err instanceof ApiError ? err.body.detail : 'Google sign-in failed. Try again.',
          ),
        )
        .finally(() => setGoogleBusy(false))
    }).catch(() => {
      // Google's script can be blocked by an extension or a strict network.
      // Failing quietly here keeps email sign-in usable.
      if (!cancelled) setGoogleFailed(true)
    })

    return () => {
      cancelled = true
    }
  }, [config.data?.google_client_id, loginWithGoogle, onError])

  async function onGuest() {
    setGuestBusy(true)
    try {
      await loginAsGuest()
    } catch (err) {
      onError(err instanceof ApiError ? err.body.detail : 'Could not start a guest session.')
    } finally {
      setGuestBusy(false)
    }
  }

  const showGoogle = config.data?.google_enabled && !googleFailed
  const showGuest = config.data?.guest_enabled !== false

  if (!showGoogle && !showGuest) return null

  return (
    <div className="space-y-3">
      {showGoogle && (
        <div className="relative">
          <div ref={googleRef} className="flex justify-center [&>div]:w-full" />
          {googleBusy && (
            <div className="absolute inset-0 flex items-center justify-center rounded-md bg-canvas/80">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
            </div>
          )}
        </div>
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
