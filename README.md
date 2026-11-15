# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/charry99/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/charry99/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process: no dependencies, no
git binary, no database, no UI. It serves the four surfaces an agent already
speaks — git smart HTTP, the REST v3 API, GraphQL v4, and MCP — from its own
in-memory store, and it is driven entirely by the make.fun conformance suite
(`github-core-clone-01`, $500, entries close Nov 21, 2026 12:00 IST).

## What it serves

| Surface | Route | Notes |
| --- | --- | --- |
| Health | `GET /healthz` | 200 `{"ok": true}`, no token required |
| REST v3 | `/api/v3/...` | Repositories, branches, commits and contents; issues, comments and labels; pull requests, files and merges |
| GraphQL v4 | `POST /api/graphql` | The documents `gh` and `github-mcp-server` send, plus introspection |
| MCP | `POST /mcp` | JSON-RPC 2.0 over streamable HTTP: `initialize`, `tools/list`, `tools/call` |
| Git smart HTTP | `/<owner>/<repo>.git/...` | `info/refs`, `git-upload-pack` (protocol v2) and `git-receive-pack` (v0), implemented in-process on `node:zlib` and `node:crypto` |

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. A request
without a valid token is refused with 401; a repository belongs to the login
the token names, so the same repository name under another owner is 404, never
403. Any unknown route answers 404 with a JSON `{"message": "Not Found"}` body,
never HTML. Every reply carries a non-empty `X-GitHub-Request-Id` header.

## How to run it

Requires Node 22. No install step, no dependencies, no build step — the entry
runs from source with Node 22 type stripping.

```sh
npm start
# or: node --experimental-strip-types main.ts
```

The process binds an ephemeral port (it listens on port 0, never 8080) and
then follows the trial lifecycle: it POSTs `{"port": <port>}` to
`$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done` until the suite
says `{"done": true}`, and exits 0. With no `MAKEFUN_ENV_URL` set it still
starts the server and logs the port, and skips the register and poll steps.

Environment variables:

- `MAKEFUN_ENV_URL` — the contest environment's origin (for example
  `http://store:8080` in a trial); unset for a bare local run.
- `MAKEFUN_SHOP_TOKEN` — the bearer token the suite presents on every API
  call, and the token the entry itself expects.

## Checking it locally

With the server running on some port (start it with no `MAKEFUN_ENV_URL`
set, note the port it logs), run the kit's local conformance runner against
it — the same checks the sealed suite runs, plus the four timed workloads
with `--perf`:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<port> --token "$MAKEFUN_SHOP_TOKEN" --perf
```

The kit lives at `kit/github-core-clone-01-kit/` beside this repo's build
notes; see its `RULES.txt` for the full wire contract and scoring.

## Layout

- `main.ts` — process entry point: the trial lifecycle (bind, register, poll
  `/done`, exit 0).
- `app.ts` — HTTP router: reads the full request body, routes to the four
  surfaces, adds `X-GitHub-Request-Id`, and turns dispatch errors into 500s.
- `store.ts` — the in-memory store (repositories, refs, objects, issues,
  pull requests, labels).
- `git.ts` — git smart HTTP: upload-pack v2 and receive-pack v0, pack
  reading and writing, fast-forward enforcement.
- `rest.ts` — GitHub REST v3 dispatch.
- `graphql.ts` — GitHub GraphQL v4 dispatch.
- `mcp.ts` — Model Context Protocol dispatch over streamable HTTP.

## Notes

- Deterministic: two runs on the same instance leave the same state export,
  byte for byte — no wall clock or unseeded randomness reaches anything the
  suite scores.
- A repository is created through REST (`POST /api/v3/user/repos`); a push
  cannot invent one. Every push must fast-forward: a non-fast-forward update
  is refused per ref with `ng <ref> non-fast-forward` and the ref does not
  move.
