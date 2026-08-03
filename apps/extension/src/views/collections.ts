/**
 * Collections tree.
 *
 * Reads the same Firestore workspace the web app writes, so a request saved in
 * the browser appears here on the next refresh.
 */

import * as vscode from 'vscode'
import type { ShivoraaClient } from '../lib/firebase'
import type { SavedCollection, SavedRequest } from '../lib/resolver'

type Node = CollectionNode | RequestNode

class CollectionNode extends vscode.TreeItem {
  readonly kind = 'collection' as const

  constructor(
    public readonly collection: SavedCollection,
    count: number,
  ) {
    super(collection.name, vscode.TreeItemCollapsibleState.Expanded)
    this.contextValue = 'collection'
    this.iconPath = new vscode.ThemeIcon('folder-library')
    this.description = String(count)
  }
}

class RequestNode extends vscode.TreeItem {
  readonly kind = 'request' as const

  constructor(public readonly request: SavedRequest) {
    super(request.name, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'request'
    this.description = request.method
    this.tooltip = new vscode.MarkdownString(
      `**${request.method}** \`${request.url || '(no URL)'}\``,
    )
    // Theme colours rather than fixed hexes, so methods stay legible in any
    // colour theme the user has installed.
    this.iconPath = new vscode.ThemeIcon(
      'symbol-method',
      new vscode.ThemeColor(methodColour(request.method)),
    )
    this.command = {
      command: 'shivoraa.openRequest',
      title: 'Open Request',
      arguments: [request],
    }
  }
}

function methodColour(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'charts.blue'
    case 'POST':
      return 'charts.green'
    case 'PUT':
      return 'charts.orange'
    case 'PATCH':
      return 'charts.yellow'
    case 'DELETE':
      return 'charts.red'
    default:
      return 'foreground'
  }
}

export class CollectionsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  private collections: SavedCollection[] = []
  private requests: SavedRequest[] = []

  constructor(private readonly client: ShivoraaClient) {}

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element) {
      return element.kind === 'collection'
        ? this.requests
            .filter((r) => r.collectionId === element.collection.id)
            .map((r) => new RequestNode(r))
        : []
    }

    if (!(await this.client.isSignedIn())) return []

    try {
      // Two reads, not one per collection: Firestore's free tier meters
      // document reads, and an N+1 pattern would burn the daily quota.
      const [collectionRows, requestRows] = await Promise.all([
        this.client.list('collections'),
        this.client.list('requests'),
      ])

      this.collections = collectionRows.map((row) => ({
        id: row.id,
        name: (row.data.name as string) ?? 'Untitled',
        baseUrl: (row.data.baseUrl as string) ?? null,
        auth: (row.data.auth as SavedCollection['auth']) ?? null,
        defaultHeaders: (row.data.defaultHeaders as SavedCollection['defaultHeaders']) ?? [],
      }))

      this.requests = requestRows
        .map((row) => ({
          id: row.id,
          collectionId: (row.data.collectionId as string) ?? '',
          name: (row.data.name as string) ?? 'Untitled',
          method: (row.data.method as string) ?? 'GET',
          url: (row.data.url as string) ?? '',
          headers: (row.data.headers as SavedRequest['headers']) ?? [],
          queryParams: (row.data.queryParams as SavedRequest['queryParams']) ?? [],
          pathParams: (row.data.pathParams as SavedRequest['pathParams']) ?? [],
          body: (row.data.body as SavedRequest['body']) ?? { mode: 'none', content: '' },
          auth: (row.data.auth as SavedRequest['auth']) ?? null,
          position: (row.data.position as number) ?? 0,
        }))
        .sort((a, b) => (a as any).position - (b as any).position)
    } catch (error) {
      // Surfaced as a notification rather than a fake tree node, so the tree
      // keeps its last good state instead of blanking.
      vscode.window.showErrorMessage(`Shivoraa: ${(error as Error).message}`)
      return []
    }

    return this.collections.map(
      (c) =>
        new CollectionNode(c, this.requests.filter((r) => r.collectionId === c.id).length),
    )
  }

  collectionFor(id: string): SavedCollection | undefined {
    return this.collections.find((c) => c.id === id)
  }

  async firstCollectionId(): Promise<string> {
    if (this.collections.length) return this.collections[0].id
    await this.getChildren()
    if (this.collections.length) return this.collections[0].id

    const created = await this.client.create('collections', {
      name: 'My API',
      description: null,
      baseUrl: null,
      auth: {},
      defaultHeaders: [],
      position: 0,
      version: 1,
      createdAt: new Date().toISOString(),
    })
    return created.id
  }
}
