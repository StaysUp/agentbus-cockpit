# AGENTS.md: working in this repository

For people and coding agents who change the AgentBus cockpit. `CLAUDE.md` is a symlink to this
file, so every agent reads the same text. Keep it a symlink.

## What this repository is

The browser cockpit for [AgentBus](https://github.com/staysup/agentbus). It shows sessions, turns,
every model call, its cost and the conversation, and it can start a turn. It is one client of the
AgentBus client API, and it uses nothing else.

## Build and test

You need Node.js 20.19 or later in the 20 line, or 22.12 or later.

```sh
npm ci
npm run dev     # http://localhost:5173
npm run build   # type-check, then write dist/
npm test
```

For live data, start the service with the cockpit's origin allowed:

```sh
agentbus up -origin http://localhost:5173
```

## The gate

A change is ready when `npm run build` and `npm test` pass, and the app renders the recorded data
with no console errors. Open it in a browser and look before saying it works.

## Data sources

- **Screens get data through one interface**, `DataSource` in `src/types.ts`. Screens never know
  which implementation they have.
- **The live source** (`src/data/LiveDataSource.ts`) uses the AgentBus client API and nothing else.
  It never reads the service's store or files. The contract is `docs/CLIENT_API.md` in the AgentBus
  repository, and a running service serves its OpenAPI description at `/api/v0/openapi.json`. If a
  screen needs data the API does not offer, ask for it in the AgentBus repository. Do not work
  around it here.
- **The replay source** (`src/data/ReplayDataSource.ts`) reads a recorded `.jsonl` file. "Use
  recorded data" on the connect screen opens it, with no service needed.
- **`testdata/sessions-v0.jsonl`** is two real Claude Code sessions recorded through the gateway,
  with the person's name and email replaced. It predates the `seq` and `turn` fields and the
  `session.registered` event, so the replay source must work without them.
- **The token stays in the browser session.** It is sent only to the service address the user
  entered.

## Conventions

- **Stack:** TypeScript, Vite and React. Keep dependencies few. A new one needs a reason in its
  commit message.
- **The look:** dense and plain. Show data rather than sentences. Use colour only for status.
- **Error text comes from the API.** When a request fails, show the API's own words.
- **Tests live in `src/__tests__/`** and run under Vitest with jsdom.

## Changes and review

- Every change is reviewed by someone other than its author before it lands on `main`.
- Keep commits small, with a message that says what changed and why.

## License

The cockpit is source-available under the Functional Source License, FSL-1.1-ALv2 (see `LICENSE`).
Each release becomes Apache 2.0 two years after it is published. Contributions are accepted under
the same license.
