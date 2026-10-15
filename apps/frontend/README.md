# Axon Console (frontend)

Management console UI for Axon. Part of the [Axon monorepo](../../README.md).

This app is managed with **pnpm**, not Bun, and is deliberately outside the root Bun workspace. Run every command from this directory.

## Stack

Vite, React 19, TypeScript, Tailwind CSS v4, shadcn (radix base, `mira` style), ESLint, and Prettier.

## Setup

```bash
cd apps/frontend
cp config_template.json config.json
pnpm install
pnpm dev
```

`config.json` is per-environment and git-ignored. `config_template.json` is the checked-in shape; update both together when adding a key. Vite reads it for the dev/preview port, the base path, and the API origin, and it is importable in app code as `@config`.

## Scripts

| Script             | What it does                       |
| ------------------ | ---------------------------------- |
| `pnpm dev`         | Vite dev server on `config.port`   |
| `pnpm build`       | Typecheck the project, then build  |
| `pnpm preview`     | Serve the production build         |
| `pnpm typecheck`   | TypeScript only                    |
| `pnpm lint`        | ESLint                             |
| `pnpm format`      | Prettier write                     |

## Conventions

`@/*` resolves to `src/*`. Add shadcn components with `pnpm exec shadcn add <name>`; they land in `src/components/ui` and are excluded from Prettier so they stay close to upstream.

## How this is deployed

The console is a static build with nothing to run, so it is not deployed as its own service. `apps/backend` serves `dist/` from its own origin at `/`, and its Docker image runs `pnpm build` here and embeds the output. See that app's README for the routing and caching rules.

Because the API and the console share an origin in production, the app calls the API with **relative** URLs (`BASE_API_URL` is `""`) and there is no CORS. `vite dev` reproduces that: it proxies `/api` to `DEV_API_PROXY_TARGET` (the backend on port 0 by default), so the same relative URLs work in development.

### Deferred: frontend deployment under a path prefix

The frontend is currently a scaffold. Supporting the Docker-bundled console under `/axon/` is deferred and is not required for CLI installation, releases, or backend API traffic. Before rolling out the console there, align its compiled asset URLs, API base, and future router paths with the public mount and ingress prefix stripping. Keep production deployment free of extra build parameters, and document root (`/`) and custom-prefix hosting for open-source deployments. The Dockerfile currently uses the unchanged root-based frontend template.

The scaffold also does not implement `/external-auth`; backend `AUTH_SERVICE.BROWSER_LOGIN_URL` must point to the actual deployed login application.
