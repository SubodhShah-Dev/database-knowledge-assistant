import type { SchemaSnapshot } from './introspection';

export type TableRef = { schema: string; table: string };

export class ScopeError extends Error {
  constructor(
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function maxSelectedTables(): number {
  return Number(process.env.MAX_SELECTED_TABLES || 100);
}

export function normalizeSelection(selection: unknown): TableRef[] {
  if (!Array.isArray(selection)) throw new ScopeError('tables must be an array.', 400);

  const seen = new Set<string>();
  const tables = selection.map(item => {
    const schema = String((item as any)?.schema || 'public').trim();
    const table = String((item as any)?.table || '').trim();
    if (!schema || !table) throw new ScopeError('Each table needs a schema and name.', 400);

    const key = `${schema}.${table}`;
    if (seen.has(key)) throw new ScopeError(`Duplicate table: ${key}.`, 400);
    seen.add(key);
    return { schema, table };
  });

  const max = maxSelectedTables();
  if (tables.length > max) {
    throw new ScopeError(`You can select at most ${max} tables.`);
  }
  return tables;
}

export function defaultSelection(snapshot: SchemaSnapshot): TableRef[] {
  if (snapshot.tables.length > maxSelectedTables()) {
    throw new ScopeError(
      `This database has more than ${maxSelectedTables()} tables. Select tables explicitly.`
    );
  }
  return snapshot.tables.map(table => ({ schema: table.schema, table: table.name }));
}

export function assertSelectionExists(snapshot: SchemaSnapshot, selection: TableRef[]) {
  if (selection.length === 0) throw new ScopeError('Select at least one table.');

  const available = new Set(snapshot.tables.map(table => `${table.schema}.${table.name}`));
  for (const ref of selection) {
    if (!available.has(`${ref.schema}.${ref.table}`)) {
      throw new ScopeError(
        `Table ${ref.schema}.${ref.table} is no longer available. Refresh the schema and try again.`
      );
    }
  }
}
