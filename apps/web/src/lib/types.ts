export interface User {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  email_verified: boolean
  ai_trial_used: number
  created_at: string
}

export interface WorkspaceSummary {
  id: string
  name: string
  slug: string
  is_personal: boolean
  role: 'owner' | 'editor' | 'viewer'
}

export interface KeyValue {
  key: string
  value: string
  enabled: boolean
  description?: string | null
}

export type BodyMode = 'none' | 'json' | 'raw' | 'form' | 'urlencoded' | 'graphql' | 'binary'

export interface RequestBody {
  mode: BodyMode
  content: string
  form_data?: KeyValue[]
  graphql_variables?: string
  content_type?: string | null
}

export type AuthType = 'none' | 'inherit' | 'bearer' | 'basic' | 'api_key'

export interface AuthConfig {
  type: AuthType
  token?: string
  username?: string
  password?: string
  key?: string
  value?: string
  add_to?: 'header' | 'query'
}

export interface ApiRequest {
  id: string
  collection_id: string
  folder_id: string | null
  name: string
  method: string
  url: string
  description: string | null
  headers: KeyValue[]
  query_params: KeyValue[]
  path_params: KeyValue[]
  body: RequestBody
  auth: AuthConfig | null
  settings: Record<string, unknown>
  position: number
  docs_markdown: string | null
  tests_code: string | null
  tests_framework: string | null
  version: number
  updated_at: string
}

export interface Folder {
  id: string
  collection_id: string
  parent_id: string | null
  name: string
  description: string | null
  position: number
  version: number
}

export interface Collection {
  id: string
  workspace_id: string
  name: string
  description: string | null
  base_url: string | null
  auth: AuthConfig | Record<string, never>
  default_headers: KeyValue[]
  docs_markdown: string | null
  position: number
  version: number
  created_at: string
  folders: Folder[]
  requests: ApiRequest[]
}

export interface Variable {
  id: string
  key: string
  value: string | null
  is_secret: boolean
  enabled: boolean
  description: string | null
}

export interface Environment {
  id: string
  name: string
  color: string | null
  is_default: boolean
  version: number
  variables: Variable[]
  created_at: string
}

export interface Timing {
  dns_ms: number | null
  connect_ms: number | null
  tls_ms: number | null
  ttfb_ms: number | null
  total_ms: number
}

export interface ExecutionResult {
  id: string | null
  ok: boolean
  mode: string
  status_code: number | null
  headers: Record<string, string>
  body: string | null
  content_type: string | null
  size_bytes: number
  timing: Timing
  error_code: string | null
  error_message: string | null
  error_hint: string | null
  final_url: string | null
  redirect_count: number
  unresolved_variables: string[]
  requires_local: boolean
}

export interface HistoryItem {
  id: string
  request_id: string | null
  method: string
  url: string
  status_code: number | null
  duration_ms: number | null
  response_size: number | null
  mode: string
  status: string
  error_message: string | null
  created_at: string
}

export interface ContextItem {
  kind: string
  label: string
  tokens: number
  included: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  context_manifest: ContextItem[]
  suggested_actions: Record<string, unknown>[]
  provider_type: string | null
  model: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usd: string | null
  latency_ms: number | null
  feedback: number | null
  created_at: string
}

export interface Conversation {
  id: string
  title: string
  feature: string
  request_id: string | null
  created_at: string
  updated_at: string
}

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'ollama'
  | 'oci'
  | 'custom'

export interface Provider {
  id: string
  type: ProviderType
  name: string
  base_url: string | null
  default_model: string
  enabled: boolean
  feature_overrides: Record<string, string>
  last_health_status: string | null
  last_health_message: string | null
  has_key: boolean
  created_at: string
}

export interface Member {
  id: string
  user_id: string
  email: string
  display_name: string
  avatar_url: string | null
  role: string
  joined_at: string
}
