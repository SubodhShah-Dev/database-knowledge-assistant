import { Router, type Response } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import {
  getConnectionSchema,
  getOwnedConnection,
  toTargetConfig
} from '../services/connectionAccess';
import { safeConnectionError } from '../services/connectionPool';
import {
  buildTableRecordCountQuery,
  referencedDatabaseTables,
  runDatabaseQuery,
  validateDatabaseQuery
} from '../services/databaseAdapters';
import { resolveModelConfig } from '../services/modelConfig';
import {
  AgentError,
  asksForRelationshipCounts,
  isTableRecordCountQuestion,
  type AnswerMode,
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
import { SqlValidationError } from '../services/sqlGuard';
import { TargetDbTimeoutError } from '../services/sqlExecution';

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

function isAnswerMode(value: unknown): value is AnswerMode {
  return value === 'auto' || value === 'data' || value === 'schema';
}

function safeDbError(error: any): string {
  if (error?.code === '42501') return 'The database role does not have permission to read this data.';
  if (error?.code === '42P01') {
    return 'A selected table no longer exists. Refresh the schema and start a new session.';
  }
  return 'The database could not run the generated query.';
}

function safeRecordCountError(error: unknown, engine: string): string {
  const typedError = error as {
    message?: string;
    sqlMessage?: string;
    stage?: string;
  } | null;
  const message = typedError?.message ?? '';
  const tableMatch = /(?:Could not count|counting) ([^:]+):/.exec(message);
  const tableDetail = tableMatch ? ` Table: ${tableMatch[1]}.` : '';
  const stageDetail = typedError?.stage ? ` Failed during ${typedError.stage}.` : '';
  const serverDetail = (typedError?.sqlMessage ?? message)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
  const code = String(
    (error as { code?: string; cause?: { code?: string } } | null)?.code ??
      (error as { cause?: { code?: string } } | null)?.cause?.code ??
      'unknown'
  );
  if (['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(code)) {
    return `The database account does not have permission to count records.${tableDetail}${stageDetail}`;
  }
  if (code === 'ER_NO_SUCH_TABLE') {
    return `A selected table is not visible to this database account or no longer exists. Refresh the schema and create a new session.${tableDetail}${stageDetail}`;
  }
  if (code === 'ER_LOCK_WAIT_TIMEOUT') {
    return `The database could not count records because it was waiting on a table lock.${tableDetail}${stageDetail}`;
  }
  if (code === 'ER_PARSE_ERROR' || code === 'ER_NOT_SUPPORTED_YET') {
    return `${engine === 'mysql' ? 'TiDB/MySQL' : engine} rejected a statement in the record-count operation (${code}).${stageDetail} ${serverDetail}`;
  }
  return `${engine === 'mysql' ? 'TiDB/MySQL' : engine} rejected the record-count query (code: ${code}). Check SELECT access to the selected tables.${tableDetail}${stageDetail} ${serverDetail}`;
}

function isConnectionTimeout(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ??
    (error as { cause?: { code?: string } } | null)?.cause?.code;
  return ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT'].includes(String(code));
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
  model,
  answerMode
}: {
  userId: string;
  conversationId: string;
  question: string;
  answer: string;
  evidence: Evidence | unknown[];
  model: string;
  answerMode: 'data' | 'schema' | 'clarify';
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO qa_history (user_id, conversation_id, question, answer, evidence, model, answer_mode)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING id`,
      [userId, conversationId, question, answer, JSON.stringify(evidence), model, answerMode]
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
  const requestedMode: unknown = req.body.mode ?? 'auto';

  if (!question) return res.status(400).json({ error: 'question is required.' });
  if (!isAnswerMode(requestedMode)) {
    return res.status(400).json({ error: 'mode must be auto, data, or schema.' });
  }
  const mode = requestedMode;
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
      if ((connection.engine ?? 'postgres') === 'mysql' && isConnectionTimeout(error)) {
        return res.status(504).json({
          error:
            'The MySQL-compatible database connection timed out before the question could run. Check the host, port, network access, and TLS settings, then retry.',
          code: 'connection_timeout'
        });
      }
      return res.status(502).json({ error: safeConnectionError(error) });
    }

    const selectedTables = conversation.selected_tables;
    let recordCountTables: TableRef[] = [];
    let recordCountRelationships = new Map<string, number>();
    const engine = connection.engine ?? 'postgres';
    const schemaBlock = buildSchemaBlock(snapshot, selectedTables);
    const history = await loadHistory(conversation.id, req.user!.id);
    const modelConfig = await resolveModelConfig({ modelId: conversation.model_id });
    const requestedModel = modelConfig?.model ?? llmModel();
    const recordCountQuestion = isTableRecordCountQuestion(question);

    let plan;
    try {
      if (recordCountQuestion && mode === 'schema') {
        plan = {
          mode: 'clarify' as const,
          question:
            'Schema mode only has table metadata, not record counts. Switch to Auto or Data mode to compare records across the selected tables.'
        };
      } else if (recordCountQuestion) {
        const selectedDataTables = snapshot.tables
          .filter(table => table.type === 'table')
          .filter(table =>
            selectedTables.some(
              selected => selected.schema === table.schema && selected.table === table.name
            )
          )
          .map(table => ({ schema: table.schema, table: table.name }));
        recordCountTables = selectedDataTables;
        if (asksForRelationshipCounts(question)) {
          const selectedTableKeys = new Set(
            selectedDataTables.map(table => `${table.schema}.${table.table}`)
          );
          recordCountRelationships = new Map(
            selectedDataTables.map(table => {
              const key = `${table.schema}.${table.table}`;
              const relationshipCount = snapshot.relationships.filter(relationship =>
                selectedTableKeys.has(
                  `${relationship.from.schema}.${relationship.from.table}`
                ) &&
                selectedTableKeys.has(
                  `${relationship.to.schema}.${relationship.to.table}`
                ) &&
                ((relationship.from.schema === table.schema &&
                  relationship.from.table === table.table) ||
                (relationship.to.schema === table.schema &&
                  relationship.to.table === table.table))
              ).length;
              return [key, relationshipCount];
            })
          );
        }
        if (selectedDataTables.length === 0) {
          plan = {
            mode: 'clarify' as const,
            question:
              'No tables are selected for record counting. Select one or more tables, then ask again.'
          };
        } else {
          plan = {
            mode: 'data' as const,
            query: buildTableRecordCountQuery(
              selectedDataTables,
              engine,
              asksForRelationshipCounts(question) ? recordCountRelationships : undefined
            )
          };
        }
      } else {
        plan = await planQuestion({
          question,
          history,
          schemaBlock,
          engine,
          mode,
          modelConfig
        });
      }
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      if (error instanceof AgentError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    let query: string | undefined;
    if (plan.mode === 'data') {
      try {
        query = validateDatabaseQuery(plan.query, engine, selectedTables);
      } catch (error) {
        if (!(error instanceof SqlValidationError)) throw error;
        try {
          const repaired = await repairPlan({
            question,
            history,
            schemaBlock,
            previous: plan,
            reason: error.message,
            engine,
            mode,
            modelConfig
          });
          if (repaired.mode !== 'data') {
            throw new AgentError(error.message, 422, 'validation_failed', plan.query);
          }
          query = validateDatabaseQuery(repaired.query, engine, selectedTables);
          plan = repaired;
        } catch (repairError) {
          if (repairError instanceof LlmUnavailableError) {
            return res.status(503).json({ error: repairError.message, sql: plan.query });
          }
          if (repairError instanceof SqlValidationError) {
            return res.status(422).json({ error: repairError.message, sql: repairError.sql });
          }
          if (repairError instanceof AgentError) {
            return res.status(repairError.status).json({
              error: repairError.message,
              sql: repairError.sql ?? plan.query
            });
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
      evidence = schemaEvidence(snapshot, selectedTables, plan.focus ?? null, question);
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

      const maxRows = Number(process.env.SQL_MAX_ROWS || 100);
      const timeoutMs =
        engine === 'mysql' && recordCountQuestion
          ? Number(process.env.MYSQL_RECORD_COUNT_TIMEOUT_MS || 30_000)
          : Number(process.env.SQL_TIMEOUT_MS || 5000);

      let result;
      try {
        result = await runDatabaseQuery(
          connection,
          toTargetConfig(connection),
          query!,
          selectedTables,
          { maxRows, timeoutMs }
        );
      } catch (error: any) {
        if (error instanceof TargetDbTimeoutError) {
          sseSend(res, 'error', {
            error: 'The query took too long and was cancelled.',
            code: 'timeout',
            sql: query
          });
          return res.end();
        }

        if (error?.code === '42P01') {
          sseSend(res, 'error', { error: safeDbError(error), code: 'db_error', sql: query });
          return res.end();
        }

        if (recordCountQuestion) {
          sseSend(res, 'error', {
            error: safeRecordCountError(error, engine),
            code: 'db_error',
            sql: query
          });
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
            engine,
            mode,
            modelConfig
          });
          if (repaired.mode !== 'data') {
            throw new AgentError('The database rejected the query.', 502, 'db_error');
          }
          query = validateDatabaseQuery(repaired.query, engine, selectedTables);
          result = await runDatabaseQuery(
            connection,
            toTargetConfig(connection),
            query,
            selectedTables,
            { maxRows, timeoutMs }
          );
          plan = repaired;
        } catch (repairError: any) {
          if (repairError instanceof TargetDbTimeoutError) {
            sseSend(res, 'error', {
              error: 'The query took too long and was cancelled.',
              code: 'timeout',
              sql: query
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
            sql: query
          });
          return res.end();
        }
      }

      const displayedQuery =
        recordCountQuestion && engine === 'mysql' && asksForRelationshipCounts(question)
          ? recordCountTables
              .map(table => {
                const schema = table.schema.replace(/`/g, '``');
                const name = table.table.replace(/`/g, '``');
                const relationshipCount =
                  recordCountRelationships.get(`${table.schema}.${table.table}`) ?? 0;
                return `SELECT COUNT(*) AS record_count FROM \`${schema}\`.\`${name}\`; -- relationship_count: ${relationshipCount}`;
              })
              .join('\n')
          : recordCountQuestion && engine === 'mongodb'
            ? recordCountTables
                .map(table => {
                  const key = `${table.schema}.${table.table}`;
                  const relationshipCount = recordCountRelationships.get(key);
                  const countCommand = `db.getCollection(${JSON.stringify(table.table)}).countDocuments({})`;
                  return relationshipCount === undefined
                    ? countCommand
                    : `${countCommand} // direct relationships: ${relationshipCount}`;
                })
                .join('\n')
            : query!;
      evidence = queryEvidence(
        displayedQuery,
        result,
        referencedDatabaseTables(query!, engine, selectedTables),
        engine === 'mongodb' ? 'mongodb' : 'sql'
      );
      sseSend(res, 'evidence', { evidence });

      try {
        answer = await streamAnswer({
          res,
          messages: dataAnswerMessages({ question, query: displayedQuery, result }),
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
          sql: query,
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
        sql: query,
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
        model: modelConfig?.model ?? requestedModel,
        answerMode: plan.mode
      });

      if (clientGone) return;
      sseSend(res, 'done', {
        conversationId: conversation.id,
        messageId,
        answer,
        model: modelConfig?.model ?? requestedModel,
        mode: plan.mode
      });
      res.end();
    } catch {
      sseSend(res, 'error', {
        error: 'The answer could not be saved.',
        code: 'persist_failed',
        sql: query,
        evidence
      });
      res.end();
    }
  } catch (error) {
    next(error);
  }
});
