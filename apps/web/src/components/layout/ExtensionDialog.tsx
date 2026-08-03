import { Check, Copy, Download, X } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * VS Code extension install instructions.
 *
 * The extension is not on the Marketplace yet, so this hands over a .vsix and
 * the exact command to install it. Publishing needs a Microsoft publisher
 * account; until then a direct download is honest and takes about a minute.
 */
export function ExtensionDialog({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    function onEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  function copy(id: string, text: string) {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }

  const installCmd = 'code --install-extension ~/Downloads/shivoraa-studio.vsix'
  const agentCmd = 'make agent'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Shivoraa Studio for VS Code"
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-line bg-elevated shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Shivoraa Studio for VS Code</h2>
            <p className="mt-0.5 text-2xs text-muted">
              Send requests from your editor — including localhost
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost px-2" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <p className="text-muted">
            A browser cannot reach <span className="font-mono text-ink">localhost:8000</span>, and
            it cannot read a response from an API that has not opted in with CORS. The extension
            sends requests from your machine, so neither limit applies. Your collections stay in
            sync with this workspace.
          </p>

          <ol className="space-y-3">
            <li>
              <div className="mb-1.5 text-xs font-medium">1 · Download</div>
              <a
                href="/download/shivoraa-studio.vsix"
                download="shivoraa-studio.vsix"
                className="btn-primary w-full py-2"
              >
                <Download className="h-4 w-4" />
                shivoraa-studio.vsix
              </a>
            </li>

            <li>
              <div className="mb-1.5 text-xs font-medium">2 · Install it</div>
              <div className="flex gap-1.5">
                <code className="flex-1 overflow-x-auto rounded border border-line bg-subtle px-2.5 py-1.5 font-mono text-2xs">
                  {installCmd}
                </code>
                <button
                  type="button"
                  onClick={() => copy('install', installCmd)}
                  className="btn-outline shrink-0 px-2"
                  aria-label="Copy install command"
                >
                  {copied === 'install' ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <p className="mt-1 text-2xs text-muted">
                Or in VS Code: Extensions → ⋯ → Install from VSIX
              </p>
            </li>

            <li>
              <div className="mb-1.5 text-xs font-medium">3 · Connect it</div>
              <p className="text-2xs text-muted">
                Run <span className="font-mono text-ink">Shivoraa: Sign In</span> from the command
                palette, then paste the pairing code from{' '}
                <span className="font-mono text-ink">Settings → Account</span>.
              </p>
            </li>
          </ol>

          <div className="rounded border border-line bg-canvas p-3">
            <div className="text-xs font-medium">Prefer to stay in the browser?</div>
            <p className="mt-1 text-2xs text-muted">
              Run the local agent instead. Shivoraa detects it automatically and routes requests
              through it when the browser cannot — same result, no editor needed.
            </p>
            <div className="mt-2 flex gap-1.5">
              <code className="flex-1 rounded border border-line bg-subtle px-2.5 py-1.5 font-mono text-2xs">
                {agentCmd}
              </code>
              <button
                type="button"
                onClick={() => copy('agent', agentCmd)}
                className="btn-outline shrink-0 px-2"
                aria-label="Copy agent command"
              >
                {copied === 'agent' ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
