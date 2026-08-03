import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { ApiError } from '@/lib/api'
import { AuthShell } from '@/pages/Login'
import { useAuth } from '@/store/auth'

const MIN_PASSWORD = 12

export function RegisterPage() {
  const { register, status } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated') return <Navigate to="/" replace />

  const longEnough = password.length >= MIN_PASSWORD
  const canSubmit = longEnough && email.includes('@') && displayName.trim().length > 0

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await register(email, password, displayName)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err
          : new ApiError(0, { code: 'network', detail: 'Could not reach the server.' }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <div className="mb-8 lg:hidden">
        <div className="text-2xl text-accent">◈</div>
      </div>

      <h1 className="text-xl font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-muted">
        You get a personal workspace and 50 free AI actions. No card needed.
      </p>

      {error && (
        <div
          role="alert"
          className="mt-6 flex gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div>
            <div className="text-ink">{error.body.detail}</div>
            {error.hint && <div className="mt-0.5 text-muted">{error.hint}</div>}
            {error.fields.map((f) => (
              <div key={f.field} className="mt-0.5 text-muted">
                {f.field}: {f.message}
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
            Your name
          </label>
          <input
            id="name"
            required
            autoFocus
            autoComplete="name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="new-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/* Length is the dominant factor in password strength, so that is what
              we ask for rather than a symbol-class checklist. */}
          <div
            className={`mt-1.5 flex items-center gap-1.5 text-xs ${
              longEnough ? 'text-success' : 'text-muted'
            }`}
          >
            {longEnough ? <Check className="h-3.5 w-3.5" /> : <span className="w-3.5" />}
            At least {MIN_PASSWORD} characters
            {password.length > 0 && !longEnough && ` (${password.length}/${MIN_PASSWORD})`}
          </div>
        </div>

        <button type="submit" disabled={busy || !canSubmit} className="btn-primary w-full py-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? 'Creating your workspace…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  )
}
