import { AlertCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Wordmark } from '@/components/layout/Logo'
import { ApiError } from '@/lib/api'
import { SignInOptions } from '@/components/layout/SignInOptions'
import { useAuth } from '@/store/auth'

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <div className="flex w-full flex-col justify-center px-6 py-12 lg:w-1/2 lg:px-16">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>

      {/* Hidden below lg — on a phone the form is the only thing that matters. */}
      <div className="hidden bg-surface lg:flex lg:w-1/2 lg:flex-col lg:justify-center lg:px-16">
        <div className="max-w-md">
          <Wordmark className="mb-6 text-base" />
          <h2 className="text-2xl font-semibold leading-tight">
            Your APIs. Your workspace.
          </h2>
          <p className="mt-4 text-muted">
            Send requests, inspect responses, and ask questions without pasting context into a
            chat window. Shivoraa already knows your request, your response, and your
            environment.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-muted">
            {[
              'Full HTTP client with timing breakdown',
              'AI that sees your workspace, not a blank prompt',
              'Bring your own key — OpenAI, Claude, Gemini, Groq, Ollama',
              'Secrets never leave your workspace',
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-accent-bright">✓</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export function LoginPage() {
  const { login, status } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated') return <Navigate to="/" replace />

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, { code: 'network', detail: 'Could not reach the server.' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <div className="mb-8 lg:hidden">
        <Wordmark />
      </div>

      <h1 className="text-xl font-semibold">Sign in to Shivoraa Studio</h1>
      <p className="mt-1 text-sm text-muted">Welcome back.</p>

      {error && (
        <div
          role="alert"
          className="mt-6 flex gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div>
            <div className="text-ink">{error.body.detail}</div>
            {error.hint && <div className="mt-0.5 text-muted">{error.hint}</div>}
          </div>
        </div>
      )}

      <div className="mt-6">
        <SignInOptions onError={(m) => setError(new ApiError(0, { code: 'auth', detail: m }))} />
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            autoFocus
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
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" disabled={busy} className="btn-primary w-full py-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <Link to="/register" className="text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  )
}
