/**
 * Collections tree in the activity bar.
 *
 * Mirrors the web app's explorer, so a request saved in the browser appears
 * here and vice versa.
 */

import * as vscode from 'vscode'
import type { ShivoraaClient } from '../lib/client'

export interface ApiRequest {
  id: string
  collection_id: string
  name: string
  method: string
  url: string
  version: number
}

export interface Collection {
  id: string
  name: string
  description: string | null
  requests: ApiRequest[]
}

type Node = CollectionNode | RequestNode

class CollectionNode extends vscode.TreeItem {
  readonly kind = 'collection' as const

  constructor(public readonly collection: Collection) {
    super(collection.name, vscode.TreeItemCollapsibleState.Expanded)
    this.contextValue = 'collection'
    this.iconPath = new vscode.ThemeIcon('folder-library')
    this.description = `${collection.requests.length}`
    this.tooltip = collection.description ?? collection.name
  }
}

class RequestNode extends vscode.TreeItem {
  readonly kind = 'request' as const

  constructor(public readonly request: ApiRequest) {
    super(request.name, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'request'
    this.description = request.method
    this.tooltip = new vscode.MarkdownString(
      `**${request.method}** \`${request.url || '(no URL)'}\``,
    )
    // Method colours reuse VS Code's theme tokens so they stay legible in any
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

  private collections: Collection[] = []
  private loadError: string | null = null

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
        ? element.collection.requests.map((r) => new RequestNode(r))
        : []
    }

    if (!(await this.client.isSignedIn())) return []

    try {
      this.collections = await this.client.request<Collection[]>('/collections')
      this.loadError = null
    } catch (error) {
      // Surfaced as a notification rather than a fake tree node, so the tree
      // keeps showing the last known good data instead of blanking.
      this.loadError = (error as Error).message
      vscode.window.showErrorMessage(`Shivoraa: ${this.loadError}`)
      return []
    }

    return this.collections.map((c) => new CollectionNode(c))
  }

  findRequest(id: string): ApiRequest | undefined {
    for (const c of this.collections) {
      const found = c.requests.find((r) => r.id === id)
      if (found) return found
    }
    return undefined
  }

  firstCollectionId(): string | undefined {
    return this.collections[0]?.id
  }
}
