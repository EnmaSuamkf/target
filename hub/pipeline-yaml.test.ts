/**
 * Tests for pipeline-yaml.ts: the parser, the validator and the expression
 * rules. Pure: no database and no filesystem, so the test setup only isolates
 * the homes the rest of the suite needs.
 */

import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

const {
	editDistance,
	MAX_PIPELINE_BYTES,
	parsePipeline,
	sourceHash,
} = await import("./pipeline-yaml.ts");

type Errors = { line: number | null; path: string; message: string }[];

function okOf(source: string) {
	const result = parsePipeline(source);
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) throw new Error("unreachable");
	return result.pipeline;
}

function errorsOf(source: string): Errors {
	const result = parsePipeline(source);
	assert.equal(result.ok, false, "expected validation to fail");
	if (result.ok) throw new Error("unreachable");
	return result.errors;
}

function at(errors: Errors, path: string): Errors[number] {
	const found = errors.filter((e) => e.path === path);
	assert.equal(found.length, 1, `expected exactly one error at ${path}: ${JSON.stringify(errors)}`);
	return found[0];
}

/** The example from docs/pipelines.md, verbatim. */
const DOC_EXAMPLE = `name: verify
description: Install, typecheck and test one package.

inputs:
  package:
    description: Directory of the package to verify.
    default: hub

env:
  CI: "1"

timeout-minutes: 15

steps:
  - name: Install
    run: npm ci
    working-directory: \${{ inputs.package }}
    report: false

  - name: Typecheck
    run: npm run typecheck
    working-directory: \${{ inputs.package }}

  - name: Tests
    run: npm test
    working-directory: \${{ inputs.package }}
    continue-on-error: true
    timeout-minutes: 10
    env:
      API_TOKEN: \${{ secrets.API_TOKEN }}

  - name: Collect coverage
    if: always()
    run: cat coverage/summary.txt
    working-directory: \${{ inputs.package }}
`;

test("the documented example parses, with defaults applied", () => {
	const p = okOf(DOC_EXAMPLE);
	assert.equal(p.name, "verify");
	assert.equal(p.description, "Install, typecheck and test one package.");
	assert.deepEqual(p.inputs, {
		package: {
			description: "Directory of the package to verify.",
			required: false,
			default: "hub",
		},
	});
	assert.deepEqual(p.env, { CI: "1" });
	assert.equal(p.timeoutMinutes, 15);
	assert.deepEqual(p.defaults, { run: { shell: "bash", workingDirectory: "." } });
	assert.equal(p.runsOn, "host");
	assert.equal(p.steps.length, 4);

	const [install, typecheck, tests, collect] = p.steps;
	assert.equal(install.name, "Install");
	assert.equal(install.run, "npm ci");
	assert.equal(install.workingDirectory, "${{ inputs.package }}");
	assert.equal(install.report, false);
	assert.equal(install.if, "success()");
	assert.equal(install.continueOnError, false);
	assert.equal(install.timeoutMinutes, 15, "unset step timeout inherits the pipeline's");
	assert.equal(install.shell, "bash");
	assert.equal(install.index, 0);

	assert.equal(typecheck.name, "Typecheck");
	assert.equal(typecheck.report, true, "report defaults to true");

	assert.equal(tests.continueOnError, true);
	assert.equal(tests.timeoutMinutes, 10);
	assert.deepEqual(tests.env, { API_TOKEN: "${{ secrets.API_TOKEN }}" });

	assert.equal(collect.if, "always()");
	assert.equal(collect.name, "Collect coverage");
});

test("a minimal pipeline gets every default", () => {
	const p = okOf("name: min\nsteps:\n  - run: echo hi\n");
	assert.equal(p.timeoutMinutes, 30);
	assert.equal(p.description, null);
	assert.deepEqual(p.inputs, {});
	assert.deepEqual(p.env, {});
	assert.deepEqual(p.defaults.run, { shell: "bash", workingDirectory: "." });
	const [step] = p.steps;
	assert.equal(step.name, "echo hi", "name defaults to the first line of run");
	assert.equal(step.id, null);
	assert.equal(step.shell, "bash");
	assert.equal(step.workingDirectory, ".");
	assert.equal(step.if, "success()");
	assert.equal(step.continueOnError, false);
	assert.equal(step.report, true);
	assert.equal(step.timeoutMinutes, 30);
});

test("defaults.run applies to every job step unless the step overrides it", () => {
	const p = okOf(`name: x
defaults:
  run:
    shell: pwsh
    working-directory: sub
steps:
  - run: ls
  - run: ls
    shell: sh
    working-directory: other
`);
	assert.equal(p.steps[0].shell, "pwsh");
	assert.equal(p.steps[0].workingDirectory, "sub");
	assert.equal(p.steps[1].shell, "sh");
	assert.equal(p.steps[1].workingDirectory, "other");
});

test("if accepts the optional ${{ }} wrapper", () => {
	const p = okOf("name: x\nsteps:\n  - run: a\n    if: ${{ always() }}\n  - run: b\n    if: failure()\n");
	assert.equal(p.steps[0].if, "always()");
	assert.equal(p.steps[1].if, "failure()");
});

test("an unknown key is an error with a did-you-mean suggestion and its line", () => {
	const errors = errorsOf(`name: a
steps:
  - run: echo
    continue_on_error: true
`);
	const e = at(errors, "steps[0].continue_on_error");
	assert.equal(e.line, 4);
	assert.equal(e.message, 'unknown key "continue_on_error" (did you mean "continue-on-error"?)');
});

test("a misspelt key gets the closest suggestion", () => {
	const errors = errorsOf("name: a\ntimeout_minutes: 5\nsteps:\n  - run: x\n");
	assert.equal(
		at(errors, "timeout_minutes").message,
		'unknown key "timeout_minutes" (did you mean "timeout-minutes"?)',
	);
});

test("GitHub Actions top-level keys get their own message, not the unknown-key one", () => {
	const errors = errorsOf("on: push\nname: a\nsteps:\n  - run: x\n");
	const e = at(errors, "on");
	assert.equal(e.line, 1);
	assert.match(e.message, /GitHub Actions key that is not supported/);
	assert.doesNotMatch(e.message, /unknown key/);
});

test("uses: in a job step is refused with the GitHub Actions message and its line", () => {
	const errors = errorsOf(`name: a
steps:
  - uses: actions/checkout@v4
    run: x
`);
	const e = at(errors, "steps[0].uses");
	assert.equal(e.line, 3);
	assert.match(e.message, /GitHub Actions key that is not supported/);
});

test("every GitHub Actions job key is refused, not just on and uses", () => {
	for (const key of ["jobs", "needs", "strategy", "matrix", "services", "container", "with", "outputs"]) {
		const errors = errorsOf(`name: a\n${key}: x\nsteps:\n  - run: x\n`);
		assert.match(at(errors, key).message, /not supported/, key);
	}
});

test("anchors and aliases are rejected, each with its line", () => {
	const errors = errorsOf(`name: a
env:
  A: &v x
  B: *v
steps:
  - run: echo
`);
	assert.equal(errors.length, 2, "only the alias errors: schema checks would be noise");
	const anchor = errors.find((e) => /anchors/.test(e.message));
	const alias = errors.find((e) => /aliases/.test(e.message));
	assert.ok(anchor, "anchor error");
	assert.equal(anchor.line, 3);
	assert.ok(alias, "alias error");
	assert.equal(alias.line, 4);
});

test("a document over 64 KiB is refused before it is parsed", () => {
	const source = "name: a\nsteps:\n  - run: x\n#" + "x".repeat(MAX_PIPELINE_BYTES);
	const errors = errorsOf(source);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].line, null);
	assert.match(errors[0].message, /64 KiB/);
});

test("a multi-document stream is refused", () => {
	const errors = errorsOf("name: a\nsteps:\n  - run: x\n---\nname: b\n");
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /one YAML document/);
});

test("a non-mapping root is refused", () => {
	const errors = errorsOf("- a\n- b\n");
	assert.equal(errors[0].path, "");
	assert.equal(errors[0].line, 1);
	assert.match(errors[0].message, /must be a mapping/);
});

test("an empty document is refused", () => {
	assert.match(errorsOf("").at(0)?.message ?? "", /empty/);
});

test("a missing run names the step and its line", () => {
	const errors = errorsOf(`name: a
steps:
  - run: echo
  - name: second
`);
	const e = at(errors, "steps[1]");
	assert.equal(e.line, 4);
	assert.equal(e.message, '"run" is required');
});

test("a missing name is required, at the top of the document", () => {
	const errors = errorsOf("steps:\n  - run: x\n");
	const e = at(errors, "name");
	assert.equal(e.line, 1);
	assert.equal(e.message, '"name" is required');
});

test("steps must contain at least one entry", () => {
	const errors = errorsOf("name: a\nsteps: []\n");
	const e = at(errors, "steps");
	assert.equal(e.line, 2);
	assert.match(e.message, /at least one job step/);
});

test("shell must be bash, sh or pwsh", () => {
	const errors = errorsOf(`name: a
steps:
  - run: x
    shell: zsh
`);
	const e = at(errors, "steps[0].shell");
	assert.equal(e.line, 4);
	assert.match(e.message, /shell must be one of bash, sh, pwsh; got "zsh"/);
});

test("runs-on accepts only host", () => {
	const errors = errorsOf("name: a\nruns-on: sandbox\nsteps:\n  - run: x\n");
	const e = at(errors, "runs-on");
	assert.equal(e.line, 2);
	assert.match(e.message, /only accepted value is "host"/);
	okOf("name: a\nruns-on: host\nsteps:\n  - run: x\n");
});

test("if accepts only success(), failure() and always()", () => {
	const errors = errorsOf("name: a\nsteps:\n  - run: x\n    if: cancelled()\n");
	const e = at(errors, "steps[0].if");
	assert.equal(e.line, 4);
	assert.match(e.message, /success\(\), failure\(\) or always\(\)/);
});

test("working-directory must be relative and must not leave the workdir", () => {
	const errors = errorsOf(`name: a
steps:
  - run: x
    working-directory: /etc
  - run: x
    working-directory: ../up
  - run: x
    working-directory: a/../../b
  - run: x
    working-directory: a/../b
`);
	assert.equal(errors.length, 3, JSON.stringify(errors));
	assert.equal(at(errors, "steps[0].working-directory").line, 4);
	assert.match(at(errors, "steps[0].working-directory").message, /not an absolute path/);
	assert.equal(at(errors, "steps[1].working-directory").line, 6);
	assert.match(at(errors, "steps[1].working-directory").message, /leaves it/);
	assert.equal(at(errors, "steps[2].working-directory").line, 8);
});

test("a ${{ }} in run is rejected, with the line of the expression", () => {
	const errors = errorsOf(`name: a
inputs:
  x:
    default: y
steps:
  - run: echo \${{ inputs.x }}
`);
	const e = at(errors, "steps[0].run");
	assert.equal(e.line, 6);
	assert.match(e.message, /is not allowed in "run"/);
	assert.match(e.message, /Pass the value through env/);
});

test("a ${{ }} in a multi-line run block points at the line that holds it", () => {
	const errors = errorsOf(`name: a
steps:
  - run: |
      set -e
      echo \${{ secrets.TOKEN }}
`);
	assert.equal(at(errors, "steps[0].run").line, 5);
});

test("the same input read through env is accepted, and run reads it as a shell variable", () => {
	const p = okOf(`name: a
inputs:
  x:
    default: y
env:
  X: \${{ inputs.x }}
steps:
  - run: echo "$X"
`);
	assert.equal(p.env.X, "${{ inputs.x }}");
	assert.equal(p.inputs.x.default, "y");
});

test("an undeclared input in env is rejected with its line", () => {
	const errors = errorsOf(`name: a
env:
  X: \${{ inputs.nope }}
steps:
  - run: x
`);
	const e = at(errors, "env.X");
	assert.equal(e.line, 3);
	assert.match(e.message, /input "nope" is not declared in inputs/);
});

test("only the documented expressions are allowed outside run", () => {
	const errors = errorsOf(`name: a
steps:
  - run: x
    env:
      A: \${{ secrets.TOKEN }}
      B: \${{ env.HOME }}
`);
	assert.equal(errors.length, 1, JSON.stringify(errors));
	const e = at(errors, "steps[0].env.B");
	assert.equal(e.line, 6);
	assert.match(e.message, /expression "env.HOME" is not supported/);
});

test("an unterminated ${{ in env is an error", () => {
	const errors = errorsOf("name: a\nenv:\n  X: ${{ inputs.x\nsteps:\n  - run: x\n");
	assert.match(at(errors, "env.X").message, /unterminated/);
});

test("duplicate step ids are rejected at the second one", () => {
	const errors = errorsOf(`name: a
steps:
  - id: build
    run: x
  - id: build
    run: y
`);
	const e = at(errors, "steps[1].id");
	assert.equal(e.line, 5);
	assert.match(e.message, /duplicate id "build" \(already used by steps\[0\]\)/);
});

test("wrong types are reported, each with its line", () => {
	const errors = errorsOf(`name: a
env:
  CI: 1
steps:
  - run: x
    continue-on-error: "yes"
    report: yes
    timeout-minutes: 0
`);
	assert.equal(errors.length, 4, JSON.stringify(errors));
	assert.equal(at(errors, "env.CI").line, 3);
	assert.match(at(errors, "env.CI").message, /must be a string/);
	assert.equal(at(errors, "steps[0].continue-on-error").line, 6);
	assert.match(at(errors, "steps[0].continue-on-error").message, /must be true or false/);
	assert.equal(at(errors, "steps[0].report").line, 7, "YAML 1.2: yes is a string");
	assert.equal(at(errors, "steps[0].timeout-minutes").line, 8);
	assert.match(at(errors, "steps[0].timeout-minutes").message, /whole number of minutes from 1 to 360/);
});

test("every error is returned, not only the first", () => {
	const errors = errorsOf(`name: a
timeout-minutes: 400
steps:
  - name: one
    continue_on_error: true
  - run: x
    shell: zsh
`);
	assert.equal(errors.length, 4, JSON.stringify(errors));
	assert.equal(at(errors, "timeout-minutes").line, 2);
	assert.equal(at(errors, "steps[0]").line, 4);
	assert.equal(at(errors, "steps[0].continue_on_error").line, 5);
	assert.equal(at(errors, "steps[1].shell").line, 7);
});

test("inputs: unknown input keys get suggestions, and default must be a string", () => {
	const errors = errorsOf(`name: a
inputs:
  pkg:
    descripton: x
    default: 5
steps:
  - run: x
`);
	const misspelt = at(errors, "inputs.pkg.descripton");
	assert.equal(misspelt.line, 4);
	assert.match(misspelt.message, /did you mean "description"\?/);
	const dflt = at(errors, "inputs.pkg.default");
	assert.equal(dflt.line, 5);
	assert.match(dflt.message, /must be a string/);
});

test("steps must be a list", () => {
	const errors = errorsOf("name: a\nsteps: nope\n");
	const e = at(errors, "steps");
	assert.equal(e.line, 2);
	assert.match(e.message, /must be a list of job steps/);
});

test("the default shell and working-directory are overridable per step", () => {
	const p = okOf("name: a\nsteps:\n  - run: x\n    timeout-minutes: 5\n    report: false\n");
	assert.equal(p.steps[0].timeoutMinutes, 5);
	assert.equal(p.steps[0].report, false);
});

test("sourceHash is the SHA-256 hex of the exact text, stable across calls", () => {
	const text = DOC_EXAMPLE;
	const expected = createHash("sha256").update(text, "utf8").digest("hex");
	assert.equal(sourceHash(text), expected);
	assert.equal(sourceHash(text), sourceHash(text));
	assert.equal(sourceHash(text).length, 64);
	assert.notEqual(sourceHash(text), sourceHash(text + "\n"), "any byte change changes the hash");
});

test("editDistance is the Levenshtein distance", () => {
	assert.equal(editDistance("kitten", "sitting"), 3);
	assert.equal(editDistance("name", "name"), 0);
	assert.equal(editDistance("nmae", "name"), 2);
});
