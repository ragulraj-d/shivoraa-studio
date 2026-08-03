/**
 * Response webview.
 *
 * Deliberately minimal: status, timing, headers, body. The full builder lives
 * in the web app — the extension's job is proximity to code, not feature parity.
 */

import * as vscode from 'vscode'
import type { ExecutionResult } from '../lib/executor'

export class ResponsePanel {
  private static current: ResponsePanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      'shivoraa.response',
      'Shivoraa Response',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  static show(name: string, result: ExecutionResult, mode: 'local' | 'server'): void {
    if (!ResponsePanel.current) ResponsePanel.current = new ResponsePanel()
    const panel = ResponsePanel.current
    panel.panel.title = `${name} — ${result.status_code ?? 'failed'}`
    panel.panel.webview.html = render(result, mode)
    panel.panel.reveal(vscode.ViewColumn.Beside, true)
  }

  static showLoading(name: string): void {
    if (!ResponsePanel.current) ResponsePanel.current = new ResponsePanel()
    ResponsePanel.current.panel.title = `${name} — sending…`
    ResponsePanel.current.panel.webview.html = loading(name)
    ResponsePanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
  }

  dispose(): void {
    ResponsePanel.current = undefined
    this.panel.dispose()
    while (this.disposables.length) this.disposables.pop()?.dispose()
  }
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function statusColour(status: number | null): string {
  if (status === null) return 'var(--vscode-errorForeground)'
  if (status < 300) return 'var(--vscode-testing-iconPassed)'
  if (status < 400) return 'var(--vscode-editorWarning-foreground)'
  return 'var(--vscode-errorForeground)'
}

/** VS Code theme variables throughout, so the panel matches whatever theme
 *  the user has rather than fighting it. */
const STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 12px 16px;
  }
  .bar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
         padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .status { font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .badge { border: 1px solid var(--vscode-panel-border); border-radius: 3px;
           padding: 1px 6px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px;
        border-radius: 4px; overflow-x: auto; font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size); white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  td { padding: 3px 8px 3px 0; vertical-align: top;
       border-bottom: 1px solid var(--vscode-panel-border); }
  td.k { color: var(--vscode-descriptionForeground); width: 34%;
         font-family: var(--vscode-editor-font-family); }
  h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em;
       color: var(--vscode-descriptionForeground); margin: 18px 0 6px; }
  .error { border-left: 3px solid var(--vscode-errorForeground);
           padding: 10px 12px; background: var(--vscode-inputValidation-errorBackground); }
  .hint { color: var(--vscode-descriptionForeground); margin-top: 6px; }
`

function loading(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>
  <body><div class="bar"><span class="muted">Sending ${escape(name)}…</span></div></body></html>`
}

function render(result: ExecutionResult, mode: 'local' | 'server'): string {
  if (!result.ok) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
      <div class="error">
        <div class="status">${escape(result.error_message ?? 'The request failed.')}</div>
        ${result.error_hint ? `<div class="hint">${escape(result.error_hint)}</div>` : ''}
      </div>
      <div class="muted" style="margin-top:10px">
        ${result.duration_ms} ms · sent from ${mode === 'local' ? 'your machine' : "Shivoraa's servers"}
      </div>
    </body></html>`
  }

  const body = result.body ?? ''
  let pretty = body
  if ((result.content_type ?? '').includes('json')) {
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      /* not valid JSON despite the header — show it raw */
    }
  }

  const truncated = pretty.length > 200_000
  const shown = truncated ? pretty.slice(0, 200_000) : pretty

  const headerRows = Object.entries(result.headers)
    .map(([k, v]) => `<tr><td class="k">${escape(k)}</td><td>${escape(v)}</td></tr>`)
    .join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
    <div class="bar">
      <span class="status" style="color:${statusColour(result.status_code)}">
        ● ${result.status_code} ${escape(result.status_text)}
      </span>
      <span class="muted">${result.duration_ms} ms</span>
      <span class="muted">${formatBytes(result.size_bytes)}</span>
      ${result.content_type ? `<span class="muted">${escape(result.content_type.split(';')[0])}</span>` : ''}
      <span class="badge" title="Where this request was sent from">
        ${mode === 'local' ? 'local' : 'server'}
      </span>
    </div>

    <h3>Body</h3>
    <pre>${escape(shown)}${truncated ? '\n\n… truncated' : ''}</pre>

    <h3>Headers (${Object.keys(result.headers).length})</h3>
    <table>${headerRows}</table>
  </body></html>`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
