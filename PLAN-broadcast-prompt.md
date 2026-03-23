# Plan: `mesh_broadcast_prompt`

Send a prompt to all terminals on the mesh and collect all responses.

## Design Decisions

- **New tool** (`mesh_broadcast_prompt`), not an extension of `mesh_prompt` — different return shape (map vs single), different timeout semantics (wait for all), cleaner for LLM tool selection.
- **No slash command yet** — prove the tool first, add `/mesh-broadcast-prompt` later if useful interactively.
- **No new protocol messages** — reuse existing `prompt_request` / `prompt_response`. Send N individual requests, one per target.
- **Partial failure is normal** — terminals can timeout, error, or be busy. The result captures all outcomes.

## Response Shape

```ts
// content (human-readable summary)
"Collected 3/4 responses (2 ok, 1 timeout, 1 error)"

// details (structured, machine-readable)
{
  responses: {
    [name: string]: {
      status: "ok" | "error" | "timeout";
      response?: string;
      error?: string;
    }
  },
  total: number,
  ok: number,
  failed: number,
}
```

## Implementation Notes

- **Snapshot targets at start** — use `connectedTerminals` minus self at invocation time. Joins/leaves during execution don't change the wait set.
- **Fail fast per target** — if `routeMessage()` returns `false`, mark that target as failed immediately instead of waiting for timeout.
- **Handle "no other terminals"** — return an empty success result immediately.
- **Deterministic ordering** — sort target names so summaries and details are stable.
- **Busy terminals** — each receiver only accepts one remote prompt at a time, so some may reply "Terminal is busy". This fits the partial-failure model.

---

## Batch 1 — Core tool registration & fan-out

Register the tool and send prompts to all targets.

### Steps

1. Register `mesh_broadcast_prompt` tool:
   - Parameters: `prompt: string`
   - Description explains fan-out and partial failure semantics
2. On execute:
   - Early return with `notConnectedResult()` if disconnected
   - Snapshot targets: `connectedTerminals.filter(n => n !== terminalName).sort()`
   - Early return if no targets: `textResult("No other terminals connected", { responses: {}, total: 0, ok: 0, failed: 0 })`
3. Generate one `requestId` per target using `crypto.randomUUID()`
4. Send N `prompt_request` messages via `routeMessage()`
5. For any target where `routeMessage()` returns `false`, mark as `{ status: "error", error: "not_delivered" }` immediately

### Output

Tool is registered, prompts fan out, but responses aren't collected yet — tool resolves immediately with a placeholder. This lets us verify the fan-out works before wiring up collection.

---

## Batch 2 — Collection & resolution

Wire up response collection so the tool waits for all targets to respond.

### Steps

1. Create a `Promise` that resolves when all targets have a result (ok, error, or timeout)
2. For each target, register an entry in `pendingPromptResponses` with its own `requestId`
3. Per-terminal timeout: `setTimeout` per target using `PROMPT_TIMEOUT_MS`
   - On timeout: record `{ status: "timeout" }` for that target
   - Check if all targets are resolved; if so, resolve the outer promise
4. As each `prompt_response` arrives via existing `handleIncoming`:
   - Match by `requestId` (already works — each target has its own ID)
   - Record `{ status: "ok", response }` or `{ status: "error", error }`
   - Check if all targets are resolved; if so, resolve the outer promise
5. Abort signal support:
   - On abort, cancel all pending timeouts, mark remaining targets as `{ status: "error", error: "aborted" }`
   - Resolve immediately with partial results

### Output

Tool fully works end-to-end: fans out, collects, handles timeouts and errors, resolves with the complete results map.

---

## Batch 3 — Result formatting & rendering

Polish the output for both LLM and human consumption.

### Steps

1. Format `content` summary: `"Collected N/M responses (X ok, Y failed)"`
2. Format `details` with the full structured map plus `total`, `ok`, `failed` counts
3. Add `renderCall`:
   - Show "mesh_broadcast_prompt" title
   - Preview prompt text using `truncatePreview()`
   - Show target count: e.g., "→ 4 terminals"
4. Add `renderResult`:
   - Summary line with ok/failed counts
   - Per-terminal status lines with ✓/✗ icons and response previews

### Output

Complete feature: functional, well-formatted, easy for both LLMs and humans to interpret.
