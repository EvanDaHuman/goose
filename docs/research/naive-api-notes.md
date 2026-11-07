# Naive Managed Agents: implementation notes for Goose (SDK `@usenaive-sdk/vetta` 0.10.0)

Researched 2026-11-04 **without an API key**. Sources were the docs, `npm view`, and the public OpenAPI file, which needs no key. No authenticated endpoint was called and nothing here has been tested against a live organization.

**Citation keys.**
- `D:<path>:<line>` is https://vetta.sh/docs/<path>. These are the same pages as `https://usenaive.ai/docs/<path>` without `.md`. Line numbers refer to the markdown as fetched today.
- `T:<n>` is `node_modules/@usenaive-sdk/vetta/dist/index.d.ts`.
- `J:<n>` is `.../dist/index.js`.
- `OA:<operationId>` is `https://api.vetta.sh/v1/openapi.json`. It is public (`security: []`), has `info.version` `2026-09-30`, and gives the request bodies and the `x-vetta-scope` for every route. It does not describe response bodies.

**Which source wins.** Method and field names come from `T:`, request bodies from `OA:`, and behaviour from `D:`. The TypeScript snippets in the docs are often wrong for 0.10.0 (see §10).

## 0. Most important facts
1. `handoffs: false` removes `send_to_agent`, `list_agents` and `wait_for_agents` from an agent. Goose sets it on the coordinator too, so the coordinator cannot delegate (D:capabilities/tools.md:97,161; D:team/delegation.md:23).
2. Each card that reaches `done` or `blocked` triggers the board clock to start a **coordinator session** with a digest of the changes, billed to the coordinator (D:team/board.md:111-121). `run.ts` mirrors every task as a card, so every task produces a coordinator session.
3. Sessions take **no attachments**: the SDK type `SessionCreate` has no files field (T:2225-2240). To give an agent a file, upload it, put its `fil_` id in the first message, and have the agent call `fetch_file`. Outputs come back through `publish_file`, and the server reads them with `files.downloadBytes(id)` (D:capabilities/files.md:31; D:api/files.md:106).
4. The SDK **never retries**. It also uses a random `Idempotency-Key` per call unless you pass one (D:sdk/errors.md:77; J:4135-4146), so retrying `sessions.create` duplicates the session. Pass `opts.idempotencyKey` (T:8337-8339).
5. A 2xx response that fails the zod schema throws a **ZodError**, not an `ApiError` (J:4174-4179). The docs describe a `ResponseParseError` class that does not exist in 0.10.0.
6. `stop_reason` has ten values (T:102-113). `run.ts` does not treat `awaiting_input` as terminal, so it polls until its 15-minute timeout. On timeout it does not cancel the session, which keeps spending.
7. Ask-by-default tools under a `deny` default: the docs contradict themselves. Two pages say these tools stay `ask` (D:concepts/policies.md:59; D:capabilities/tools.md:34) and one says they become `deny` (D:capabilities/tools.md:496). To be safe, deny each one by name.
8. Computer: a Linux micro-VM. A session's computer is 1 vCPU / 1 GiB at **$0.0666/h**, which confirms the app's assumption (D:computer/limits-and-billing.md:30). Outbound network is open. **Python 3, pip, git and unzip are not documented** (UNCERTAIN). One page says every session of an agent shares one computer (D:api/computers.md:216), while other pages say each session gets its own sandbox.
9. Scopes: every read needs a `*:read` scope (OA). The key-creation command in `.env.example` only grants `agents:write,sessions:write,files:write,billing:read`. Whether `:write` implies `:read` is UNCERTAIN.
10. Only the commercial and coordinator agents ever run on Naive (lib/agents.ts). The modernization and verification agents, which have the sandbox and file tools, are provisioned but never called.

## 1. Package, auth, transport, errors
- **Versions.** `npm view @usenaive-sdk/vetta versions time dist-tags` gives 0.1.0 (2026-08-23), 0.2.0, 0.3.0, 0.4.0, 0.5.0, 0.5.1, 0.6.0, 0.7.0, 0.8.0, 0.9.0 (2026-10-16) and **0.10.0 (2026-10-20T19:31:06Z) = latest**. Goose pins 0.10.0, so it is current. The tarball has no CHANGELOG and the docs have no changelog page, so there are no breaking changes to report. README.md:13 still says "Not published to a registry yet"; that is stale.
- **Package shape.** ESM only, Node ≥20, and one runtime dependency, `zod ^4.4.3` (package.json).
- **Client.** `createClient({ baseUrl, apiKey, fetch, idempotencyKey })`. In 0.10.0 all four fields are required: there are no defaults in either the types or the code (T:21-28; J:6105). The docs claim `fetch` and `idempotencyKey` have defaults (D:sdk/typescript.md:35); that is wrong for this version.
- **Base URL.** The REST base is `https://api.vetta.sh/v1` (D:api/overview.md:16). The SDK paths already start with `/v1`, so `baseUrl` must be `https://api.vetta.sh`, which matches README.md:23 and the default in config.ts.
- **Headers on every call** (J:4135-4146): `authorization: Bearer <key>`; `vetta-version: 2026-09-30` (from `API_VERSION`, J:206, not configurable); `accept`; `content-type: application/json` for JSON bodies (FormData gets none, so `fetch` sets the boundary); `idempotency-key: config.idempotencyKey()` on POST, PATCH, PUT and DELETE (J:4087).
  - Only `sessions.create`, `sessions.send` and `sessions.handoffs` accept a per-call `{ idempotencyKey }` override (T:8337, 8580-8587; J:5228).
- **Environment variables.** The SDK reads none (no `process.env` in J). `VETTA_API_KEY` and `VETTA_API_BASE_URL` are CLI variables (D:quickstart.md:46). Live keys look like `sk_live_…` and are shown once (D:api/authentication.md:19-23). `GET /v1/me` reports the organization's `mode` as `live` or `test` (T:2322-2329).
- **Date versions.** Since version `2026-09-01`, unknown body keys and unknown query parameters are **refused with 400**, not ignored (D:api/overview.md:33). The SDK does **not validate request bodies**; it only calls `JSON.stringify` (J:4148-4155). A misspelled field therefore only fails on the server.
- **Idempotency** (D:api/overview.md:84-95): the same key with the same body replays the original response (`Idempotency-Replayed: true`); a concurrent request with the same key gets 409 while the first is in flight; keys are kept 24 hours.
  - Same key with a different body returns 409, with code `validation_failed` per the overview (:90) but `idempotency_conflict` per D:api/errors.md:84. UNCERTAIN which.
- **Rate limits** (D:api/overview.md:115-133): 6000 requests/min per organization and 3000/min per key (fixed 60-second window); over the limit, `429 rate_limited` with `Retry-After` and `RateLimit-Limit/Remaining/Reset`. At most 50 sessions `running` at once; the rest wait as `queued`.
- **Errors.** Every non-2xx response throws `ApiError { status, type, code, message, requestId, param }` (T:34-41). A body that is not the error envelope becomes `code: "internal_error"` (J:4156-4165). Codes (D:api/errors.md:65-96):

  | HTTP | Codes |
  | - | - |
  | 400 | `validation_failed`, `window_unavailable` |
  | 401 | `unauthorized` |
  | 402 | `budget_exceeded`, `insufficient_credits`, `subscription_required` |
  | 403 | `forbidden` (scope, role or tool policy). The SDK docs call it `insufficient_scope` (D:sdk/errors.md:86). UNCERTAIN. |
  | 404 | `not_found`. Also returned for a real id that belongs to the other mode (live vs test). |
  | 409 | `version_conflict` (the SDK docs say `conflict`, D:sdk/errors.md:88), `idempotency_conflict`, `state_conflict`, `session_running`, `session_terminal`, `computer_unavailable`. `job_not_ready` and `compliance_pending` mean "retry later". |
  | 429 | `rate_limited` |
  | 500 | `internal_error` |
  | 501 | `feature_not_configured` |
  | 502 | `provider_error` |

- **Retries.** Documented policy: back off on 429 (honour `Retry-After`) and on transient 5xx; 400/401/402/403/404 are terminal; for 409 branch on `code` (D:api/errors.md:107). Only `client.stream` reconnects by itself (up to `maxRetries`, default 5, no backoff; J:5873-5900).
  - **Implement retries inside the injected `fetch`.** Headers are computed once per SDK call, so a fetch-level retry resends the same Idempotency-Key and is safe.
- **Scopes per route** (OA; D:api/authentication.md:25-39):

  | Scope | Routes |
  | - | - |
  | `agents:write` | create, update, delete and rollback agents; create boards and cards; patch cards; comment |
  | `agents:read` | list and get agents, read versions, read boards and cards |
  | `sessions:write` | create, send, handoffs, interrupt, tool_confirmations, answers, cancel, budget, plan PUT |
  | `sessions:read` | get, list, events, stream, threads, plan |
  | `files:write` | upload, uploads, imports, publish, patch, delete |
  | `files:read` | list, get, download, url |
  | `billing:read` | balance, subscription, ledger, and `GET /v1/agents/{id}/spend` |
  | `computers:write` | exec, fs, inspect |
  | `audit:read` | session workspace tarballs |
  | none | `GET /v1/me` and `/v1/models` still need a key but no scope |

  The quickstart creates a key with only `agents:write,sessions:write` (D:quickstart.md:144), which hints that `write` may imply `read`. UNCERTAIN, so grant the read scopes explicitly.

## 2. Agents
- **Methods** (T:3140-3622): `agents.create(body: AgentCreate)` (POST /v1/agents, 201); `get(id)`; `update(id, AgentPatch & { expected_version? })` (PATCH); `getVersion(id, n)`; `delete(id)` → `{ id, object, deleted }`.
  - `list(query?: { limit?, after? })` → `{ data, has_more, next_cursor }`; `limit` must be 1–100 or 400 (D:api/pagination.md:15). `listVersions(id)` returns everything in one unpaginated page (D:api/agents.md:388).
  - `rollback(id, { to_version, expected_version? })` mints a new version cloning `to_version` (J:5143). `spend(id, { by?: "component" })` → `{ agent_id, period, period_start, spent_micro_usd, by_component? }` (T:3570-3578). `computer(id)` → `Computer | null`.
- **Required on the wire:** `name`, `model`, `budget` (OA:createAgent). The SDK type `AgentCreate` only requires `name` and `model` (T:2220), so TypeScript will not catch a missing `budget`; the server refuses it (D:concepts/budgets.md:13).
- **Other fields and their defaults** (OA:createAgent):
  - `harness`: `"pi"` (default), `"claude_code"`, `"vetta"` or `"hermes"` (T:434-439). Only `pi` supports approvals and structured output (D:concepts/harness-capabilities.md:25-26). `window`: `"immediate"` (default), `"priority"` or `"loose"`.
  - **`system`** is the instructions / system prompt (string, default `""`). `tools`, if omitted, defaults to `{default_config:{permission:"allow"}, configs:{}}`, which means **allow everything**.
  - `mcp_servers` (≤20, https only); `skills` (`slug[@n]` or `naive/slug`); `multiagent` (default `false`); `handoffs` (default `true`); `output_schema` (default `null`); `structured_output_required` (default `false`, needs an `output_schema`); `description`; `metadata`; `model_selection`.
  - `notifications {email, approvals, questions, updates}` is accepted on the wire but **not in the SDK types**.
- **Budget shape:** `{ cap_micro_usd: int, max_task_micro_usd: int, period: "day"|"week"|"month" }`. Values are plain integers in micro-USD, not strings (T:418-426; J:178).
- **Model:** a plain string id (T:365; OA minLength 1). The docs also allow an object `{id, effort}` (D:concepts/model-router.md:325), but neither 0.10.0 nor the OpenAPI accepts it.
  - The catalogue is **live** ("hundreds of models") and there is no curated list (D:concepts/model-router.md:57-68).
  - `models.list({search?, window?, limit?, after?})` and `models.retrieve(id)` (the id is URL-encoded; an unknown id returns 404) return `{object:"model", id, context_window, max_output_tokens, supported_windows, efforts}` (J:5121-5129, J:5151-5160). Both calls need a key.
  - **No per-token prices are published anywhere.** "The model object publishes no prices" (D:concepts/model-router.md:120).
  - Model ids mentioned in the docs:
    - `zai-org/GLM-5.2-FP8`: context 1,048,576, max output 32,768, all three windows (D:concepts/model-router.md:107-115).
    - `vetta/auto`: `immediate` only, held against a price ceiling of $5 per million input tokens and $25 per million output tokens, then billed at the rate of the model that actually answered (:158-167).
    - Also mentioned: `moonshotai/Kimi-K2.6`, `google/gemma-4-31B-it`, `anthropic/claude-sonnet-4.5`, `google/gemini-3-flash`, `openai/gpt-5.6-sol`, `openai/gpt-oss-120b`.
- **Versioning** (D:api/agents.md:267-308):
  - Each PATCH mints an immutable version. A no-op patch, or one that only renames, does not.
  - A stale `expected_version` returns **409 `version_conflict`**. Omitting `expected_version` means last write wins.
  - A session pins `agent_version`, which defaults to `current_version` (D:api/sessions.md:197). Running sessions keep the config they started with (D:capabilities/tools.md:35).
- **Toolset** (T:336-353): `{ default_config:{ permission }, configs:{ [tool]: { enabled: boolean, permission: "allow"|"ask"|"deny", config?: {} } } }`.
  - `allow` runs the tool silently. `ask` emits `tool.confirm` and parks the session with `awaiting_approval`. `deny` means the tool is never offered to the model (D:concepts/policies.md:24-28).
  - A PATCH replaces `configs` as a whole. Use `withTool(tools, name, {enabled?, permission?, config?})` (T:3136; J:6083) to change one entry. It throws if the name is neither a built-in nor namespaced.
  - Web tool config: `{ allowed_domains?, blocked_domains?, max_content_tokens? = 4000 }` (T:3104-3111).
- **Built-in tool names.** The exact list is in J:1334-1404; descriptions are from D:capabilities/tools.md:37-88.
  - **Sandbox tools** (only offered when the session has a computer, D:capabilities/tools.md:163):
    - `bash` runs `bash -c` in a non-login shell. stdout and stderr are buffered and each is capped at 262,144 characters; the result includes `exit_code` (D:computer/shell.md:9,49-52).
    - `read`, `write`, `edit` (string replace), `ls`, `find` (by name or pattern).
    - There is **no `grep`**; use `bash`.
  - **Files:**
    - `publish_file{path, name?, content_type?, title?, tags?, folder?}` mints a new published file id.
    - `fetch_file{file_ids ≤8, dir?}` returns `{files:[{file_id, path, bytes, content_type}]}`.
    - `find_files` returns metadata only. `view_image` shows up to 4 images.
  - **Web:** `web_search`, `web_fetch`.
  - **Team:** `send_to_agent`, `wait_for_agents`, `list_agents`, `board_read`, `board_write`, `post_to_channel`, `project_context`.
  - **Human in the loop:**
    - `ask_operator`: the agent asks a question and the session parks with `awaiting_answer`. It can **never** be set to `allow`.
    - `request_tools`: also never `allow`.
    - `write_plan` and `propose_plan`: plan mode.
    - There is **no "answer" tool**. You answer through `sessions.answer` (REST).
  - **Information:** `session_spend` (read-only, free), `show`, `compose`, `open_panel`, `read_skill`.
  - **Browser and phone:** `browser` (actions: goto, click, type, act, extract, observe, links, screenshot, login, signup, save_context) and `mobile`.
  - **Media and data:** `generate_image`, `generate_video` (`edit_video` follows its setting, J:1405), `clip_video`, `build_media_skill`, `generate_3d_model`, `build_3d`, `create_character`, `get_character`, `list_characters`, `delete_character`, `transcribe_audio`, `generate_speech`, `generate_sound_effect`, `generate_music`, `find_stock_photo`, `data_search`, `data_describe`, `data_run`, `apps`.
  - **Added automatically:** `submit_output` whenever an `output_schema` is set. Tool permissions do not apply to it (D:capabilities/structured-outputs.md:102-111).
  - **Namespaced tools:** `<connector>.<tool>`, for example `email.send`, `email.read`, `company.set_timezone`, `company.set_logo`, `company.set_brand`. The three `company.*` tools are offered to **every** session (D:capabilities/tools.md:530).
- **Ask-by-default tools** (D:capabilities/tools.md:496): `social.post`, `email.send`, `legal.*`, `wallet.pay`, `wallet.transfer`, `card.*`, `trading.*` writes, `company.set_*`, `apps.request_access`, `mobile`, `data_run`, `generate_video`, `edit_video`, `create_character`.
  - `create_character`, `apps.request_access`, `company.set_logo` and `company.set_brand` can never be `allow` (J:1406-1407).
  - Under a deny default, whether these tools become `ask` or `deny` is UNCERTAIN (see §0 item 7). Only an explicit per-tool entry is guaranteed to deny one (D:concepts/policies.md:59).

## 3. Files
- **Upload:** `files.upload(form: FormData)` (T:9991; J:6021) sends `POST /v1/files` as multipart, capped at **25 MiB** (D:api/files.md:146).
  - Form parts (OA:uploadFile): `file` (required); `scope` (`"published"` default, or `"session"`); `session_id` (required when `scope` is `"session"`); `name`; `title`; `description`; `tags` (one **comma-separated string**); `folder`.
- **Larger uploads, up to 60 MiB:** call `files.createUpload({name, content_type, size_bytes ≤ 62,914,560, folder?})`. It returns `{object:"file_upload", file_id, upload_url, expires_at}`. Then PUT the raw bytes to `upload_url` within 15 minutes, with no key and the exact `Content-Type` and `Content-Length` you declared (D:api/files.md:179-214).
- **Server-side import:** `files.import({url, title?, description?, tags?})` fetches a public URL (max 25 MiB). It requires an Idempotency-Key (D:api/files.md:216-268).
- **Getting a file into a session.** There is **no mount and no `files[]` field on session create**. Put the `fil_` id in the first `message` and let the agent call `fetch_file`, or paste small content inline (D:capabilities/files.md:31; D:api/files.md:106).
  - `fetch_file` needs a computer; without one it fails with `computer_unavailable`.
  - It takes at most 8 ids per call and 5 GiB per file.
  - `dir` is relative and confined to the working directory.
  - Ids are resolved against your organization's library only (D:capabilities/tools.md:421-453).
- **Getting a file out.** The agent calls `publish_file(path, …)`. It returns the new published file's id, name and size, which the agent can put into its structured output (D:capabilities/files.md:58-87).
  - Files are up to 5 GiB.
  - Names are **not unique**, so key off the returned id (:91).
  - Published files survive the session; files that only lived in the sandbox are released when the session is cancelled (:133).
- **Reading outputs from the server:**
  - `files.list({ session_id, scope:"published", agent_id?, kind?, tag?, search?, ids?, order?, limit?, after? })` returns a page (T:2464-2482).
  - `files.get(id)` returns metadata.
  - `files.downloadBytes(id)` returns a `Uint8Array` via `GET /v1/files/{id}?download=true`. Supports `ETag` and `Range`.
  - `files.download(id)` returns a **string**, which corrupts binary content (J:6025-6027).
  - `files.url(id)` returns `{object:"file_url", url, expires_at}`: a link that works without a key for **7 days** (D:api/files.md:314-342).
  - `files.publish(id)` promotes a session-scoped file. It is idempotent.
- **File object fields** (J:1222-1235): `id (fil_), name, content_type, size_bytes, scope, session_id, sha256, created_at, kind, title, description, tags, folder, source, agent_id?`. Tags are limited to 32, each up to 64 characters (D:api/files.md:63).

## 4. Computer (sandbox)
- **What it is.** A "disposable Linux micro-VM" with a filesystem, a shell, and an optional browser (D:capabilities/computer.md:9).
- **Size.** A **session's computer is 1 vCPU / 1 GiB** (D:computer/limits-and-billing.md:30). Computers you create yourself default to 2 vCPU / 4 GiB, with a range of 1–16 vCPU and 128–65,536 MiB, and disk up to 100 GiB (D:computer/sandbox.md:17-23). You do not attach a computer to an agent; a session gets one only if its tools need it (D:quickstart.md:97).
- **Preinstalled tools.** The docs say nothing about Python 3, pip, git, unzip or the OS image: **UNCERTAIN**. Indirect evidence:
  - `build_3d` runs "a clean Python process on the agent's computer", and its toolchain "installs on first use" (D:capabilities/3d.md:38).
  - Workspace archives offer `?kind=diff`, the `git diff HEAD` of a repository in the workspace (D:api/sessions.md:563).
  - The tools page notes an agent "can install `ffmpeg`" (D:capabilities/tools.md:418).

  **Recommendation:** have the agent's first step run `command -v python3 pip3 git unzip; python3 -V` and install anything missing.
- **Paths.** The home directory is `/home/user` in the examples. The docs say to read it from `computers.inspect` rather than assume it (D:computer/filesystem.md:21). Tool examples use `/workspace` (D:capabilities/tools.md:426). Have the agent use relative paths.
- **Network:**
  - Outbound access is **open by default** (D:computer/networking.md:13).
  - From `bash`, 169.254/16, 10/8 and 172.16/12 are blocked; 192.168/16 is "not reliably" blocked; there is **no filter by host** (:17-31).
  - Nothing can reach the computer from outside: there is no port exposure (:39).
  - The only hard kill-switch is `allow_outbound:false` at computer creation, and you do not create an agent's computer.
- **Limits** (D:computer/limits-and-billing.md:50,72-79): shell output 262,144 characters each for stdout and stderr; `fs` read/write 4 MiB per call; `publish_file` / `fetch_file` 5 GiB per file; 25 computers per organization at once.
  - Computer lifetime is `max_duration_hours` (default 12 h, wall-clock); it is auto-destroyed after that or when the balance hits zero.
  - REST `exec` timeout defaults to 30,000 ms (D:api/computers.md:277). The `bash` tool's default timeout is not documented.
- **Persistence across sessions of one agent.** The docs CONFLICT:
  - "Each agent has one computer, and every session of the agent works on it and sees the same files", paused after a few idle minutes and removed when the agent is deleted (D:api/computers.md:216-227; also T:596 `agent_id`, `agents.computer` J:5147).
  - Against that: the session's computer "belongs to the session … destroyed when the session ends" (D:api/sessions.md:43), and "Sessions always get their own sandbox" (D:quickstart.md:151).

  UNCERTAIN. Design for both cases: work in `jobs/<jobId>/<attempt>/`, delete it at the end, and never rely on files persisting. Publish whatever must be kept.
- **Lifecycle:** running, sleeping (woken automatically), parked (needs an explicit resume), destroyed (D:computer/sandbox.md:53-67). Volumes and snapshots exist (D:computer/snapshots-and-volumes.md). An agent can't be given a specific computer yet: "`computer` (coming soon)" (D:concepts/sessions.md:76).

## 5. Sessions
- **Create:** `sessions.create(body: SessionCreate, opts?: { idempotencyKey? })` sends `POST /v1/sessions`. It creates **and starts** the session; the response is often `status:"queued"` (D:api/sessions.md:189,252).
  - Required: `agent_id`, `message: string`.
  - Optional: `agent_version`, `window`, `budget_micro_usd` (integer), `deployment_id`, `output_schema` (must be `type:"object"` with at least one property, J:180-185), `structured_output_required`, `metadata` (echoed on events), `mode` (`"plan"` or `"build"`), `identity` (`idn_…` or a name) (T:2225-2240; OA:createSession).
  - OA also accepts `outcome`, which is not in the SDK type.
  - The docs list `computer`, `skills`, `vault_ids` and `overrides` as "coming soon"; none is accepted (D:concepts/sessions.md:70-108).
  - The **message format is plain text**. There is no structured message type.
- **Status values** (T:207-214): `queued`, `running`, `idle` (resumable), `completed` (terminal: the agent declared the task done), `failed` (terminal), `cancelled` (terminal).
- **`stop_reason` values** (T:102-113; D:concepts/sessions.md:136-147):
  - `end_turn`: the normal resting state.
  - `awaiting_input`: nothing is owed; the session waits for your next message.
  - `awaiting_approval`: a tool with `ask` permission is waiting in `pending_actions`.
  - `budget_paused`: a cap was hit, or the balance ran out.
  - `interrupted`
  - `max_iterations`: the per-slice step cap was hit. Send another message to continue.
  - `context_exhausted`: the turn produced neither a message nor a tool call.
  - `awaiting_delegation`: the coordinator is waiting for its delegated threads. No reply unblocks it.
  - `awaiting_answer`: every parked row is a `kind:"question"`.
  - `error`: resumable. This is also what you get when `structured_output_required` is not satisfied.
- **Session fields** (T:188-309): `consumed_micro_usd`, `budget_micro_usd`, `token_usage{input, cache_write, cache_read, output, reasoning}`, `pending_actions[]`, `output_schema`, `structured_output`, `last_seq`, `model`, `mode`, `computer_id`, `parent_session_id`, `root_session_id`, `thread_role`, `started_at`, `ended_at`.
  - `budget_micro_usd` is always set; if you don't give one it falls back to the agent's `max_task_micro_usd` (D:api/sessions.md:63).
  - The API also returns `stop_code` (D:api/sessions.md:53-55), but **the SDK strips it**.
- **Waiting for a result:**
  - Poll `sessions.get(id)`.
  - Or use `client.stream(id, { afterSeq?, maxRetries? })`, an `AsyncGenerator<Event>` that **returns at each `session.idle`** (D:sdk/streaming.md:43). It silently skips any frame that fails `EventSchema` (J:5886-5888), so treat polling as the source of truth.
  - Or read events in pages with `sessions.events(id, { after_seq?, limit? (default 20, max 100), includeAccepted? })`, which returns `{data, has_more, next_cursor}` (T:9112-9127). `after_seq` is exclusive, and events are kept for at least 72 hours (D:api/events.md:86-98).
  - **This event log is the transcript; there is no messages endpoint.**
  - Event payloads differ between pages. `tool.completed` is `{name, result, duration_ms}` in D:api/events.md:46 but `{name, output, is_error}` in D:quickstart.md:118. Parse `data` defensively; it is typed `Record<string, unknown>` (T:506).
  - Other useful events: `session.usage {token_usage, consumed_micro_usd, active_seconds, tool_calls}` and `session.idle {stop_reason, pending_actions?, structured_output, error?, code?, background?}` (D:api/events.md:54-55).
- **Structured output:** read `session.structured_output`, an object or null.
  - The agent submits it by calling `submit_output`.
  - With `structured_output_required: true`, failing to submit leaves the session `idle` with `stop_reason:"error"`, and the `session.idle` event carries `error` (D:capabilities/structured-outputs.md:90-116).
  - `pi` serves typed results. `vetta` declares the capability but can't serve it (D:team/delegation.md:163).
- **Follow-ups:** `sessions.send(id, { message, interrupt?, queue?, model?, mode? }, { idempotencyKey? })` returns 202 `{ session_id, status, accepted_seq }`.
  - Sending to a `running` session without `interrupt` or `queue` fails with 409 `session_running`.
  - Wait for events with `seq > accepted_seq` (D:api/sessions.md:322-363). The `hint` field in the reply is stripped by the SDK.
- **Approvals** (`awaiting_approval`, `pending_actions[].kind:"tool"`): call `sessions.confirmTool(id, { tool_call_id, decision:"allow"|"deny", reason?, scope?:"call"|"session" })`. It returns 202 with the session (D:api/sessions.md:390-428).
- **Questions** (`kind:"question"`, `name:"ask_operator"`, `question{prompt, fields[1–3]{key, label, type: text|choice|media|connect, optional?}}`): call `sessions.answer(id, { tool_call_id, answers: Record<string, string | string[]> })` (T:8777).
  - Every non-optional field must be answered, and `""` is rejected (D:api/sessions.md:463-479).
  - **Branch on `kind`.** A session parked on both kinds reports `awaiting_approval` (D:concepts/session-operations.md:125-129).
  - The session resumes automatically once the last pending row is resolved.
  - A parked tool costs nothing while it waits (D:concepts/policies.md:72).
- **Control:**
  - `sessions.interrupt(id, { message? })`: the session stays resumable.
  - `sessions.cancel(id)`: terminal; releases the sandbox. Sessions **cannot be deleted or archived** (D:concepts/session-operations.md:236).
  - `sessions.setBudget(id, capMicroUsd)` sends PATCH with `{cap_micro_usd}`. **Raise only**: a cap at or below what has been consumed fails with 400. A raise resumes a `budget_paused` session automatically (D:api/sessions.md:525-546).
  - Other methods: `sessions.list({ agent_id?, status?, stop_reason?, parent_session_id?, … })`, `threads(id)`, `plan(id)`, `writePlan(id, …)`, `handoffs(id, {agents ≤6, message, handoff_key?, budget_micro_usd?})`.
- **Workspace tarball:** `GET /v1/sessions/{id}/workspaces/{end|card_start|card_end}[?kind=diff]` returns a `tar.gz` (scope `audit:read`). There is no SDK method; call the exported `send(client.config, call, "*/*")` (D:api/sessions.md:563-565; T:53).
- **Maximum duration:** no session-level cap is published. Turns run in slices with a step budget and a wall-clock budget, but the numbers are not given (D:concepts/runtime.md:30). Sessions can sit idle for days, and the computer lives at most 12 h by default (§4). UNCERTAIN.

## 6. Team / multiagent / board
- **Coordinator config** (T:396-412; J:1468-1487): `multiagent: { type:"coordinator", agents: [ {type:"agent", id:"agt_…", version?} | "agt_…" | {type:"self"} | {type:"advisor", model} ], board?: boolean }`.
  - 1 to 20 entries; at most one `self`.
  - `advisor` entries are **refused at save** (D:team/coordinator.md:133-151).
  - Sending `null` clears the roster; `false` is the default.
  - Members must be referenced by `agt_` id; names are rejected (D:team/coordinator.md:79).
- **Version pinning.** If you omit `version`, the server pins each member's current version at save time. Members **never pick up their own later edits** until you re-save the roster (D:team/rosters-and-versioning.md:28-30).
- **Checks at save** (:36-46): the member exists, its version exists, it is not itself a coordinator, it is runnable, and its harness can serve typed results and approvals if its own config needs them.
- **Delegation tools.** These are model tools, not REST calls.
  - `send_to_agent{agent (name), message ≤20,000 characters, wait, output_schema? (wait:true only), handoff_key? / budget_micro_usd? (wait:false only)}` returns at once.
  - `wait:true` runs the member as a **thread of the coordinator's session, on the coordinator's budget**.
  - `wait_for_agents{}` parks the coordinator with `awaiting_delegation`.
  - `wait:false` starts a separate top-level session on the target's own budget (D:team/delegation.md:38-77).
  - Members cannot use `wait:true` (`no_delegation`).
  - Refusals come back to the model as tool results: `unknown_agent`, `no_structured_output`, `at_capacity`, `handoff_only`, `wait_required`, `forbidden`, `not_found` (:87-95).
  - All of these require `handoffs` to be anything but `false` (:23). `"team"` limits them to roster names plus the company CEO, and is refused if the agent has no roster (D:api/agents.md:171).
  - Threads appear as `thread.created`, `thread.idle` and `thread.terminated` events on the coordinator, and through `sessions.threads(id)` (D:team/context-and-budgets.md:65-71).
- **Board methods** (T:4340-4493; J:4623-4667). `boardRef` is a `brd_` id **or the owning agent's `agt_` id** (T:2934).

  - `board.create(agentId)` is an "ensure" (201 if it created the board, 200 if it existed). `board.get(ref)` returns counts per column.
  - `cards.list(ref, {limit, after})` sorts by column before paging, so always page. Also `cards.ofAgent(agentId)`, `cards.get(ref, cid)`, `cards.assign(ref, cid, name | null)`, `cards.comments(ref, cid)`, `cards.comment(ref, cid, {body})`.
  - `cards.create(ref, { title ≤200, body? ≤20,000, status?, assignee? (agent **name**), blocked_by?: crd_[] ≤50, key? ≤128 })`. `key` makes the create idempotent: the same key returns the same card with 200 (D:team/board.md:221).
  - `cards.update(ref, cid, { title?, body?, status?, assignee?, blocked_by?, note? ≤20,000 })` is the operator override and outranks the claim guards (:229).

- **Card statuses are fixed:** `todo`, `doing`, `blocked`, `done` (T:522-527).
  - **`done` needs a note**, either on the call or already on the card. `done` is terminal and never reopened (D:team/board.md:56).
  - When everything in a card's `blocked_by` is done, it heals back to `todo`.
  - **Assigning a `todo` card with no open blocker wakes the assignee**: it starts a top-level session of that agent, on its own budget, and records `woken_session_id` (D:team/board.md:62-80). A card gets at most 3 wakes (J:1722).
  - A woken session that ends while its card is still `todo` or `doing` gets the card parked as `blocked`.
  - **Every card that becomes `done` or `blocked` triggers one digest session per board for the owner**, on the next tick of the clock, which runs about once a minute (:111-121).
- **Board tools inside sessions:** `board_read{status?, owner?, card_id?, limit?}` and `board_write{op: create|update|comment|assign, …}`. They are only offered to sessions seated on a board, and they still follow the tool policy (D:team/board.md:132-197).

## 7. Budgets and policies (D:concepts/budgets.md; D:concepts/policies.md)
- **Fields:**
  - `cap_micro_usd` is what the agent may spend in each `period` (`day`, `week` or `month`).
  - `max_task_micro_usd` is the most a single session/task may spend, "even if the period cap has room" (budgets.md:107-121).
  - All money is integer micro-USD.
  - The docs' TypeScript example `capMicroUsd: "50000000"` is **wrong for 0.10.0** (:33).
- **Pre-flight gate:** before every model call or priced tool call, the platform quotes the worst case at the session's window, then checks in order (:59-64):
  1. the organization balance;
  2. the agent cap minus what the agent has spent this period;
  3. `max_task_micro_usd` minus what this session has spent;
  4. the session budget.

  If the call would breach any of these, it is refused and a `budget.exceeded {estimate_micro_usd, remaining_micro_usd}` event is emitted. For a model call, the quote is input tokens plus `max_output_tokens` at the output rate (D:concepts/model-router.md:135-139).
- **Effective cap per session** is the smaller of `max_task_micro_usd` and `budget_micro_usd`. A session budget above the task ceiling does nothing. For handoffs the server clamps it (D:api/sessions.md:302); for create, UNCERTAIN.
- **`budget_paused`:** a session stopped by the period cap or the task ceiling **resumes when you raise that number**, through an edit or a rollback; this covers sessions paused in the last 7 days. A session given its own budget resumes when you raise *that* with `setBudget`. A top-up resumes sessions that the balance stopped (budgets.md:68).
  - Rules: a new cap must be strictly greater than what has been consumed, and removing a cap is one-way (:84-88).
- **Booked after the fact, so not bounded by `max_task_micro_usd`:** web tools, media, computer time, browser and mobile (D:platform/pricing.md:49,146).
- **Policies:** two layers, the organization default and the agent override. `allow`, `ask` and `deny` are resolved on every tool call (policies.md:13-28). `ask` emits `tool.confirm` and parks `awaiting_approval`; the approver is recorded (:63-72). Scoping by connections and primitives, `{primitives, connections:{mode: open|allowlist|blocklist, list}}`, is described (:78-105) but **is not in the agent schema** (T:364-442; OA). UNCERTAIN.

## 8. Readiness checks (billing and status)
- **`auth.me()`** sends `GET /v1/me` (no scope) and returns `{ object:"identity", principal{type: user|key|system, id}, organization{id, name, mode: live|test} | null, scopes[], user | null, creator? }` (T:10424-10450).
- **`credits.subscription()`** returns `{ object:"subscription", status: "none"|"active"|"past_due"|"canceled", current_period_end, grace_until, cancel_at_period_end, action_url, plan?: "standard"|"pro"|null, price_micro_usd?, included_credit_micro_usd?, trial_end?, pending_plan?, trial_eligible?, trial_days?, trial_credit_micro_usd?, plans_available? }` (T:10838-10854).
  - A free trial shows `status:"active"` with `trial_end` set (D:sdk/credits.md:68).
  - Every route outside billing returns 402 `subscription_required` until the plan is active (:66).
  - **`past_due` keeps working until `grace_until`** (D:api/credits.md:274).
- **`credits.show()`** returns `{ object:"credit_balance", balance_micro_usd: int, mode: "live"|"test" }` (T:10794).
- **Ledger:** `credits.ledger({type?, session_id?, agent_id?, deployment_id?, from?, to?, limit?, after?})` returns rows with `line_items[{tier, amount_micro_usd}]`. Tiers: `input`, `output`, `cache_write`, `cache_read`, `reasoning`, `computer`, `search`, `media`, `browser`, `mobile`, `social`, `storage`, `email`, `voice` (T:10810-10836).

## 9. Pricing (D:platform/pricing.md; D:computer/limits-and-billing.md)
- **Computer:** $0.000014/s per vCPU and $0.0000045/s per GiB of memory, per running second (limits-and-billing.md:21-22). A session's 1 vCPU / 1 GiB computer is **$0.0666/h = 18.5 µUSD/s**, so `config.ts` `computerMicroUsdPerSecond: 18.5` is correct (:30). The pricing page repeats "$0.0666 an hour" (pricing.md:93).
  - No creation fee.
  - Paused or sleeping costs nothing according to limits-and-billing.md:27, but sandbox.md:47 says storage is metered above 5 GiB free. They conflict.
  - Self-created 2 vCPU / 4 GiB computers cost $0.1656/h.
- **Plans:** Standard $20/month (includes $20 credit; 7-day trial with $10 credit) and Pro $200/month (includes $200) (pricing.md:13-24).
- **Models:** priced per token across five tiers at the completion window's tariff. **No per-model price table exists** ("no prices", D:concepts/model-router.md:120). Relative prices only: `immediate` > `priority` > `loose`.
- **Tools:** `web_search` $0.00166/call, `web_fetch` $0.00083/call (pricing.md:55-56), browser $0.10/h plus $0.01 per model-driven action, mobile $0.03/min, email $0.0008 per send. Media is billed at the actual cost of each finished job.

## 10. Where the docs and SDK 0.10.0 disagree (follow the types)
- **Budget fields.** The docs use `budget {capMicroUsd:"…"}`, `{capUsd}` and `cap_usd` (D:concepts/budgets.md:33; D:team/coordinator.md:26,50; D:capabilities/structured-outputs.md:47). The SDK uses `{cap_micro_usd, max_task_micro_usd, period}` as numbers.
- **Session create.** The docs write `sessions.create({agent, budgetMicroUsd:"…", outputSchema})` and call `session.send()` / `session.stream()` on the session object (D:concepts/sessions.md:38-66,115). The SDK uses `{agent_id, message, budget_micro_usd, output_schema}`, `client.sessions.send(id, {message})` and `client.stream(id)`.
- **Create without a message.** The docs say a session can be created without a message and starts `idle` (D:concepts/sessions.md:30). In reality `message` is **required** (T:2227; OA).
- **Listing a session's files.** The docs use `files.list({sessionId})` and get back an array (:161). The SDK takes `session_id` and returns a page.
- **Computers.** The docs show `computers.exec(id, {command, cwd, env, timeoutMs})` (D:computer/shell.md:25) and `computers.create({memoryMb, …})` (D:capabilities/computer.md:31). The SDK has `exec(id, command, timeoutMs?)` (T:9248) and snake_case `memory_mb` / `disk_gb`.
- **Methods in the docs that are missing from 0.10.0:** `ResponseParseError` (D:sdk/errors.md:61), `sessions.setOutcome` (D:sdk/sessions.md:231), `files.move`, `files.folders`, `files.deleteMany` (D:sdk/files.md:156-216), `credits.spend` and `subscription({includePaymentMethod})` (D:sdk/credits.md:41-52), and `events()` returning `skipped` (D:sdk/sessions.md:263).
- **Error codes.** The SDK docs use `insufficient_scope` and `conflict`; the API docs use `forbidden` and `version_conflict`.
- **Fields the SDK strips from responses:** session `stop_code`, `pending_actions[].parked_seq` (D:api/sessions.md:121-123), the send `hint` (:365), agent `notifications`, and the subscription's `plans` field (the SDK has `plans_available`).
- **Model as an object.** The docs allow `model: {id, effort}`; the SDK and OpenAPI only take a string.
- **Balance floor.** One page says the balance never goes negative (D:platform/billing.md:49); another says it may go negative by one job (D:platform/pricing.md:72).

## 11. Review of the Goose code (no edits made)

### `lib/naive/client.ts`
- **C1 (:53-61).** A ZodError from a 2xx response that doesn't match the schema is not an `ApiError`, so it falls through to `"unreachable"`. **Fix:** check `e instanceof Error && e.name === "ZodError"` and report it as `"error"` with a message about the SDK schema not matching the API, and log `e.issues`.
- **C2 (:42).** `sub.status !== "active"` reports `no_plan` for `past_due`, but the organization still works until `grace_until` (D:api/credits.md:274). **Fix:** treat `past_due` with a future `grace_until` as `ready`, plus a warning.
- **C3 (:40-58).** 403 is reported as a generic error and `me.scopes` is never checked. `.env.example:14` mints a key without `agents:read`, `sessions:read` or `files:read`, which OA requires for `agents.list/get`, `sessions.get`, board reads and `files.get/download`. **Fix:**
  - require `me.scopes` to include `admin` or each needed scope;
  - add a `missing_scope` state;
  - add the read scopes to `.env.example` and README.md:130.
- **C4.** The status check never verifies the model. **Fix:** call `c.models.retrieve(config.naive.model)`; a 404 means the model is not served.
- **C5.** There is no retry or backoff for 429 and 5xx, and the SDK does none either. **Fix:** wrap `fetchImpl` with a retry that honours `Retry-After`. It is safe because the headers, including Idempotency-Key, are fixed per call.

### `lib/naive/team.ts` (agent specs and provisioning)
- **T1 (:74).** `handoffs: false` on the coordinator means its `send_to_agent`, `list_agents` and `wait_for_agents` "allow" entries (:37-38) never take effect. **Fix:** create the coordinator with `false`, then in the roster PATCH (:101-108) also send `handoffs: "team"`. The server refuses `"team"` while there is no roster. Alternatively, if Goose orchestrates everything itself, delete those tool entries.
- **T2 (:105).** Roster entries carry no `version`, so the server pins each member's version at save time and never updates it.
  - A roster is only written while `multiagent` is unset (:100).
  - `config_sha` is stored (:95) but never compared, so changed specs never reach existing agents.
  - **Fix:** when the sha differs, call `agents.update(id, {...agentBody(role), expected_version})`, then re-save the roster with an explicit `version: member.current_version`.
- **T3 (:93).** Only the first page of `agents.list({limit:100})` is searched, and agent names are not documented as unique. **Fix:** page with `after: next_cursor` and match on `metadata.role` together with the name.
- **T4 (:27-59).** Under the deny default, the ask-by-default tools may still be offered as `ask` (see §0 item 7). Every session is offered `company.set_timezone/logo/brand` (D:capabilities/tools.md:530). A call to any of these parks the session with `awaiting_approval`. **Fix:** add explicit `tool("deny")` entries for:
  - `company.set_timezone`, `company.set_logo`, `company.set_brand`
  - `data_run`, `generate_video`, `edit_video`, `create_character`, `mobile`, `build_media_skill`
  - `ask_operator`, `request_tools`, `propose_plan`
- **T5 (:47-49).** Denying `web_*` does not isolate the modernization agent. `bash` has open egress, so `curl` and `pip` still reach the internet (D:computer/networking.md:13,29), and `fetch_file` can read any file in the organization by id. Reword the comment; never upload the frozen checks to Files.
- **T6.** If the agent's computer really is shared (D:api/computers.md:216), one customer's code is visible to the next job, and concurrent sessions share one disk. **Fix:** give each job its own directory and clean it up, or run modernization sessions one at a time.
- **T7 (:69, :76).** `harness:"pi"` is right: it is the only harness with approvals and typed results. Once `cap_micro_usd` (monthly, $40–60) is exhausted, all of that agent's sessions are `budget_paused` until the period resets or you raise the cap.

### `lib/naive/run.ts`
- **R1 (:12-13).** `TERMINAL_STOPS` is missing `awaiting_input`, so the loop polls until the 15-minute timeout. **Fix:** add it and treat it like `end_turn`. Keeping `awaiting_delegation` non-terminal is correct.
- **R2 (:46-52).** On timeout the session is neither cancelled nor interrupted, so it keeps spending. **Fix:** call `await client.sessions.cancel(session.id)` (or `interrupt`) before returning.
- **R3 (:22-25, :62-65).** Mirroring each task as a card on the coordinator's board means every move to `done` or `blocked` starts a **coordinator digest session** (D:team/board.md:111-121).
  - The coordinator's prompt tells it to track work on the board and it has `board_write`, so it may create and assign cards.
  - Assigning a card wakes a member session on the member's budget. The member's tools deny the board tools, so it cannot close the card; the card gets parked as `blocked`, which triggers another digest.
  - **Fix:** keep the mirror only in Postgres. Or deny `board_write` for the coordinator, have its prompt treat digests as no-ops, and budget for those turns.
- **R4 (:21, :26-28).** The resume lookup ignores `attempt` and the message, and the card key is `${jobId}:${stage}:${attempt}:${role}`.
  - `answerCustomer` always uses stage `"support"` and attempt 1 (agents.ts:96; actions.ts:96). A second question therefore gets the **same card**, because the key is idempotent, and the **first question's session**, so it returns the first answer.
  - Without a board, `card_id IS NOT DISTINCT FROM NULL` also matches across attempts.
  - **Fix:** put the attempt and `sha256(message)` in the key, and store them in `naive_sessions`.
- **R5 (:33).** `sessions.create` without `{ idempotencyKey }` creates a duplicate session when a network error is retried. **Fix:** pass `{ idempotencyKey: key }`. The server keeps it for 24 h and it also becomes the first message's `client_message_id` (J:5231).
- **R6 (:38).** `Math.max(1, …)` can create a session with a budget of 1 µUSD, which the first pre-flight quote refuses, so the session is instantly `budget_paused`. **Fix:** don't start the session when the budget left is below a floor such as $0.05. Also keep the session budget at or below the agent's `max_task_micro_usd`.
- **R7 (:55-61).** The cost is recorded once, with `kind:"model"`, but `consumed_micro_usd` is the session's total spend: model, computer, search and media (D:concepts/budgets.md:92-103). Spend after a resume is never recorded. **Fix:** upsert per session using the latest `consumed_micro_usd`, label it as a session total, and take the breakdown from `credits.ledger({session_id})`.
- **R8 (:70-73).** `awaiting_approval` and `awaiting_answer` are returned as `needs_answer`, but nothing in the app ever resolves them. **Fix:** persist `pending_actions` (kind, tool_call_id, name, args, question) and route `kind:"tool"` to `confirmTool` and `kind:"question"` to `answer`. Alternatively deny these tools (T4).
- **R9 (:74-79).** When the stop reason is `error` or the status is `failed`, the reason is lost: the SDK strips `stop_code`, and `session.idle.data.error` and `data.code` only appear in events. **Fix:** read the most recent events with `sessions.events(id, {after_seq: last_seq - 20})` and log the `session.idle` data.
- **R10 (:62-65, :23-24).**
  - Updating a card that is already `done` is risky, because `done` is terminal. After a restart or an R4 reuse, the update may throw and lose a result that was already obtained. **Fix:** skip the update when the status already matches, and wrap it in try/catch.
  - Creating cards as `doing` with no assignee has UNCERTAIN meaning; `doing` normally means claimed. Use `todo`: a `todo` card with no assignee never wakes anyone.
- **R11 (:50-51).** Polling every 3 s is fine under the rate limits. Don't switch to `client.stream` alone: it stops at each idle and skips frames that don't parse.

### `lib/agents.ts`
- **A1.** Only the commercial agent (:39, :64, :96) and the coordinator (:115) run on Naive. The modernization and verification work runs in the local engine (lib/stages.ts:337-383, 489), and `lib/` has no code that uploads, fetches, publishes or downloads files.
  - To build a real loop: zip and upload the source with `files.upload` (≤25 MiB), put the `fil_` ids in the message, let the agent run `fetch_file`, `bash` and `publish_file`, have it return the output `fil_` ids in `structured_output`, then call `files.downloadBytes`.
- **A2 (:96).** Every `answerCustomer` call uses the same key (see R4).
- **A3 (:115).** For its decision task the coordinator still has `board_write` and the "you assign work" prompt, so it may also create or assign cards as a side effect. Deny `board_write`, or limit what the brief allows.
- **A4.** The output schemas pass the SDK's checks: `type:"object"` with properties (J:180-185). For background tasks, consider `window:"priority"` to pay less (D:concepts/completion-window.md); the model must support that window.

### `tests/integration/naive-contract.test.ts`
- **X1 (:1-4).** The header says "a wrong request … fails here". That is false: the SDK serializes request bodies without validating them (J:4148-4155), while the server refuses unknown keys (D:api/overview.md:33). **Fix:** snapshot `openapi.json` into a test fixture and validate every recorded body against its `requestBody` schema, or at least check the keys against its `properties`.
- **X2 (:100).** The assertion `handoffs === false` for all four agents locks in T1. Instead, assert that the coordinator ends up with `"team"`.
- **X3.** Missing coverage:
  - `queued`, `awaiting_input` (R1), `awaiting_delegation`, `error` with `structured_output_required`, and the timeout-then-cancel path (R2);
  - two customer questions (R4);
  - card key idempotency, where the same key must return the same card;
  - a deterministic Idempotency-Key on `sessions.create` (R5) and the `vetta-version: 2026-09-30` header.
- **X4 (:59).** Every create returns the same `SES`, so the test can't detect duplicate session creation. Return a different id for each create.

## 12. Recommended loop (sketch)
`upload inputs (files.upload)` → `sessions.create(body, {idempotencyKey})` → poll `sessions.get` until `status ∈ {completed, failed, cancelled}` or (`idle` and `stop_reason ≠ awaiting_delegation`), then:

| Stop reason | Action |
| - | - |
| `end_turn`, `awaiting_input` | Read `structured_output`; `null` counts as a failure |
| `awaiting_approval`, `awaiting_answer` | For each `pending_actions` row: `kind:"tool"` → `confirmTool`, `kind:"question"` → `answer` |
| `budget_paused` | `setBudget(id, cap > consumed)` or raise the agent budget; the session resumes automatically |
| `max_iterations` | `send(id, {message:"Continue."})`, at most N times |
| `error`, `context_exhausted`, `failed` | Read events for `session.idle {error, code}`, then retry once or fall back |
| timeout | `cancel(id)` |

After that: outputs come from `structured_output.file_ids` via `files.downloadBytes` (or `files.list({session_id, scope:"published"})`); the transcript comes from paging `sessions.events(id, {after_seq, limit:100})` until `has_more` is false; cost comes from `consumed_micro_usd` and `token_usage`.
