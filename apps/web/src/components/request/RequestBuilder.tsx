import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Save, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { KeyValueEditor } from '@/components/request/KeyValueEditor'
import { api, ApiError } from '@/lib/api'
import type { AuthType, BodyMode, Environment, ExecutionResult } from '@/lib/types'
import { METHODS, METHOD_COLORS, cn, interpolatePreview, tryFormatJson } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

type Tab = 'params' | 'auth' | 'headers' | 'body'

const BODY_MODES: { value: BodyMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'raw', label: 'Raw' },
  { value: 'urlencoded', label: 'Form URL-encoded' },
  { value: 'graphql', label: 'GraphQL' },
]

const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: 'inherit', label: 'Inherit from collection' },
  { value: 'none', label: 'No auth' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic auth' },
  { value: 'api_key', label: 'API key' },
]

export function RequestBuilder() {
  const queryClient = useQueryClient()
  const { draft, patchDraft, markSaved, setResult, setSending, sending, activeEnvironmentId } =
    useWorkspace()
  const [tab, setTab] = useState<Tab>('params')
  const [error, setError] = useState<string | null>(null)

  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api.get<Environment[]>('/environments'),
  })

  // Non-secret values only — the client never receives secret values, so the
  // preview shows the placeholder rather than pretending to resolve it.
  const variables = useMemo(() => {
    const env = environments.data?.find((e) => e.id === activeEnvironmentId)
    const map: Record<string, string> = {}
    for (const variable of env?.variables ?? []) {
      if (variable.enabled && !variable.is_secret && variable.value != null) {
        map[variable.key] = variable.value
      }
    }
    return map
  }, [environments.data, activeEnvironmentId])

  const preview = useMemo(() => interpolatePreview(draft.url, variables), [draft.url, variables])
  const secretNames = useMemo(() => {
    const env = environments.data?.find((e) => e.id === activeEnvironmentId)
    return new Set((env?.variables ?? []).filter((v) => v.is_secret).map((v) => v.key))
  }, [environments.data, activeEnvironmentId])

  // A variable that is defined but secret is fine; one that is defined nowhere
  // is what breaks the request, so only those are warned about.
  const trulyUnresolved = preview.unresolved.filter((name) => !secretNames.has(name))

  const send = useMutation({
    mutationFn: async () => {
      const payload = draft.id
        ? { request_id: draft.id, environment_id: activeEnvironmentId }
        : {
            adhoc: {
              method: draft.method,
              url: draft.url,
              headers: draft.headers.filter((h) => h.key),
              query_params: draft.queryParams.filter((q) => q.key),
              body: draft.body,
              auth: draft.auth,
            },
            environment_id: activeEnvironmentId,
          }
      return api.post<ExecutionResult>('/executions', payload)
    },
    onMutate: () => {
      setError(null)
      setSending(true)
      setResult(null)
    },
    onSuccess: (result) => {
      setResult(result)
      void queryClient.invalidateQueries({ queryKey: ['history'] })
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.body.detail : 'The request could not be sent.')
    },
    onSettled: () => setSending(false),
  })

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft.name,
        method: draft.method,
        url: draft.url,
        headers: draft.headers.filter((h) => h.key),
        query_params: draft.queryParams.filter((q) => q.key),
        body: draft.body,
        auth: draft.auth,
        version: draft.version,
      }
      if (draft.id) return api.patch<{ version: number; id: string }>(`/requests/${draft.id}`, body)
      if (!draft.collectionId) throw new ApiError(400, {
        code: 'no_collection',
        detail: 'Pick a collection to save this request into.',
      })
      return api.post<{ version: number; id: string }>(
        `/collections/${draft.collectionId}/requests`,
        body,
      )
    },
    onSuccess: (saved) => {
      markSaved(saved.version, saved.id)
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
    },
    onError: (err) => {
      // A 409 means someone else changed this request while it was open. The
      // server sends its current state back so this can become a real conflict
      // UI rather than a silent overwrite.
      setError(err instanceof ApiError ? `${err.body.detail}${err.hint ? ` ${err.hint}` : ''}` : 'Could not save.')
    },
  })

  function onKeyDown(event: React.KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key === 'Enter') {
      event.preventDefault()
      if (draft.url.trim()) send.mutate()
    } else if (mod && event.key === 's') {
      event.preventDefault()
      save.mutate()
    }
  }

  const counts = {
    params: draft.queryParams.filter((p) => p.key).length,
    headers: draft.headers.filter((h) => h.key).length,
  }

  return (
    <div className="flex shrink-0 flex-col border-b border-line" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <input
          value={draft.name}
          onChange={(e) => patchDraft({ name: e.target.value })}
          aria-label="Request name"
          className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus:underline"
        />
        {draft.dirty && <span className="text-2xs text-muted">Unsaved</span>}
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          title="Save (⌘S)"
          className="btn-ghost px-2"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex gap-2 px-3 pb-2">
        <select
          value={draft.method}
          onChange={(e) => patchDraft({ method: e.target.value })}
          aria-label="HTTP method"
          className={cn(
            'rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-xs font-semibold outline-none',
            METHOD_COLORS[draft.method] ?? 'text-ink',
          )}
        >
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>

        <div className="min-w-0 flex-1">
          <input
            value={draft.url}
            onChange={(e) => patchDraft({ url: e.target.value })}
            placeholder="https://api.example.com/users/{{user_id}}"
            aria-label="Request URL"
            className="input font-mono text-xs"
          />
        </div>

        <button
          type="button"
          onClick={() => send.mutate()}
          disabled={sending || !draft.url.trim()}
          title="Send (⌘↵)"
          className="btn-primary min-w-[92px]"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sending ? 'Sending' : 'Send'}
        </button>
      </div>

      {/* The resolved URL sits directly under the input so an unresolved
          variable is visible before sending, not diagnosed from a 401 after. */}
      {draft.url.includes('{{') && (
        <div className="px-3 pb-2 font-mono text-2xs text-muted">
          <span className="mr-1 opacity-60">→</span>
          {preview.resolved}
        </div>
      )}

      {trulyUnresolved.length > 0 && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-mono">{trulyUnresolved.join(', ')}</span>{' '}
            {trulyUnresolved.length === 1 ? 'is' : 'are'} not defined in this environment. The
            request will send the placeholder as-is.
          </span>
        </div>
      )}

      {error && (
        <div role="alert" className="mx-3 mb-2 rounded border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-ink">
          {error}
        </div>
      )}

      <div className="flex border-b border-line px-3">
        {(
          [
            ['params', `Params${counts.params ? ` (${counts.params})` : ''}`],
            ['auth', 'Auth'],
            ['headers', `Headers${counts.headers ? ` (${counts.headers})` : ''}`],
            ['body', 'Body'],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn('tab', tab === value && 'tab-active')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="max-h-52 overflow-y-auto">
        {tab === 'params' && (
          <KeyValueEditor
            rows={draft.queryParams}
            onChange={(rows) => patchDraft({ queryParams: rows })}
          />
        )}

        {tab === 'headers' && (
          <KeyValueEditor
            rows={draft.headers}
            onChange={(rows) => patchDraft({ headers: rows })}
            keyPlaceholder="Content-Type"
            valuePlaceholder="application/json"
          />
        )}

        {tab === 'auth' && (
          <div className="space-y-3 p-3">
            <select
              value={draft.auth?.type ?? 'inherit'}
              onChange={(e) =>
                patchDraft({ auth: { ...draft.auth, type: e.target.value as AuthType } })
              }
              aria-label="Authentication type"
              className="input max-w-xs text-xs"
            >
              {AUTH_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            {draft.auth?.type === 'bearer' && (
              <input
                className="input font-mono text-xs"
                placeholder="{{api_token}}"
                value={draft.auth.token ?? ''}
                onChange={(e) => patchDraft({ auth: { ...draft.auth!, token: e.target.value } })}
                aria-label="Bearer token"
              />
            )}

            {draft.auth?.type === 'basic' && (
              <div className="grid max-w-md grid-cols-2 gap-2">
                <input
                  className="input text-xs"
                  placeholder="Username"
                  value={draft.auth.username ?? ''}
                  onChange={(e) => patchDraft({ auth: { ...draft.auth!, username: e.target.value } })}
                />
                <input
                  className="input text-xs"
                  type="password"
                  placeholder="Password"
                  value={draft.auth.password ?? ''}
                  onChange={(e) => patchDraft({ auth: { ...draft.auth!, password: e.target.value } })}
                />
              </div>
            )}

            {draft.auth?.type === 'api_key' && (
              <div className="grid max-w-lg grid-cols-3 gap-2">
                <input
                  className="input text-xs"
                  placeholder="X-API-Key"
                  value={draft.auth.key ?? ''}
                  onChange={(e) => patchDraft({ auth: { ...draft.auth!, key: e.target.value } })}
                />
                <input
                  className="input font-mono text-xs"
                  placeholder="{{api_key}}"
                  value={draft.auth.value ?? ''}
                  onChange={(e) => patchDraft({ auth: { ...draft.auth!, value: e.target.value } })}
                />
                <select
                  className="input text-xs"
                  value={draft.auth.add_to ?? 'header'}
                  onChange={(e) =>
                    patchDraft({
                      auth: { ...draft.auth!, add_to: e.target.value as 'header' | 'query' },
                    })
                  }
                >
                  <option value="header">In header</option>
                  <option value="query">In query</option>
                </select>
              </div>
            )}

            <p className="text-2xs text-muted">
              Reference secrets by name, like <span className="font-mono">{'{{api_token}}'}</span>.
              Values stay in your environment and are never sent to AI providers.
            </p>
          </div>
        )}

        {tab === 'body' && (
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2">
              <select
                value={draft.body.mode}
                onChange={(e) =>
                  patchDraft({ body: { ...draft.body, mode: e.target.value as BodyMode } })
                }
                aria-label="Body type"
                className="input max-w-[200px] text-xs"
              >
                {BODY_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>

              {draft.body.mode === 'json' && (
                <button
                  type="button"
                  onClick={() =>
                    patchDraft({
                      body: { ...draft.body, content: tryFormatJson(draft.body.content) },
                    })
                  }
                  className="btn-ghost text-xs"
                >
                  Format
                </button>
              )}
            </div>

            {draft.body.mode === 'none' ? (
              <p className="py-4 text-center text-xs text-muted">This request has no body.</p>
            ) : draft.body.mode === 'urlencoded' ? (
              <KeyValueEditor
                rows={draft.body.form_data ?? [{ key: '', value: '', enabled: true }]}
                onChange={(rows) => patchDraft({ body: { ...draft.body, form_data: rows } })}
              />
            ) : (
              <textarea
                value={draft.body.content}
                onChange={(e) => patchDraft({ body: { ...draft.body, content: e.target.value } })}
                spellCheck={false}
                aria-label="Request body"
                placeholder={draft.body.mode === 'json' ? '{\n  "name": "Ada"\n}' : ''}
                className="input h-32 resize-y font-mono text-xs leading-relaxed"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
