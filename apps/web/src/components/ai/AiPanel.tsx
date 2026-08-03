import { AlertCircle, ChevronDown, Eye, Loader2, Lock, Send, Sparkles, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { streamSSE } from '@/lib/api'
import type { ContextItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  context?: ContextItem[]
  dropped?: string[]
  provider?: string
  model?: string
  streaming?: boolean
  error?: { detail: string; hint?: string }
}

const FEATURES = [
  { value: 'chat', label: 'Chat' },
  { value: 'debug', label: 'Debug' },
  { value: 'generate_docs', label: 'Docs' },
  { value: 'generate_tests', label: 'Tests' },
  { value: 'security', label: 'Security' },
] as const

/**
 * Context disclosure.
 *
 * Collapsed by default so it isn't noise, but always one click away. This is the
 * mechanism that makes sending workspace data to a third-party model something a
 * user can verify rather than trust blindly — so it shows the real manifest the
 * server sent, not a description of it.
 */
function ContextDisclosure({ items, dropped }: { items: ContextItem[]; dropped?: string[] }) {
  const [open, setOpen] = useState(false)
  const included = items.filter((i) => i.included)
  const tokens = included.reduce((sum, i) => sum + i.tokens, 0)

  return (
    <div className="mb-2 rounded border border-line bg-canvas text-2xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted hover:text-ink"
      >
        <Eye className="h-3 w-3" />
        <span>
          Context sent · {included.length} item{included.length === 1 ? '' : 's'} ·{' '}
          {tokens.toLocaleString()} tokens
        </span>
        <ChevronDown className={cn('ml-auto h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-line px-2 py-1.5">
          {items.map((item) => (
            <div
              key={`${item.kind}-${item.label}`}
              className={cn(
                'flex items-center gap-1.5 py-0.5',
                !item.included && 'text-muted/60 line-through',
              )}
            >
              <span className={item.included ? 'text-success' : 'text-muted'}>
                {item.included ? '✓' : '—'}
              </span>
              <span className="truncate">{item.label}</span>
              <span className="ml-auto shrink-0 text-muted">{item.tokens}</span>
            </div>
          ))}

          {dropped && dropped.length > 0 && (
            <p className="mt-1.5 border-t border-line pt-1.5 text-warning">
              {dropped.length} item{dropped.length === 1 ? '' : 's'} didn't fit the model's context
              window and {dropped.length === 1 ? 'was' : 'were'} left out.
            </p>
          )}

          <p className="mt-1.5 flex items-start gap-1 border-t border-line pt-1.5 text-muted">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" />
            Secret values are replaced with their names before anything is sent.
          </p>
        </div>
      )}
    </div>
  )
}

export function AiPanel() {
  const { draft, result, activeEnvironmentId, activeConversationId, setConversation } = useWorkspace()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [feature, setFeature] = useState<(typeof FEATURES)[number]['value']>('chat')
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  // A failing response is the highest-intent moment for AI in the product, so
  // the panel pre-selects Debug rather than making the user choose.
  useEffect(() => {
    if (result && !result.ok) setFeature('debug')
    else if (result && result.status_code && result.status_code >= 400) setFeature('debug')
  }, [result])

  function stop() {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setTurns((prev) =>
      prev.map((turn, index) =>
        index === prev.length - 1 ? { ...turn, streaming: false } : turn,
      ),
    )
  }

  async function send() {
    const message = input.trim()
    if (!message || busy) return

    setInput('')
    setBusy(true)
    setTurns((prev) => [
      ...prev,
      { role: 'user', content: message },
      { role: 'assistant', content: '', streaming: true },
    ])

    const controller = new AbortController()
    abortRef.current = controller

    await streamSSE(
      '/ai/chat',
      {
        message,
        feature,
        conversation_id: activeConversationId,
        request_id: draft.id,
        execution_id: result?.id,
        environment_id: activeEnvironmentId,
      },
      {
        signal: controller.signal,
        onEvent: (event, data) => {
          const payload = data as Record<string, unknown>
          setTurns((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (!last || last.role !== 'assistant') return prev

            if (event === 'context') {
              last.context = payload.items as ContextItem[]
              last.dropped = payload.dropped as string[]
              last.provider = payload.provider as string
              last.model = payload.model as string
            } else if (event === 'token') {
              last.content += (payload.text as string) ?? ''
            } else if (event === 'error') {
              last.error = {
                detail: (payload.detail as string) ?? 'The AI request failed.',
                hint: payload.hint as string | undefined,
              }
              last.streaming = false
            } else if (event === 'done') {
              last.streaming = false
              if (payload.conversation_id) setConversation(payload.conversation_id as string)
            }
            return next
          })
        },
        onError: (error) => {
          setTurns((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') {
              last.error = { detail: error.message }
              last.streaming = false
            }
            return next
          })
        },
      },
    )

    setBusy(false)
    abortRef.current = null
  }

  // Suggestions follow what's on screen, so the empty state is a shortcut rather
  // than a static list the user has to translate into their situation.
  const suggestions =
    result && !result.ok
      ? ['Why did this fail?', 'How do I fix this?']
      : result && (result.status_code ?? 0) >= 400
        ? [`Why does this return ${result.status_code}?`, 'What should the request look like?']
        : draft.url
          ? ['Generate tests for this request', 'Write documentation for this endpoint']
          : ['Create a request that lists users', 'What can you help me with?']

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Sparkles className="h-4 w-4 text-ai" />
        <span className="text-sm font-medium">AI Assistant</span>
        <select
          value={feature}
          onChange={(e) => setFeature(e.target.value as typeof feature)}
          aria-label="AI mode"
          className="ml-auto rounded border border-line bg-canvas px-1.5 py-0.5 text-2xs outline-none"
        >
          {FEATURES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {turns.length === 0 && (
          <div className="pt-6 text-center">
            <div className="mb-2 text-2xl text-ai opacity-40">✦</div>
            <p className="text-sm font-medium">Ask about your API</p>
            <p className="mt-1 px-2 text-xs text-muted">
              I can already see your request, its response, and your environment — no need to
              paste anything.
            </p>
            <div className="mt-4 space-y-1.5">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className="w-full rounded border border-line px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:border-ai/40 hover:text-ink"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) =>
          turn.role === 'user' ? (
            <div key={index} className="ml-6 rounded-lg bg-subtle px-3 py-2 text-sm">
              {turn.content}
            </div>
          ) : (
            <div key={index} className="text-sm">
              {turn.context && <ContextDisclosure items={turn.context} dropped={turn.dropped} />}

              {turn.error ? (
                <div className="flex gap-2 rounded border border-danger/30 bg-danger/10 p-2.5 text-xs">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                  <div>
                    <div>{turn.error.detail}</div>
                    {turn.error.hint && <div className="mt-1 text-muted">{turn.error.hint}</div>}
                    {turn.error.detail.toLowerCase().includes('provider') && (
                      <Link to="/settings/providers" className="mt-1.5 inline-block text-accent hover:underline">
                        Configure a provider →
                      </Link>
                    )}
                  </div>
                </div>
              ) : (
                // The violet left border marks everything a model produced, so
                // machine-written content is never mistaken for the user's own.
                <div className="border-l-2 border-ai/40 pl-3">
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {turn.content}
                    {turn.streaming && (
                      <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ai align-middle" />
                    )}
                  </div>
                  {!turn.streaming && turn.model && (
                    <div className="mt-1.5 text-2xs text-muted">
                      {turn.provider} · {turn.model}
                    </div>
                  )}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className="border-t border-line p-2">
        <div className="flex gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder="Ask anything about your API…"
            aria-label="Message"
            className="input resize-none text-xs"
          />
          {busy ? (
            <button type="button" onClick={stop} title="Stop" className="btn-outline px-2">
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim()}
              title="Send"
              className="btn-primary px-2"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
