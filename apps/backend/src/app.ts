import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { pool } from './db';
import { authRouter } from './routes/auth.routes';
import { modelsRouter } from './routes/models.routes';
import { connectionsRouter } from './routes/connections.routes';
import { conversationsRouter } from './routes/conversations.routes';
import { questionsRouter } from './routes/questions.routes';
import { recoveryRouter } from './routes/recovery.routes';
import { userApiKeysRouter } from './routes/userApiKeys.routes';
import { userModelsRouter } from './routes/userModels.routes';
import { profileRouter } from './routes/profile.routes';
import { LlmUnavailableError } from './services/llm';

export const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

app.get('/api/health', async (_req, res) => {
  let dbStatus = 'unknown';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }
  res.json({
    ok: true,
    message: 'API is running',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

app.use('/api/auth', authRouter);
app.use('/api/models', modelsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/questions', questionsRouter);
app.use('/api/recovery', recoveryRouter);
app.use('/api/user/api-keys', userApiKeysRouter);
app.use('/api/user/models', userModelsRouter);
app.use('/api/user/profile', profileRouter);

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (err instanceof LlmUnavailableError) {
    return res
      .status(503)
      .json({ error: 'The language model is unavailable right now. Please try again in a moment.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error(
    'Unhandled server error:',
    JSON.stringify({
      code: err?.code,
      status: err?.status,
      message: String(err?.message ?? err).slice(0, 500)
    })
  );
  res.status(500).json({ error: 'Unexpected server error.' });
});
