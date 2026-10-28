import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { authRouter } from './routes/auth.routes';
import { modelsRouter } from './routes/models.routes';
import { LlmUnavailableError } from './services/llm';

export const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'API is running' });
});

app.use('/api/auth', authRouter);
app.use('/api/models', modelsRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (err instanceof LlmUnavailableError) {
    return res.status(503).json({ error: 'The language model is unavailable right now. Please try again in a moment.' });
  }
  res.status(500).json({ error: err.message || 'Unexpected server error.' });
});
