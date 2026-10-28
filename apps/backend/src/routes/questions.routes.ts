import { Router, type Response } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import {
  getConnectionSchema,
  getOwnedConnection,
  getTargetPool
} from '../services/connectionAccess';
import { safeConnectionError } from '../services/connectionPool';
import { resolveModelConfig } from '../services/modelConfig';
import {
  AgentError,
  buildSchemaBlock,
  dataAnswerMessages,
  planQuestion,
  queryEvidence,
  repairPlan,
  schemaAnswerMessages,
  schemaEvidence,
  type Evidence
} from '../services/agent';
import {
  chatStream,
  LlmUnavailableError,
  llmModel,
  type ChatMessage,
  type LlmConfig
} from '../services/llm';
import { assertSelectionExists, ScopeError, type TableRef } from '../services/sessionScope';
import { referencedTables, SqlValidationError, validateSql } from '../services/sqlGuard';
import { runReadOnlyQuery, TargetDbTimeoutError } from '../services/sqlExecution';

export const questionsRouter = Router();

type ConversationRow = {
  id: string;
  user_id: string;
  connection_id: string;
  title: string;
  selected_tables: TableRef[];
  model_id: string | null;
};

function sseSend(res: Response, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError';
}

function safeDbError(error: any): string {
  if (error?.code === '42501') return 'The database role does not have permission to read this data.';
  if (error?.code === '42P01') {
    return 'A selected table no longer exists. Refresh the schema and start a new session.';
  }
  return 'The database could not run the generated query.';
}

async function loadHistory(conversationId: string, userId: string): Promise<ChatMessage[]> {
  const { rows } = await pool.query(
    `SELECT question, answer
     FROM qa_history
     WHERE conversation_id = $1 AND user_id = $2
     ORDER BY id DESC
     LIMIT 6`,
    [conversationId, userId]
  );

  return rows.reverse().flatMap(row => [
    { role: 'user' as const, content: String(row.question).slice(0, 1000) },
    { role: 'assistant' as const, content: String(row.answer).slice(0, 1000) }
  ]);
}

async function persistTurn({
  userId,
  conversationId,
  question,
  answer,
  evidence,
  model
}: {
  userId: string;
  conversationId: string;
  question: string;
  answer: string;
  evidence: Evidence | unknown[];
  model: string;
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO qa_history (user_id, conversation_id, question, answer, evidence, model)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id`,
      [userId, conversationId, question, answer, JSON.stringify(evidence), model]
    );

    const title = question.length > 80 ? `${question.slice(0, 77)}...` : question;
    await client.query(
      `UPDATE conversations
       SET title = CASE WHEN title = 'New session' THEN $3 ELSE title END,
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [conversationId, userId, title]
    );

    await client.query('COMMIT');
    return inserted.rows[0].id as string;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function streamAnswer({
  res,
  messages,
  signal,
  modelConfig,
  aborted
}: {
  res: Response;
  messages: ChatMessage[];
  signal: AbortSignal;
  modelConfig?: Partial<LlmConfig>;
  aborted: () => boolean;
}): Promise<string> {
  let answer = '';
  for await (const delta of chatStream(messages, {
    temperature: 0.1,
    signal,
    modelConfig
  })) {
    if (aborted()) return answer;
    answer += delta;
    sseSend(res, 'token', { text: delta });
  }
  return answer;
}

questionsRouter.post('/', requireAuth, async (req, res, next) => {
  const question = String(req.body.question || '').trim();
  const conversationId = Number(req.body.conversationId);

  if (!question) return res.status(400).json({ error: 'question is required.' });
  if (question.length > 2000) {
    return res.status(400).json({ error: 'question is too long (max 2000 characters).' });
  }
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: 'conversationId is required.' });
  }

  try {
    const conversationResult = await pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, req.user!.id]
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) return res.status(404).json({ error: 'Session not found.' });

    const connection = await getOwnedConnection(req.user!.id, conversation.connection_id);
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });

    let snapshot;
    try {
      snapshot = await getConnectionSchema(connection);
      assertSelectionExists(snapshot, conversation.selected_tables);
    } catch (error) {
      if (error instanceof ScopeError) {
        return res.status(error.status).json({ error: error.message });
      }
      return res.status(502).json({ error: safeConnectionError(error) });
    }

    const selectedTables = conversation.selected_tables;
    const schemaBlock = buildSchemaBlock(snapshot, selectedTables);
    const history = await loadHistory(conversation.id, req.user!.id);
    const modelConfig = await resolveModelConfig({ modelId: conversation.model_id });
    const model = modelConfig?.model ?? llmModel();

    let plan;
    try {
      plan = await planQuestion({ question, history, schemaBlock, modelConfig });
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      if (error instanceof AgentError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    let sql: string | undefined;
    if (plan.mode === 'data') {
      try {
        sql = validateSql(plan.sql, selectedTables);
      } catch (error) {
        if (!(error instanceof SqlValidationError)) throw error;
        try {
          const repaired = await repairPlan({
            question,
            history,
            schemaBlock,
            previous: plan,
            reason: error.message,
            modelConfig
          });
          if (repaired.mode !== 'data') {
            throw new AgentError(error.message, 422, 'validation_failed', plan.sql);
          }
          sql = validateSql(repaired.sql, selectedTables);
          plan = repaired;
        } catch (repairError) {
          if (repairError instanceof LlmUnavailableError) {
            return res.status(503).json({ error: repairError.message });
          }
          if (repairError instanceof SqlValidationError) {
            return res.status(422).json({ error: repairError.message });
          }
          if (repairError instanceof AgentError) {
            return res.status(repairError.status).json({ error: repairError.message });
          }
          throw repairError;
        }
      }
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abortController = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        abortController.abort();
      }
    });

    sseSend(res, 'status', { phase: 'planning', label: 'Understanding the question' });

    let evidence: Evidence | undefined;
    let answer = '';

    if (plan.mode === 'clarify') {
      answer = plan.question;
      sseSend(res, 'token', { text: answer });
    } else if (plan.mode === 'schema') {
      evidence = schemaEvidence(snapshot, selectedTables, plan.focus ?? null);
      sseSend(res, 'evidence', { evidence });
      try {
        answer = await streamAnswer({
          res,
          messages: schemaAnswerMessages({ question, schemaBlock }),
          signal: abortController.signal,
          modelConfig,
          aborted: () => clientGone
        });
      } catch (error) {
        if (clientGone || isAbortError(error)) return;
        sseSend(res, 'error', {
          error:
            error instanceof LlmUnavailableError
              ? error.message
              : 'The answer could not be generated.',
          code: 'llm_unavailable',
          evidence
        });
        return res.end();
      }
    } else {
      sseSend(res, 'status', {
        phase: 'running_query',
        label: 'Running read-only query'
      });

      const targetPool = getTargetPool(connection);
      const maxRows = Number(process.env.SQL_MAX_ROWS || 100);
      const timeoutMs = Number(process.env.SQL_TIMEOUT_MS || 5000);

      let result;
      try {
        result = await runReadOnlyQuery(targetPool, sql!, { maxRows, timeoutMs });
      } catch (error: any) {
        if (error instanceof TargetDbTimeoutError) {
          sseSend(res, 'error', {
            error: 'The query took too long and was cancelled.',
            code: 'timeout',
            sql
          });
          return res.end();
        }

        if (error?.code === '42P01') {
          sseSend(res, 'error', { error: safeDbError(error), code: 'db_error', sql });
          return res.end();
        }

        try {
          const repaired = await repairPlan({
            question,
            history,
            schemaBlock,
            previous: plan,
            reason: `The database rejected the query: ${String(error?.message ?? error).slice(
              0,
              500
            )}`,
            modelConfig
          });
          if (repaired.mode !== 'data') {
            throw new AgentError('The database rejected the query.', 502, 'db_error');
          }
          sql = validateSql(repaired.sql, selectedTables);
          result = await runReadOnlyQuery(targetPool, sql, { maxRows, timeoutMs });
        } catch (repairError: any) {
          if (repairError instanceof TargetDbTimeoutError) {
            sseSend(res, 'error', {
              error: 'The query took too long and was cancelled.',
              code: 'timeout',
              sql
            });
            return res.end();
          }
          sseSend(res, 'error', {
            error:
              repairError instanceof LlmUnavailableError
                ? repairError.message
                : repairError instanceof SqlValidationError
                  ? repairError.message
                  : repairError instanceof AgentError
                    ? repairError.message
                    : safeDbError(repairError),
            code:
              repairError instanceof LlmUnavailableError
                ? 'llm_unavailable'
                : repairError instanceof SqlValidationError
                  ? 'validation_failed'
                  : 'db_error',
            sql
          });
          return res.end();
        }
      }

      evidence = queryEvidence(sql!, result, referencedTables(sql!));
      sseSend(res, 'evidence', { evidence });

      try {
        answer = await streamAnswer({
          res,
          messages: dataAnswerMessages({ question, sql: sql!, result }),
          signal: abortController.signal,
          modelConfig,
          aborted: () => clientGone
        });
      } catch (error) {
        if (clientGone || isAbortError(error)) return;
        sseSend(res, 'error', {
          error:
            error instanceof LlmUnavailableError
              ? error.message
              : 'The answer could not be generated.',
          code: 'llm_unavailable',
          sql,
          evidence
        });
        return res.end();
      }
    }

    if (clientGone) return;
    if (!answer.trim()) {
      sseSend(res, 'error', {
        error: 'The answer was empty. Please try again.',
        code: 'empty_answer',
        sql,
        evidence
      });
      return res.end();
    }

    try {
      const messageId = await persistTurn({
        userId: req.user!.id,
        conversationId: conversation.id,
        question,
        answer,
        evidence: evidence ?? [],
        model
      });

      if (clientGone) return;
      sseSend(res, 'done', {
        conversationId: conversation.id,
        messageId,
        answer,
        model
      });
      res.end();
    } catch {
      sseSend(res, 'error', {
        error: 'The answer could not be saved.',
        code: 'persist_failed',
        sql,
        evidence
      });
      res.end();
    }
  } catch (error) {
    next(error);
  }
});
