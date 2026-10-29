import { useMemo, useState } from 'react';
import type { TableMeta } from '../types';
import { compactNumber } from '../format';
import { IconChevronDown, IconSearch, IconTable } from './icons';

type Props = {
  tables: TableMeta[];
  selected: string[];
  onChange: (keys: string[]) => void;
  max?: number;
};

function keyOf(table: TableMeta) {
  return `${table.schema}.${table.name}`;
}

export default function TablePicker({ tables, selected, onChange, max }: Props) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter(table => {
      if (`${table.schema}.${table.name}`.toLowerCase().includes(needle)) return true;
      return table.columns.some(
        column =>
          column.name.toLowerCase().includes(needle) ||
          column.dataType.toLowerCase().includes(needle)
      );
    });
  }, [tables, query]);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else {
      if (max !== undefined && next.size >= max) return;
      next.add(key);
    }
    onChange([...next]);
  }

  function toggleExpanded(key: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="table-picker">
      <div className="table-picker-head">
        <div>
          <h3>Tables and collections in scope</h3>
          <p>
            {selected.length} of {tables.length} selected
          </p>
        </div>
        <div className="table-picker-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChange(tables.map(keyOf))}
            disabled={selected.length === tables.length || (max !== undefined && tables.length > max)}
            title={max !== undefined && tables.length > max ? `Select at most ${max} items` : undefined}
          >
            Select all
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChange([])}
            disabled={selected.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      <label className="search-field">
        <IconSearch size={16} />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search tables, collections, or fields"
          aria-label="Search tables, collections, or fields"
        />
      </label>

      <div className="table-list" role="group" aria-label="Select tables and collections">
      {filtered.length === 0 && <p className="muted empty-note">No items match that search.</p>}

        {filtered.map(table => {
          const key = keyOf(table);
          const isSelected = selectedSet.has(key);
          const isExpanded = expanded.has(key);

          return (
            <div className={`table-row${isSelected ? ' selected' : ''}`} key={key}>
              <div className="table-row-main">
                <label className="table-check">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(key)}
                    aria-label={`Include ${key}`}
                  />
                  <span className="table-icon">
                    <IconTable size={16} />
                  </span>
                  <span className="table-name">
                    <strong>{table.name}</strong>
                    <span>
                      {table.schema} · {table.type} · {table.columns.length} columns
                      {table.rowEstimate !== null ? ` · ~${compactNumber(table.rowEstimate)} rows` : ''}
                    </span>
                  </span>
                </label>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`${isExpanded ? 'Hide' : 'Show'} columns for ${key}`}
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpanded(key)}
                >
                  <IconChevronDown
                    size={16}
                    style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                  />
                </button>
              </div>

              {isExpanded && (
                <div className="column-list">
                  {table.columns.map(column => (
                    <div className="column-row" key={column.name}>
                      <span className="column-name">{column.name}</span>
                      <span className="column-type">{column.dataType}</span>
                      <span className="column-flags">
                        {column.isPrimaryKey && <span className="badge badge-key">PK</span>}
                        {column.isForeignKey && <span className="badge badge-link">FK</span>}
                        {!column.nullable && <span className="badge">NOT NULL</span>}
                      </span>
                    </div>
                  ))}
                  {table.comment && <p className="table-comment">{table.comment}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
