import { useState } from 'react';
import type { Evidence, QueryEvidence, Relationship, SchemaEvidence } from '../types';
import { IconCheck, IconCopy, IconLink, IconTable } from './icons';

function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function Cell({ value }: { value: unknown }) {
  if (value === null) return <span className="cell-null">NULL</span>;
  if (typeof value === 'boolean') return <span className="cell-bool">{String(value)}</span>;
  if (typeof value === 'object') {
    return <code className="cell-json">{JSON.stringify(value)}</code>;
  }
  return <>{String(value)}</>;
}

function ResultTable({ evidence }: { evidence: QueryEvidence }) {
  return (
    <div className="result-table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {evidence.columns.map((column, index) => (
              <th key={`${column.name}-${index}`} scope="col">
                <span>{column.name}</span>
                <small>{column.dataType}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {evidence.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, cellIndex) => (
                <td key={cellIndex}>
                  <Cell value={value} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {evidence.rows.length === 0 && (
        <p className="result-empty">The query returned no rows.</p>
      )}
    </div>
  );
}

export function RelationshipList({ relationships }: { relationships: Relationship[] }) {
  if (relationships.length === 0) {
    return (
      <p className="muted empty-note">
        No direct foreign keys between the selected tables. Relationships are not inferred from
        column names.
      </p>
    );
  }

  return (
    <div className="relationship-list">
      {relationships.map(relationship => (
        <div className="relationship-item" key={relationship.name}>
          <div className="relationship-path">
            <span>
              {relationship.from.schema}.{relationship.from.table}.
              {relationship.from.columns.join(', ')}
            </span>
            <span className="relationship-arrow">→</span>
            <span>
              {relationship.to.schema}.{relationship.to.table}.{relationship.to.columns.join(', ')}
            </span>
          </div>
          <div className="relationship-meta">
            <code>{relationship.name}</code>
            <span>
              ON DELETE {relationship.onDelete} · ON UPDATE {relationship.onUpdate}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SqlEvidence({ evidence }: { evidence: QueryEvidence }) {
  const [copied, setCopied] = useState(false);

  async function copySql() {
    let copiedToClipboard = false;
    try {
      await Promise.race([
        navigator.clipboard.writeText(evidence.sql),
        new Promise((_, reject) => window.setTimeout(reject, 400))
      ]);
      copiedToClipboard = true;
    } catch {
      copiedToClipboard = false;
    }

    if (!copiedToClipboard) {
      const area = document.createElement('textarea');
      area.value = evidence.sql;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <details className="evidence" open>
      <summary className="evidence-summary">
        <span className="evidence-title">
          <IconTable size={15} /> Query
        </span>
        <span className="evidence-stats">
          {evidence.rowCount} {evidence.rowCount === 1 ? 'row' : 'rows'} ·{' '}
          {formatMs(evidence.executionMs)}
          {evidence.truncated ? ' · truncated' : ''}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm evidence-copy"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            void copySql();
          }}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? 'Copied' : 'Copy SQL'}
        </button>
      </summary>

      <pre className="sql-block">
        <code>{evidence.sql}</code>
      </pre>

      {evidence.truncated && (
        <p className="evidence-note">
          Showing the first {evidence.rows.length} rows. The query was capped at the configured
          row limit.
        </p>
      )}

      <ResultTable evidence={evidence} />
    </details>
  );
}

function SchemaEvidencePanel({ evidence }: { evidence: SchemaEvidence }) {
  return (
    <details className="evidence" open>
      <summary className="evidence-summary">
        <span className="evidence-title">
          <IconTable size={15} /> Schema
          {evidence.focus ? <span className="badge">{evidence.focus}</span> : null}
        </span>
        <span className="evidence-stats">
          {evidence.tables.length} {evidence.tables.length === 1 ? 'table' : 'tables'} ·{' '}
          {evidence.relationships.length}{' '}
          {evidence.relationships.length === 1 ? 'relationship' : 'relationships'}
        </span>
      </summary>

      <div className="schema-evidence">
        {evidence.tables.map(table => (
          <section className="schema-evidence-table" key={`${table.schema}.${table.table}`}>
            <h4>
              {table.schema}.{table.table}
            </h4>
            <div className="schema-evidence-columns">
              {table.columns.map(column => (
                <div className="schema-evidence-column" key={column.name}>
                  <code>{column.name}</code>
                  <span>{column.dataType}</span>
                  <span className="column-flags">
                    {column.isPrimaryKey && <span className="badge badge-key">PK</span>}
                    {column.isForeignKey && <span className="badge badge-link">FK</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="evidence-relationships">
        <h4>
          <IconLink size={14} /> Relationships
        </h4>
        <RelationshipList relationships={evidence.relationships} />
      </div>
    </details>
  );
}

export default function EvidencePanel({ evidence }: { evidence: Evidence }) {
  if (evidence.kind === 'sql') return <SqlEvidence evidence={evidence} />;
  if (evidence.kind === 'schema') return <SchemaEvidencePanel evidence={evidence} />;
  return (
    <div className="evidence evidence-unknown">
      <p className="muted">This evidence format is not supported by this version of the app.</p>
    </div>
  );
}
