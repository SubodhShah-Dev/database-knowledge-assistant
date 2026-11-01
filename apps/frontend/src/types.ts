export type User = {
  id: string;
  email: string;
  role: 'user' | 'admin';
  first_name?: string | null;
  last_name?: string | null;
};

export type ProfileUpdate = {
  first_name?: string | null;
  last_name?: string | null;
};

export type PasswordChange = {
  current_password: string;
  new_password: string;
  confirm_password: string;
};

export type AuthResponse = {
  user: User;
  token: string;
};

export type Connection = {
  id: string;
  engine: 'postgres' | 'mysql' | 'mongodb';
  name: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl_mode: string;
  has_password: boolean;
  has_sessions: boolean;
  created_at: string;
  updated_at: string;
};

export type ConnectionInput = {
  engine: Connection['engine'];
  name: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  sslMode?: string;
  connectionUri?: string;
};

export type ConnectionUpdateInput = Omit<ConnectionInput, 'password'> & { password?: string };

export type ConnectionTest =
  | { ok: true; serverVersion: string; sessionReadOnly: boolean; roleIsSuperuser: boolean; warning: string | null }
  | { ok: false; error: string };

export type ColumnMeta = {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  comment: string | null;
};

export type TableMeta = {
  schema: string;
  name: string;
  type: 'table' | 'view';
  comment: string | null;
  rowEstimate: number | null;
  columns: ColumnMeta[];
};

export type Relationship = {
  name: string;
  from: { schema: string; table: string; columns: string[] };
  to: { schema: string; table: string; columns: string[] };
  onDelete: string;
  onUpdate: string;
};

export type SchemaSnapshot = {
  connection: { id: string; name: string; database: string };
  tables: TableMeta[];
  relationships: Relationship[];
  introspectedAt: string;
};

export type Model = {
  id: string;
  label: string;
  model_id: string;
  is_default: boolean;
};

export type AnswerMode = 'auto' | 'data' | 'schema';
export type UsedAnswerMode = AnswerMode | 'clarify';

export type AdminModel = Model & {
  base_url: string;
  is_enabled: boolean;
  sort_order: number;
  has_api_key: boolean;
  api_key_source: 'stored' | 'environment' | null;
};

export type AdminModelInput = {
  label: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  isDefault: boolean;
  sortOrder: number;
};

export type UserApiKey = {
  modelId: string;
  label: string;
  model_id: string;
  base_url: string;
  hasKey: boolean;
};

export type UserModel = {
  id: string;
  label: string;
  model_id: string;
  base_url: string;
  is_enabled: boolean;
  sort_order: number;
  created_at: string;
};

export type UserModelInput = {
  label: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  isEnabled: boolean;
  sortOrder: number;
};

export type TableRef = { schema: string; table: string };

export type ConversationSummary = {
  id: string;
  title: string;
  connectionId: string;
  selectedTables: TableRef[];
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  connection: { id: string; name: string; database: string };
};

export type QueryEvidence = {
  version: 1;
  kind: 'sql';
  sql: string;
  queryFormat?: 'sql' | 'mongodb';
  columns: Array<{ name: string; dataType: string }>;
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
  tables: TableRef[];
};

export type SchemaEvidence = {
  version: 1;
  kind: 'schema';
  focus: string | null;
  tables: Array<{
    schema: string;
    table: string;
    columns: Array<{
      name: string;
      dataType: string;
      isPrimaryKey: boolean;
      isForeignKey: boolean;
    }>;
  }>;
  relationships: Relationship[];
};

export type Evidence = QueryEvidence | SchemaEvidence;

export type Turn = {
  id: string;
  question: string;
  answer: string;
  evidence: Evidence | [] | null;
  model: string | null;
  mode?: UsedAnswerMode | null;
  createdAt: string;
};

export type ConversationDetail = ConversationSummary & {
  turns: Turn[];
};

export type DonePayload = {
  conversationId: string;
  messageId: string;
  answer: string;
  model: string;
  mode: UsedAnswerMode;
};

export type StreamStatus = {
  phase: 'planning' | 'running_query' | 'answering' | string;
  label: string;
};
