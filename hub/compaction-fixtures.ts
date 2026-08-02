/**
 * REAL compaction records, copied verbatim (bar the trimming noted below) out of
 * this machine's transcripts. Fixtures for compaction.test.ts.
 *
 * The point of using real records rather than hand-written ones is that the two
 * formats are nothing alike and neither is documented anywhere the hub controls.
 * A shape we invented would happily keep passing while the real files stopped
 * matching it — which is exactly the failure mode here, since the free-code
 * record is the one compaction has actually been observed on in the wild (17 of
 * them across 8 session files at the time of writing) and it carries no token
 * metadata to key off.
 *
 * Trimming, and nothing else: multi-kilobyte `summary` text is cut to its first
 * line, and claude's `compactMetadata.preservedMessages`/`preservedSegment`
 * (hundreds of uuids each) and `details.readFiles` lists are dropped or cut to
 * two entries. Every field the detectors read — `type`, `subtype`, `timestamp`,
 * `compactMetadata.trigger`/`preTokens`/`postTokens` — is byte-for-byte what the
 * harness wrote.
 */

/** One fixture record, with the transcript it came from. */
export interface CompactionFixture {
	/** Absolute path of the real transcript this was taken from. */
	source: string;
	/** The record, as one parsed JSONL line. */
	record: Record<string, unknown>;
}

/**
 * free-code's `{"type":"compaction",…}` records. Note what is NOT here: no
 * `preTokens`, no `postTokens`, no window, no occupancy — just a summary, the
 * `parentId` chain and a timestamp. `tokensBefore` happens to be present on
 * these builds and the detector reads it opportunistically, but the detection
 * itself must not need it (see the "no token metadata" test).
 */
export const FREE_CODE_COMPACTIONS: CompactionFixture[] = [
	{
		source: "/home/lenovo/.agent-webhook-bridge/sessions/instalacion-target-d46b4136/1785344822129-726499f0-3dc8-439b-97a8-f4e32e576473.jsonl",
		record: {"type": "compaction", "id": "d2485175", "parentId": "2df4219c", "timestamp": "2026-07-29T18:22:40.523Z", "summary": "## Goal Investigate and fix how the agent list is managed when creating a new workflow in \"The Target Project\" (`/home/lenovo/Documentos/target`), ensuring that […trimmed for the fixture]", "firstKeptEntryId": "6a389293", "tokensBefore": 139663, "fromHook": false, "details": {"readFiles": ["/home/lenovo/Documentos/target/hub/awb.ts", "/home/lenovo/Documentos/target/hub/cli.ts"], "modifiedFiles": []}},
	},
	{
		source: "/home/lenovo/.agent-webhook-bridge/sessions/check-open-convesation-free-code-docker-c7e4559c/1785318667388-0a9567ef-addc-46db-86af-a25e6a4d9cf7.jsonl",
		record: {"type": "compaction", "id": "63bb6da0", "parentId": "dcac7bb0", "timestamp": "2026-07-29T13:36:39.905Z", "summary": "## Goal Debug why clicking \"Open conversation\" on the \"Test workflow\" in The Target Project web UI results in an empty terminal. The workflow is named \"check op […trimmed for the fixture]", "firstKeptEntryId": "b2011ed9", "tokensBefore": 122011, "fromHook": false},
	},
	{
		source: "/home/lenovo/.agent-webhook-bridge/sessions/research-rabbit-72e8549f/1785503338850-425103c8-50b9-4f87-99a8-6e978b1f5d62.jsonl",
		record: {"type": "compaction", "id": "91df57db", "parentId": "c098cfac", "timestamp": "2026-07-31T13:45:36.395Z", "summary": "## Goal - Research the ResearchRabbit website (researchrabbit.ai) by navigating through all public sections without logging in, understand deeply how it works, […trimmed for the fixture]", "firstKeptEntryId": "fa0031f8", "tokensBefore": 125434, "fromHook": false},
	},
];

/**
 * Claude Code's `{"type":"system","subtype":"compact_boundary",…}` records.
 * Both were written into the SAME `.jsonl` under the SAME `sessionId` as the
 * turns around them — which is why a session id stays valid across a compaction
 * and `--resume` keeps working, and why the hub can detect the boundary without
 * any change to how it tracks sessions.
 */
export const CLAUDE_COMPACT_BOUNDARIES: CompactionFixture[] = [
	{
		source: "/home/lenovo/.claude/projects/-home-lenovo-Documentos-agentmeshWorkspace/e6a7580c-961b-4c1b-8737-372d1b48d351.jsonl",
		record: {"parentUuid": null, "logicalParentUuid": "ac218c1b-d056-4451-9a1c-826e3b5b21d4", "isSidechain": false, "type": "system", "subtype": "compact_boundary", "content": "Conversation compacted", "level": "info", "uuid": "8ea1143c-4e2d-4138-a9ff-d72b8c2b0f3b", "timestamp": "2026-07-10T10:55:25.266Z", "sessionId": "e6a7580c-961b-4c1b-8737-372d1b48d351", "version": "2.1.206", "cwd": "/home/lenovo/Documentos/agentmeshWorkspace", "compactMetadata": {"trigger": "manual", "preTokens": 417221, "postTokens": 11944, "cumulativeDroppedTokens": 405277, "durationMs": 148346}},
	},
	{
		source: "/home/lenovo/.claude/projects/-home-lenovo-Documentos-agentmeshWorkspace-agentmesh/e6b5d927-9e92-49b1-b418-6f735eea0892.jsonl",
		record: {"parentUuid": null, "logicalParentUuid": "16acd02a-486b-4c7b-bda5-52bf7b5f3c6e", "isSidechain": false, "type": "system", "subtype": "compact_boundary", "content": "Conversation compacted", "level": "info", "uuid": "a36adc16-638c-40d1-bbe5-277aedfa6e56", "timestamp": "2026-07-11T21:57:38.992Z", "sessionId": "e6b5d927-9e92-49b1-b418-6f735eea0892", "version": "2.1.207", "cwd": "/home/lenovo/Documentos/agentmeshWorkspace/agentmesh", "compactMetadata": {"trigger": "manual", "preTokens": 200791, "postTokens": 8621, "cumulativeDroppedTokens": 192170, "durationMs": 122912}},
	},
];
