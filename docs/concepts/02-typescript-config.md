# 02 — TypeScript configuration

> Two tsconfigs, strict everywhere, ESM in the frontend and Node16/CJS interop in the backend — plus the reasoning you need to rebuild them.

**Back to:** [Implementation Walkthrough](../history/implementation-walkthrough.md#concept-index) · [01 — Monorepo & tooling](01-monorepo-tooling.md)

> **Current implementation note:** the workspace layout and TypeScript targets are unchanged. The backend now also compiles MySQL/MongoDB adapter code; run `npm run typecheck` from the repo root after dependency changes.

## What it is

TypeScript's compiler options decide how much type safety you get and what module system your output speaks. In a two-app monorepo each app needs its own `tsconfig.json` because their targets genuinely differ: the backend runs under Node (`tsx` in dev, `tsc` for a production build), and the browser app is native ESM bundled by Vite.

**Prerequisites:** [01 — Monorepo & tooling](01-monorepo-tooling.md) (workspaces each own a tsconfig).

## Why it matters here

- `strict: true` catches the bugs this project is full of: a possibly-undefined `req.user`, untyped `process.env` reads, a nullable target connection, and result rows whose type is genuinely unknown.
- Getting `moduleResolution` right is the difference between "imports just work" and an hour of `Cannot find module '../db'`.
- The backend runs TypeScript directly via `tsx` in development, so tsconfig correctness is enforced by `npm run typecheck`, not by a compile step.
- The frontend excludes `e2e/` from typechecking on purpose; Playwright transpiles its own specs.

## When to copy these settings

- Any new Express + TS service: copy the backend config almost verbatim.
- Any new Vite React app: the frontend config is the standard Vite template with `strict` on.
- Libraries intended for both Node and browsers: you will need `paths` or project references — beyond this project's scope.

## How it works here

### Backend — `apps/backend/tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Why these choices:

- **`module: Node16` + `moduleResolution: Node16`** — the backend `package.json` has no `"type": "module"`, so Node treats output as CommonJS. Node16 resolution understands both `require` and `import` in a package-aware way and avoids the deprecated `Node` resolution mode. `esModuleInterop` lets you use modern `import x from 'y'` syntax over CJS packages such as `jsonwebtoken`, `bcrypt`, and `pg`.
- **`strict: true`** — enables `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and friends. `req.user` being optional forces every route to handle the unauthenticated case in the type system, not just in review.
- **`include: ["src"]`** — tests live in `test/` and are typechecked by ts-jest at test time. If you want them in `npm run typecheck`, add `"test"` to `include`; the trade-off is slower typechecks and test-only types leaking into the app build.
- **`rootDir: "src"`** — keeps `dist/` shaped like `src/`, so `node dist/server.js` resolves imports predictably.

### Frontend — `apps/frontend/tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "isolatedModules": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Why these choices:

- **`moduleResolution: "Bundler"`** — Vite resolves imports itself (extensionless, `exports`-field aware). `"NodeNext"` would demand explicit `.js` extensions everywhere; `"Bundler"` matches reality.
- **`isolatedModules: true`** — Vite transpiles file-by-file with esbuild, so every file must be valid alone: no const-only enums, and re-export types with `export type`.
- **`include: ["src"]`** — deliberately excludes `e2e/` and `playwright.config.ts`; Playwright transpiles those itself. This keeps `npm run typecheck` focused on the app.
- **`noEmit: true`** — the build script is `tsc -b && vite build`: TypeScript validates, Vite emits the bundle. Typechecking and bundling are separate concerns.
- **`jsx: "react-jsx"`** — no `import React` needed in every component.

### Typechecking script (root)

```json
"typecheck": "npm run typecheck -w apps/backend && npm run typecheck -w apps/frontend"
```

Each workspace's `typecheck` is `tsc --noEmit`. Run this before every commit; it is the cheapest correctness gate.

### Types that matter in this project

The target database is dynamic, so keep the boundary honest:

```ts
type TableRef = { schema: string; table: string };

type QueryEvidence = {
  version: 1;
  kind: 'sql';
  sql: string;
  columns: Array<{ name: string; dataType: string }>;
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
  tables: TableRef[];
};
```

Use `unknown`, not `any`, for row values and parsed LLM JSON. Narrow at the edge with `zod` or explicit guards. If a value crosses from the target database into the app, it is untrusted by definition.

## Pitfalls we hit (and fixes)

1. **`Cannot find module '../db'` in a seed script.** Not a tsconfig problem — the file lives in `src/`, so the import must be `'./db'`. Count relative depth from the file's own location, not the project root.
2. **Using the deprecated `Node` resolution.** Recent TypeScript warns that `"Node"` is deprecated in favor of `"Node16"`/`"NodeNext"`. Use `Node16` in both `module` and `moduleResolution` for the backend, or you will chase a warning that is easy to silence incorrectly.
3. **`any` creeping through `process.env`.** `process.env.X` is `string | undefined`; using it as `string` fails under strict. Read once in a `readConfig()` function with defaults, so the `undefined` is handled in exactly one place.
4. **Forgetting `skipLibCheck`** on a fresh install — `tsc` spends minutes deep-checking `@types/pg` and friends. `skipLibCheck: true` is a safe default; your own code is still fully checked.
5. **Putting e2e in the frontend include.** The Playwright config uses Node globals and ESM path helpers; including it in the Vite tsconfig creates errors for code that never ships to the browser.

## Verification checklist

```bash
npm run typecheck        # exits 0, both workspaces
# Introduce a type error (e.g. `const n: number = 'x'` in any src file)
npm run typecheck        # exits non-zero naming the file — confirms it actually runs
```

## Backlinks

- Walkthrough: [Step 0 — Repository foundation](../history/implementation-walkthrough.md#1-step-0--repository-foundation) · [Step 8 — Tests and docs](../history/implementation-walkthrough.md#9-step-8--tests-e2e-and-documentation)
- Related: [01 — Monorepo & tooling](01-monorepo-tooling.md) · [12 — Testing strategy](12-testing-strategy.md)
