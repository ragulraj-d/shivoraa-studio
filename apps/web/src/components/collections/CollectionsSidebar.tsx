import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Download, FolderPlus, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ImportDialog } from '@/components/collections/ImportDialog'
import { api, ApiError } from '@/lib/api'
import type { ApiRequest, Collection } from '@/lib/types'
import { METHOD_COLORS, cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

export function CollectionsSidebar() {
  const queryClient = useQueryClient()
  const { draft, loadRequest } = useWorkspace()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [importing, setImporting] = useState(false)

  const collections = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get<Collection[]>('/collections'),
  })

  const createCollection = useMutation({
    mutationFn: (name: string) => api.post<Collection>('/collections', { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['collections'] }),
  })

  /**
   * Create a request and open it.
   *
   * This used to only reset the in-memory draft, so clicking it appeared to do
   * nothing when the builder was already blank — and the draft had no
   * collection, so saving later failed. It now creates the row, and creates a
   * collection first if the workspace has none, so the button always produces
   * something visible.
   */
  const createRequest = useMutation({
    mutationFn: async (collectionId?: string) => {
      let target = collectionId ?? collections.data?.[0]?.id
      if (!target) {
        const collection = await api.post<{ id: string }>('/collections', { name: 'My API' })
        target = collection.id
      }
      return api.post<ApiRequest>(`/collections/${target}/requests`, {
        name: 'Untitled request',
        method: 'GET',
        url: '',
      })
    },
    onSuccess: (request) => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] })
      if (request) loadRequest(request)
    },
    onError: (err) =>
      window.alert(err instanceof ApiError ? err.body.detail : 'Could not create the request.'),
  })

  const deleteCollection = useMutation({
    mutationFn: (id: string) => api.delete(`/collections/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['collections'] }),
  })

  const filtered = useMemo(() => {
    const data = collections.data ?? []
    if (!filter.trim()) return data
    const term = filter.toLowerCase()
    return data
      .map((collection) => ({
        ...collection,
        requests: collection.requests.filter(
          (r) =>
            r.name.toLowerCase().includes(term) ||
            r.url.toLowerCase().includes(term) ||
            r.method.toLowerCase().includes(term),
        ),
      }))
      .filter((c) => c.requests.length > 0 || c.name.toLowerCase().includes(term))
  }, [collections.data, filter])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line p-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            className="input py-1 pl-7 text-xs"
            placeholder="Filter requests…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter requests"
          />
        </div>
        <button
          type="button"
          title="Import from Postman, OpenAPI, HAR or cURL"
          aria-label="Import a collection"
          onClick={() => setImporting(true)}
          className="btn-ghost px-2"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="New collection"
          aria-label="New collection"
          onClick={() => {
            const name = window.prompt('Collection name')
            if (name?.trim()) createCollection.mutate(name.trim())
          }}
          className="btn-ghost px-2"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {collections.isLoading && (
          <div className="space-y-1.5 p-2">
            {/* Skeletons at varying widths read as content loading rather than a
                stalled spinner. */}
            {[70, 45, 60, 38, 55].map((width, index) => (
              <div key={index} className="skeleton h-5" style={{ width: `${width}%` }} />
            ))}
          </div>
        )}

        {collections.isError && (
          <div className="p-3 text-sm">
            <p className="text-danger">Couldn't load your collections.</p>
            <button
              type="button"
              onClick={() => collections.refetch()}
              className="mt-2 text-accent hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {collections.isSuccess && filtered.length === 0 && !filter && (
          // This is the moment a new user decides whether to invest, so it
          // explains the concept and offers the action rather than saying "empty".
          <div className="p-4 text-center">
            <div className="mb-2 text-2xl opacity-40">◫</div>
            <p className="text-sm font-medium">Your collections live here</p>
            <p className="mt-1 text-xs text-muted">
              Group related requests so you can find and share them.
            </p>
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="btn-primary mt-3 w-full"
            >
              <Download className="h-3.5 w-3.5" />
              Import a collection
            </button>
            <button
              type="button"
              onClick={() => createCollection.mutate('My API')}
              className="btn-outline mt-1.5 w-full"
            >
              <Plus className="h-3.5 w-3.5" />
              Start from scratch
            </button>
          </div>
        )}

        {collections.isSuccess && filtered.length === 0 && filter && (
          <div className="p-4 text-center text-sm text-muted">
            <p>No requests match “{filter}”.</p>
            <button
              type="button"
              onClick={() => setFilter('')}
              className="mt-2 text-accent hover:underline"
            >
              Clear filter
            </button>
          </div>
        )}

        {filtered.map((collection) => {
          const isCollapsed = collapsed[collection.id] && !filter
          return (
            <div key={collection.id} className="mb-0.5">
              <div className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-subtle">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [collection.id]: !c[collection.id] }))
                  }
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted transition-transform',
                      !isCollapsed && 'rotate-90',
                    )}
                  />
                  <span className="truncate text-xs font-medium">{collection.name}</span>
                  <span className="shrink-0 text-2xs text-muted">
                    {collection.requests.length}
                  </span>
                </button>

                <button
                  type="button"
                  title="New request"
                  aria-label={`New request in ${collection.name}`}
                  onClick={() => createRequest.mutate(collection.id)}
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete collection"
                  aria-label={`Delete ${collection.name}`}
                  onClick={() => {
                    const count = collection.requests.length
                    const message = count
                      ? `Delete “${collection.name}” and its ${count} request${count === 1 ? '' : 's'}?`
                      : `Delete “${collection.name}”?`
                    if (window.confirm(message)) deleteCollection.mutate(collection.id)
                  }}
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {!isCollapsed && (
                <div className="ml-3 border-l border-line pl-1">
                  {collection.requests.length === 0 && (
                    <button
                      type="button"
                      onClick={() => createRequest.mutate(collection.id)}
                      className="w-full px-2 py-1.5 text-left text-2xs text-muted hover:text-accent"
                    >
                      + Add a request
                    </button>
                  )}
                  {collection.requests.map((request) => (
                    <button
                      key={request.id}
                      type="button"
                      onClick={() => loadRequest(request)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-subtle',
                        draft.id === request.id && 'bg-subtle',
                      )}
                    >
                      <span
                        className={cn(
                          'w-10 shrink-0 font-mono text-2xs font-semibold',
                          METHOD_COLORS[request.method] ?? 'text-muted',
                        )}
                      >
                        {request.method}
                      </span>
                      <span className="truncate text-xs">{request.name}</span>
                      {draft.id === request.id && draft.dirty && (
                        <span
                          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                          title="Unsaved changes"
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={() => createRequest.mutate(undefined)}
          disabled={createRequest.isPending}
          className="btn-outline w-full text-xs"
        >
          {createRequest.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          New request
        </button>
      </div>

      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  )
}
