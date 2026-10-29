import { readFile, realpath, stat } from 'node:fs/promises';
import { resolveSrv } from 'node:dns/promises';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import initSqlJs, { type Database as SqliteDatabase } from 'sql.js';
import { MongoClient, type Document } from 'mongodb';
import sqlServer from 'mssql';
import mysql from 'mysql2/promise';
import type { Pool } from 'pg';
import { assertHostAllowed, HostGuardError } from './hostGuard';
import {
  getPool,
  invalidatePools,
  safeConnectionError,
  testConnection as testPostgresConnection,
  type SslMode,
  type TargetConfig
} from './connectionPool';
import { getSchemaSnapshot, type ColumnMeta, type SchemaSnapshot, type TableMeta } from './introspection';
import { runReadOnlyQuery, type QueryResult, TargetDbTimeoutError } from './sqlExecution';
import { referencedTables, SqlValidationError, validateSql } from './sqlGuard';
import type { TableRef } from './sessionScope';

type ConnectionRef = { id: string; updated_at: string | Date };
type QueryOptions = { maxRows: number; timeoutMs: number };
type MongoQuery =
  | { collection: string; pipeline: Document[] }
  | {
      operation: 'countDocuments';
      collections: Array<{ schema: string; table: string; relationshipCount?: number }>;
    };
type MysqlTableCountOperation = {
  operation: 'tableRecordCounts';
  tables: Array<{ schema: string; table: string; relationshipCount: number }>;
};

export function buildTableRecordCountQuery(
  tables: TableRef[],
  engine: NonNullable<TargetConfig['engine']>,
  relationshipCounts?: Map<string, number>
): string {
  if (tables.length === 0) throw new Error('No selected tables are available to compare.');

  if (engine === 'mongodb') {
    return JSON.stringify({
      operation: 'countDocuments',
      collections: tables.map(table => ({
        ...table,
        ...(relationshipCounts
          ? { relationshipCount: relationshipCounts.get(`${table.schema}.${table.table}`) ?? 0 }
          : {})
      }))
    });
  }
  if (engine === 'mysql' && relationshipCounts) {
    return JSON.stringify({
      operation: 'tableRecordCounts',
      tables: tables.map(table => ({
        ...table,
        relationshipCount: relationshipCounts.get(`${table.schema}.${table.table}`) ?? 0
      }))
    } satisfies MysqlTableCountOperation);
  }

  const identifier = (value: string): string => {
    if (engine === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
    if (engine === 'sqlserver') return `[${value.replace(/]/g, ']]')}]`;
    return `"${value.replace(/"/g, '""')}"`;
  };
  const count =
    engine === 'sqlserver'
      ? 'COALESCE(SUM(CAST(1 AS BIGINT)), CAST(0 AS BIGINT))'
      : 'COUNT(*)';
  const counts = tables.map(({ schema, table }) => {
    const qualifiedTable = `${identifier(schema)}.${identifier(table)}`;
    const name = `${schema}.${table}`.replace(/'/g, "''");
    const relationshipCount = relationshipCounts
      ? `, ${relationshipCounts.get(`${schema}.${table}`) ?? 0} AS relationship_count`
      : '';
    return `SELECT '${name}' AS table_name, ${count} AS record_count${relationshipCount} FROM ${qualifiedTable}`;
  });
  return `${counts.join(' UNION ALL ')} ORDER BY record_count DESC, table_name ASC`;
}

export class TargetConfigurationError extends Error {
  readonly code = 'TARGET_CONFIGURATION';
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'TargetConfigurationError';
  }
}

export function parseMongoUri(uri: string): {
  hosts: Array<{ hostname: string; port?: number }>;
  database: string;
  username: string;
  srv: boolean;
} {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?[^#]*)?(?:#.*)?$/i.exec(uri);
  if (!match) throw new TargetConfigurationError('Enter a valid MongoDB connection URI.');

  const [, scheme, authority, databasePath = ''] = match;
  const srv = scheme.toLowerCase() === 'mongodb+srv';
  const at = authority.lastIndexOf('@');
  const credentials = at >= 0 ? authority.slice(0, at) : '';
  const hostList = authority.slice(at + 1);
  if (!hostList || (srv && hostList.includes(','))) {
    throw new TargetConfigurationError('MongoDB URI must contain a valid host list.');
  }

  const hosts = hostList.split(',').map(value => {
    let hostname: string;
    let portText = '';
    if (value.startsWith('[')) {
      const end = value.indexOf(']');
      if (end < 0) throw new TargetConfigurationError('MongoDB URI contains an invalid host.');
      hostname = value.slice(1, end);
      portText = value.slice(end + 1).replace(/^:/, '');
    } else {
      const colon = value.lastIndexOf(':');
      if (colon >= 0) {
        hostname = value.slice(0, colon);
        portText = value.slice(colon + 1);
      } else {
        hostname = value;
      }
    }
    if (!hostname || (srv && portText)) {
      throw new TargetConfigurationError('MongoDB URI contains an invalid host or port.');
    }
    const port = portText ? Number(portText) : undefined;
    if (portText && (!Number.isInteger(port) || port! < 1 || port! > 65535)) {
      throw new TargetConfigurationError('MongoDB URI contains an invalid port.');
    }
    return { hostname, port };
  });

  let username = '';
  try {
    username = decodeURIComponent(credentials.split(':', 1)[0] ?? '');
    return {
      hosts,
      database: decodeURIComponent(databasePath),
      username,
      srv
    };
  } catch {
    throw new TargetConfigurationError('MongoDB URI contains invalid percent encoding.');
  }
}

const schemaCache = new Map<string, { snapshot: SchemaSnapshot; expiresAt: number }>();
const mongoClients = new Map<string, { client: MongoClient; lastUsed: number }>();
const MAX_MONGO_CLIENTS = 20;
const sqlitePromise = initSqlJs({
  locateFile: filename => require.resolve(`sql.js/dist/${filename}`)
});

function timeoutMs(engine?: NonNullable<TargetConfig['engine']>) {
  if (engine === 'mysql') {
    const mysqlValue = Number(
      process.env.MYSQL_CONNECT_TIMEOUT_MS ?? process.env.DB_CONNECT_TIMEOUT_MS ?? 15_000
    );
    return Number.isFinite(mysqlValue) && mysqlValue > 0 ? mysqlValue : 15_000;
  }
  const value = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

export async function validateConnectionTarget(config: TargetConfig) {
  if (config.engine === 'sqlite') {
    await sqliteDatabaseFile(config);
    return;
  }
  await assertNetworkHost(config);
}

function cleanError(error: unknown): string {
  return safeConnectionError(error);
}

function normalizedLimit(options: QueryOptions) {
  return Math.max(1, Math.min(Number(options.maxRows) || 100, 1000));
}

function normalizedTimeout(options: QueryOptions) {
  return Math.max(1, Math.min(Number(options.timeoutMs) || 5000, 60_000));
}

function makeColumn(
  name: string,
  dataType: string,
  nullable = true,
  isPrimaryKey = false,
  isForeignKey = false,
  defaultValue: string | null = null
): ColumnMeta {
  return {
    name,
    dataType,
    nullable,
    defaultValue,
    isPrimaryKey,
    isForeignKey,
    comment: null
  };
}

function makeTable(schema: string, name: string, type: 'table' | 'view' = 'table'): TableMeta {
  return { schema, name, type, comment: null, rowEstimate: null, columns: [] };
}

function snapshot(tables: TableMeta[], relationships: SchemaSnapshot['relationships'] = []): SchemaSnapshot {
  return { tables, relationships, introspectedAt: new Date().toISOString() };
}

function sqlDialect(engine: NonNullable<TargetConfig['engine']>) {
  if (engine === 'mysql') return 'MySQL';
  if (engine === 'sqlserver') return 'TransactSQL';
  return 'SQLite';
}

function validateDialectSql(
  raw: string,
  engine: 'mysql' | 'sqlserver' | 'sqlite',
  allowed: TableRef[],
  references?: TableRef[]
): string {
  const query = raw.trim().replace(/;+\s*$/, '');
  if (!query) throw new Error('The model returned an empty query.');

  const parser = new (require('node-sql-parser').Parser)();
  let parsed: any;
  try {
    parsed = parser.astify(query, { database: sqlDialect(engine) });
  } catch {
    throw new Error('The model returned SQL that could not be parsed.');
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) throw new Error('Only one SQL statement is allowed.');

  const cteNames = new Set<string>();
  const tables: Array<{ schema: string; table: string }> = [];
  const forbiddenTables = new Set(['openrowset', 'opendatasource', 'openquery', 'xp_cmdshell']);
  const forbidden = /^(insert|update|delete|replace|create|alter|drop|truncate|attach|detach|pragma|vacuum|call|execute|exec)$/i;
  const forbiddenFunctions = new Set([
    'sleep', 'benchmark', 'load_file', 'load_extension', 'readfile', 'writefile',
    'get_lock', 'release_lock', 'openrowset', 'opendatasource', 'xp_cmdshell', 'sp_execute'
  ]);
  const visited = new Set<object>();
  let invalid = false;

  function walk(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    const node = value as Record<string, any>;
    if (typeof node.type === 'string' && forbidden.test(node.type)) invalid = true;
    if (node.type === 'function') {
      const functionParts = node.name?.name;
      const name = Array.isArray(functionParts)
        ? functionParts.map((part: { value?: string }) => part.value ?? '').join('.').toLowerCase()
        : String(functionParts ?? node.name ?? '').toLowerCase();
      if (forbiddenFunctions.has(name)) invalid = true;
    }
    if (node.type === 'select') {
      const into = node.into;
      if (into && into.type) invalid = true;
      if (node.locking_read || node.for_update || node.for) invalid = true;
      if (Array.isArray(node.with)) {
        for (const cte of node.with) {
          const cteName = String(cte.name?.value ?? cte.name ?? '').toLowerCase();
          if (cteName) cteNames.add(cteName);
          if (engine === 'sqlite' && cte.recursive) invalid = true;
          if (cte.stmt?.ast) walk(cte.stmt.ast);
          else if (cte.stmt) walk(cte.stmt);
        }
      }
      if (Array.isArray(node.from)) {
        for (const source of node.from) {
          if (typeof source.table !== 'string') {
            if (engine === 'sqlserver') invalid = true;
            continue;
          }
          const table = source.table.toLowerCase();
          if (forbiddenTables.has(table)) invalid = true;
          if (cteNames.has(table)) continue;
          if (engine === 'sqlserver' && (source.server || (source.schema && source.db))) {
            invalid = true;
          }
          const schema = String(
            source.schema ?? source.db ?? (engine === 'sqlite' ? 'main' : '')
          ).toLowerCase();
          if (engine === 'sqlserver' && !schema) invalid = true;
          tables.push({ schema, table });
        }
      }
      if (node._next) walk(node._next);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parentheses') continue;
      walk(child);
    }
  }

  walk(statements[0]);
  if (statements[0]?.type !== 'select' || invalid) {
    throw new Error('Only read-only SELECT statements are allowed.');
  }
  for (const table of tables) {
    const match = allowed.find(ref =>
      table.schema
        ? `${ref.schema}.${ref.table}`.toLowerCase() === `${table.schema}.${table.table}`
        : ref.table.toLowerCase() === table.table
    );
    if (!match) {
      throw new Error(`Table ${table.schema ? `${table.schema}.` : ''}${table.table} is outside this session's scope.`);
    }
    references?.push(match);
  }
  return query;
}

function normalizeRows(
  columns: Array<{ name: string; dataType: string | number }>,
  sourceRows: Array<Record<string, unknown>>,
  maxRows: number,
  executionMs: number
): QueryResult {
  const rows: unknown[][] = [];
  let bytes = 0;
  let truncated = sourceRows.length > maxRows;
  for (const source of sourceRows.slice(0, maxRows)) {
    const row = columns.map(column => safeMongoValue(source[column.name] ?? null));
    const serialized = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(serialized);
    if (bytes + rowBytes > 5 * 1024 * 1024) {
      truncated = true;
      break;
    }
    rows.push(row);
    bytes += rowBytes;
  }
  return {
    columns: columns.map(column => ({ name: column.name, dataType: column.dataType })),
    rows,
    rowCount: rows.length,
    truncated,
    executionMs
  };
}

async function assertNetworkHost(config: TargetConfig) {
  if (config.engine === 'mongodb') {
    if (!config.connectionUri) throw new TargetConfigurationError('A MongoDB connection URI is required.');
    const parsed = parseMongoUri(config.connectionUri);
    for (const host of parsed.hosts) await assertHostAllowed(host.hostname);
    if (parsed.srv) {
      let records;
      try {
        records = await resolveSrv(`_mongodb._tcp.${parsed.hosts[0].hostname}`);
      } catch {
        throw new HostGuardError('The MongoDB SRV host could not be resolved.', 'HOST_UNRESOLVED');
      }
      if (records.length === 0) {
        throw new HostGuardError('The MongoDB SRV host could not be resolved.', 'HOST_UNRESOLVED');
      }
      for (const record of records) await assertHostAllowed(record.name);
    }
    return;
  }
  await assertHostAllowed(config.host);
}

async function mysqlConnection(config: TargetConfig) {
  await assertNetworkHost(config);
  const options = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectTimeout: timeoutMs('mysql'),
    multipleStatements: false,
    ssl: config.sslMode === 'disable' ? undefined : { rejectUnauthorized: ['verify-ca', 'verify-full'].includes(config.sslMode) }
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await mysql.createConnection(options);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const transient = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT', 'ECONNRESET'].includes(
        code ?? ''
      );
      if (attempt > 0 || !transient) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function queryMysqlRows<T extends object>(
  connection: mysql.Connection,
  query: string
): Promise<T[]> {
  const [rows] = await connection.query(query);
  return rows as T[];
}

function mysqlCountStageError(stage: string, error: unknown): Error {
  const details = error as {
    code?: string;
    sqlMessage?: string;
    message?: string;
  };
  return Object.assign(
    new Error(`${stage}: ${details.sqlMessage ?? details.message ?? 'database query failed'}`),
    {
      code: details.code,
      sqlMessage: details.sqlMessage,
      stage
    }
  );
}

export function isTiDBReadOnlyNoopError(error: unknown): boolean {
  const details = error as { code?: string; sqlMessage?: string; message?: string } | null;
  const message = details?.sqlMessage ?? details?.message ?? '';
  return (
    details?.code === 'ER_NOT_SUPPORTED_YET' &&
    /function\s+read only has only noop implementation/i.test(message)
  );
}

function queryTimeoutMs() {
  const value = Number(process.env.SQL_TIMEOUT_MS || 5000);
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

function sqlServerConfig(config: TargetConfig, requestTimeout = queryTimeoutMs()): sqlServer.config {
  return {
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: timeoutMs(),
    requestTimeout,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: config.sslMode !== 'disable',
      trustServerCertificate: !['verify-ca', 'verify-full'].includes(config.sslMode)
    }
  };
}

async function sqliteDatabaseFile(config: TargetConfig): Promise<string> {
  const allowedDir = process.env.SQLITE_ALLOWED_DIR;
  if (!allowedDir) {
    throw new TargetConfigurationError('SQLite support requires the API administrator to set SQLITE_ALLOWED_DIR.');
  }
  if (!config.sqlitePath || !path.isAbsolute(config.sqlitePath)) {
    throw new TargetConfigurationError('A valid absolute SQLite database path is required.');
  }
  let root: string;
  try {
    root = await realpath(allowedDir);
  } catch {
    throw new TargetConfigurationError('The configured SQLITE_ALLOWED_DIR must exist and be accessible.');
  }
  let file: string;
  try {
    file = await realpath(config.sqlitePath);
  } catch {
    throw new TargetConfigurationError('The SQLite database file could not be accessed.');
  }
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TargetConfigurationError('The SQLite database path must be inside SQLITE_ALLOWED_DIR.');
  }
  const info = await stat(file);
  if (!info.isFile()) throw new TargetConfigurationError('The SQLite database path must be a regular file.');
  const maxSizeMb = Number(process.env.SQLITE_MAX_FILE_SIZE_MB || 256);
  if (!Number.isFinite(maxSizeMb) || maxSizeMb <= 0) {
    throw new TargetConfigurationError('SQLITE_MAX_FILE_SIZE_MB must be a positive number.');
  }
  const maxBytes = maxSizeMb * 1024 * 1024;
  if (info.size > maxBytes) throw new TargetConfigurationError('The SQLite database exceeds the configured file-size limit.');
  return file;
}

async function sqliteDatabaseBytes(config: TargetConfig): Promise<Uint8Array> {
  const file = await sqliteDatabaseFile(config);
  return readFile(file);
}

async function openSqlite(config: TargetConfig): Promise<SqliteDatabase> {
  const bytes = await sqliteDatabaseBytes(config);
  const SQL = await sqlitePromise;
  const db = new SQL.Database(bytes);
  db.run('PRAGMA query_only = ON');
  return db;
}

async function runSqliteQueryInWorker(
  config: TargetConfig,
  query: string,
  timeout: number
): Promise<{ columns: Array<{ name: string; dataType: string }>; rows: unknown[][]; truncated: boolean }> {
  const bytes = await sqliteDatabaseBytes(config);
  const source = __filename.endsWith('.ts');
  const workerPath = path.join(__dirname, source ? 'sqliteQueryWorker.ts' : 'sqliteQueryWorker.js');
  const worker = new Worker(workerPath, {
    workerData: { bytes, query, maxResultBytes: 5 * 1024 * 1024 },
    execArgv: source ? ['--import', 'tsx'] : undefined,
    resourceLimits: { maxOldGenerationSizeMb: Number(process.env.SQLITE_WORKER_MEMORY_MB || 512) }
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new TargetDbTimeoutError());
    }, timeout);
    worker.once('message', (message: {
      error?: string;
      columns?: Array<{ name: string; dataType: string }>;
      rows?: unknown[][];
      truncated?: boolean;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve({
          columns: message.columns ?? [],
          rows: message.rows ?? [],
          truncated: message.truncated ?? false
        });
      }
    });
    worker.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`SQLite query worker exited with code ${code}.`));
    });
  });
}

function sqliteRows(db: SqliteDatabase, query: string) {
  const statement = db.prepare(query);
  try {
    const columns = statement.getColumnNames().map(name => ({ name, dataType: 'SQLite' }));
    const rows: Array<Record<string, unknown>> = [];
    while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>);
    return { columns, rows };
  } finally {
    statement.free();
  }
}

function safeMongoValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { __type: 'buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(safeMongoValue);
  if (typeof value === 'object') {
    const candidate = value as { toHexString?: () => string; _bsontype?: string };
    if (typeof candidate.toHexString === 'function') return candidate.toHexString();
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = safeMongoValue(item);
    return result;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function validateMongoQuery(raw: string, allowed: TableRef[]): MongoQuery {
  if (raw.length > 64_000) throw new Error('The MongoDB query is too large.');
  let query: unknown;
  try {
    query = JSON.parse(raw);
  } catch {
    throw new Error('The model returned an invalid MongoDB aggregation query.');
  }
  const allowedTables = new Set(allowed.map(ref => ref.table));
  if (
    query &&
    typeof query === 'object' &&
    'operation' in query &&
    query.operation === 'countDocuments'
  ) {
    const operation = query as { operation: string; collections: unknown };
    if (
      !Array.isArray(operation.collections) ||
      operation.collections.length === 0 ||
      operation.collections.some(collection => {
        if (!collection || typeof collection !== 'object') return true;
        const item = collection as Record<string, unknown>;
        return (
          typeof item.schema !== 'string' ||
          typeof item.table !== 'string' ||
          (item.relationshipCount !== undefined &&
            (!Number.isSafeInteger(item.relationshipCount) ||
              Number(item.relationshipCount) < 0)) ||
          Object.keys(item).some(
            key => key !== 'schema' && key !== 'table' && key !== 'relationshipCount'
          )
        );
      }) ||
      Object.keys(query).some(key => key !== 'operation' && key !== 'collections')
    ) {
      throw new Error('A MongoDB count operation must list one or more selected collections.');
    }
    const collections = operation.collections as Array<{
      schema: string;
      table: string;
      relationshipCount?: number;
    }>;
    if (new Set(collections.map(collection => `${collection.schema}.${collection.table}`)).size !== collections.length) {
      throw new Error('A MongoDB count operation cannot repeat a collection.');
    }
    for (const collection of collections) {
      if (!allowed.some(ref => ref.schema === collection.schema && ref.table === collection.table)) {
        throw new Error(`Collection ${collection.table} is outside this session's scope.`);
      }
    }
    return { operation: 'countDocuments', collections };
  }
  const aggregation = query as MongoQuery;
  if (
    !aggregation ||
    !('collection' in aggregation) ||
    typeof aggregation.collection !== 'string' ||
    !Array.isArray(aggregation.pipeline) ||
    aggregation.pipeline.length > 20 ||
    Object.keys(aggregation).some(key => key !== 'collection' && key !== 'pipeline')
  ) {
    throw new Error('The MongoDB query must name one collection and contain at most 20 stages.');
  }
  const selected = allowed.some(ref => ref.table === aggregation.collection);
  if (!selected) {
    throw new Error(`Collection ${aggregation.collection} is outside this session's scope.`);
  }

  const stages = new Set([
    '$match', '$project', '$sort', '$limit', '$skip', '$group', '$unwind',
    '$count', '$addFields', '$set', '$unset', '$replaceRoot', '$replaceWith',
    '$bucket', '$bucketAuto', '$sample'
  ]);
  const forbiddenKeys = new Set([
    '$where', '$function', '$accumulator', '$out', '$merge', '$lookup',
    '$unionWith', '$graphLookup', '$documents', '$search', '$vectorSearch',
    '$collStats', '$indexStats', '$currentOp', '$listSessions', '$planCacheStats'
  ]);
  const checkValue = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(checkValue);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) throw new Error(`MongoDB operator ${key} is not allowed.`);
        checkValue(child);
      }
    }
  };
  for (const stage of aggregation.pipeline) {
    if (!stage || typeof stage !== 'object' || Object.keys(stage).length !== 1) {
      throw new Error('Each MongoDB pipeline stage must contain exactly one operator.');
    }
    const [stageName] = Object.keys(stage);
    if (!stages.has(stageName)) throw new Error(`MongoDB stage ${stageName} is not allowed.`);
    checkValue(stage);
  }
  return aggregation as { collection: string; pipeline: Document[] };
}

function validateMysqlTableCountOperation(
  raw: string,
  allowed: TableRef[]
): MysqlTableCountOperation | null {
  let query: unknown;
  try {
    query = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!query || typeof query !== 'object' || !('operation' in query)) return null;
  if (query.operation !== 'tableRecordCounts') {
    throw new Error('Unsupported MySQL operation.');
  }
  const operation = query as { operation: string; tables: unknown };
  if (
    !Array.isArray(operation.tables) ||
    operation.tables.length === 0 ||
    Object.keys(query).some(key => key !== 'operation' && key !== 'tables')
  ) {
    throw new Error('A MySQL table count operation must list selected tables.');
  }
  const tables = operation.tables as unknown[];
  const seen = new Set<string>();
  const selected: MysqlTableCountOperation['tables'] = [];
  for (const value of tables) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('A MySQL table count operation contains an invalid table.');
    }
    const table = value as Record<string, unknown>;
    if (
      typeof table.schema !== 'string' ||
      typeof table.table !== 'string' ||
      !Number.isSafeInteger(table.relationshipCount) ||
      Number(table.relationshipCount) < 0 ||
      Object.keys(table).some(
        key => !['schema', 'table', 'relationshipCount'].includes(key)
      )
    ) {
      throw new Error('A MySQL table count operation contains invalid table metadata.');
    }
    const key = `${table.schema}.${table.table}`.toLowerCase();
    if (seen.has(key)) throw new Error('A MySQL table count operation cannot repeat a table.');
    seen.add(key);
    if (!allowed.some(ref => `${ref.schema}.${ref.table}`.toLowerCase() === key)) {
      throw new Error(`Table ${key} is outside this session's scope.`);
    }
    selected.push({
      schema: table.schema,
      table: table.table,
      relationshipCount: Number(table.relationshipCount)
    });
  }
  return { operation: 'tableRecordCounts', tables: selected };
}

export function validateDatabaseQuery(
  query: string,
  engine: NonNullable<TargetConfig['engine']>,
  allowed: TableRef[]
): string {
  try {
    if (engine === 'postgres') return validateSql(query, allowed);
    if (engine === 'mongodb') return JSON.stringify(validateMongoQuery(query, allowed));
    if (engine === 'mysql') {
      const countOperation = validateMysqlTableCountOperation(query, allowed);
      return countOperation ? JSON.stringify(countOperation) : validateDialectSql(query, engine, allowed);
    }
    if (engine === 'sqlserver' || engine === 'sqlite') {
      return validateDialectSql(query, engine, allowed);
    }
    throw new Error('Unsupported database type.');
  } catch (error) {
    if (error instanceof SqlValidationError) throw error;
    throw new SqlValidationError(
      error instanceof Error ? error.message : 'The model returned an invalid query.',
      query
    );
  }
}

export function referencedDatabaseTables(
  query: string,
  engine: NonNullable<TargetConfig['engine']>,
  allowed: TableRef[]
): TableRef[] {
  let references: TableRef[];
  if (engine === 'postgres') {
    references = referencedTables(query);
  } else if (engine === 'mongodb') {
    const mongoQuery = validateMongoQuery(query, allowed);
    const collections = 'operation' in mongoQuery
      ? new Set(mongoQuery.collections.map(collection => `${collection.schema}.${collection.table}`))
      : new Set([mongoQuery.collection]);
    references = allowed.filter(ref =>
      'operation' in mongoQuery
        ? collections.has(`${ref.schema}.${ref.table}`)
        : collections.has(ref.table)
    );
  } else if (engine === 'mysql') {
    const countOperation = validateMysqlTableCountOperation(query, allowed);
    if (countOperation) {
      references = countOperation.tables.map(table => ({
        schema: table.schema,
        table: table.table
      }));
    } else {
      references = [];
      validateDialectSql(query, engine, allowed, references);
    }
  } else {
    references = [];
    validateDialectSql(query, engine, allowed, references);
  }
  const seen = new Set<string>();
  return references.filter(ref => {
    const key = `${ref.schema}.${ref.table}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function targetPool(ref: ConnectionRef, config: TargetConfig): Pool {
  return getPool(ref, config);
}

export async function testDatabaseConnection(config: TargetConfig, connectionId: string) {
  try {
    if (config.engine === 'postgres' || !config.engine) {
      return await testPostgresConnection(config);
    }
    if (config.engine === 'mysql') {
      const connection = await mysqlConnection(config);
      try {
        const rows = await queryMysqlRows<{ version: string }>(connection, 'SELECT VERSION() AS version');
        return {
          ok: true as const,
          serverVersion: rows[0]?.version ?? 'MySQL-compatible',
          sessionReadOnly: false,
          roleIsSuperuser: false,
          warning: 'Use a database account with read-only privileges for safety.'
        };
      } finally {
        await connection.end();
      }
    }
    if (config.engine === 'sqlserver') {
      await assertNetworkHost(config);
      const connection = await new sqlServer.ConnectionPool(sqlServerConfig(config)).connect();
      try {
        const result = await connection.request().query<{ version: string }>('SELECT @@VERSION AS version');
        return {
          ok: true as const,
          serverVersion: result.recordset[0]?.version ?? 'SQL Server',
          sessionReadOnly: false,
          roleIsSuperuser: false,
          warning: 'Use a database account with read-only privileges for safety.'
        };
      } finally {
        await connection.close();
      }
    }
    if (config.engine === 'sqlite') {
      const db = await openSqlite(config);
      try {
        const result = sqliteRows(db, 'SELECT sqlite_version() AS version');
        return {
          ok: true as const,
          serverVersion: String(result.rows[0]?.version ?? 'SQLite'),
          sessionReadOnly: true,
          roleIsSuperuser: false,
          warning: 'Queries run against an in-memory copy of this database file.'
        };
      } finally {
        db.close();
      }
    }

    await assertNetworkHost(config);
    const client = await getMongoClient(config, connectionId);
    await client.db(config.database).command({ ping: 1 });
    return {
      ok: true as const,
      serverVersion: 'MongoDB',
      sessionReadOnly: false,
      roleIsSuperuser: false,
      warning: 'Use a MongoDB user with read-only privileges for safety.'
    };
  } catch (error) {
    return { ok: false as const, error: cleanError(error) };
  }
}

async function getMongoClient(config: TargetConfig, connectionId: string): Promise<MongoClient> {
  if (!config.connectionUri) {
    throw new TargetConfigurationError('A MongoDB connection URI is required.');
  }
  const cached = mongoClients.get(connectionId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }
  const client = new MongoClient(config.connectionUri, {
    connectTimeoutMS: timeoutMs('mongodb'),
    serverSelectionTimeoutMS: timeoutMs('mongodb'),
    maxPoolSize: 2
  });
  mongoClients.set(connectionId, { client, lastUsed: Date.now() });
  if (mongoClients.size > MAX_MONGO_CLIENTS) {
    const oldest = [...mongoClients.entries()]
      .filter(([id]) => id !== connectionId)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    if (oldest) {
      mongoClients.delete(oldest[0]);
      await oldest[1].client.close();
    }
  }
  return client;
}

export async function getDatabaseSchema(
  connectionId: string,
  config: TargetConfig,
  refresh = false
): Promise<SchemaSnapshot> {
  const cached = schemaCache.get(connectionId);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.snapshot;

  let result: SchemaSnapshot;
  if (config.engine === 'mysql') result = await mysqlSchema(config);
  else if (config.engine === 'sqlserver') result = await sqlServerSchema(config);
  else if (config.engine === 'sqlite') result = await sqliteSchema(config);
  else if (config.engine === 'mongodb') result = await mongoSchema(config, connectionId);
  else result = await getSchemaSnapshot(targetPool({ id: connectionId, updated_at: new Date() }, config), connectionId, config, refresh);

  const ttl = Number(process.env.SQL_SCHEMA_CACHE_MS || 300_000);
  schemaCache.set(connectionId, { snapshot: result, expiresAt: Date.now() + ttl });
  return result;
}

async function mysqlSchema(config: TargetConfig): Promise<SchemaSnapshot> {
  const connection = await mysqlConnection(config);
  try {
    const tableRows = await queryMysqlRows<{ name: string; type: string }>(
      connection,
      `SELECT table_name AS name, table_type AS type
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_name`
    );
    const tables = tableRows.map(row => makeTable(config.database, row.name, row.type === 'VIEW' ? 'view' : 'table'));
    const byName = new Map(tables.map(table => [table.name, table]));
    const columnRows = await queryMysqlRows<{
      table_name: string; column_name: string; column_type: string; is_nullable: string;
      column_default: string | null; column_key: string;
    }>(
      connection,
      `SELECT table_name, column_name, column_type, is_nullable, column_default, column_key
       FROM information_schema.columns WHERE table_schema = DATABASE()
       ORDER BY table_name, ordinal_position`
    );
    for (const column of columnRows) {
      byName.get(column.table_name)?.columns.push(
        makeColumn(column.column_name, column.column_type, column.is_nullable === 'YES', column.column_key === 'PRI', false, column.column_default)
      );
    }
    const foreignRows = await queryMysqlRows<{
      constraint_name: string; table_name: string; column_name: string;
      referenced_table_name: string; referenced_column_name: string;
    }>(
      connection,
      `SELECT constraint_name, table_name, column_name, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL
       ORDER BY constraint_name, ordinal_position`
    );
    const groups = new Map<string, typeof foreignRows>();
    for (const row of foreignRows) {
      const key = `${row.table_name}.${row.constraint_name}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
      const column = byName.get(row.table_name)?.columns.find(item => item.name === row.column_name);
      if (column) column.isForeignKey = true;
    }
    const relationships: SchemaSnapshot['relationships'] = [...groups].map(([name, rows]) => ({
      name,
      from: { schema: config.database, table: rows[0].table_name, columns: rows.map(row => row.column_name) },
      to: { schema: config.database, table: rows[0].referenced_table_name, columns: rows.map(row => row.referenced_column_name) },
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION'
    }));
    return snapshot(tables, relationships);
  } finally {
    await connection.end();
  }
}

async function sqlServerSchema(config: TargetConfig): Promise<SchemaSnapshot> {
  await assertNetworkHost(config);
  const connection = await new sqlServer.ConnectionPool(sqlServerConfig(config)).connect();
  try {
    const [tableResult, columnResult, foreignResult] = await Promise.all([
      connection.request().query<{ schema_name: string; table_name: string; type: string }>(
        `SELECT s.name AS schema_name, o.name AS table_name,
                CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS type
         FROM sys.objects o JOIN sys.schemas s ON o.schema_id = s.schema_id
         WHERE o.type IN ('U', 'V') ORDER BY s.name, o.name`
      ),
      connection.request().query<{
        schema_name: string; table_name: string; column_name: string; data_type: string;
        is_nullable: boolean; is_primary_key: boolean; is_foreign_key: boolean; default_value: string | null;
      }>(
        `SELECT s.name AS schema_name, o.name AS table_name, c.name AS column_name,
                t.name AS data_type, c.is_nullable,
                CONVERT(bit, CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END) AS is_primary_key,
                CONVERT(bit, CASE WHEN fk.parent_column_id IS NULL THEN 0 ELSE 1 END) AS is_foreign_key,
                OBJECT_DEFINITION(c.default_object_id) AS default_value
         FROM sys.columns c JOIN sys.objects o ON c.object_id = o.object_id
         JOIN sys.schemas s ON o.schema_id = s.schema_id
         JOIN sys.types t ON c.user_type_id = t.user_type_id
         LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.indexes i
                    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    WHERE i.is_primary_key = 1) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
         LEFT JOIN sys.foreign_key_columns fk ON fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id
         WHERE o.type IN ('U', 'V') ORDER BY s.name, o.name, c.column_id`
      ),
      connection.request().query<{
        name: string; from_schema: string; from_table: string; from_column: string;
        to_schema: string; to_table: string; to_column: string; delete_action: string; update_action: string;
      }>(
        `SELECT fk.name, ss.name AS from_schema, st.name AS from_table, sc.name AS from_column,
                ds.name AS to_schema, dt.name AS to_table, dc.name AS to_column,
                fk.delete_referential_action_desc AS delete_action,
                fk.update_referential_action_desc AS update_action
         FROM sys.foreign_key_columns fkc
         JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
         JOIN sys.tables st ON st.object_id = fkc.parent_object_id
         JOIN sys.schemas ss ON ss.schema_id = st.schema_id
         JOIN sys.columns sc ON sc.object_id = st.object_id AND sc.column_id = fkc.parent_column_id
         JOIN sys.tables dt ON dt.object_id = fkc.referenced_object_id
         JOIN sys.schemas ds ON ds.schema_id = dt.schema_id
         JOIN sys.columns dc ON dc.object_id = dt.object_id AND dc.column_id = fkc.referenced_column_id
         ORDER BY fk.name, fkc.constraint_column_id`
      )
    ]);
    const tables = tableResult.recordset.map(row => makeTable(row.schema_name, row.table_name, row.type === 'view' ? 'view' : 'table'));
    const byKey = new Map(tables.map(table => [`${table.schema}.${table.name}`, table]));
    for (const column of columnResult.recordset) {
      byKey.get(`${column.schema_name}.${column.table_name}`)?.columns.push(
        makeColumn(column.column_name, column.data_type, column.is_nullable, column.is_primary_key, column.is_foreign_key, column.default_value)
      );
    }
    const grouped = new Map<string, Array<(typeof foreignResult.recordset)[number]>>();
    for (const row of foreignResult.recordset) grouped.set(row.name, [...(grouped.get(row.name) ?? []), row]);
    const relationships = [...grouped].map(([name, rows]) => ({
      name,
      from: { schema: rows[0].from_schema, table: rows[0].from_table, columns: rows.map(row => row.from_column) },
      to: { schema: rows[0].to_schema, table: rows[0].to_table, columns: rows.map(row => row.to_column) },
      onDelete: rows[0].delete_action,
      onUpdate: rows[0].update_action
    }));
    return snapshot(tables, relationships);
  } finally {
    await connection.close();
  }
}

async function sqliteSchema(config: TargetConfig): Promise<SchemaSnapshot> {
  const db = await openSqlite(config);
  try {
    const entries = sqliteRows(
      db,
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).rows as Array<{ name: string; type: string }>;
    const tables = entries.map(entry => makeTable('main', entry.name, entry.type === 'view' ? 'view' : 'table'));
    const relations: SchemaSnapshot['relationships'] = [];
    for (const table of tables) {
      const escaped = table.name.replace(/"/g, '""');
      const columnRows = sqliteRows(db, `PRAGMA table_info("${escaped}")`).rows as Array<{
        name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
      }>;
      const foreignRows = sqliteRows(db, `PRAGMA foreign_key_list("${escaped}")`).rows as Array<{
        id: number; table: string; from: string; to: string; on_delete: string; on_update: string;
      }>;
      table.columns = columnRows.map(column => makeColumn(
        column.name,
        column.type || 'unknown',
        !column.notnull,
        column.pk > 0,
        foreignRows.some(foreign => foreign.from === column.name),
        column.dflt_value === null ? null : String(column.dflt_value)
      ));
      const grouped = new Map<number, typeof foreignRows>();
      for (const row of foreignRows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
      for (const [id, rows] of grouped) relations.push({
        name: `fk_${table.name}_${id}`,
        from: { schema: 'main', table: table.name, columns: rows.map(row => row.from) },
        to: { schema: 'main', table: rows[0].table, columns: rows.map(row => row.to) },
        onDelete: rows[0].on_delete,
        onUpdate: rows[0].on_update
      });
    }
    return snapshot(tables, relations);
  } finally {
    db.close();
  }
}

async function mongoSchema(config: TargetConfig, connectionId: string): Promise<SchemaSnapshot> {
  await assertNetworkHost(config);
  const client = await getMongoClient(config, connectionId);
  const database = client.db(config.database);
  const collections = (await database.listCollections({}, { nameOnly: true }).toArray())
    .filter(collection => !collection.name.startsWith('system.'));
  const tables: TableMeta[] = [];
  for (let index = 0; index < collections.length; index += 5) {
    const batch = await Promise.all(collections.slice(index, index + 5).map(async collection => {
      const table = makeTable(config.database, collection.name);
      const samples = await database.collection(collection.name)
        .aggregate([
          { $sample: { size: 20 } },
          {
            $project: {
              _id: 0,
              fields: {
                $slice: [
                  {
                    $map: {
                      input: { $objectToArray: '$$ROOT' },
                      as: 'field',
                      in: { name: '$$field.k', type: { $type: '$$field.v' } }
                    }
                  },
                  500
                ]
              }
            }
          }
        ], { maxTimeMS: 5000, allowDiskUse: false }).toArray();
      const fieldTypes = new Map<string, string>();
      for (const document of samples) {
        for (const field of document.fields ?? []) {
          if (!fieldTypes.has(field.name)) fieldTypes.set(field.name, field.type);
        }
      }
      table.columns = [...fieldTypes].map(([name, type]) => makeColumn(name, type));
      if (fieldTypes.has('_id')) table.columns.find(column => column.name === '_id')!.isPrimaryKey = true;
      return table;
    }));
    tables.push(...batch);
  }
  return snapshot(tables);
}

export async function runDatabaseQuery(
  ref: ConnectionRef,
  config: TargetConfig,
  rawQuery: string,
  allowed: TableRef[],
  options: QueryOptions
): Promise<QueryResult> {
  const maxRows = normalizedLimit(options);
  const timeout = normalizedTimeout(options);
  const started = Date.now();

  if (config.engine === 'postgres' || !config.engine) {
    return runReadOnlyQuery(targetPool(ref, config), validateSql(rawQuery, allowed), { maxRows, timeoutMs: timeout });
  }
  if (config.engine === 'mongodb') {
    const query = validateMongoQuery(rawQuery, allowed);
    await assertNetworkHost(config);
    const client = await getMongoClient(config, ref.id);
    try {
      if ('operation' in query) {
        const rows: Array<Record<string, unknown>> = [];
        for (const table of query.collections) {
          const remainingMs = timeout - (Date.now() - started);
          if (remainingMs <= 0) throw new TargetDbTimeoutError();
          const recordCount = await client
            .db(config.database)
            .collection(table.table)
            .countDocuments({}, { maxTimeMS: remainingMs });
          rows.push({
            table_name: table.table,
            record_count: recordCount,
            ...(table.relationshipCount === undefined
              ? {}
              : { relationship_count: table.relationshipCount })
          });
        }
        rows.sort((a, b) => {
          const countDiff = Number(b.record_count) - Number(a.record_count);
          return countDiff || String(a.table_name).localeCompare(String(b.table_name));
        });
        return normalizeRows(
          [
            { name: 'table_name', dataType: 'string' },
            { name: 'record_count', dataType: 'number' },
            ...(query.collections.some(table => table.relationshipCount !== undefined)
              ? [{ name: 'relationship_count', dataType: 'number' }]
              : [])
          ],
          rows,
          maxRows,
          Date.now() - started
        );
      }

      const collection = client.db(config.database).collection(query.collection);
      const cursor = collection.aggregate(
        [...query.pipeline, { $limit: maxRows + 1 }],
        { maxTimeMS: timeout, allowDiskUse: false }
      );
      const documents: Array<Record<string, unknown>> = [];
      const maxResultBytes = 5 * 1024 * 1024;
      let resultBytes = 0;
      let truncated = false;
      try {
        for await (const document of cursor) {
          if (documents.length >= maxRows) {
            truncated = true;
            break;
          }
          const safeDocument = safeMongoValue(document) as Record<string, unknown>;
          const size = Buffer.byteLength(JSON.stringify(safeDocument));
          if (resultBytes + size > maxResultBytes) {
            truncated = true;
            break;
          }
          documents.push(safeDocument);
          resultBytes += size;
        }
      } finally {
        await cursor.close();
      }
      const names = [...new Set(documents.flatMap(document => Object.keys(document)))];
      const columns = names.map(name => ({ name, dataType: 'BSON' }));
      return {
        columns,
        rows: documents.map(document => names.map(name => document[name] ?? null)),
        rowCount: documents.length,
        truncated,
        executionMs: Date.now() - started
      };
    } catch (error: any) {
      if (error?.code === 50 || error?.name === 'MongoOperationTimeoutError') {
        throw new TargetDbTimeoutError();
      }
      throw error;
    }
  }
  if (config.engine === 'sqlite') {
    const query = validateDialectSql(rawQuery, 'sqlite', allowed);
    const result = await runSqliteQueryInWorker(
      config,
      `SELECT * FROM (${query}) AS _session_query LIMIT ${maxRows + 1}`,
      timeout
    );
    const truncated = result.truncated || result.rows.length > maxRows;
    return {
      columns: result.columns,
      rows: result.rows.slice(0, maxRows),
      rowCount: Math.min(result.rows.length, maxRows),
      truncated,
      executionMs: Date.now() - started
    };
  }
  if (config.engine === 'mysql') {
    const tableCountOperation = validateMysqlTableCountOperation(rawQuery, allowed);
    const query = tableCountOperation
      ? null
      : validateDialectSql(rawQuery, 'mysql', allowed);
    const connection = await mysqlConnection(config);
    try {
      try {
        await connection.query('SET TRANSACTION READ ONLY');
      } catch (error) {
        if (!isTiDBReadOnlyNoopError(error)) throw error;
      }
      try {
        await connection.beginTransaction();
      } catch (error) {
        if (tableCountOperation) {
          throw mysqlCountStageError('starting the transaction', error);
        }
        throw error;
      }
      if (tableCountOperation) {
        const rows: Array<Record<string, unknown>> = [];
        for (const table of tableCountOperation.tables) {
          const remainingMs = timeout - (Date.now() - started);
          if (remainingMs <= 0) throw new TargetDbTimeoutError();
          const qualifiedTable =
            `\`${table.schema.replace(/`/g, '``')}\`.` +
            `\`${table.table.replace(/`/g, '``')}\``;
          try {
            const [countRows] = await connection.query({
              sql: `SELECT COUNT(*) AS record_count FROM ${qualifiedTable}`,
              timeout: remainingMs
            });
            rows.push({
              table_name: `${table.schema}.${table.table}`,
              record_count: (countRows as Array<{ record_count: unknown }>)[0]?.record_count ?? 0,
              relationship_count: table.relationshipCount
            });
          } catch (error) {
            const stageError = mysqlCountStageError(
              `counting ${table.schema}.${table.table}`,
              error
            );
            throw stageError;
          }
        }
        rows.sort((a, b) => {
          const countDiff = Number(b.record_count) - Number(a.record_count);
          return countDiff || String(a.table_name).localeCompare(String(b.table_name));
        });
        await connection.rollback();
        return normalizeRows(
          [
            { name: 'table_name', dataType: 'string' },
            { name: 'record_count', dataType: 'number' },
            { name: 'relationship_count', dataType: 'number' }
          ],
          rows,
          maxRows,
          Date.now() - started
        );
      }
      const [rows, fields] = await connection.query({
        sql: `SELECT * FROM (${query!}) AS _session_query LIMIT ${maxRows + 1}`,
        timeout
      });
      await connection.rollback();
      const resultRows = rows as Array<Record<string, unknown>>;
      return normalizeRows(
        (fields ?? []).map(field => ({ name: field.name, dataType: String(field.type) })),
        resultRows,
        maxRows,
        Date.now() - started
      );
    } catch (error: any) {
      await connection.rollback().catch(() => undefined);
      if (error?.code === 'ER_QUERY_TIMEOUT' || error?.code === 'ETIMEDOUT') {
        throw new TargetDbTimeoutError();
      }
      throw error;
    } finally {
      await connection.end();
    }
  }

  const query = validateDialectSql(rawQuery, 'sqlserver', allowed);
  await assertNetworkHost(config);
  const connection = await new sqlServer.ConnectionPool(sqlServerConfig(config, timeout)).connect();
  const transaction = new sqlServer.Transaction(connection);
  try {
    await transaction.begin(sqlServer.ISOLATION_LEVEL.READ_COMMITTED);
    await new sqlServer.Request(transaction).query(`SET ROWCOUNT ${maxRows + 1}`);
    const result = await new sqlServer.Request(transaction).query(query);
    await new sqlServer.Request(transaction).query('SET ROWCOUNT 0');
    await transaction.rollback();
    const fields = Object.entries(result.recordset?.columns ?? {}).map(([name, column]: [string, any]) => ({
      name,
      dataType: String(column.type?.name ?? 'unknown')
    }));
    const rows = result.recordset ?? [];
    return normalizeRows(fields, rows, maxRows, Date.now() - started);
  } catch (error: any) {
    await new sqlServer.Request(transaction).query('SET ROWCOUNT 0').catch(() => undefined);
    await transaction.rollback().catch(() => undefined);
    if (error?.code === 'ETIMEOUT') throw new TargetDbTimeoutError();
    throw error;
  } finally {
    await connection.close();
  }
}

export async function closeDatabaseConnections() {
  await Promise.all([...mongoClients.values()].map(entry => entry.client.close()));
  mongoClients.clear();
  schemaCache.clear();
}

export async function invalidateDatabaseConnection(connectionId: string) {
  schemaCache.delete(connectionId);
  const mongoClient = mongoClients.get(connectionId);
  if (mongoClient) {
    mongoClients.delete(connectionId);
    await mongoClient.client.close();
  }
  await invalidatePools(connectionId);
}

export { safeConnectionError, type SslMode };
