import { isTableRecordCountQuestion, schemaEvidence } from '../src/services/agent';
import type { SchemaSnapshot } from '../src/services/introspection';

const snapshot = {
  tables: ['customers', 'orders', 'order_items', 'products'].map(name => ({
    schema: 'public',
    name,
    type: 'table' as const,
    comment: null,
    rowEstimate: null,
    columns: [
      {
        name: 'id',
        dataType: 'integer',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isForeignKey: false,
        comment: null
      }
    ]
  })),
  relationships: [
    {
      name: 'orders_customer_id_fkey',
      from: { schema: 'public', table: 'orders', columns: ['customer_id'] },
      to: { schema: 'public', table: 'customers', columns: ['id'] },
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION'
    },
    {
      name: 'order_items_order_id_fkey',
      from: { schema: 'public', table: 'order_items', columns: ['order_id'] },
      to: { schema: 'public', table: 'orders', columns: ['id'] },
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION'
    }
  ]
} as SchemaSnapshot;

const selected = snapshot.tables.map(({ schema, name }) => ({ schema, table: name }));

describe('table record-count question detection', () => {
  test.each([
    'Which table has most records?',
    'What collection has the highest number of documents?',
    'Which table contains the largest number of rows?'
  ])('recognizes cross-table count question: %s', question => {
    expect(isTableRecordCountQuestion(question)).toBe(true);
  });

  test('does not classify a regular row-count question as a cross-table comparison', () => {
    expect(isTableRecordCountQuestion('How many records are in the orders table?')).toBe(false);
  });
});

describe('schema evidence relevance', () => {
  test('includes only named tables and relationships between them', () => {
    const evidence = schemaEvidence(
      snapshot,
      selected,
      'orders',
      'How are orders and customers related?'
    );

    expect(evidence.tables.map(table => table.table)).toEqual(['customers', 'orders']);
    expect(evidence.relationships.map(relationship => relationship.name)).toEqual([
      'orders_customer_id_fkey'
    ]);
  });

  test('includes directly related tables when only one table is named', () => {
    const evidence = schemaEvidence(snapshot, selected, 'orders', 'What is orders related to?');

    expect(evidence.tables.map(table => table.table)).toEqual([
      'customers',
      'orders',
      'order_items'
    ]);
    expect(evidence.relationships).toHaveLength(2);
  });
});
