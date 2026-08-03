import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Logo } from '@/components/layout/Logo'
import { api, ApiError } from '@/lib/api'
import type { Environment, Member, Provider, ProviderType, Variable } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

const SECTIONS = [
  { path: 'providers', label: 'AI Providers' },
  { path: 'environments', label: 'Environments' },
  { path: 'members', label: 'Team' },
  { path: 'account', label: 'Account' },
]

export function SettingsPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
        <Link to="/" className="btn-ghost px-2" aria-label="Back to studio">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Logo size={22} />
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>

      <div className="mx-auto flex max-w-5xl gap-8 p-6">
        <nav className="w-44 shrink-0">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.path}
              to={section.path}
              className={({ isActive }) =>
                cn(
                  'block rounded px-2.5 py-1.5 text-sm transition-colors',
                  isActive ? 'bg-subtle font-medium text-ink' : 'text-muted hover:text-ink',
                )
              }
            >
              {section.label}
            </NavLink>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <Routes>
            <Route index element={<Navigate to="providers" replace />} />
            <Route path="providers" element={<ProvidersSection />} />
            <Route path="environments" element={<EnvironmentsSection />} />
            <Route path="members" element={<MembersSection />} />
            <Route path="account" element={<AccountSection />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Providers
// --------------------------------------------------------------------------- //
const PROVIDER_TYPES: { value: ProviderType; label: string; needsKey: boolean; model: string }[] = [
  { value: 'openai', label: 'OpenAI', needsKey: true, model: 'gpt-4o-mini' },
  { value: 'anthropic', label: 'Anthropic (Claude)', needsKey: true, model: 'claude-sonnet-4-20250514' },
  { value: 'gemini', label: 'Google Gemini', needsKey: true, model: 'gemini-2.0-flash' },
  { value: 'groq', label: 'Groq', needsKey: true, model: 'llama-3.3-70b-versatile' },
  { value: 'ollama', label: 'Ollama (local)', needsKey: false, model: 'llama3.2' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)', needsKey: true, model: 'gpt-4o-mini' },
]

function ProvidersSection() {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [type, setType] = useState<ProviderType>('openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('gpt-4o-mini')
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState<string | null>(null)

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<Provider[]>('/ai/providers'),
  })

  const selected = PROVIDER_TYPES.find((p) => p.value === type)!

  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message: string }>('/ai/providers/test', {
        type,
        name: selected.label,
        api_key: apiKey || null,
        base_url: baseUrl || null,
        default_model: model,
      }),
    onSuccess: (result) => {
      setTested(result.ok ? result.message : null)
      setError(result.ok ? null : result.message)
    },
    onError: (err) => setError(err instanceof ApiError ? err.body.detail : 'Test failed.'),
  })

  const create = useMutation({
    mutationFn: () =>
      api.post('/ai/providers', {
        type,
        name: selected.label,
        api_key: apiKey || null,
        base_url: baseUrl || null,
        default_model: model,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] })
      setAdding(false)
      setApiKey('')
      setTested(null)
      setError(null)
    },
    onError: (err) =>
      setError(err instanceof ApiError ? `${err.body.detail} ${err.hint ?? ''}` : 'Could not save.'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/ai/providers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  })

  return (
    <section>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold">AI Providers</h2>
          <p className="mt-0.5 text-sm text-muted">
            Bring your own key. It is stored in this browser only and used to call the
            provider directly — it is never sent to Shivoraa or any server.
          </p>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="btn-primary text-xs">
            <Plus className="h-3.5 w-3.5" />
            Add provider
          </button>
        )}
      </div>

      {adding && (
        <div className="card mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Provider</span>
              <select
                value={type}
                onChange={(e) => {
                  const next = e.target.value as ProviderType
                  setType(next)
                  setModel(PROVIDER_TYPES.find((p) => p.value === next)!.model)
                  setTested(null)
                }}
                className="input text-xs"
              >
                {PROVIDER_TYPES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block font-medium">Model</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} className="input text-xs" />
            </label>

            {selected.needsKey && (
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block font-medium">API key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setTested(null)
                  }}
                  placeholder={type === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                  className="input font-mono text-xs"
                />
              </label>
            )}

            {(type === 'ollama' || type === 'custom') && (
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block font-medium">Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={type === 'ollama' ? 'http://localhost:11434' : 'https://…/v1'}
                  className="input font-mono text-xs"
                />
              </label>
            )}
          </div>

          {error && (
            <div role="alert" className="mt-3 rounded border border-danger/30 bg-danger/10 p-2.5 text-xs">
              {error}
            </div>
          )}
          {tested && (
            <div className="mt-3 flex items-center gap-1.5 rounded border border-success/30 bg-success/10 p-2.5 text-xs">
              <Check className="h-3.5 w-3.5 text-success" />
              {tested}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {/* Keys are validated by a live call before saving — a typo found
                three days later reads as a broken product. */}
            <button
              type="button"
              onClick={() => test.mutate()}
              disabled={test.isPending || (selected.needsKey && !apiKey)}
              className="btn-outline text-xs"
            >
              {test.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Test connection
            </button>
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={create.isPending || (selected.needsKey && !apiKey)}
              className="btn-primary text-xs"
            >
              {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save provider
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setError(null)
                setTested(null)
              }}
              className="btn-ghost text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {providers.isLoading && <div className="skeleton h-20" />}

      {providers.data?.length === 0 && !adding && (
        <div className="card p-6 text-center">
          <p className="text-sm font-medium">No providers connected</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
            You can use your free trial actions now and connect a provider later — but connecting
            one removes the limit and lets you choose the model.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {providers.data?.map((provider) => (
          <div key={provider.id} className="card flex items-center gap-3 p-3">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                provider.last_health_status === 'ok' ? 'bg-success' : 'bg-danger',
              )}
              title={provider.last_health_message ?? ''}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{provider.name}</div>
              <div className="truncate text-2xs text-muted">
                {provider.default_model}
                {provider.base_url ? ` · ${provider.base_url}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Remove ${provider.name}?`)) remove.mutate(provider.id)
              }}
              className="btn-ghost px-2 hover:text-danger"
              aria-label={`Remove ${provider.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

// --------------------------------------------------------------------------- //
// Environments
// --------------------------------------------------------------------------- //
function EnvironmentsSection() {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [rows, setRows] = useState<Variable[]>([])

  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api.get<Environment[]>('/environments'),
  })

  const create = useMutation({
    mutationFn: (name: string) => api.post('/environments', { name, variables: [] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['environments'] }),
  })

  const save = useMutation({
    mutationFn: ({ id, variables }: { id: string; variables: Variable[] }) =>
      api.patch(`/environments/${id}`, {
        variables: variables
          .filter((v) => v.key)
          .map((v) => ({
            key: v.key,
            value: v.value ?? '',
            is_secret: v.is_secret,
            enabled: v.enabled,
            description: v.description,
          })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['environments'] })
      setEditingId(null)
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/environments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['environments'] }),
  })

  function startEditing(env: Environment) {
    setEditingId(env.id)
    setRows([
      ...env.variables,
      { id: 'new', key: '', value: '', is_secret: false, enabled: true, description: null },
    ])
  }

  return (
    <section>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold">Environments</h2>
          <p className="mt-0.5 text-sm text-muted">
            Switch between local, staging, and production without editing requests.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('Environment name', 'Staging')
            if (name?.trim()) create.mutate(name.trim())
          }}
          className="btn-primary text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          New environment
        </button>
      </div>

      {environments.isLoading && <div className="skeleton h-24" />}

      <div className="space-y-3">
        {environments.data?.map((env) => (
          <div key={env.id} className="card p-3">
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: env.color ?? 'rgb(var(--muted))' }}
              />
              <span className="text-sm font-medium">{env.name}</span>
              {env.is_default && (
                <span className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted">
                  default
                </span>
              )}
              <span className="text-2xs text-muted">{env.variables.length} variables</span>

              <div className="ml-auto flex gap-1">
                {editingId === env.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => save.mutate({ id: env.id, variables: rows })}
                      className="btn-primary text-xs"
                    >
                      {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                      Save
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} className="btn-ghost px-2">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => startEditing(env)} className="btn-outline text-xs">
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete environment “${env.name}”?`)) remove.mutate(env.id)
                      }}
                      className="btn-ghost px-2 hover:text-danger"
                      aria-label={`Delete ${env.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {editingId === env.id && (
              <div className="mt-3 border-t border-line pt-3">
                {rows.map((row, index) => (
                  <div key={index} className="mb-1.5 grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2">
                    <input
                      value={row.key}
                      placeholder="VARIABLE_NAME"
                      onChange={(e) => {
                        const next = [...rows]
                        next[index] = { ...row, key: e.target.value }
                        if (index === rows.length - 1 && e.target.value) {
                          next.push({
                            id: `new-${Date.now()}`,
                            key: '',
                            value: '',
                            is_secret: false,
                            enabled: true,
                            description: null,
                          })
                        }
                        setRows(next)
                      }}
                      className="input font-mono text-xs"
                    />
                    <input
                      type={row.is_secret ? 'password' : 'text'}
                      value={row.value ?? ''}
                      placeholder={row.is_secret ? '••••••••' : 'value'}
                      onChange={(e) => {
                        const next = [...rows]
                        next[index] = { ...row, value: e.target.value }
                        setRows(next)
                      }}
                      className="input font-mono text-xs"
                    />
                    <label className="flex items-center gap-1 text-2xs text-muted">
                      <input
                        type="checkbox"
                        checked={row.is_secret}
                        onChange={(e) => {
                          const next = [...rows]
                          next[index] = { ...row, is_secret: e.target.checked }
                          setRows(next)
                        }}
                        className="h-3 w-3 accent-[rgb(var(--accent))]"
                      />
                      secret
                    </label>
                    <button
                      type="button"
                      onClick={() => setRows(rows.filter((_, i) => i !== index))}
                      className="text-muted hover:text-danger"
                      aria-label="Remove variable"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <p className="mt-2 text-2xs text-muted">
                  Secrets are encrypted at rest, hidden from this screen once saved, and replaced
                  with their name before anything reaches an AI provider.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// --------------------------------------------------------------------------- //
// Members
// --------------------------------------------------------------------------- //
function MembersSection() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<Member[]>('/workspaces/current/members'),
  })

  const add = useMutation({
    mutationFn: () => api.post('/workspaces/current/members', { email, role: 'editor' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      setEmail('')
      setError(null)
    },
    onError: (err) =>
      setError(err instanceof ApiError ? `${err.body.detail} ${err.hint ?? ''}` : 'Could not add.'),
  })

  return (
    <section>
      <h2 className="text-base font-semibold">Team</h2>
      <p className="mt-0.5 text-sm text-muted">
        Share collections and environments with your team.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@company.com"
          className="input max-w-sm text-xs"
          aria-label="Email to add"
        />
        <button
          type="button"
          onClick={() => add.mutate()}
          disabled={!email.includes('@') || add.isPending}
          className="btn-primary text-xs"
        >
          Add member
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded border border-danger/30 bg-danger/10 p-2.5 text-xs">
          {error}
        </div>
      )}

      <div className="mt-4 space-y-1.5">
        {members.data?.map((member) => (
          <div key={member.id} className="card flex items-center gap-3 p-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-2xs font-medium text-white">
              {member.display_name[0]?.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{member.display_name}</div>
              <div className="truncate text-2xs text-muted">{member.email}</div>
            </div>
            <span className="rounded border border-line px-2 py-0.5 text-2xs text-muted">
              {member.role}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

// --------------------------------------------------------------------------- //
// Account
// --------------------------------------------------------------------------- //
function AccountSection() {
  const { user, logout } = useAuth()

  return (
    <section>
      <h2 className="text-base font-semibold">Account</h2>

      <div className="card mt-4 divide-y divide-line">
        <div className="flex justify-between p-3 text-sm">
          <span className="text-muted">Name</span>
          <span>{user?.display_name}</span>
        </div>
        <div className="flex justify-between p-3 text-sm">
          <span className="text-muted">Email</span>
          <span>{user?.email}</span>
        </div>
      </div>

      <button type="button" onClick={() => void logout()} className="btn-outline mt-4 text-xs">
        Sign out
      </button>
    </section>
  )
}
