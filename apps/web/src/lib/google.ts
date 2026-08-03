/**
 * Google Identity Services loader.
 *
 * The script is loaded on demand rather than in index.html, so a visitor who
 * never touches the Google button pays nothing for it — and the app still works
 * if Google's CDN is blocked or slow.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string
            callback: (response: { credential: string }) => void
            auto_select?: boolean
            cancel_on_tap_outside?: boolean
            ux_mode?: 'popup' | 'redirect'
          }) => void
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: 'outline' | 'filled_blue' | 'filled_black'
              size?: 'small' | 'medium' | 'large'
              text?: 'signin_with' | 'signup_with' | 'continue_with'
              shape?: 'rectangular' | 'pill'
              width?: number
              logo_alignment?: 'left' | 'center'
            },
          ) => void
          disableAutoSelect: () => void
        }
      }
    }
  }
}

const SCRIPT_URL = 'https://accounts.google.com/gsi/client'
let loader: Promise<void> | null = null

export function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()
  // Concurrent callers share one load; two <script> tags would double-initialise.
  if (loader) return loader

  loader = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load Google sign-in')))
      return
    }

    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      loader = null
      reject(new Error('Failed to load Google sign-in'))
    }
    document.head.appendChild(script)
  })

  return loader
}

export async function renderGoogleButton(
  container: HTMLElement,
  clientId: string,
  onCredential: (credential: string) => void,
): Promise<void> {
  await loadGoogleScript()
  if (!window.google?.accounts?.id) throw new Error('Google sign-in unavailable')

  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => onCredential(response.credential),
    // One Tap auto-select is deliberately off: silently signing someone into an
    // account they did not choose is disorienting, especially on shared machines.
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: 'popup',
  })

  container.innerHTML = ''
  window.google.accounts.id.renderButton(container, {
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    width: container.offsetWidth || 320,
  })
}
