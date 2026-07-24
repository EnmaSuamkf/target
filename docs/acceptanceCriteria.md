# Acceptance criteria — Conversation context

These are the checks for the **Conversation context** feature (see
`feature.md`). A workflow with a non-empty Conversation context must satisfy
every item below.

1. **Inject before all**
   The context text appears in the agent's input **only on the first
   dispatched step** of a fresh run (no prior session). It is prefixed before
   the step's task description and the subagent suffix.

2. **No re-injection**
   Subsequent steps (which resume the session) do **not** carry the preamble
   in their dispatch input. `context_injected` is `true` and `dispatchStep`
   skips the preamble.

3. **Tracking is observable**
   `context_injected` is `false` until a session is established, then `true`.
   Both `conversationContext` and `contextInjected` are surfaced in
   `GET /api/workflows/:id` and in the progress `.md` file, so the state can
   be inspected at any time.

4. **Failed first dispatch re-injects**
   If the first dispatch fails without producing a session, the flag stays
   `false`, so the next attempt re-injects the context — no lost preamble, no
   double preamble.

5. **Restart re-injects**
   `restartWorkflow` resets `context_injected` to `false` and drops the
   session id, so the new conversation gets the context again on its first
   step.

6. **Once injected, the context is locked**
   Once `context_injected` is `true`, the context can no longer be edited:
   `setConversationContext` throws `context already injected`, the
   `PATCH /api/workflows/:id/context` route returns `400`, and the UI makes
   the field read-only and disables the Save button. It can only be changed
   again after a **restart** resets the flag to `false`.

7. **Empty context = unchanged behavior**
   A workflow with an empty/null context behaves exactly as before: no
   preamble is ever injected, and the flag is irrelevant.

8. **Context is set on an existing workflow, not at creation**
   The context is not part of workflow creation — `POST /api/workflows`
   ignores a `conversationContext` field and the new-workflow form has none.
   It is set/viewed/edited afterward via `PATCH /api/workflows/:id/context`
   (API) and the **Conversation context** block in the workflow detail panel
   (UI). The stored value round-trips through the API and is shown back on
   reload, with its injected state (`yes` / `not yet` / `(none)`).

9. **CLI support**
   - `target set-context <id> "..."` sets (or, with `""`, clears) the context
     on an existing workflow.
   - `target show <id>` displays it.
   - `target create` has no context flag (the context is added afterward).

10. **Tests and typecheck pass**
    `npm test` (60 tests) and `npm run typecheck` (run from `hub/`) stay
    green, with `hub/context.test.ts` (14 tests) covering items 1–7 and the
    API wiring in item 8 (create ignores the field; PATCH sets/clears/round-trips/auth/error).
