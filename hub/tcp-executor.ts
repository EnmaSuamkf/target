/**
 * Executes TCP tool request templates: parse a curl string, substitute agent
 * inputs and configured secret tokens, then perform the HTTP request.
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

	const methodMatch = /(?:^|\s)-X\s+(\w+)/i.exec(rest);
	if (methodMatch) {
		method = methodMatch[1].toUpperCase();
		rest = rest.replace(methodMatch[0], " ").trim();
	}

	const urlMatch = /https?:\/\/[^\s'"]+/i.exec(rest) ?? /^(\S+)/.exec(rest);
	if (!urlMatch) throw new Error("invalid_curl_template");
	const url = urlMatch[0].replace(/^['"]|['"]$/g, "");
	rest = rest.replace(urlMatch[0], " ").trim();

	while (rest.length > 0) {
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
		if (rest.startsWith("-")) {
			const skip = /^\S+/.exec(rest);
			rest = skip ? rest.slice(skip[0].length).trim() : "";
			continue;
		}
		break;
	}

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

function normalizeInputs(tool: TcpTool, request: TcpExecuteRequest): Record<string, string> {
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

function substitutePlaceholders(text: string, replacements: Record<string, string>): string {
	let out = text;
	for (const [key, value] of Object.entries(replacements)) {
		const patterns = [`$${key}`, `<$${key}>`];
		for (const pattern of patterns) {
			out = out.split(pattern).join(value);
		}
	}
	return out;
}

function buildReplacements(tool: TcpTool, provided: Record<string, string>): Record<string, string> {
	const replacements: Record<string, string> = { ...tool.tokens };
	for (const input of tool.inputs) {
		const value = provided[input.name] ?? "";
		const key = input.placeholder.replace(/^\$/, "");
		replacements[key] = value;
	}
	if (provided.default) {
		replacements.MODEL_INPUT = provided.default;
		replacements.INPUT_1 = provided.default;
	}
	return replacements;
}

export function applyTemplateSubstitutions(template: string, replacements: Record<string, string>): string {
	return substitutePlaceholders(template, replacements);
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
			message: `Faltan entradas obligatorias: ${missing.join(", ")}`,
			missing,
		};
	}

	const replacements = buildReplacements(tool, provided);
	const resolvedTemplate = applyTemplateSubstitutions(tool.requestTemplate, replacements);
	let parsed: ParsedCurlRequest;
	try {
		parsed = parseCurlTemplate(resolvedTemplate);
	} catch {
		return { ok: false, error: "invalid_template", message: "La plantilla curl no es válida" };
	}

	const headers = Object.fromEntries(
		Object.entries(parsed.headers).map(([k, v]) => [k, substitutePlaceholders(v, replacements)]),
	);
	const body = parsed.body == null ? undefined : substitutePlaceholders(parsed.body, replacements);
	const started = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const res = await fetch(parsed.url, {
			method: parsed.method,
			headers,
			body: body == null || parsed.method === "GET" ? undefined : body,
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
				description: "Argumento del agente",
				required: true,
			},
		];
	}
	return [];
}
