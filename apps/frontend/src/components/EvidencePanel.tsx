import { useState, type ReactNode } from 'react';
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
      <div className="drawer-relationships-empty">
        <span className="drawer-relationships-empty-icon">
          <IconLink size={20} />
        </span>
        <strong>No relationships in this session scope</strong>
        <p>
          Foreign-key links appear when both related tables are included. Links are read from the
          database schema, not guessed from column names.
        </p>
      </div>
    );
  }

  return (
    <div className="drawer-relationship-list">
      {relationships.map(relationship => (
        <article className="drawer-relationship-card" key={relationship.name}>
          <div className="drawer-relationship-card-head">
            <span className="drawer-relationship-type">
              <IconLink size={13} /> Foreign key
            </span>
            <code title={relationship.name}>{relationship.name}</code>
          </div>
          <div className="drawer-relationship-flow">
            <div className="drawer-relationship-endpoint">
              <span className="drawer-relationship-direction">From</span>
              <strong>{relationship.from.schema}.{relationship.from.table}</strong>
              <code>{relationship.from.columns.join(', ')}</code>
            </div>
            <span className="drawer-relationship-connector" aria-label="references">
              <IconLink size={16} />
            </span>
            <div className="drawer-relationship-endpoint">
              <span className="drawer-relationship-direction">References</span>
              <strong>{relationship.to.schema}.{relationship.to.table}</strong>
              <code>{relationship.to.columns.join(', ')}</code>
            </div>
          </div>
          <div className="drawer-relationship-rules">
            <span>Delete <strong>{relationship.onDelete}</strong></span>
            <span>Update <strong>{relationship.onUpdate}</strong></span>
          </div>
        </article>
      ))}
    </div>
  );
}

function QueryDetails({
  sql,
  stats,
  copyLabel,
  children
}: {
  sql: string;
  stats: string;
  copyLabel: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copyQuery() {
    let copiedToClipboard = false;
    try {
      await Promise.race([
        navigator.clipboard.writeText(sql),
        new Promise((_, reject) => window.setTimeout(reject, 400))
      ]);
      copiedToClipboard = true;
    } catch {
      copiedToClipboard = false;
    }

    if (!copiedToClipboard) {
      const area = document.createElement('textarea');
      area.value = sql;
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
        <span className="evidence-stats">{stats}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm evidence-copy"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            void copyQuery();
          }}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? 'Copied' : copyLabel}
        </button>
      </summary>
      <pre className="sql-block">
        <code>{sql}</code>
      </pre>
      {children}
    </details>
  );
}

function SqlEvidence({ evidence }: { evidence: QueryEvidence }) {
  const stats = `${evidence.rowCount} ${evidence.rowCount === 1 ? 'row' : 'rows'} · ${formatMs(
    evidence.executionMs
  )}${evidence.truncated ? ' · truncated' : ''}`;

  return (
    <>
      <div className="schema-answer-context query-answer-context">
        <p>
          <strong>Answer context:</strong> Based on {evidence.tables.length || 'the query'}{' '}
          {evidence.tables.length === 1 ? 'table' : evidence.tables.length ? 'tables' : 'results'}{' '}
          and {evidence.rowCount} {evidence.rowCount === 1 ? 'returned row' : 'returned rows'}.
        </p>
        {evidence.tables.length > 0 && (
          <details className="schema-context-details">
            <summary>View details</summary>
            <div className="schema-evidence schema-evidence-body">
              <section className="schema-evidence-section">
                <div className="schema-section-heading">
                  <h4>Tables used</h4>
                  <span>{evidence.tables.length}</span>
                </div>
                <div className="schema-evidence-tables">
                  {evidence.tables.map(table => (
                    <span className="schema-table-name" key={`${table.schema}.${table.table}`}>
                      <IconTable size={13} />
                      <code>{table.schema}.{table.table}</code>
                    </span>
                  ))}
                </div>
              </section>
            </div>
          </details>
        )}
      </div>
      <QueryDetails
        sql={evidence.sql}
        stats={stats}
        copyLabel={evidence.queryFormat === 'mongodb' ? 'Copy query' : 'Copy SQL'}
      >
        {evidence.truncated && (
          <p className="evidence-note">
            Showing the first {evidence.rows.length} rows. The query was capped at the configured
            row limit.
          </p>
        )}

        <ResultTable evidence={evidence} />
      </QueryDetails>
    </>
  );
}

export function FailedQuery({ sql }: { sql: string }) {
  return (
    <div className="failed-query">
      <QueryDetails sql={sql} stats="Execution failed" copyLabel="Copy SQL" />
    </div>
  );
}

function SchemaEvidencePanel({ evidence }: { evidence: SchemaEvidence }) {
  const tableCount = `${evidence.tables.length} ${
    evidence.tables.length === 1 ? 'table' : 'tables'
  }`;
  const relationshipCount =
    evidence.relationships.length === 0
      ? 'no foreign-key relationships'
      : `${evidence.relationships.length} ${
          evidence.relationships.length === 1 ? 'relationship' : 'relationships'
        }`;

  return (
    <div className="schema-evidence-panel">
      <div className="schema-answer-context">
        <p>
          <strong>Answer context:</strong> Based on {tableCount} and {relationshipCount}.
        </p>
        <details className="schema-context-details">
          <summary>View details</summary>
          <div className="schema-evidence schema-evidence-body">
            <section className="schema-evidence-section">
              <div className="schema-section-heading">
                <h4>Tables</h4>
                <span>{evidence.tables.length}</span>
              </div>
              <div className="schema-evidence-tables">
                {evidence.tables.map(table => (
                  <span className="schema-table-name" key={`${table.schema}.${table.table}`}>
                    <IconTable size={13} />
                    <code>{table.schema}.{table.table}</code>
                  </span>
                ))}
                {evidence.tables.length === 0 && (
                  <p className="schema-evidence-empty">No tables were returned for this answer.</p>
                )}
              </div>
            </section>

            <section className="schema-evidence-section schema-relationships-section">
              <div className="schema-section-heading">
                <h4><IconLink size={14} /> Relationships</h4>
                <span>{evidence.relationships.length}</span>
              </div>
              {evidence.relationships.length > 0 ? (
                <div className="relationship-list">
                  {evidence.relationships.map(relationship => (
                    <div className="relationship-item" key={relationship.name}>
                      <div className="relationship-path">
                        <div className="relationship-endpoint">
                          <span>From</span>
                          <code>{relationship.from.schema}.{relationship.from.table}</code>
                          <small>{relationship.from.columns.join(', ')}</small>
                        </div>
                        <span className="relationship-connector" aria-label="references">
                          <span />
                          <IconLink size={14} />
                          <span />
                        </span>
                        <div className="relationship-endpoint">
                          <span>References</span>
                          <code>{relationship.to.schema}.{relationship.to.table}</code>
                          <small>{relationship.to.columns.join(', ')}</small>
                        </div>
                      </div>
                      <div className="relationship-meta">
                        <code>{relationship.name}</code>
                        <span>ON DELETE {relationship.onDelete}</span>
                        <span>ON UPDATE {relationship.onUpdate}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="schema-evidence-empty">
                  No direct foreign-key relationships were returned for these tables.
                </p>
              )}
            </section>
          </div>
        </details>
      </div>
    </div>
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
