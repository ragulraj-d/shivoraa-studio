import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { AiPanel } from '@/components/ai/AiPanel'
import { CollectionsSidebar } from '@/components/collections/CollectionsSidebar'
import { TopBar } from '@/components/layout/TopBar'
import { RequestBuilder } from '@/components/request/RequestBuilder'
import { ResponseViewer } from '@/components/response/ResponseViewer'
import { api } from '@/lib/api'
import type { Environment } from '@/lib/types'
import { useWorkspace } from '@/store/workspace'

export function StudioPage() {
  const { aiPanelOpen, sidebarOpen, activeEnvironmentId, setEnvironment, toggleAiPanel, toggleSidebar } =
    useWorkspace()

  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api.get<Environment[]>('/environments'),
  })

  // Fall back to the default environment when nothing is selected, so
  // {{variables}} resolve on a fresh session instead of silently failing.
  useEffect(() => {
    if (!activeEnvironmentId && environments.data?.length) {
      const fallback = environments.data.find((e) => e.is_default) ?? environments.data[0]
      setEnvironment(fallback.id)
    }
  }, [activeEnvironmentId, environments.data, setEnvironment])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      if (event.key === 'b') {
        event.preventDefault()
        toggleSidebar()
      } else if (event.key === 'j') {
        event.preventDefault()
        toggleAiPanel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleAiPanel, toggleSidebar])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      <TopBar environments={environments.data ?? []} />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="hidden w-72 shrink-0 border-r border-line bg-surface md:block">
            <CollectionsSidebar />
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <RequestBuilder />
          <ResponseViewer />
        </main>

        {aiPanelOpen && (
          <aside className="hidden w-[380px] shrink-0 border-l border-line bg-surface lg:block">
            <AiPanel />
          </aside>
        )}
      </div>
    </div>
  )
}
