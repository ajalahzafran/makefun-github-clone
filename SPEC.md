# github-core-clone-01 — Specification

## Goal

A standalone GitHub-compatible git forge in **one Node 22 process, standard library
only**, no dependencies, no network calls out, no `git` binary. It serves four
surfaces on one HTTP server and is graded by a sealed conformance suite (120 checks)
plus four timed workloads. Target: top 5.

## Surfaces (priority order)

1. **Git smart HTTP** — `/{owner}/{repo}.git/info/refs`, `git-upload-pack`
   (protocol v2 + v0), `git-receive-pack` (v0). Pkt-line framing, packfile
   read/write (ofs-delta + ref-delta, thin packs), object store, refs.
2. **REST v3** — `/api/v3`: repos, refs, branches, commits, contents, labels,
   issues, comments, pulls, merges. Every reply `application/json` with a
   non-empty `X-GitHub-Request-Id`; errors are JSON `{message}`.
3. **GraphQL v4** — `POST /api/graphql`: the 18 documents `gh` and
   `github-mcp-server` send (viewer, repository, issues, pull requests, the four
   mutations, introspection, `node(id:)`, batched operations).
4. **MCP** — `POST /mcp`, JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
   (`server/discover`, no handshake) with a 2025-11-25 `initialize` fallback.
   Six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
   `create_pull_request`, `merge_pull_request`.

## Contract (from the kit)

- Lifecycle (`main.ts`): bind an ephemeral port (`listen(0)`, never 8080),
  `POST $MAKEFUN_ENV_URL/register {"port": N}`, `GET $MAKEFUN_ENV_URL/done`
  until `{"done": true}`, close and exit 0. Boot budget 20 s; the env then
  `GET /healthz` twice — it must answer `200 {"ok":true}`.
- Auth: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
  (the same token is in the process environment). A request without it is 401;
  a wrong token is 401. A repository belongs to the login the token names, so
  the same name under another owner is 404, never 403.
- The token is opaque (`shpat_…`). The login it names is the contest's fixed
  scenario viewer, derived deterministically from the published fixed scenario
  seed (`6a09e667f3bcc909`, FNV-1a + splitmix64 + xorshift64* + the public
  first/last-name lists) — see `scenario.ts`. It is `adaiversen`.
- Store: in-memory, one process, fresh pod per trial. No persistence needed.
- Determinism: no wall clock and no unseeded randomness in any response. All
  timestamps come from a logical clock seeded from `MAKEFUN_TRIAL_NOW`
  (falling back to 2025-01-01T00:00:00Z) plus a monotonic counter; ids are
  counters; request ids are `req-<n>`.
- Size caps: single file ≤ 8 MiB, whole tree ≤ 16 MiB. Runtime: Node 22,
  2 CPUs, 1024 MB, 900 s wall.

## Object model

- Objects are SHA-1 of `<type> <size>\0<content>`, zlib-deflated in packs.
  Stored verbatim, byte-exact; never re-serialized on read.
- Commits carry `tree`, `parent` lines, `author`/`committer` lines, message.
  Trees are `<mode> <name>\0<20-byte oid>` entries, git-sorted (directories
  compare as `name/`). Annotated tags peel to their target.
- Reachability: commit → tree + parents; tag → target; tree → entries
  (gitlinks skipped). A fetch sends `closure(wants) − closure(haves)`, where a
  `shallow` boundary commit's parents are not traversed for the haves side.
  Depth `d` cuts the want closure at `d` generations; the boundary commits are
  reported in `shallow-info`, and previously shallow commits now inside the
  depth are reported in `unshallow`.
- Packs written are version 2, undeltified (valid; clients accept it), with a
  SHA-1 trailer. Pack reads resolve ofs-delta and ref-delta, including thin
  packs whose bases live in the store.

## REST semantics (the checks' shape)

- Repos: `POST /user/repos` → 201 (422 `name already exists` on duplicate);
  `GET /repos/{o}/{r}` → 200; `PATCH` updates description; `DELETE` → 204.
  `GET /user/repos?per_page=10` pages with a `Link: <url>; rel="next"` chain
  (same origin, ≥3 pages for 30 repos, no duplicates).
- Refs: `POST /git/refs {ref, sha}` → 201; `GET /git/refs/heads/{b}` and
  `GET /branches[/{b}]` expose branch tips.
- Commits: `GET /commits[?sha=<ref>]` lists commits reachable from the ref
  only, newest first.
- Contents: `PUT /contents/{path}` creates (201) or updates (200) a file with
  a commit, works on an unborn repo, creates a named branch from the default
  tip when asked; stale `sha` → 409. `GET` returns base64 file content or a
  directory listing. `DELETE` removes the file with a commit.
- Issues: numbers increment per repo from 1; `state` open/closed; labels must
  exist first (else 422); list filters `state` and sorts `created` asc/desc.
- Pulls: `head.sha`/`base.sha` are the branch tips; `GET /pulls/{n}/files`
  reports `filename`, `status` (`added`/`modified`/`removed`), `additions`,
  `deletions`, `changes`. `PUT /pulls/{n}/merge {merge_method:"squash"}` →
  200 `{sha, merged:true, message}`, closes the PR with `merged_at` and
  `merge_commit_sha`, and puts the squash commit (head's content) on the
  default branch; unknown PR → 404; three-way conflict → 405.
- `GET /api/v3/` → 200 + `X-OAuth-Scopes`; `GET /api/v3/meta` →
  `{"installed_version": "<non-empty>"}`. Unknown route → 404 JSON.
  Malformed JSON body → 400.

## GraphQL semantics

- Global ids are opaque base64 of `Type:<key>` (never the plain database id or
  number), stable across reads, decodable for `node(id:)` and the mutations.
- Issue/PR `state` enums are `OPEN`/`CLOSED` (`MERGED` for a merged PR);
  REST uses lowercase. `mergeable` is `MERGEABLE`/`CONFLICTING`/`UNKNOWN`.
- `repository.issues` honours `states: [OPEN]` and `orderBy: {CREATED_AT,
  DESC}` (numbers descending, ties by number DESC); cursor pagination uses an
  opaque offset cursor with `pageInfo {hasNextPage, endCursor}`.
- Unknown field → HTTP 200 with `errors` naming it; unknown repository →
  `data.repository = null` with no errors; batched array bodies answer an
  array in order; unauthenticated → 401 exactly.

## MCP semantics

- `server/discover` answers `supportedVersions: ["2026-07-28"]`,
  `capabilities: {tools: {}}`, `serverInfo`. `initialize` echoes a legacy
  revision. Notifications answer 202 with an empty body.
- `tools/list` is byte-identical across calls. Tool results carry both a
  `content` text block (JSON) and `structuredContent`. Unknown tool → -32602
  or -32601, never HTTP 500. Missing required arguments → `isError: true` or
  -32602. A non-JSON body → HTTP 400 with -32700. No auth → 401.
- Tools act on the same store as REST; ids are unchanged across reads.

## Performance (T_ref, calibrated medians)

- push 1640.82 ms / 200 sequential 1 KiB pushes; clone 266.941 ms / 50
  concurrent depth-1 clones of a 200-commit repo; read 2759.715 ms / 2000
  sequential issue GETs on one keep-alive connection; write 348.965 ms / 200
  sequential issue creates. Points per workload:
  `round(clamp(25 − 12.5·log2(t / T_ref), 0, 50))`.
- Design for speed: O(1) map lookups on the read/write paths, linear pack
  parse per push, and a memoized pack per (repo version, want set, depth) so
  the 50 concurrent clones share one pack build.

## Non-goals

- No UI, no persistence to disk, no org/team support, no webhooks, no search
  endpoint beyond the introspected `SearchType` enum, no delta-compressed pack
  writing (undeltified is valid and simpler), no `report-status-v2`.

## Verification

- Unit-style smoke tests in `test/` (Node's built-in test runner, no deps):
  pack round-trip, delta application, pkt-lines, fetch/have negotiation.
- Live tests against real `git`: create a repo through the server, clone,
  commit, push, pull, verify objects byte-for-byte.
- `curl` tests for REST/GraphQL/MCP.
- `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`
  from inside the kit; iterate until conformance passes and timings are near
  or better than T_ref.
