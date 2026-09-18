---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Monorepo layout

This is a Bun workspaces monorepo. `bun install` runs once at the root and produces the single `bun.lock`.

Root `check`, `typecheck`, and `test` fan out to every app explicitly, crossing package-manager
boundaries (`bun` for the CLI, `pnpm` for the frontend, `make`/`uv` for the backend). Never scope
them with `bun run --filter`: that resolves Bun workspace members only, so it would silently skip
`apps/frontend` and `apps/backend`. Per-app variants are suffixed (`check:frontend`, `test:backend`).
`lint`, `format`, and `format:check` at the root are Biome-only and therefore Bun-apps-only by design.

- `apps/cli` is the `ddcli` launcher. Run its scripts from that directory (`cd apps/cli && bun test`), or from the root with `bun run --cwd apps/cli <script>`.
- `apps/frontend` is the management console: pnpm, Vite, React 19, TypeScript, Tailwind v4, and shadcn. It is **not** a Bun workspace member and is excluded from Biome, so use pnpm from inside that directory and never `bun install` there. It has its own ESLint and Prettier. Its `config.json` is git-ignored; `config_template.json` is the checked-in shape and both change together.
- `apps/backend` is the centralized management API: a standalone Python 3.12 project managed by uv, with Vortex, Ruff, pytest, and its own `uv.lock`. Run its commands from that directory; it is not a Bun workspace member and is excluded from Biome. Its `config.json` is git-ignored; keep `config_template.json` in sync with its shape.
- `packages/` holds code shared between apps. Create it only when two apps need the same code.
- `biome.json` and `tsconfig.base.json` at the root apply to every Bun-managed app. App `tsconfig.json` files extend the base and only set `include`/`exclude`.
- Every Bun-managed app declares every package it imports in its own `package.json`. Bun uses isolated installs, so an undeclared transitive dependency is not resolvable even if another package depends on it.
- GitHub Release tags are namespaced per component. CLI tags are `cli-<semver>` with no `v` prefix.
