/**
 * Regression tests for the conversation-context textarea's draft rule
 * (hub/ui/src/views/contextDraft.ts), which is what "Save context" got wrong.
 *
 * The bug: the panel re-synced the textarea from the polled workflow whenever
 * the field was not focused. Clicking "Save context" blurs the textarea BEFORE
 * the click is dispatched, so the resync ran on that blur, replaced the typed
 * text with the stale server value (empty) and left the button non-dirty, hence
 * disabled — the click never saved anything and the context stayed null.
 *
 * These tests pin the replacement rule: adoption is gated on unsaved edits, not
 * on focus, so no re-render between typing and the click can drop the draft.
 * The server side of the round-trip (PATCH then GET) is covered in
 * context.test.ts.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

const { initialDraftState, isDirty, markSaved, reconcileDraft } = await import("./ui/src/views/contextDraft.ts");

test("a re-render while the operator has unsaved edits never drops the draft (the Save-blur bug)", () => {
	// Fresh panel on a workflow with no context yet.
	let state = initialDraftState("wf-1", "");
	// The operator types.
	state = { ...state, draft: "Responde siempre en espanol." };
	assert.equal(isDirty(state), true);

	// The blur caused by pressing Save re-renders the panel with the SAME
	// (stale, still empty) server value. Previously this wiped the draft.
	state = reconcileDraft(state, "wf-1", "");
	assert.equal(state.draft, "Responde siempre en espanol.", "typed text survives the blur re-render");
	assert.equal(isDirty(state), true, "Save stays enabled, so the click actually saves");

	// Even a poll arriving mid-edit with a different server value must not win.
	state = reconcileDraft(state, "wf-1", "something else from the server");
	assert.equal(state.draft, "Responde siempre en espanol.", "an in-flight poll cannot clobber unsaved edits");
});

test("after a successful save the draft is clean and adopts the stored (trimmed) value", () => {
	let state = initialDraftState("wf-1", "");
	state = { ...state, draft: "  con espacios  " };

	// The save succeeded, so the draft agrees with the server again.
	state = markSaved(state, "  con espacios  ");
	assert.equal(isDirty(state), false, "Save button goes disabled once saved");

	// The next poll brings back what the server actually stored (it trims).
	state = reconcileDraft(state, "wf-1", "con espacios");
	assert.equal(state.draft, "con espacios", "the field shows exactly what was persisted");
	assert.equal(isDirty(state), false);
});

test("a failed save keeps the text so the operator can retry", () => {
	let state = initialDraftState("wf-1", "");
	state = { ...state, draft: "texto importante" };
	// No markSaved — the request failed. A later poll must not eat the text.
	state = reconcileDraft(state, "wf-1", "");
	assert.equal(state.draft, "texto importante");
	assert.equal(isDirty(state), true);
});

test("a saved context shows up when the panel is reopened", () => {
	// Reopening mounts the panel from the workflow the API returned.
	const state = initialDraftState("wf-1", "Responde siempre en espanol.");
	assert.equal(state.draft, "Responde siempre en espanol.");
	assert.equal(isDirty(state), false, "nothing to save — it is already stored");
});

test("switching workflows shows the new workflow's context, never the old draft", () => {
	let state = initialDraftState("wf-1", "contexto A");
	state = { ...state, draft: "edicion sin guardar" };

	state = reconcileDraft(state, "wf-2", "contexto B");
	assert.equal(state.id, "wf-2");
	assert.equal(state.draft, "contexto B", "a draft never leaks across workflows");
	assert.equal(isDirty(state), false);
});

test("reconcileDraft returns the same object when nothing changed (no render loop)", () => {
	const state = initialDraftState("wf-1", "ctx");
	assert.equal(reconcileDraft(state, "wf-1", "ctx"), state);
});
