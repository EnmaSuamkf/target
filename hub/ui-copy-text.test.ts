/**
 * copyText (ui/src/lib/copyText.ts): uses the async clipboard API when the page
 * has one, falls back to a hidden textarea + execCommand over plain http (where
 * `navigator.clipboard` is undefined), and never throws.
 */
import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyText } from "./ui/src/lib/copyText.ts";

const g = globalThis as Record<string, unknown>;
const saved = { navigator: g.navigator, document: g.document };

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
});

const setGlobal = (key: string, value: unknown): void => {
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};

interface FakeArea {
	value: string;
	style: Record<string, string>;
	removed: boolean;
	selected: boolean;
	setAttribute(): void;
	select(): void;
	setSelectionRange(): void;
	remove(): void;
}

function fakeDocument(execResult: boolean | Error): { doc: unknown; areas: FakeArea[]; copied: string[] } {
	const areas: FakeArea[] = [];
	const copied: string[] = [];
	const doc = {
		body: { appendChild: () => undefined },
		createElement: (): FakeArea => {
			const area: FakeArea = {
				value: "",
				style: {},
				removed: false,
				selected: false,
				setAttribute: () => undefined,
				select: () => {
					area.selected = true;
				},
				setSelectionRange: () => undefined,
				remove: () => {
					area.removed = true;
				},
			};
			areas.push(area);
			return area;
		},
		execCommand: (cmd: string): boolean => {
			assert.equal(cmd, "copy");
			if (execResult instanceof Error) throw execResult;
			copied.push(areas[areas.length - 1]?.value ?? "");
			return execResult;
		},
	};
	return { doc, areas, copied };
}

test("copyText: uses navigator.clipboard when it exists", async () => {
	const written: string[] = [];
	setGlobal("navigator", { clipboard: { writeText: async (t: string) => void written.push(t) } });
	assert.equal(await copyText("wf_123"), true);
	assert.deepEqual(written, ["wf_123"]);
});

test("copyText: falls back to a hidden textarea when navigator.clipboard is undefined", async () => {
	const { doc, areas, copied } = fakeDocument(true);
	setGlobal("navigator", {});
	setGlobal("document", doc);
	assert.equal(await copyText("wf_456"), true);
	assert.deepEqual(copied, ["wf_456"]);
	assert.equal(areas[0]?.selected, true);
	assert.equal(areas[0]?.removed, true, "the temporary textarea is always removed");
});

test("copyText: falls back when the clipboard API rejects", async () => {
	const { doc, copied } = fakeDocument(true);
	setGlobal("navigator", {
		clipboard: {
			writeText: async () => {
				throw new Error("NotAllowedError");
			},
		},
	});
	setGlobal("document", doc);
	assert.equal(await copyText("wf_789"), true);
	assert.deepEqual(copied, ["wf_789"]);
});

test("copyText: resolves false, without throwing, when every path fails", async () => {
	const { doc, areas } = fakeDocument(new Error("execCommand blew up"));
	setGlobal("navigator", {});
	setGlobal("document", doc);
	assert.equal(await copyText("x"), false);
	assert.equal(areas[0]?.removed, true);

	const refused = fakeDocument(false);
	setGlobal("document", refused.doc);
	assert.equal(await copyText("x"), false);
});

test("copyText: resolves false when there is no DOM at all", async () => {
	setGlobal("navigator", undefined);
	setGlobal("document", undefined);
	assert.equal(await copyText("x"), false);
});
