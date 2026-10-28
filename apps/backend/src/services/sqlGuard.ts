import { parse } from 'pgsql-ast-parser';
import type { TableRef } from './sessionScope';

export class SqlValidationError extends Error {
  constructor(
    message: string,
    readonly sql: string
  ) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

const SELECT_LIKE = new Set(['select', 'with', 'union', 'union all']);
const MUTATING = new Set([
  'insert',
  'update',
  'delete',
  'create table',
  'create index',
  'create view',
  'alter table',
  'drop table',
  'drop index',
  'truncate table',
  'copy',
  'set',
  'show'
]);

function isSelectLike(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'select') return true;
  if (node.type === 'union' || node.type === 'union all') {
    return isSelectLike(node.left) && isSelectLike(node.right);
  }
  if (node.type === 'with') return isSelectLike(node.in);
  return false;
}

function walk(node: any, visit: (node: any) => void) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== 'object') return;

  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function collectCteAliases(statement: any): Set<string> {
  const aliases = new Set<string>();
  walk(statement, node => {
    if (node.type !== 'with' || !Array.isArray(node.bind)) return;
    for (const bind of node.bind) {
      const name = bind?.alias?.name;
      if (typeof name === 'string') aliases.add(name.toLowerCase());
    }
  });
  return aliases;
}

function collectTableRefs(statement: any, cteAliases: Set<string>): TableRef[] {
  const refs: TableRef[] = [];
  walk(statement, node => {
    if (node.type !== 'table' || !node.name?.name) return;
    const schema = typeof node.name.schema === 'string' ? node.name.schema : undefined;
    const table = String(node.name.name);
    if (!schema && cteAliases.has(table.toLowerCase())) return;
    refs.push({ schema: schema ?? 'public', table });
  });
  return refs;
}

function assertSelectOnly(statement: any, sql: string) {
  walk(statement, node => {
    if (MUTATING.has(node.type)) {
      throw new SqlValidationError('Only SELECT statements are allowed.', sql);
    }
    if (node.type === 'select' && node.for) {
      throw new SqlValidationError('Row locking clauses are not allowed.', sql);
    }
    if (node.type === 'with' && Array.isArray(node.bind)) {
      for (const bind of node.bind) {
        if (!isSelectLike(bind?.statement)) {
          throw new SqlValidationError('Every CTE must be a SELECT statement.', sql);
        }
      }
    }
    if (node.type === 'statement' && !isSelectLike(node.statement)) {
      throw new SqlValidationError('Only SELECT subqueries are allowed.', sql);
    }
  });
}

export function validateSql(sql: string, allowed: TableRef[]): string {
  const cleaned = sql.trim().replace(/;+\s*$/, '');
  if (!cleaned) throw new SqlValidationError('The model returned an empty query.', sql);

  let statements: any[];
  try {
    statements = parse(cleaned) as any[];
  } catch {
    throw new SqlValidationError('The model returned SQL that could not be parsed.', sql);
  }

  if (statements.length !== 1) {
    throw new SqlValidationError('Only one SQL statement is allowed.', sql);
  }

  const statement = statements[0];
  if (!SELECT_LIKE.has(statement.type) || !isSelectLike(statement)) {
    throw new SqlValidationError('Only SELECT statements are allowed.', sql);
  }

  assertSelectOnly(statement, sql);

  const allowedKeys = new Set(allowed.map(ref => `${ref.schema}.${ref.table}`.toLowerCase()));
  for (const ref of collectTableRefs(statement, collectCteAliases(statement))) {
    const key = `${ref.schema}.${ref.table}`.toLowerCase();
    if (!allowedKeys.has(key)) {
      throw new SqlValidationError(`Table ${key} is outside this session's scope.`, sql);
    }
  }

  return cleaned;
}
