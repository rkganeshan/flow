# Flow UI

Vite + React frontend companion for the Flow backend.

## Scripts

- `npm run dev`
- `npm run build`
- `npm run preview`

## Local run

```bash
cd ui
npm install
npm run dev
```

The UI now starts with a real sign-up / sign-in screen.

## Authentication

The backend supports:

- `POST /v1/auth/register` to create a tenant, owner user, and bootstrap API key
- `POST /v1/auth/login` to mint a new API key for an existing tenant user
- `GET /v1/auth/me` to read the current identity

You do not need to pre-create a token for first-time use. Sign up from the UI and it will store the returned API key and tenant ID automatically.

If you already have credentials, use the advanced existing API key section on the landing screen.

## What it shows

- Authenticated identity
- Workflows list
- Workflow version history
- Draft graph editor
- Trigger form editor
- Node palette for supported node types
- Connector/edge editor
- Recent runs
- DLQ items
- Manual run creation
- Selected run timeline and node logs
- Run control actions
- DLQ resolve for owner users

## Supported node types

The UI playground is aligned to the current backend execution nodes:

- `delay`
- `http_request`
- `condition`
- `notify`

## Environment

Set `VITE_API_BASE_URL` if the API is not running on `http://localhost:3000`.

## Testing

Build the UI:

```bash
cd ui
npm run build
```

Smoke the backend and scheduler from the repo root:

```bash
npm run test:e2e:backend
npm run test:e2e:schedule
```
