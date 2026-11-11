/**
 * Tests for pipeline-runner.ts. Every test runs real shell commands in a fresh
 * temporary workdir. Nothing here touches the database or the hub.
 *
 * Two shortcuts, both on purpose: a pipeline's timeouts are whole minutes, so a
 * timeout test sets the parsed spec's timeout to a fraction of a minute after
 * parsing (the validator's range is checked by pipeline-yaml.test.ts), and the
 * secrets resolver is a plain function, standing in for the hub's store.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { PipelineSpec } from "./pipeline-yaml.ts";
import type { JobStepState, PipelineRunResult } from "./pipeline-runner.ts";

const { parsePipeline, sourceHash } = await import("./pipeline-yaml.ts");
const { runPipeline } = await import("./pipeline-runner.ts");

interface Harness {
	result: PipelineRunResult;
	workdir: string;
	logPath: string;
	resultsDir: string;
	spec: PipelineSpec;
}

function parse(yaml: string): PipelineSpec {
	const parsed = parsePipeline(yaml);
	if (!parsed.ok) throw new Error(`fixture does not validate: ${JSON.stringify(parsed.errors)}`);
	return parsed.pipeline;
}

async function execute(
	yaml: string,
	options: {
		inputs?: Record<string, string>;
		resolveSecrets?: (names: string[]) => Record<string, string>;
		signal?: AbortSignal;
		onJobStep?: (s: JobStepState) => void;
		adjust?: (spec: PipelineSpec) => void;
		workdir?: string;
	} = {},
): Promise<Harness> {
	const workdir = options.workdir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-runner-")));
	const spec = parse(yaml);
	options.adjust?.(spec);
	const logPath = path.join(workdir, ".logs", "run.log");
	const resultsDir = path.join(workdir, ".results");
	const result = await runPipeline({
		spec,
		sourceHash: sourceHash(yaml),
		inputs: options.inputs ?? {},
		workflow: { id: "wf-test", name: "test workflow", workdir },
		resultsDir,
		logPath,
		resolveSecrets: options.resolveSecrets ?? (() => ({})),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onJobStep ? { onJobStep: options.onJobStep } : {}),
	});
	return { result, workdir, logPath, resultsDir, spec };
}

/** True while the process exists and is not a zombie. A zombie has exited; it only waits to be reaped. */
function isAlive(pid: number): boolean {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state !== "Z";
	} catch {
		return false;
	}
}

test("a run of successful steps succeeds, with every step recorded as success", async () => {
	const { result, logPath } = await execute(`name: ok
steps:
  - name: first
    run: echo one
  - name: second
    run: echo two
`);
	assert.equal(result.conclusion, "success");
	assert.equal(result.cancelled, false);
	assert.equal(result.error, undefined);
	assert.deepEqual(
		result.steps.map((s) => [s.name, s.status, s.exitCode]),
		[
			["first", "success", 0],
			["second", "success", 0],
		],
	);
	const log = fs.readFileSync(logPath, "utf8");
	assert.match(log, /=== \[0\] first ===\none\n/);
	assert.match(log, /=== \[1\] second ===\ntwo\n/);
});

test("the first failure fails the run and later steps are skipped", async () => {
	const { result } = await execute(`name: stops
steps:
  - name: breaks
    run: exit 3
  - name: later
    run: echo should-not-run
`);
	assert.equal(result.conclusion, "failure");
	assert.equal(result.cancelled, false);
	assert.equal(result.steps[0].status, "failed");
	assert.equal(result.steps[0].exitCode, 3);
	assert.equal(result.steps[1].status, "skipped");
	assert.equal(result.steps[1].startedAt, null, "a skipped step never started");
	assert.match(result.error ?? "", /breaks/);
});

test("continue-on-error keeps the run green while the step is recorded as failed", async () => {
	const { result } = await execute(`name: tolerated
steps:
  - name: flaky
    run: exit 1
    continue-on-error: true
  - name: after
    run: echo still-running
`);
	assert.equal(result.conclusion, "success");
	assert.equal(result.steps[0].status, "failed", "recorded as failed");
	assert.equal(result.steps[0].continueOnError, true);
	assert.equal(result.steps[1].status, "success", "the next step ran");
});

test("if: always() runs after a failure; if: failure() runs only after one; success() is skipped", async () => {
	const { result } = await execute(`name: conditions
steps:
  - name: breaks
    run: exit 1
  - name: cleanup
    if: always()
    run: echo cleanup
  - name: on-failure
    if: failure()
    run: echo on-failure
  - name: normal
    run: echo normal
`);
	assert.deepEqual(
		result.steps.map((s) => [s.name, s.status]),
		[
			["breaks", "failed"],
			["cleanup", "success"],
			["on-failure", "success"],
			["normal", "skipped"],
		],
	);
	assert.equal(result.conclusion, "failure");
});

test("if: failure() is skipped when nothing has failed", async () => {
	const { result } = await execute(`name: quiet
steps:
  - name: fine
    run: echo fine
  - name: only-on-failure
    if: failure()
    run: echo should-not-run
`);
	assert.deepEqual(
		result.steps.map((s) => s.status),
		["success", "skipped"],
	);
	assert.equal(result.conclusion, "success");
});

test("a step timeout kills a long sleep and its child processes within a few seconds", async () => {
	const { result, workdir } = await execute(
		`name: slow
steps:
  - name: hangs
    run: |
      sleep 37 &
      echo $! > child.pid
      sleep 37
`,
		// Fraction of a minute: three seconds. The validator only accepts whole minutes,
		// so the test sets this on the parsed spec.
		{ adjust: (spec) => (spec.steps[0].timeoutMinutes = 0.05) },
	);
	const elapsed = Date.now() - new Date(result.steps[0].startedAt ?? 0).getTime();
	assert.ok(elapsed < 12_000, `the run ended well before the sleep (${elapsed} ms)`);
	assert.equal(result.steps[0].status, "failed");
	assert.match(result.steps[0].error ?? "", /timed out/);
	assert.equal(result.conclusion, "failure");
	assert.equal(result.cancelled, false, "a step timeout is not a run cancellation");

	const childPid = Number(fs.readFileSync(path.join(workdir, "child.pid"), "utf8").trim());
	assert.ok(childPid > 0);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(isAlive(childPid), false, "the background sleep was killed with its group");
});

test("abort marks the run cancelled, kills the running step and skips the rest", async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	const started = Date.now();
	const { result } = await execute(
		`name: aborted
steps:
  - name: long
    run: sleep 30
  - name: after
    if: always()
    run: echo never
`,
		{ signal: controller.signal },
	);
	assert.ok(Date.now() - started < 12_000, "the sleep was stopped, not waited for");
	assert.equal(result.cancelled, true);
	assert.equal(result.conclusion, "failure");
	assert.equal(result.error, "aborted");
	assert.equal(result.steps[0].status, "failed");
	assert.equal(result.steps[0].error, "aborted");
	assert.equal(result.steps[1].status, "skipped", "always() does not run after an abort");
});

test("the pipeline's own timeout cancels the run", async () => {
	const { result } = await execute(
		`name: run-timeout
steps:
  - name: long
    run: sleep 30
`,
		{ adjust: (spec) => (spec.timeoutMinutes = 0.05) },
	);
	assert.equal(result.cancelled, true);
	assert.equal(result.conclusion, "failure");
	assert.match(result.error ?? "", /timeout-minutes/);
});

test("a missing secret fails the run before any job step starts", async () => {
	const marker = "started-marker.txt";
	const { result, workdir } = await execute(
		`name: needs-secret
env:
  TOKEN: \${{ secrets.NOT_THERE }}
steps:
  - name: would-run
    run: touch ${marker}
`,
		{
			resolveSecrets: (names) => {
				assert.deepEqual(names, ["NOT_THERE"]);
				throw new Error("missing secret: NOT_THERE");
			},
		},
	);
	assert.equal(result.conclusion, "failure");
	assert.equal(result.error, "missing secret: NOT_THERE");
	assert.equal(result.steps[0].status, "skipped");
	assert.equal(result.steps[0].startedAt, null);
	assert.equal(fs.existsSync(path.join(workdir, marker)), false, "no job step ran");
});

test("a printed secret appears only as *** in the log file and the tail", async () => {
	const secret = "hunter2-very-long-secret-value";
	const { result, logPath } = await execute(
		`name: leaky
env:
  TOKEN: \${{ secrets.TOKEN }}
steps:
  - name: echo-secret
    run: |
      echo "the token is $TOKEN"
      echo "and again $TOKEN" >&2
`,
		{ resolveSecrets: () => ({ TOKEN: secret }) },
	);
	assert.equal(result.conclusion, "success");
	const log = fs.readFileSync(logPath, "utf8");
	assert.ok(!log.includes(secret), "the value is not in the log file");
	assert.match(log, /the token is \*\*\*/);
	assert.ok(!result.steps[0].tail.includes(secret), "the value is not in the tail");
	assert.match(result.steps[0].tail, /\*\*\*/);
});

test("inputs reach the script through env and through INPUT_<NAME>", async () => {
	const { result, workdir } = await execute(
		`name: inputs
inputs:
  who:
    default: nobody
  my-flag:
    required: true
env:
  FROM_EXPR: \${{ inputs.who }}
steps:
  - name: read
    run: |
      echo "expr=$FROM_EXPR" > out.txt
      echo "env=$INPUT_WHO flag=$INPUT_MY_FLAG" >> out.txt
`,
		{ inputs: { who: "alice", "my-flag": "yes" } },
	);
	assert.equal(result.conclusion, "success");
	assert.equal(fs.readFileSync(path.join(workdir, "out.txt"), "utf8"), "expr=alice\nenv=alice flag=yes\n");
});

test("a declared default is used when the command step gives no value", async () => {
	const { result, workdir } = await execute(
		`name: defaults
inputs:
  who:
    default: nobody
steps:
  - run: echo "$INPUT_WHO" > who.txt
`,
	);
	assert.equal(result.conclusion, "success");
	assert.equal(fs.readFileSync(path.join(workdir, "who.txt"), "utf8"), "nobody\n");
});

test("a working-directory that resolves outside the workdir is refused before anything runs", async () => {
	const marker = "should-not-exist.txt";
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-outside-")));
	const { result, workdir } = await execute(
		`name: escape
inputs:
  dir:
    default: .
steps:
  - name: escapes
    working-directory: \${{ inputs.dir }}
    run: touch ${marker}
`,
		{ inputs: { dir: outside } },
	);
	assert.equal(result.conclusion, "failure");
	assert.match(result.error ?? "", /outside the workflow's workdir/);
	assert.equal(result.steps[0].status, "skipped");
	assert.equal(fs.existsSync(path.join(outside, marker)), false, "nothing ran in the outside directory");
	assert.equal(fs.existsSync(path.join(workdir, marker)), false);
});

test("a symlink inside the workdir that points outside it is refused too", async () => {
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-link-target-")));
	const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-link-")));
	fs.symlinkSync(outside, path.join(workdir, "link"));
	const { result } = await execute(
		`name: symlink
steps:
  - working-directory: link
    run: echo hi
`,
		{ workdir },
	);
	assert.equal(result.conclusion, "failure");
	assert.match(result.error ?? "", /outside the workflow's workdir/);
});

test("each job step's log offset and length point at its own section of the file", async () => {
	const { result, logPath } = await execute(`name: offsets
steps:
  - name: alpha
    run: |
      echo first-line
      echo second-line >&2
  - name: beta
    run: echo beta-line
`);
	assert.equal(result.conclusion, "success");
	const file = fs.readFileSync(logPath);
	for (const step of result.steps) {
		const section = file.subarray(step.logOffset, step.logOffset + step.logLength).toString("utf8");
		assert.ok(section.startsWith(`=== [${step.idx}] ${step.name} ===\n`), `section for ${step.name}: ${JSON.stringify(section)}`);
	}
	assert.equal(result.steps[0].logOffset, 0);
	assert.equal(result.steps[1].logOffset, result.steps[0].logOffset + result.steps[0].logLength, "sections are adjacent");
	assert.equal(result.steps[1].logOffset + result.steps[1].logLength, file.length, "the file ends with the last section");
	const alpha = file.subarray(result.steps[0].logOffset, result.steps[0].logOffset + result.steps[0].logLength).toString("utf8");
	assert.match(alpha, /first-line\n/);
	assert.match(alpha, /second-line\n/, "stderr is interleaved into the same section");
});

test("onJobStep fires on every status change, with a copy of the state", async () => {
	const seen: Array<{ name: string; status: string }> = [];
	await execute(
		`name: events
steps:
  - name: one
    run: echo 1
  - name: two
    run: exit 1
  - name: three
    run: echo 3
`,
		{
			onJobStep: (s) => {
				seen.push({ name: s.name, status: s.status });
			},
		},
	);
	assert.deepEqual(seen, [
		{ name: "one", status: "running" },
		{ name: "one", status: "success" },
		{ name: "two", status: "running" },
		{ name: "two", status: "failed" },
		{ name: "three", status: "skipped" },
	]);
});

test("a pipeline shell can be sh", async () => {
	const { result } = await execute(`name: posix
steps:
  - name: sh-step
    shell: sh
    run: echo "from sh" > sh.txt
`);
	assert.equal(result.conclusion, "success");
});

test("the tail keeps the last 80 lines of a chatty step", async () => {
	const { result, logPath } = await execute(`name: chatty
steps:
  - name: many
    run: |
      i=0
      while [ $i -lt 2000 ]; do echo "line $i"; i=$((i+1)); done
`);
	assert.equal(result.conclusion, "success");
	const tail = result.steps[0].tail.split("\n");
	assert.equal(tail.length, 80, "the tail keeps the last 80 lines");
	assert.equal(tail[tail.length - 1], "line 1999");
	assert.match(fs.readFileSync(logPath, "utf8"), /line 1999\n/);
});

test("a runaway command cannot grow the log past its cap; it stops with a marker", async () => {
	const { result, logPath } = await execute(`name: runaway
steps:
  - name: flood
    run: yes "a line of output to fill the log quickly" | head -c 12000000 || true
`);
	assert.equal(result.conclusion, "success");
	const size = fs.statSync(logPath).size;
	assert.ok(size <= 10 * 1024 * 1024 + 200, `the log is capped (${size} bytes)`);
	const log = fs.readFileSync(logPath, "utf8");
	assert.match(log, /\[log truncated: the run's output passed 10 MiB\]/);
	assert.equal(log.match(/\[log truncated/g)?.length, 1, "the marker is written once");
});
