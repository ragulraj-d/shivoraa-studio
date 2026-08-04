/**
 * Request builder webview.
 *
 * A full editor — method, URL, params, headers, auth, body — with the response
 * below it, in the shape developers already know from Thunder Client and
 * Postman. The previous panel only rendered a response, which meant every edit
 * had to happen in the browser; that is not a companion tool, it is a viewer.
 *
 * Built as one self-contained document rather than a bundled framework: the
 * whole UI is ~15 KB, it loads instantly, and it cannot drift out of sync with
 * a build step. Styling comes entirely from VS Code theme variables so it
 * belongs in the editor rather than sitting on top of it.
 */

import * as vscode from 'vscode'
import type { ExecutionResult } from '../lib/executor'
import type { Environment, SavedRequest } from '../lib/resolver'

export interface PanelHandlers {
  onSend: (request: SavedRequest) => void
  onSave: (request: SavedRequest) => void
  onSelectEnvironment: (id: string) => void
}

export class RequestPanel {
  private static current: RequestPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private handlers?: PanelHandlers

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      'shivoraa.request',
      'Shivoraa',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    )

    this.panel.webview.html = this.render()
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'send':
            this.handlers?.onSend(message.request)
            break
          case 'save':
            this.handlers?.onSave(message.request)
            break
          case 'selectEnvironment':
            this.handlers?.onSelectEnvironment(message.id)
            break
          case 'copy':
            void vscode.env.clipboard.writeText(message.text)
            vscode.window.showInformationMessage('Copied to clipboard.')
            break
        }
      },
      null,
      this.disposables,
    )
  }

  static show(_extensionUri: vscode.Uri, handlers: PanelHandlers): RequestPanel {
    if (!RequestPanel.current) RequestPanel.current = new RequestPanel()
    RequestPanel.current.handlers = handlers
    RequestPanel.current.panel.reveal(vscode.ViewColumn.Active)
    return RequestPanel.current
  }

  static get instance(): RequestPanel | undefined {
    return RequestPanel.current
  }

  load(request: SavedRequest, environment?: Environment, environments: Environment[] = []): void {
    this.panel.title = request.name || 'Shivoraa'
    void this.panel.webview.postMessage({ type: 'load', request, environment, environments })
  }

  setEnvironment(environment?: Environment, environments?: Environment[]): void {
    void this.panel.webview.postMessage({ type: 'environment', environment, environments })
  }

  sending(): void {
    void this.panel.webview.postMessage({ type: 'sending' })
  }

  result(result: ExecutionResult, mode: string): void {
    void this.panel.webview.postMessage({ type: 'result', result, mode })
  }

  saved(): void {
    void this.panel.webview.postMessage({ type: 'saved' })
  }

  dispose(): void {
    RequestPanel.current = undefined
    this.panel.dispose()
    while (this.disposables.length) this.disposables.pop()?.dispose()
  }

  private render(): string {
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join('')

    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${STYLES}</style>
</head>
<body>
  <div class="bar">
    <select id="method" class="method" aria-label="HTTP method"></select>
    <input id="url" class="url" placeholder="https://api.example.com/users" spellcheck="false" aria-label="Request URL" />
    <button id="send" class="btn primary">Send</button>
    <button id="save" class="btn" title="Save (Ctrl+S)">Save</button>
    <select id="env" class="env" title="Environment" aria-label="Environment"></select>
  </div>

  <div id="varline" class="varline hidden"></div>

  <div class="tabs" id="reqTabs">
    <button class="tab active" data-tab="params">Query<span class="count" id="c-params"></span></button>
    <button class="tab" data-tab="headers">Headers<span class="count" id="c-headers"></span></button>
    <button class="tab" data-tab="auth">Auth</button>
    <button class="tab" data-tab="body">Body<span class="count" id="c-body"></span></button>
  </div>

  <div class="pane" id="pane-params"><div class="kv" id="kv-params"></div></div>
  <div class="pane hidden" id="pane-headers"><div class="kv" id="kv-headers"></div></div>

  <div class="pane hidden" id="pane-auth">
    <div class="row">
      <select id="authType" aria-label="Auth type">
        <option value="inherit">Inherit from collection</option>
        <option value="none">No auth</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Basic auth</option>
        <option value="api_key">API key</option>
      </select>
    </div>
    <div id="authFields" class="row"></div>
    <p class="hint">Use <code>{{variable}}</code> to pull values from the selected environment.</p>
  </div>

  <div class="pane hidden" id="pane-body">
    <div class="row">
      <select id="bodyMode" aria-label="Body type">
        <option value="none">None</option>
        <option value="json">JSON</option>
        <option value="raw">Raw</option>
        <option value="urlencoded">Form URL-encoded</option>
        <option value="graphql">GraphQL</option>
      </select>
      <button id="format" class="btn small hidden">Format</button>
    </div>
    <textarea id="bodyText" class="code hidden" spellcheck="false" placeholder='{\n  "name": "Ada"\n}'></textarea>
    <div class="kv hidden" id="kv-form"></div>
    <p class="hint" id="bodyNone">This request has no body.</p>
  </div>

  <div class="divider"></div>

  <div id="response" class="response">
    <div class="empty">
      <div class="empty-icon">&#8623;</div>
      <p>Send the request to see the response.</p>
      <p class="hint">Requests are sent from this machine, so localhost works.</p>
    </div>
  </div>

<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`
  }
}

// --------------------------------------------------------------------------- //
// Styles — every colour is a VS Code variable, so the panel matches any theme
// --------------------------------------------------------------------------- //
const STYLES = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.hidden { display: none !important; }

.bar { display: flex; gap: 6px; padding: 10px 12px 8px; align-items: center; }
.method {
  font-family: var(--vscode-editor-font-family); font-weight: 600; font-size: 12px;
  padding: 5px 6px; min-width: 88px;
  background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border); border-radius: 3px;
}
.url {
  flex: 1; min-width: 0; padding: 6px 8px;
  font-family: var(--vscode-editor-font-family); font-size: 12px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
}
.url:focus, select:focus, textarea:focus, input:focus {
  outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
}
.btn {
  padding: 6px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none; border-radius: 3px;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.btn.small { padding: 3px 8px; font-size: 11px; }
.btn:disabled { opacity: .5; cursor: default; }
.env {
  max-width: 180px; padding: 5px 6px; font-size: 12px;
  background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border); border-radius: 3px;
}

.varline {
  margin: 0 12px 6px; padding: 5px 8px; border-radius: 3px; font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
}

.tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab {
  background: none; border: none; cursor: pointer; padding: 7px 10px; font-size: 12px;
  color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent;
}
.tab:hover { color: var(--vscode-foreground); }
.tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
.count { margin-left: 5px; font-size: 10px; opacity: .8; }

.pane { padding: 10px 12px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
select, textarea, input[type=text], input[type=password] {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  padding: 5px 7px; font-size: 12px; font-family: inherit;
}
.code {
  width: 100%; min-height: 150px; resize: vertical;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  line-height: 1.5;
}
.hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0 0; }
code { font-family: var(--vscode-editor-font-family); }

.kv-row { display: grid; grid-template-columns: 22px 1fr 1.4fr 24px; gap: 6px; align-items: center; padding: 2px 0; }
.kv-row input[type=text] {
  width: 100%; font-family: var(--vscode-editor-font-family); font-size: 12px;
  background: transparent; border: none; border-bottom: 1px solid var(--vscode-panel-border);
  border-radius: 0; padding: 4px 2px;
}
.kv-row input[type=text]:focus { border-bottom-color: var(--vscode-focusBorder); outline: none; }
.kv-head {
  display: grid; grid-template-columns: 22px 1fr 1.4fr 24px; gap: 6px;
  font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--vscode-descriptionForeground); padding-bottom: 4px;
}
.del { background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1; }
.del:hover { color: var(--vscode-errorForeground); }

.divider { height: 1px; background: var(--vscode-panel-border); margin-top: 4px; }

.response { padding: 0 0 20px; }
.empty { text-align: center; padding: 40px 20px; color: var(--vscode-descriptionForeground); }
.empty-icon { font-size: 26px; opacity: .35; margin-bottom: 6px; }
.empty p { margin: 4px 0; font-size: 12px; }

.status-bar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
.status { font-weight: 600; }
.muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
.badge { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 1px 6px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.actions { margin-left: auto; display: flex; gap: 6px; }

pre.out {
  margin: 0; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  line-height: 1.5; background: var(--vscode-textCodeBlock-background);
}
table.hdrs { width: 100%; border-collapse: collapse; font-size: 12px; }
table.hdrs td { padding: 4px 10px 4px 12px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
table.hdrs td.k { width: 34%; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
.err { margin: 12px; padding: 12px; border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); font-size: 12px; }
.err h4 { margin: 0 0 6px; font-size: 12px; }
.spinner { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
`

// --------------------------------------------------------------------------- //
// Webview script
// --------------------------------------------------------------------------- //
const SCRIPT = `
const vscode = acquireVsCodeApi();
const METHODS = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
const METHOD_COLOR = { GET:'#4FC1FF', POST:'#4EC9B0', PUT:'#CE9178', PATCH:'#DCDCAA', DELETE:'#F48771' };

let state = {
  id: null, collectionId: '', name: 'Untitled',
  method: 'GET', url: '',
  headers: [], queryParams: [], pathParams: [],
  body: { mode: 'none', content: '', form_data: [] },
  auth: null,
};
let environment = undefined;
let environments = [];

const $ = (id) => document.getElementById(id);

// ---- method dropdown ----
METHODS.forEach(m => {
  const o = document.createElement('option'); o.value = m; o.textContent = m; $('method').appendChild(o);
});
function paintMethod() {
  $('method').style.color = METHOD_COLOR[state.method] || 'var(--vscode-dropdown-foreground)';
}

// ---- key/value editors ----
// A trailing blank row appears automatically, so adding a header never needs a
// separate "add" click — the same behaviour as a spreadsheet.
function renderKV(mountId, rows, onChange, keyPh, valPh) {
  const mount = $(mountId);
  mount.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'kv-head';
  head.innerHTML = '<span></span><span>Key</span><span>Value</span><span></span>';
  mount.appendChild(head);

  const list = rows.slice();
  const last = list[list.length - 1];
  if (!last || last.key || last.value) list.push({ key:'', value:'', enabled:true });

  list.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'kv-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = row.enabled !== false;
    cb.addEventListener('change', () => { list[i].enabled = cb.checked; onChange(list); });

    const k = document.createElement('input');
    k.type = 'text'; k.value = row.key || ''; k.placeholder = keyPh || 'Key';
    k.addEventListener('input', () => { list[i].key = k.value; onChange(list, true); });

    const v = document.createElement('input');
    v.type = 'text'; v.value = row.value || ''; v.placeholder = valPh || 'Value';
    v.addEventListener('input', () => { list[i].value = v.value; onChange(list, true); });

    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '\\u00d7'; del.title = 'Remove';
    del.addEventListener('click', () => { list.splice(i, 1); onChange(list); });

    el.append(cb, k, v, i === list.length - 1 && !row.key && !row.value ? document.createElement('span') : del);
    mount.appendChild(el);
  });
}

function repaintKVs() {
  renderKV('kv-params', state.queryParams, (rows, quiet) => {
    state.queryParams = rows; updateCounts(); if (!quiet) repaintKVs();
  });
  renderKV('kv-headers', state.headers, (rows, quiet) => {
    state.headers = rows; updateCounts(); if (!quiet) repaintKVs();
  }, 'Content-Type', 'application/json');
  renderKV('kv-form', state.body.form_data || [], (rows, quiet) => {
    state.body.form_data = rows; if (!quiet) repaintKVs();
  });
}

function updateCounts() {
  const n = (a) => (a || []).filter(r => r.key).length;
  $('c-params').textContent = n(state.queryParams) ? '(' + n(state.queryParams) + ')' : '';
  $('c-headers').textContent = n(state.headers) ? '(' + n(state.headers) + ')' : '';
  $('c-body').textContent = state.body.mode !== 'none' ? '\\u25CF' : '';
}

// ---- auth ----
function renderAuth() {
  const type = (state.auth && state.auth.type) || 'inherit';
  $('authType').value = type;
  const wrap = $('authFields');
  wrap.innerHTML = '';

  const field = (ph, key, pw) => {
    const i = document.createElement('input');
    i.type = pw ? 'password' : 'text';
    i.placeholder = ph;
    i.value = (state.auth && state.auth[key]) || '';
    i.style.flex = '1';
    i.addEventListener('input', () => {
      state.auth = Object.assign({ type }, state.auth, { [key]: i.value });
    });
    wrap.appendChild(i);
  };

  if (type === 'bearer') field('{{api_token}}', 'token');
  else if (type === 'basic') { field('Username', 'username'); field('Password', 'password', true); }
  else if (type === 'api_key') {
    field('X-API-Key', 'key'); field('{{api_key}}', 'value');
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="header">In header</option><option value="query">In query</option>';
    sel.value = (state.auth && state.auth.add_to) || 'header';
    sel.addEventListener('change', () => {
      state.auth = Object.assign({ type }, state.auth, { add_to: sel.value });
    });
    wrap.appendChild(sel);
  }
}

// ---- body ----
function renderBody() {
  const mode = state.body.mode || 'none';
  $('bodyMode').value = mode;
  $('bodyNone').classList.toggle('hidden', mode !== 'none');
  $('bodyText').classList.toggle('hidden', mode === 'none' || mode === 'urlencoded');
  $('kv-form').classList.toggle('hidden', mode !== 'urlencoded');
  $('format').classList.toggle('hidden', mode !== 'json');
  $('bodyText').value = state.body.content || '';
}

// ---- environment ----
function renderEnvironments() {
  const sel = $('env');
  sel.innerHTML = '';

  const none = document.createElement('option');
  none.value = ''; none.textContent = 'No environment';
  sel.appendChild(none);

  environments.forEach(env => {
    const o = document.createElement('option');
    o.value = env.id;
    // The variable count disambiguates environments with similar names, which
    // is exactly when picking the wrong one is easiest.
    o.textContent = env.name + ' (' + ((env.variables || []).length) + ')';
    sel.appendChild(o);
  });

  sel.value = (environment && environment.id) || '';
}

$('env').addEventListener('change', e => {
  vscode.postMessage({ type: 'selectEnvironment', id: e.target.value });
});

// ---- variables preview ----
function checkVariables() {
  const names = [];
  const re = /\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}\\}/g;
  let m;
  while ((m = re.exec(state.url)) !== null) if (!names.includes(m[1])) names.push(m[1]);

  const known = new Set(((environment && environment.variables) || []).filter(v => v.enabled !== false).map(v => v.key));
  const missing = names.filter(n => !known.has(n));

  const line = $('varline');
  if (!missing.length) { line.classList.add('hidden'); return; }
  line.classList.remove('hidden');
  line.textContent = missing.join(', ') + (missing.length === 1 ? ' is' : ' are') +
    ' not defined' + (environment ? ' in ' + environment.name : '') + ' — it will be sent as written.';
}

// ---- tabs ----
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    ['params','headers','auth','body'].forEach(p => {
      $('pane-' + p).classList.toggle('hidden', p !== tab.dataset.tab);
    });
  });
});

// ---- inputs ----
$('method').addEventListener('change', e => { state.method = e.target.value; paintMethod(); });
$('url').addEventListener('input', e => { state.url = e.target.value; checkVariables(); });
$('authType').addEventListener('change', e => { state.auth = { type: e.target.value }; renderAuth(); });
$('bodyMode').addEventListener('change', e => { state.body.mode = e.target.value; renderBody(); updateCounts(); });
$('bodyText').addEventListener('input', e => { state.body.content = e.target.value; });
$('format').addEventListener('click', () => {
  try {
    state.body.content = JSON.stringify(JSON.parse(state.body.content), null, 2);
    $('bodyText').value = state.body.content;
  } catch (_) { /* leave invalid JSON exactly as typed */ }
});

function collect() {
  return Object.assign({}, state, {
    headers: (state.headers || []).filter(r => r.key),
    queryParams: (state.queryParams || []).filter(r => r.key),
  });
}

$('send').addEventListener('click', () => vscode.postMessage({ type: 'send', request: collect() }));
$('save').addEventListener('click', () => vscode.postMessage({ type: 'save', request: collect() }));

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('send').click(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); $('save').click(); }
});

// ---- response ----
function statusColor(s) {
  if (s === null || s === undefined) return 'var(--vscode-errorForeground)';
  if (s < 300) return 'var(--vscode-testing-iconPassed)';
  if (s < 400) return 'var(--vscode-editorWarning-foreground)';
  return 'var(--vscode-errorForeground)';
}
function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
}
function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderResult(r, mode) {
  const box = $('response');

  if (!r.ok) {
    box.innerHTML = '<div class="err"><h4>' + esc(r.error_message || 'The request failed.') + '</h4>' +
      (r.error_hint ? '<div class="muted">' + esc(r.error_hint) + '</div>' : '') +
      '<div class="muted" style="margin-top:8px">' + r.duration_ms + ' ms \\u00b7 sent from your machine</div></div>';
    return;
  }

  let body = r.body || '';
  if ((r.content_type || '').indexOf('json') !== -1) {
    try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
  }
  const truncated = body.length > 300000;
  if (truncated) body = body.slice(0, 300000);

  const hdrs = Object.keys(r.headers || {})
    .map(k => '<tr><td class="k">' + esc(k) + '</td><td>' + esc(r.headers[k]) + '</td></tr>').join('');

  box.innerHTML =
    '<div class="status-bar">' +
      '<span class="status" style="color:' + statusColor(r.status_code) + '">\\u25CF ' +
        r.status_code + ' ' + esc(r.status_text || '') + '</span>' +
      '<span class="muted">' + r.duration_ms + ' ms</span>' +
      '<span class="muted">' + bytes(r.size_bytes) + '</span>' +
      (r.content_type ? '<span class="muted">' + esc(String(r.content_type).split(';')[0]) + '</span>' : '') +
      '<span class="badge">' + esc(mode) + '</span>' +
      '<span class="actions">' +
        '<button class="btn small" id="copyBody">Copy</button>' +
      '</span>' +
    '</div>' +
    '<div class="tabs" id="resTabs">' +
      '<button class="tab active" data-r="body">Body</button>' +
      '<button class="tab" data-r="headers">Headers (' + Object.keys(r.headers || {}).length + ')</button>' +
    '</div>' +
    '<div id="res-body"><pre class="out">' + esc(body) + (truncated ? '\\n\\n\\u2026 truncated' : '') + '</pre></div>' +
    '<div id="res-headers" class="hidden"><table class="hdrs">' + hdrs + '</table></div>';

  document.querySelectorAll('#resTabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#resTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('res-body').classList.toggle('hidden', t.dataset.r !== 'body');
      $('res-headers').classList.toggle('hidden', t.dataset.r !== 'headers');
    });
  });

  const copy = $('copyBody');
  if (copy) copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: r.body || '' }));
}

// ---- host messages ----
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'load') {
    state = Object.assign({
      headers: [], queryParams: [], pathParams: [],
      body: { mode:'none', content:'', form_data: [] }, auth: null,
    }, msg.request);
    if (!state.body) state.body = { mode:'none', content:'', form_data: [] };
    environment = msg.environment;
    environments = msg.environments || [];
    renderEnvironments();
    $('method').value = state.method || 'GET';
    $('url').value = state.url || '';
    paintMethod(); repaintKVs(); renderAuth(); renderBody(); updateCounts(); checkVariables();
    $('response').innerHTML = '<div class="empty"><div class="empty-icon">\\u21AF</div>' +
      '<p>Send the request to see the response.</p>' +
      '<p class="hint">Requests are sent from this machine, so localhost works.</p></div>';
  }
  if (msg.type === 'environment') {
    environment = msg.environment;
    if (msg.environments) environments = msg.environments;
    renderEnvironments();
    checkVariables();
  }
  if (msg.type === 'sending') {
    $('send').disabled = true;
    $('response').innerHTML = '<div class="spinner">Sending\\u2026</div>';
  }
  if (msg.type === 'result') { $('send').disabled = false; renderResult(msg.result, msg.mode); }
  if (msg.type === 'saved') {
    $('save').textContent = 'Saved';
    setTimeout(() => { $('save').textContent = 'Save'; }, 1200);
  }
});

paintMethod(); repaintKVs(); renderAuth(); renderBody(); updateCounts(); renderEnvironments();
`
