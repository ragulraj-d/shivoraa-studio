import { ChevronDown, LogOut, Moon, PanelLeft, Settings, Sparkles, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Environment } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useWorkspace } from '@/store/workspace'

function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('sv_theme')
    if (stored) return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('sv_theme', dark ? 'dark' : 'light')
  }, [dark])

  return { dark, toggle: () => setDark((d) => !d) }
}

function Dropdown({
  label,
  children,
}: {
  label: React.ReactNode
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function onEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost gap-1 text-sm"
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[220px] animate-slide-up rounded-lg border border-line bg-elevated p-1 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function TopBar({ environments }: { environments: Environment[] }) {
  const { user, workspaces, activeWorkspace, switchWorkspace, logout } = useAuth()
  const { activeEnvironmentId, setEnvironment, toggleSidebar, toggleAiPanel, aiPanelOpen } =
    useWorkspace()
  const { dark, toggle } = useTheme()

  const activeEnv = environments.find((e) => e.id === activeEnvironmentId)
  const trialLeft = user ? Math.max(0, 50 - user.ai_trial_used) : 0

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
      <button
        type="button"
        onClick={toggleSidebar}
        title="Toggle sidebar (⌘B)"
        aria-label="Toggle sidebar"
        className="btn-ghost px-2"
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-2 pr-2">
        <span className="text-lg text-accent">◈</span>
        <span className="hidden text-sm font-semibold sm:inline">Shivoraa</span>
      </div>

      <Dropdown label={<span className="max-w-[160px] truncate">{activeWorkspace?.name ?? 'Workspace'}</span>}>
        {(close) => (
          <>
            <div className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
              Workspaces
            </div>
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  if (workspace.id !== activeWorkspace?.id) switchWorkspace(workspace.id)
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-subtle',
                  workspace.id === activeWorkspace?.id && 'text-accent',
                )}
              >
                <span className="truncate">{workspace.name}</span>
                <span className="ml-2 text-2xs text-muted">{workspace.role}</span>
              </button>
            ))}
          </>
        )}
      </Dropdown>

      <div className="flex-1" />

      {trialLeft > 0 && trialLeft <= 50 && (
        <span
          className="hidden items-center gap-1 rounded-full border border-ai/30 bg-ai/10 px-2.5 py-1 text-2xs text-ai md:inline-flex"
          title="Free AI actions before you need your own provider key"
        >
          <Sparkles className="h-3 w-3" />
          {trialLeft} free AI actions
        </span>
      )}

      {/* Environment switching re-resolves every {{variable}} immediately, so
          this control is placed where it is always reachable. */}
      <Dropdown
        label={
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: activeEnv?.color ?? 'rgb(var(--muted))' }}
            />
            <span className="max-w-[120px] truncate">{activeEnv?.name ?? 'No environment'}</span>
          </span>
        }
      >
        {(close) => (
          <>
            <div className="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
              Environment
            </div>
            {environments.length === 0 && (
              <div className="px-2 py-2 text-sm text-muted">
                No environments yet.
                <Link to="/settings/environments" className="ml-1 text-accent hover:underline">
                  Create one
                </Link>
              </div>
            )}
            {environments.map((env) => (
              <button
                key={env.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setEnvironment(env.id)
                  close()
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-subtle',
                  env.id === activeEnvironmentId && 'text-accent',
                )}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: env.color ?? 'rgb(var(--muted))' }}
                />
                <span className="truncate">{env.name}</span>
                <span className="ml-auto text-2xs text-muted">{env.variables.length} vars</span>
              </button>
            ))}
          </>
        )}
      </Dropdown>

      <button
        type="button"
        onClick={toggleAiPanel}
        title="Toggle AI panel (⌘J)"
        aria-label="Toggle AI panel"
        aria-pressed={aiPanelOpen}
        className={cn('btn-ghost px-2', aiPanelOpen && 'text-ai')}
      >
        <Sparkles className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={toggle}
        title="Toggle theme"
        aria-label="Toggle theme"
        className="btn-ghost px-2"
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>

      <Dropdown
        label={
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-2xs font-medium text-white">
            {user?.display_name?.[0]?.toUpperCase() ?? '?'}
          </span>
        }
      >
        {(close) => (
          <>
            <div className="border-b border-line px-2 pb-2 pt-1">
              <div className="truncate text-sm font-medium">{user?.display_name}</div>
              <div className="truncate text-2xs text-muted">{user?.email}</div>
            </div>
            <Link
              to="/settings"
              onClick={close}
              role="menuitem"
              className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-subtle"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => void logout()}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-danger hover:bg-subtle"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </>
        )}
      </Dropdown>
    </header>
  )
}
