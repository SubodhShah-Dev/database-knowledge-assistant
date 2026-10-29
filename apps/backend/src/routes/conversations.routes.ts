import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { getConnectionSchema, getOwnedConnection } from '../services/connectionAccess';
import { safeConnectionError } from '../services/connectionPool';
import {
  assertSelectionExists,
  defaultSelection,
  normalizeSelection,
  ScopeError,
  type TableRef
} from '../services/sessionScope';

export const conversationsRouter = Router();

type ConversationRow = {
  id: string;
  user_id: string;
  connection_id: string;
  title: string;
  selected_tables: TableRef[];
  model_id: string | null;
  created_at: string;
  updated_at: string;
};

function toConversation(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    connectionId: row.connection_id,
    selectedTables: row.selected_tables,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getOwnedConversation(userId: string, id: string) {
  const { rows } = await pool.query<ConversationRow>(
    'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rows[0] ?? null;
}

async function validateModelId(value: unknown): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const { rows } = await pool.query(
    'SELECT id FROM models WHERE (id::text = $1 OR model_id = $1) AND is_enabled = true',
    [String(value)]
  );
  if (!rows[0]) throw new ScopeError('That model is not available.');
  return rows[0].id;
}

function parseTitle(value: unknown): string {
  const title = String(value ?? '').trim();
  if (!title) throw new ScopeError('Session title cannot be empty.', 400);
  if (title.length > 200) throw new ScopeError('Session title is too long (max 200).', 400);
  return title;
}

conversationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, d.name AS connection_name, d.database_name
       FROM conversations c
       JOIN database_connections d ON d.id = c.connection_id
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC`,
      [req.user!.id]
    );
    res.json(
      rows.map(row => ({
        ...toConversation(row),
        connection: {
          id: row.connection_id,
          name: row.connection_name,
          database: row.database_name
        }
      }))
    );
  } catch (error) {
    next(error);
  }
});

conversationsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const connectionId = String(req.body.connectionId || '');
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required.' });

    const connection = await getOwnedConnection(req.user!.id, connectionId);
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });

    let tables: TableRef[];
    try {
      const snapshot = await getConnectionSchema(connection);
      tables = req.body.tables ? normalizeSelection(req.body.tables) : defaultSelection(snapshot);
      assertSelectionExists(snapshot, tables);
    } catch (error) {
      if (error instanceof ScopeError) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(502).json({ error: safeConnectionError(error) });
    }

    const modelId = await validateModelId(req.body.modelId);
    const { rows } = await pool.query<ConversationRow>(
      `INSERT INTO conversations (user_id, connection_id, title, selected_tables, model_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [
        req.user!.id,
        connection.id,
        'New session',
        JSON.stringify(tables),
        modelId ?? null
      ]
    );

    res.status(201).json({
      ...toConversation(rows[0]),
      connection: { id: connection.id, name: connection.name, database: connection.database_name }
    });
  } catch (error) {
    if (error instanceof ScopeError) {
      return res.status(error.status).json({ error: error.message });
    }
    next(error);
  }
});

conversationsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const conversation = await getOwnedConversation(req.user!.id, String(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'Session not found.' });

    const connection = await getOwnedConnection(req.user!.id, conversation.connection_id);
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });

    const turns = await pool.query(
      `SELECT id, question, answer, evidence, model, answer_mode, created_at
       FROM qa_history
       WHERE conversation_id = $1 AND user_id = $2
       ORDER BY id ASC`,
      [conversation.id, req.user!.id]
    );

    res.json({
      ...toConversation(conversation),
      connection: { id: connection.id, name: connection.name, database: connection.database_name },
      turns: turns.rows.map(turn => ({
        id: turn.id,
        question: turn.question,
        answer: turn.answer,
        evidence: turn.evidence,
        model: turn.model,
        mode: turn.answer_mode,
        createdAt: turn.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

conversationsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    if (req.body.connectionId !== undefined) {
      return res.status(400).json({
        error: "A session's connection cannot be changed. Start a new session."
      });
    }

    const conversation = await getOwnedConversation(req.user!.id, String(req.params.id));
    if (!conversation) return res.status(404).json({ error: 'Session not found.' });

    let title = conversation.title;
    let tables = conversation.selected_tables;
    let modelId = conversation.model_id;

    if (req.body.title !== undefined) title = parseTitle(req.body.title);
    const nextModelId = await validateModelId(req.body.modelId);
    if (nextModelId !== undefined) modelId = nextModelId;

    if (req.body.tables !== undefined) {
      const connection = await getOwnedConnection(req.user!.id, conversation.connection_id);
      if (!connection) return res.status(404).json({ error: 'Connection not found.' });

      try {
        const snapshot = await getConnectionSchema(connection, true);
        tables = normalizeSelection(req.body.tables);
        assertSelectionExists(snapshot, tables);
      } catch (error) {
        if (error instanceof ScopeError) {
          return res.status(error.status).json({ error: error.message });
        }
        return res.status(502).json({ error: safeConnectionError(error) });
      }
    }

    const { rows } = await pool.query<ConversationRow>(
      `UPDATE conversations
       SET title = $3, selected_tables = $4::jsonb, model_id = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [conversation.id, req.user!.id, title, JSON.stringify(tables), modelId]
    );

    res.json(toConversation(rows[0]));
  } catch (error) {
    if (error instanceof ScopeError) {
      return res.status(error.status).json({ error: error.message });
    }
    next(error);
  }
});

conversationsRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Session not found.' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
