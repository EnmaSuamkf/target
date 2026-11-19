/**
 * Executes TCP tool request templates: parse a curl string with its
 * placeholders still intact, substitute each part (URL, header value, body)
 * exactly once, then perform the HTTP request.
 *
 * Agent inputs are data. They are percent-encoded in the URL, JSON-string-escaped
 * inside a JSON body, and rejected when they put CR or LF into a header. They
 * are never written back into the curl text and never scanned for `$TOKEN_*`.
 * Token placeholders are filled only from `tool.tokens`. The request is sent
 * only when the resolved scheme, host, and port match the template and the
 * path still has the template's shape (a `..` input cannot climb to another
 * route). Redirects are not followed. See docs/tcp-tools.md.
 */
import type { TcpTool, TcpToolInput } from "./tcp-store.ts";

export interface TcpExecuteRequest {
	toolName: string;
	/** Keyed by input `name`. */
	inputs?: Record<string, string>;
	/** Shorthand for a single-input tool. */
	input?: string;
}

export interface TcpExecuteResult {
	ok: boolean;
	status?: number;
	body?: string;
	durationMs?: number;
	error?: string;
	message?: string;
	missing?: string[];
}

export interface ParsedCurlRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Parses a minimal curl one-liner or backslash-continued command. */
export function parseCurlTemplate(template: string): ParsedCurlRequest {
	const normalized = template.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized.toLowerCase().startsWith("curl ")) {
		throw new Error("invalid_curl_template");
	}
	let rest = normalized.slice(5).trim();
	let method = "GET";
	const headers: Record<string, string> = {};
	let body: string | null = null;
	let url = "";

	while (rest.length > 0) {
		if (rest.startsWith("-X ") || rest.startsWith("--request ")) {
			const flag = rest.startsWith("-X ") ? "-X " : "--request ";
			rest = rest.slice(flag.length).trim();
			const token = readQuoted(rest);
			method = token.value.toUpperCase();
			rest = token.rest.trim();
			continue;
		}
		if (rest.startsWith("-H ") || rest.startsWith("--header ")) {
			const flag = rest.startsWith("-H ") ? "-H " : "--header ";
			rest = rest.slice(flag.length).trim();
			const quoted = readQuoted(rest);
			const sep = quoted.value.indexOf(":");
			if (sep === -1) throw new Error("invalid_curl_header");
			const key = quoted.value.slice(0, sep).trim();
			const value = quoted.value.slice(sep + 1).trim();
			headers[key] = value;
			rest = quoted.rest.trim();
			continue;
		}
		if (rest.startsWith("-u ") || rest.startsWith("--user ")) {
			const flag = rest.startsWith("-u ") ? "-u " : "--user ";
			rest = rest.slice(flag.length).trim();
			const quoted = readQuoted(rest);
			headers.Authorization = `Basic ${Buffer.from(quoted.value).toString("base64")}`;
			rest = quoted.rest.trim();
			continue;
		}
		if (rest.startsWith("-d ") || rest.startsWith("--data ") || rest.startsWith("--data-raw ")) {
			const flag = rest.startsWith("-d ")
				? "-d "
				: rest.startsWith("--data-raw ")
					? "--data-raw "
					: "--data ";
			rest = rest.slice(flag.length).trim();
			const quoted = readQuoted(rest);
			body = quoted.value;
			if (method === "GET") method = "POST";
			rest = quoted.rest.trim();
			continue;
		}
		if (rest.startsWith("http://") || rest.startsWith("https://") || rest.startsWith("'") || rest.startsWith('"')) {
			const quoted = readQuoted(rest);
			url = quoted.value.replace(/^['"]|['"]$/g, "");
			rest = quoted.rest.trim();
			continue;
		}
		if (rest.startsWith("-")) {
			const skip = /^\S+/.exec(rest);
			rest = skip ? rest.slice(skip[0].length).trim() : "";
			continue;
		}
		break;
	}

	if (!url) throw new Error("invalid_curl_template");
	if (!headers["content-type"] && body != null) headers["content-type"] = "application/json";
	return { method, url, headers, body };
}

function readQuoted(input: string): { value: string; rest: string } {
	if (input.startsWith("'")) {
		const end = input.indexOf("'", 1);
		if (end === -1) throw new Error("invalid_curl_template");
		return { value: input.slice(1, end), rest: input.slice(end + 1) };
	}
	if (input.startsWith('"')) {
		const end = input.indexOf('"', 1);
		if (end === -1) throw new Error("invalid_curl_template");
		return { value: input.slice(1, end), rest: input.slice(end + 1) };
	}
	const bare = /^\S+/.exec(input);
	if (!bare) throw new Error("invalid_curl_template");
	return { value: bare[0], rest: input.slice(bare[0].length) };
}

export function normalizeInputs(tool: TcpTool, request: TcpExecuteRequest): Record<string, string> {
	const out: Record<string, string> = {};
	if (request.inputs && typeof request.inputs === "object") {
		for (const [key, value] of Object.entries(request.inputs)) {
			if (typeof value === "string") out[key] = value;
		}
	}
	if (typeof request.input === "string" && request.input !== "") {
		if (tool.inputs.length === 1) {
			out[tool.inputs[0].name] = request.input;
		} else if (tool.inputs.length === 0) {
			out.default = request.input;
		}
	}
	return out;
}

export function validateInputs(tool: TcpTool, provided: Record<string, string>): string[] {
	const missing: string[] = [];
	for (const input of tool.inputs) {
		if (input.required !== false && !(input.name in provided)) missing.push(input.name);
	}
	return missing;
}

/**
 * `$NAME` or `<$NAME>`, one left-to-right pass. The text returned for a match
 * is not scanned again, so a value of `$TOKEN_1` stays those characters.
 */
function replacePlaceholders(text: string, replacer: (name: string) => string | undefined): string {
	return text.replace(/<\$([A-Za-z0-9_]+)>|\$([A-Za-z0-9_]+)/g, (match, angle: string | undefined, plain: string | undefined) => {
		const name = angle ?? plain;
		if (!name) return match;
		const value = replacer(name);
		return value === undefined ? match : value;
	});
}

function substitutePlaceholders(text: string, replacements: Record<string, string>): string {
	return replacePlaceholders(text, (name) => (Object.hasOwn(replacements, name) ? (replacements[name] ?? "") : undefined));
}

/**
 * One raw pass over `template`. Not used to execute a tool: filling the curl
 * text before `parseCurlTemplate` lets an input break out of its quotes.
 * Execution parses first and fills each part via `substituteSlot`.
 */
export function applyTemplateSubstitutions(template: string, replacements: Record<string, string>): string {
	return substitutePlaceholders(template, replacements);
}

type Slot = "url" | "header" | "json" | "raw";

function inputValueMap(tool: TcpTool, provided: Record<string, string>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const input of tool.inputs) {
		const key = input.placeholder.replace(/^\$/, "");
		values[key] = provided[input.name] ?? "";
	}
	if (provided.default) {
		values.MODEL_INPUT = provided.default;
		values.INPUT_1 = provided.default;
	}
	return values;
}

function resolvePlaceholder(
	tool: TcpTool,
	inputs: Record<string, string>,
	name: string,
): { kind: "token" | "input"; value: string } | undefined {
	// Tokens win even when an input reuses the same placeholder name.
	if (Object.hasOwn(tool.tokens, name)) return { kind: "token", value: tool.tokens[name] ?? "" };
	if (Object.hasOwn(inputs, name)) return { kind: "input", value: inputs[name] ?? "" };
	return undefined;
}

/** Embeds `value` as the contents of a JSON string (quotes already supplied by the template). */
function jsonStringContent(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/**
 * Agent inputs in a URL are one component: path, query, or fragment.
 * `encodeURIComponent` keeps the value from adding a segment, a parameter,
 * a userinfo `@`, or a second host. `.` is left intact, so a placeholder
 * that sits in the host can still change the origin — `executeTcpTool`
 * refuses that before sending. Tokens are inserted as stored; they are not
 * agent input.
 */
function encodeValue(kind: "token" | "input", value: string, slot: Slot): string {
	if (slot === "url" && kind === "input") return encodeURIComponent(value);
	if (slot === "json") return jsonStringContent(value);
	return value;
}

function substituteSlot(text: string, tool: TcpTool, inputs: Record<string, string>, slot: Slot): string {
	return replacePlaceholders(text, (name) => {
		const found = resolvePlaceholder(tool, inputs, name);
		if (!found) return undefined;
		return encodeValue(found.kind, found.value, slot);
	});
}

function isJsonBody(body: string): boolean {
	const trimmed = body.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function hasCrlf(value: string): boolean {
	return value.includes("\r") || value.includes("\n");
}

const PATH_PLACEHOLDER = /<\$[A-Za-z0-9_]+>|\$[A-Za-z0-9_]+/;

/**
 * True when the resolved path is the template path with each placeholder
 * segment replaced in place. `..` and `.` are not percent-encoded, so the URL
 * parser would otherwise turn `/api/workflows/..` into `/api/` on the same
 * origin — another route, still carrying the template's headers.
 */
function pathStaysInTemplate(templateUrl: string, resolvedUrl: string): boolean {
	let templatePath: string;
	let resolvedPath: string;
	try {
		templatePath = new URL(templateUrl).pathname;
		resolvedPath = new URL(resolvedUrl).pathname;
	} catch {
		return false;
	}
	const templateSegs = templatePath.split("/");
	const resolvedSegs = resolvedPath.split("/");
	if (templateSegs.length !== resolvedSegs.length) return false;
	for (let i = 0; i < templateSegs.length; i++) {
		const expected = templateSegs[i] ?? "";
		const actual = resolvedSegs[i] ?? "";
		if (PATH_PLACEHOLDER.test(expected)) {
			if (actual === "" || actual === "." || actual === "..") return false;
		} else if (actual !== expected) {
			return false;
		}
	}
	return true;
}

/** Scheme + host + port, or null when `url` is not an absolute http(s) URL. */
function originOf(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	return parsed.origin;
}

export async function executeTcpTool(
	tool: TcpTool,
	request: TcpExecuteRequest,
	options: { timeoutMs?: number } = {},
): Promise<TcpExecuteResult> {
	const provided = normalizeInputs(tool, request);
	const missing = validateInputs(tool, provided);
	if (missing.length > 0) {
		return {
			ok: false,
			error: "missing_inputs",
			message: `Missing required inputs: ${missing.join(", ")}`,
			missing,
		};
	}

	let parsed: ParsedCurlRequest;
	try {
		parsed = parseCurlTemplate(tool.requestTemplate);
	} catch {
		return { ok: false, error: "invalid_template", message: "The curl template is not valid" };
	}

	const inputs = inputValueMap(tool, provided);
	const url = substituteSlot(parsed.url, tool, inputs, "url");
	const templateOrigin = originOf(parsed.url);
	const resolvedOrigin = originOf(url);
	if (!templateOrigin || !resolvedOrigin) {
		return {
			ok: false,
			error: "invalid_url",
			message: "Refusing to send: the resolved URL is not a valid absolute http(s) URL",
		};
	}
	if (templateOrigin !== resolvedOrigin) {
		return {
			ok: false,
			error: "origin_mismatch",
			message: `Refusing to send: resolved origin ${resolvedOrigin} does not match template origin ${templateOrigin}`,
		};
	}
	if (!pathStaysInTemplate(parsed.url, url)) {
		return {
			ok: false,
			error: "invalid_url",
			message: "Refusing to send: the resolved path leaves the path written in the template",
		};
	}

	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed.headers)) {
		const filled = substituteSlot(value, tool, inputs, "header");
		if (hasCrlf(key) || hasCrlf(filled)) {
			return {
				ok: false,
				error: "invalid_header",
				message: "Refusing to send: a header value contains CR or LF",
			};
		}
		headers[key] = filled;
	}

	const body =
		parsed.body == null ? undefined : substituteSlot(parsed.body, tool, inputs, isJsonBody(parsed.body) ? "json" : "raw");
	const started = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: parsed.method,
			headers,
			body: body == null || parsed.method === "GET" ? undefined : body,
			redirect: "manual",
			signal: controller.signal,
		});
		const buf = Buffer.from(await res.arrayBuffer());
		const truncated = buf.length > MAX_RESPONSE_BYTES;
		const text = (truncated ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf).toString("utf8");
		return {
			ok: res.ok,
			status: res.status,
			body: truncated ? `${text}\n…[truncated]` : text,
			durationMs: Date.now() - started,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: message.includes("abort") ? "timeout" : "request_failed",
			message,
			durationMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timeout);
	}
}

/** Builds default inputs when a legacy tool omits the `inputs` array. */
export function defaultToolInputs(tool: TcpTool): TcpToolInput[] {
	if (tool.inputs.length > 0) return tool.inputs;
	if (tool.requestTemplate.includes("$MODEL_INPUT") || tool.requestTemplate.includes("$INPUT_1")) {
		return [
			{
				name: "default",
				placeholder: "$MODEL_INPUT",
				description: "Agent argument",
				required: true,
			},
		];
	}
	return [];
}
