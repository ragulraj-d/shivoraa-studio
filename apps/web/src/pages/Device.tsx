import { useMutation } from '@tanstack/react-query'
import { Check, Loader2, MonitorSmartphone } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError } from '@/lib/api'

/**
 * Device authorization approval.
 *
 * The code is shown and must be confirmed by the user rather than auto-approved
 * from the URL. That single step is what stops an attacker starting a device
 * flow of their own and social-engineering a victim into approving it.
 */
export function DevicePage() {
  const [params] = useSearchParams()
  const [code, setCode] = useState(params.get('code')?.toUpperCase() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const approve = useMutation({
    mutationFn: () => api.post('/auth/device/approve', { user_code: code.trim().toUpperCase() }),
    onSuccess: () => {
      setDone(true)
      setError(null)
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? `${err.body.detail} ${err.hint ?? ''}`.trim() : 'Could not approve.',
      ),
  })

  if (done) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
            <Check className="h-6 w-6 text-success" />
          </div>
          <h1 className="text-lg font-semibold">You're signed in</h1>
          <p className="mt-1.5 text-sm text-muted">
            Head back to VS Code — the extension is connected. You can close this tab.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15">
          <MonitorSmartphone className="h-6 w-6 text-accent" />
        </div>
        <h1 className="text-lg font-semibold">Connect VS Code</h1>
        <p className="mt-1.5 text-sm text-muted">
          Check the code below matches the one shown in your editor.
        </p>
      </div>

      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="SHIV-XXXX"
        maxLength={9}
        aria-label="Device code"
        className="input mt-6 text-center font-mono text-lg tracking-[0.2em]"
      />

      {error && (
        <div role="alert" className="mt-3 rounded border border-danger/30 bg-danger/10 p-2.5 text-xs">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => approve.mutate()}
          disabled={code.trim().length < 9 || approve.isPending}
          className="btn-primary flex-1 py-2"
        >
          {approve.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Approve
        </button>
        <button type="button" onClick={() => window.close()} className="btn-outline px-4">
          Cancel
        </button>
      </div>

      <p className="mt-4 text-center text-2xs text-muted">
        Only approve a code you started yourself, from your own editor.
      </p>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
