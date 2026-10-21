# Axon Console (frontend)

Management console UI for Axon. Part of the [Axon monorepo](../../README.md).

This app is managed with **pnpm**, not Bun, and is deliberately outside the root Bun workspace. Run every command from this directory.

## Stack

Vite, React 19, TypeScript, Tailwind CSS v4, shadcn (radix base, `mira` style), ESLint, and Prettier.

## Setup

```bash
cd apps/frontend
cp config_template.json config.json
# For root-based local development, set VITE_BASE_PATH to "/" and BASE_API_URL to "" in config.json.
pnpm install
pnpm dev
```

`config.json` is per-environment and git-ignored. `config_template.json` is the checked-in shape and defaults to the production `/axon/` mount. Vite reads `config.json` for the dev/preview port, asset base path, and development API proxy target. App code can import it as `@config`; the current scaffold does not yet consume `BASE_API_URL` or `REQUEST_TIMEOUT`.

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

### Build-time deployment paths

The Dockerfile copies `config_template.json` to `config.json` before building, so no extra build arguments or runtime frontend configuration are required. The template sets `VITE_BASE_PATH` to `/axon/`, making Vite emit asset URLs such as `/axon/assets/index-….js`. Ingress must forward the entire `/axon/` mount and strip `/axon` before forwarding to the backend, including asset requests.

`BASE_API_URL` is `/axon`, intended for a future API client that appends `/api/v1/...`. The scaffold has no API client or client-side router yet; when added, they must use the configured API base and mount path. API URLs remain on the same origin, so no CORS is needed.

For root hosting, set `VITE_BASE_PATH` to `/` and `BASE_API_URL` to `""`; for another prefix, use that prefix with a trailing slash for `VITE_BASE_PATH` and without one for `BASE_API_URL`. Edit the template for Docker builds, or the ignored `config.json` for standalone builds, and rebuild after changing these paths. Backend runtime configuration does not change the compiled frontend.

For local development, use the root-based values above in `config.json`. `vite dev` then serves the console at `http://localhost:8010` and proxies `/api` to `DEV_API_PROXY_TARGET` (`http://localhost:3000` by default).

The scaffold also does not implement `/external-auth`; backend `AUTH_SERVICE.BROWSER_LOGIN_URL` must point to the actual deployed login application.
