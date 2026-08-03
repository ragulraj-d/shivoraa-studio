import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FileUp, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  FORMAT_LABELS,
  detectFormat,
  importAny,
  type ImportFormat,
  type ParsedCollection,
} from '@/lib/importers'
import { METHOD_COLORS, cn } from '@/lib/utils'

/**
 * Import dialog.
 *
 * Nothing is written until the user has seen exactly what will be created.
 * An import that silently dumps 200 requests into someone's workspace is
 * worse than one that asks first.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ParsedCollection | null>(null)
  const [format, setFormat] = useState<ImportFormat>('unknown')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  function analyse(content: string) {
    setText(content)
    setError(null)
    setParsed(null)
    if (!content.trim()) {
      setFormat('unknown')
      return
    }

    setFormat(detectFormat(content))
    try {
      setParsed(importAny(content))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function readFile(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      setError('That file is larger than 20 MB. Try splitting it.')
      return
    }
    analyse(await file.text())
  }

  const run = useMutation({
    mutationFn: async () => {
      if (!parsed) return

      // Environment first: requests reference {{variables}}, so creating it
      // before them means an imported request resolves on the first send
      // rather than after the user works out what is missing.
      if (parsed.environment?.variables.length) {
        const env = await api.post<{ id: string }>('/environments', {
          name: parsed.environment.name,
        })
        await api.patch(`/environments/${env.id}`, {
          variables: parsed.environment.variables,
        })
      }

      if (!parsed.requests.length) return

      const collection = await api.post<{ id: string }>('/collections', {
        name: parsed.name,
        description: parsed.description,
        base_url: parsed.baseUrl,
      })

      // Sequential rather than parallel: Firestore's free tier meters writes,
      // and a burst of 200 concurrent creates is the fastest way to hit a
      // quota error halfway through an import.
      for (const request of parsed.requests) {
        await api.post(`/collections/${collection.id}/requests`, {
          name: request.name,
          method: request.method,
          url: request.url,
          headers: request.headers,
          query_params: request.query_params,
          body: request.body,
          auth: request.auth,
        })
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
      void queryClient.invalidateQueries({ queryKey: ['environments'] })
      onClose()
    },
    onError: (err) => setError((err as Error).message || 'Import failed.'),
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import collection"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-elevated shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Import a collection</h2>
            <p className="mt-0.5 text-2xs text-muted">
              Postman collections &amp; environments · OpenAPI · Swagger · HAR · cURL
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost px-2" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!parsed && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragging(false)
                  const file = e.dataTransfer.files[0]
                  if (file) void readFile(file)
                }}
                className={cn(
                  'rounded-lg border-2 border-dashed p-6 text-center transition-colors',
                  dragging ? 'border-accent bg-accent/5' : 'border-line',
                )}
              >
                <FileUp className="mx-auto h-6 w-6 text-muted" />
                <p className="mt-2 text-sm">Drop a file here</p>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="mt-2 text-xs text-accent hover:underline"
                >
                  or choose a file
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,.yaml,.yml,.har,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void readFile(file)
                  }}
                />
              </div>

              <div className="relative py-3">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-line" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-elevated px-2 text-2xs uppercase tracking-wide text-muted">
                    or paste
                  </span>
                </div>
              </div>

              <textarea
                value={text}
                onChange={(e) => analyse(e.target.value)}
                spellCheck={false}
                placeholder={'curl https://api.example.com/users \\\n  -H "Accept: application/json"'}
                className="input h-40 resize-none font-mono text-xs"
                aria-label="Paste a collection, spec or cURL command"
              />

              {text.trim() && (
                <p className="mt-2 text-2xs text-muted">
                  Detected: <span className="text-ink">{FORMAT_LABELS[format]}</span>
                </p>
              )}
            </>
          )}

          {error && (
            <div
              role="alert"
              className="mt-3 rounded border border-danger/30 bg-danger/10 p-3 text-xs"
            >
              {error}
            </div>
          )}

          {parsed && (
            <>
              <div className="mb-3 flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-medium">{parsed.name}</div>
                  <div className="text-2xs text-muted">
                    {parsed.requests.length > 0 &&
                      `${parsed.requests.length} request${parsed.requests.length === 1 ? '' : 's'}`}
                    {parsed.requests.length > 0 && parsed.environment ? ' · ' : ''}
                    {parsed.environment &&
                      `${parsed.environment.variables.length} variable${
                        parsed.environment.variables.length === 1 ? '' : 's'
                      }`}
                    {parsed.baseUrl ? ` · ${parsed.baseUrl}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setParsed(null)
                    setText('')
                  }}
                  className="text-2xs text-accent hover:underline"
                >
                  Choose something else
                </button>
              </div>

              {parsed.warnings.length > 0 && (
                <div className="mb-3 rounded border border-warning/30 bg-warning/10 p-2.5 text-2xs">
                  <div className="mb-1 flex items-center gap-1.5 font-medium text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Imported with notes
                  </div>
                  <ul className="space-y-0.5 text-muted">
                    {parsed.warnings.map((warning) => (
                      <li key={warning}>· {warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              {parsed.environment && parsed.environment.variables.length > 0 && (
                <div className="mb-3 rounded border border-line">
                  <div className="border-b border-line px-2.5 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                    Environment · {parsed.environment.name}
                  </div>
                  <div className="max-h-32 overflow-y-auto">
                    {parsed.environment.variables.map((variable) => (
                      <div
                        key={variable.key}
                        className="flex items-center gap-2 border-b border-line/50 px-2.5 py-1 last:border-0"
                      >
                        <span className="w-40 shrink-0 truncate font-mono text-2xs">
                          {variable.key}
                        </span>
                        <span className="truncate font-mono text-2xs text-muted">
                          {variable.is_secret ? '••••••••' : variable.value || '—'}
                        </span>
                        {variable.is_secret && (
                          <span className="ml-auto shrink-0 rounded border border-line px-1.5 text-2xs text-muted">
                            secret
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="max-h-64 overflow-y-auto rounded border border-line">
                {parsed.requests.map((request, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 border-b border-line/50 px-2.5 py-1.5 last:border-0"
                  >
                    <span
                      className={cn(
                        'w-12 shrink-0 font-mono text-2xs font-semibold',
                        METHOD_COLORS[request.method] ?? 'text-muted',
                      )}
                    >
                      {request.method}
                    </span>
                    <span className="truncate text-xs">{request.name}</span>
                    <span className="ml-auto truncate text-2xs text-muted" title={request.url}>
                      {request.url}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} className="btn-ghost text-xs">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => run.mutate()}
            disabled={
              (!parsed?.requests.length && !parsed?.environment?.variables.length) ||
              run.isPending
            }
            className="btn-primary text-xs"
          >
            {run.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {run.isPending ? 'Importing…' : importLabel(parsed)}
          </button>
        </div>
      </div>
    </div>
  )
}

function importLabel(parsed: ParsedCollection | null): string {
  if (!parsed) return 'Import'
  const parts: string[] = []
  if (parsed.requests.length) {
    parts.push(`${parsed.requests.length} request${parsed.requests.length === 1 ? '' : 's'}`)
  }
  const variables = parsed.environment?.variables.length ?? 0
  if (variables) parts.push(`${variables} variable${variables === 1 ? '' : 's'}`)
  return parts.length ? `Import ${parts.join(' + ')}` : 'Import'
}
