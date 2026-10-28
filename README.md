# Database Knowledge Assistant

Connect a PostgreSQL database, choose tables, and ask questions in plain English. Answers come from read-only SQL with the query and rows visible, plus schema and relationship exploration.

## Status

Phase 1 in progress.

## Stack

React + TypeScript + Vite, Node.js + Express + TypeScript, PostgreSQL, and an OpenAI-compatible LLM.

## Local services

The app database runs on host port `5434`; the demo target database runs on `5435`. This keeps the project independent from the existing document assistant on `5432`.

```bash
docker compose up -d
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant < apps/backend/schema.sql
cp .env.example .env
npm install
npm run seed -w apps/backend
npm run dev
```

## Tests

```bash
npm run typecheck
npm test
npm run test:e2e
```
