import { Check, Copy, Download, Sparkles, Terminal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { buildCurl, cn, formatBytes, formatDuration, isJsonContent, statusColor, statusText, tryFormatJson } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

type Tab = 'pretty' | 'raw' | 'headers'

export function ResponseViewer() {
  const { result, sending, draft, toggleAiPanel, aiPanelOpen } = useWorkspace()
  const [tab, setTab] = useState<Tab>('pretty')
  const [copied, setCopied] = useState<string | null>(null)

  const pretty = useMemo(
    () => (result?.body ? tryFormatJson(result.body) : ''),
    [result?.body],
  )

  function copy(label: string, text: string) {
    void navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  if (sending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-3 py-2">
          <div className="skeleton h-5 w-20" />
          <div className="skeleton h-4 w-14" />
          <div className="skeleton h-4 w-14" />
        </div>
        <div className="space-y-2 p-4">
          {[85, 60, 92, 45, 70, 55].map((width, index) => (
            <div key={index} className="skeleton h-3.5" style={{ width: `${width}%` }} />
          ))}
        </div>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <div>
          <div className="mb-3 text-3xl opacity-20">↯</div>
          <p className="text-sm text-muted">Send the request to see the response.</p>
          <p className="mt-1 text-2xs text-muted/70">
            Press <kbd className="rounded border border-line px-1 py-0.5 font-mono">⌘↵</kbd> to send
          </p>
        </div>
      </div>
    )
  }

  // A failed request explains what happened, why, and what to do next — a bare
  // "request failed" leaves the user with nowhere to go.
  if (!result.ok) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-lg">
          <div
            className={cn(
              'rounded-lg border p-4',
              result.requires_local
                ? 'border-warning/30 bg-warning/10'
                : 'border-danger/30 bg-danger/10',
            )}
          >
            <h3 className="text-sm font-medium">
              {result.error_message ?? 'The request failed.'}
            </h3>
            {result.error_hint && <p className="mt-1.5 text-sm text-muted">{result.error_hint}</p>}

            {result.requires_local && (
              <div className="mt-3 rounded border border-line bg-canvas p-3 text-xs">
                <p className="font-medium">Why this happens</p>
                <p className="mt-1 text-muted">
                  That address is only reachable from your own machine or private network. The
                  VS Code extension sends requests from your laptop instead — same request,
                  same result.
                </p>
              </div>
            )}

            {result.error_code === 'cors_blocked' && (
              <div className="mt-3 rounded border border-line bg-canvas p-3 text-xs">
                <p className="font-medium">Why this happens</p>
                <p className="mt-1 text-muted">
                  Browsers only hand a response to a page when the API says that page is
                  allowed, using an{' '}
                  <span className="font-mono">Access-Control-Allow-Origin</span> header. Without
                  it the request is still sent and answered — the browser just refuses to let
                  this page read the reply. Nothing is wrong with your request.
                </p>

                <p className="mt-2.5 font-medium">If the API is yours</p>
                <p className="mt-1 text-muted">
                  Allow this origin. In FastAPI:
                </p>
                <pre className="mt-1.5 overflow-x-auto rounded bg-subtle p-2 font-mono text-2xs leading-relaxed">
{`app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://studio.shivoraa.in"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)`}
                </pre>
                <p className="mt-1.5 text-muted">
                  With <span className="font-mono">allow_credentials=True</span> the origin must
                  be listed explicitly — browsers reject{' '}
                  <span className="font-mono">"*"</span> in that combination, which is the usual
                  reason the header comes back missing.
                </p>

                <p className="mt-2.5 font-medium">Or send it from your machine</p>
                <p className="mt-1 text-muted">
                  CORS is a browser rule, so anything that is not a browser is unaffected. Run
                  the agent and Shivoraa retries through it automatically — no change to the API
                  needed:
                </p>
                <pre className="mt-1.5 overflow-x-auto rounded bg-subtle p-2 font-mono text-2xs">
make agent
                </pre>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {!aiPanelOpen && (
                <button type="button" onClick={toggleAiPanel} className="btn-outline text-xs">
                  <Sparkles className="h-3.5 w-3.5 text-ai" />
                  Explain this error
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  copy('curl', buildCurl(draft.method, draft.url, draft.headers, draft.body.content))
                }
                className="btn-outline text-xs"
              >
                <Terminal className="h-3.5 w-3.5" />
                {copied === 'curl' ? 'Copied' : 'Copy as cURL'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const status = result.status_code ?? 0
  const timing = result.timing
  const segments = [
    { label: 'Connect', value: timing.connect_ms },
    { label: 'TTFB', value: timing.ttfb_ms },
  ].filter((s) => s.value != null) as { label: string; value: number }[]
  const totalTiming = segments.reduce((sum, s) => sum + s.value, 0) || 1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <span className={cn('font-semibold', statusColor(status))}>
          ● {status} {statusText(status)}
        </span>
        <span className="text-muted">{formatDuration(timing.total_ms)}</span>
        <span className="text-muted">{formatBytes(result.size_bytes)}</span>
        {result.content_type && (
          <span className="hidden truncate text-muted sm:inline">
            {result.content_type.split(';')[0]}
          </span>
        )}
        <span
          className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted"
          title="Where this request was sent from"
        >
          {result.mode === 'agent'
            ? 'via local agent'
            : result.mode === 'local'
              ? 'local'
              : result.mode === 'browser'
                ? 'browser'
                : 'server'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => copy('body', result.body ?? '')}
            className="btn-ghost px-2 py-1"
            title="Copy response body"
          >
            {copied === 'body' ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([result.body ?? ''], {
                type: result.content_type ?? 'text/plain',
              })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = 'response.txt'
              link.click()
              URL.revokeObjectURL(url)
            }}
            className="btn-ghost px-2 py-1"
            title="Download response"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {segments.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
            {segments.map((segment, index) => (
              <div
                key={segment.label}
                title={`${segment.label}: ${Math.round(segment.value)} ms`}
                style={{ width: `${(segment.value / totalTiming) * 100}%` }}
                className={index === 0 ? 'bg-info' : 'bg-accent'}
              />
            ))}
          </div>
          <span className="text-2xs text-muted">
            {segments.map((s) => `${s.label} ${Math.round(s.value)}ms`).join(' · ')}
          </span>
        </div>
      )}

      <div className="flex border-b border-line px-3">
        {(
          [
            ['pretty', 'Pretty'],
            ['raw', 'Raw'],
            ['headers', `Headers (${Object.keys(result.headers).length})`],
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

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'headers' ? (
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(result.headers).map(([key, value]) => (
                <tr key={key} className="border-b border-line/50">
                  <td className="w-1/3 px-3 py-1.5 align-top font-mono text-muted">{key}</td>
                  <td className="break-all px-3 py-1.5 font-mono">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
            {tab === 'pretty' && isJsonContent(result.content_type) ? pretty : result.body}
          </pre>
        )}
      </div>
    </div>
  )
}
