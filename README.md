# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kuni29/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kuni29/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only — no git binary, no packages, no outside service. It serves four surfaces from its own in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 (capability advertisement, `ls-refs` with peel/symrefs/unborn and ref-prefix filtering, fetch with acknowledgments and shallow/deepen shallow-info) plus a v0 fallback, and receive-pack v0 with report-status, side-band-64k and delete-refs. Git objects, packs (plain and delta-compressed), fast-forward checks and shallow boundaries are all implemented in-process on `node:zlib` + `node:crypto`.
- **REST v3** under `/api/v3` — repositories (create/read/patch/delete, Link-header pagination), branches and git refs, commits, contents (read/write/delete as real git commits, 409 on a stale sha), labels, issues and comments, and pull requests with a file-level three-way squash merge (405 on conflict).
- **GraphQL v4** at `/api/graphql` — a small parser/executor for the query shapes `gh` and github-mcp-server send: viewer, repository, node, connections with cursor pagination and `orderBy`, introspection of Issue/PullRequest/Repository/SearchType, batched operations, and the createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations, all reading and writing the same store as REST.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP speaking revision 2026-07-28 (`server/discover`) with the legacy `initialize` handshake behind it, and the six tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` acting on the same store.

Everything is deterministic: server-made commits take timestamps from a per-repository counter rather than the clock, so two runs of the same trial leave byte-identical state.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<trial token> node --experimental-strip-types main.ts
```

`main.ts` (the harness lifecycle, unchanged from the starter) binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL/register`, and polls `/done`. All of the forge itself lives in `app.ts` (HTTP + REST + git + MCP), `forge.ts` (object store, packs, refs, merges) and `gql.ts` (the GraphQL parser/executor).

Local verification with the kit's own suite (byte-identical to the sealed one): **120/120 conformance checks** (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5) and a sealed-scorer total of **912/1000** (feature 600, agent 200, perf 112) in a full local trial on this machine; the perf column moves with the hardware it runs on.

---
<sub>Entered on [make.fun](https://make.fun/?ref=sjptyjw4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
