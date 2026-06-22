#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 8787;
const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:8642";
const DEFAULT_LOCAL_MODELS_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1_048_576;

class BridgeError extends Error {
	constructor(status, message, details = undefined) {
		super(message);
		this.name = "BridgeError";
		this.status = status;
		this.details = details;
	}
}

function parsePort(value) {
	if (!value) return DEFAULT_BRIDGE_PORT;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid PI_HERMES_BRIDGE_PORT: ${value}`);
	}
	return port;
}

function parseTimeoutMs(value) {
	if (!value) return DEFAULT_TIMEOUT_MS;
	const timeout = Number(value);
	return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_TIMEOUT_MS;
}

function boolEnv(value) {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function normalizeBaseUrl(value) {
	const raw = value?.trim() || DEFAULT_HERMES_BASE_URL;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function normalizeLocalModelsBaseUrl(value) {
	const raw = value?.trim() || DEFAULT_LOCAL_MODELS_BASE_URL;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function readBridgeToken(env) {
	const inlineToken = env.PI_HERMES_BRIDGE_TOKEN?.trim();
	if (inlineToken) return inlineToken;

	const tokenFile = env.PI_HERMES_BRIDGE_TOKEN_FILE?.trim();
	if (!tokenFile) return undefined;

	try {
		return readFileSync(tokenFile, "utf8").trim() || undefined;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read PI_HERMES_BRIDGE_TOKEN_FILE ${tokenFile}: ${detail}`);
	}
}

export function readBridgeConfig(env = process.env) {
	return {
		host: env.PI_HERMES_BRIDGE_HOST?.trim() || DEFAULT_BRIDGE_HOST,
		port: parsePort(env.PI_HERMES_BRIDGE_PORT),
		bridgeToken: readBridgeToken(env),
		enableMutations: boolEnv(env.PI_HERMES_BRIDGE_ENABLE_MUTATIONS),
		hermesBaseUrl: normalizeBaseUrl(env.HERMES_API_BASE_URL ?? env.HERMES_API_URL),
		localModelsBaseUrl: normalizeLocalModelsBaseUrl(env.HERMES_LOCAL_MODELS_BASE_URL),
		hermesApiKey: env.HERMES_API_KEY?.trim() || env.API_SERVER_KEY?.trim() || undefined,
		timeoutMs: parseTimeoutMs(env.PI_HERMES_BRIDGE_TIMEOUT_MS),
	};
}

function bearerToken(request) {
	const header = request.headers.authorization;
	if (!header) return undefined;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim();
}

function requireBridgeToken(request, config) {
	if (!config.bridgeToken) return;
	if (bearerToken(request) !== config.bridgeToken) {
		throw new BridgeError(401, "Invalid bridge token");
	}
}

function assertMutationAllowed(request, config) {
	if (!config.enableMutations) {
		throw new BridgeError(403, "Mutating Hermes actions are disabled for this bridge");
	}
	if (!config.bridgeToken) {
		throw new BridgeError(403, "Mutating Hermes actions require PI_HERMES_BRIDGE_TOKEN");
	}
	requireBridgeToken(request, config);
}

async function getHermesApiKey(config) {
	if (config.hermesApiKey) return config.hermesApiKey;
	try {
		const { stdout } = await execFileAsync("docker", ["exec", "hermes-gateway", "printenv", "API_SERVER_KEY"], {
			timeout: config.timeoutMs,
			maxBuffer: 1024 * 1024,
		});
		const key = stdout.trim();
		if (key) return key;
	} catch (error) {
		throw new BridgeError(503, "Hermes API key is unavailable", error instanceof Error ? error.message : String(error));
	}
	throw new BridgeError(503, "Hermes API key is unavailable");
}

async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			throw new BridgeError(413, "Request body is too large");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function responseHeaders(extra = {}) {
	return {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...extra,
	};
}

function sendJson(response, status, payload, extraHeaders = {}) {
	response.writeHead(status, responseHeaders(extraHeaders));
	response.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(response, status, html, extraHeaders = {}) {
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		...extraHeaders,
	});
	response.end(html);
}

function sendHead(response, status, extraHeaders = {}) {
	response.writeHead(status, {
		"cache-control": "no-store",
		...extraHeaders,
	});
	response.end();
}

function sendNoContent(response) {
	response.writeHead(204, { "cache-control": "no-store" });
	response.end();
}

function acceptsHtml(request) {
	const accept = request.headers.accept;
	return typeof accept === "string" && accept.includes("text/html");
}

function limitedText(value) {
	if (!value) return "";
	return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

async function fetchHermes(config, path, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Hermes request timed out after ${config.timeoutMs}ms`));
	}, config.timeoutMs);
	try {
		const headers = {
			accept: "application/json",
			...options.headers,
		};
		if (options.auth !== false) {
			headers.authorization = `Bearer ${await getHermesApiKey(config)}`;
		}
		const result = await fetch(`${config.hermesBaseUrl}${path}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body,
			signal: controller.signal,
		});
		return result;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchHermesJson(config, path, options = {}) {
	const result = await fetchHermes(config, path, options);
	const text = await result.text();
	let payload;
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		payload = { raw: limitedText(text) };
	}
	if (!result.ok) {
		throw new BridgeError(result.status, `Hermes returned HTTP ${result.status}`, payload);
	}
	return payload;
}

async function fetchLocalModelsJson(config) {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Local model request timed out after ${config.timeoutMs}ms`));
	}, config.timeoutMs);
	try {
		const result = await fetch(`${config.localModelsBaseUrl}/v1/models`, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		const text = await result.text();
		let payload;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			payload = { raw: limitedText(text) };
		}
		if (!result.ok) {
			throw new BridgeError(result.status, `Local model router returned HTTP ${result.status}`, payload);
		}
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			return {
				object: "list",
				source: "local-model-router",
				...payload,
			};
		}
		return {
			object: "list",
			source: "local-model-router",
			data: Array.isArray(payload) ? payload : [],
		};
	} catch (error) {
		if (controller.signal.aborted) {
			throw new BridgeError(504, "Local model router request timed out");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function captureStatusEndpoint(config, path, options = {}) {
	try {
		return {
			path,
			ok: true,
			payload: await fetchHermesJson(config, path, options),
		};
	} catch (error) {
		return {
			path,
			ok: false,
			error: error instanceof BridgeError ? error.message : error instanceof Error ? error.message : String(error),
			status: error instanceof BridgeError ? error.status : undefined,
		};
	}
}

function forwardSessionHeaders(request) {
	const headers = {};
	for (const name of ["x-hermes-session-id", "x-hermes-session-key"]) {
		const value = request.headers[name];
		if (typeof value === "string" && value.trim()) {
			headers[name] = value.trim();
		}
	}
	return headers;
}

async function proxyJson(request, response, config, path, options = {}) {
	const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
	const headers = {
		...forwardSessionHeaders(request),
	};
	if (body && body.length > 0) {
		headers["content-type"] = request.headers["content-type"] ?? "application/json";
	}
	const payload = await fetchHermesJson(config, path, {
		method: request.method,
		headers,
		body: body && body.length > 0 ? body : undefined,
		auth: options.auth,
	});
	sendJson(response, 200, payload);
}

async function proxyStream(request, response, config, path) {
	const result = await fetchHermes(config, path, {
		method: "GET",
		headers: forwardSessionHeaders(request),
	});
	response.writeHead(result.status, {
		"content-type": result.headers.get("content-type") ?? "text/event-stream",
		"cache-control": "no-store",
	});
	if (!result.body) {
		response.end();
		return;
	}
	for await (const chunk of result.body) {
		response.write(Buffer.from(chunk));
	}
	response.end();
}

async function bridgeStatus(config) {
	const [health, detailedHealth, capabilities, models, localModels] = await Promise.all([
		captureStatusEndpoint(config, "/health", { auth: false }),
		captureStatusEndpoint(config, "/health/detailed", { auth: false }),
		captureStatusEndpoint(config, "/v1/capabilities"),
		captureStatusEndpoint(config, "/v1/models"),
		(async () => {
			try {
				return { path: "/v1/local-models", ok: true, payload: await fetchLocalModelsJson(config) };
			} catch (error) {
				return {
					path: "/v1/local-models",
					ok: false,
					error: error instanceof BridgeError ? error.message : error instanceof Error ? error.message : String(error),
					status: error instanceof BridgeError ? error.status : undefined,
				};
			}
		})(),
	]);
	return {
		bridge: {
			status: "ok",
			hermesBaseUrl: config.hermesBaseUrl,
			localModelsBaseUrl: config.localModelsBaseUrl,
			mutationsEnabled: config.enableMutations,
			bridgeTokenConfigured: Boolean(config.bridgeToken),
		},
		hermes: {
			health,
			detailedHealth,
			capabilities,
			models,
			localModels,
		},
	};
}

function bridgeIndex(config) {
	return {
		object: "pi.hermes_bridge",
		status: "ok",
		hermesBaseUrl: config.hermesBaseUrl,
		auth: {
			protectedRoutes: ["/v1/*"],
			bridgeTokenConfigured: Boolean(config.bridgeToken),
		},
		mutationsEnabled: config.enableMutations,
		endpoints: {
			health: "/health",
			detailedHealth: "/health/detailed",
			status: "/v1/status",
			models: "/v1/models",
			localModels: "/v1/local-models",
			capabilities: "/v1/capabilities",
			runs: "/v1/runs",
		},
	};
}

function bridgeIndexHtml(config) {
	const index = bridgeIndex(config);
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Pi Hermes Bridge</title>
	<style>
		body { color: #172026; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; margin: 0; padding: 32px; }
		main { max-width: 760px; }
		h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
		code { background: #edf1f5; border-radius: 4px; padding: 2px 5px; }
		ul { padding-left: 22px; }
	</style>
</head>
<body>
	<main>
		<h1>Pi Hermes Bridge</h1>
		<p>Status: <strong>${index.status}</strong></p>
		<p>Hermes target: <code>${index.hermesBaseUrl}</code></p>
		<p>Mutations enabled: <strong>${index.mutationsEnabled ? "yes" : "no"}</strong></p>
		<p>Protected routes: <code>${index.auth.protectedRoutes.join(", ")}</code></p>
		<ul>
			<li><a href="${index.endpoints.health}">Health</a></li>
			<li><a href="${index.endpoints.detailedHealth}">Detailed health</a></li>
			<li><code>${index.endpoints.models}</code> requires the bridge bearer token</li>
			<li><code>${index.endpoints.localModels}</code> requires the bridge bearer token</li>
		</ul>
	</main>
</body>
</html>
`;
}

function runIdFromPath(pathname, suffix = "") {
	const pattern = suffix
		? new RegExp(`^/v1/runs/([^/]+)/${suffix}$`)
		: /^\/v1\/runs\/([^/]+)$/;
	const match = pathname.match(pattern);
	return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function handleBridgeRequest(request, response, config) {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const pathname = url.pathname;
	const isPublicRead = request.method === "GET" || request.method === "HEAD";

	if (isPublicRead && (pathname === "/" || pathname === "/index.html")) {
		if (request.method === "HEAD") {
			sendHead(response, 200, { "content-type": "text/html; charset=utf-8" });
			return;
		}
		if (acceptsHtml(request)) {
			sendHtml(response, 200, bridgeIndexHtml(config));
		} else {
			sendJson(response, 200, bridgeIndex(config));
		}
		return;
	}
	if (isPublicRead && pathname === "/favicon.ico") {
		sendNoContent(response);
		return;
	}
	if (isPublicRead && pathname === "/health") {
		if (request.method === "HEAD") {
			sendHead(response, 200, { "content-type": "application/json; charset=utf-8" });
			return;
		}
		sendJson(response, 200, await bridgeStatus(config));
		return;
	}
	if (isPublicRead && pathname === "/health/detailed") {
		if (request.method === "HEAD") {
			sendHead(response, 200, { "content-type": "application/json; charset=utf-8" });
			return;
		}
		sendJson(response, 200, await fetchHermesJson(config, "/health/detailed", { auth: false }));
		return;
	}
	if (isPublicRead && !pathname.startsWith("/v1/")) {
		if (request.method === "HEAD") {
			sendHead(response, 200, { "content-type": "text/html; charset=utf-8" });
			return;
		}
		sendHtml(response, 200, bridgeIndexHtml(config));
		return;
	}

	requireBridgeToken(request, config);

	if (request.method === "GET" && pathname === "/v1/status") {
		sendJson(response, 200, await bridgeStatus(config));
		return;
	}
	if (request.method === "GET" && pathname === "/v1/models") {
		await proxyJson(request, response, config, "/v1/models");
		return;
	}
	if (request.method === "GET" && pathname === "/v1/local-models") {
		sendJson(response, 200, await fetchLocalModelsJson(config));
		return;
	}
	if (request.method === "GET" && pathname === "/v1/capabilities") {
		await proxyJson(request, response, config, "/v1/capabilities");
		return;
	}
	if (request.method === "POST" && pathname === "/v1/runs") {
		assertMutationAllowed(request, config);
		await proxyJson(request, response, config, "/v1/runs");
		return;
	}
	const runId = runIdFromPath(pathname);
	if (request.method === "GET" && runId) {
		await proxyJson(request, response, config, `/v1/runs/${encodeURIComponent(runId)}`);
		return;
	}
	const eventsRunId = runIdFromPath(pathname, "events");
	if (request.method === "GET" && eventsRunId) {
		await proxyStream(request, response, config, `/v1/runs/${encodeURIComponent(eventsRunId)}/events`);
		return;
	}
	const approvalRunId = runIdFromPath(pathname, "approval");
	if (request.method === "POST" && approvalRunId) {
		assertMutationAllowed(request, config);
		await proxyJson(request, response, config, `/v1/runs/${encodeURIComponent(approvalRunId)}/approval`);
		return;
	}
	const stopRunId = runIdFromPath(pathname, "stop");
	if (request.method === "POST" && stopRunId) {
		assertMutationAllowed(request, config);
		await proxyJson(request, response, config, `/v1/runs/${encodeURIComponent(stopRunId)}/stop`);
		return;
	}

	throw new BridgeError(404, "Route not found");
}

export function createBridgeServer(options = {}) {
	const config = options.config ?? readBridgeConfig(options.env);
	return createServer((request, response) => {
		handleBridgeRequest(request, response, config).catch((error) => {
			const status = error instanceof BridgeError ? error.status : 500;
			sendJson(response, status, {
				error: error instanceof Error ? error.message : String(error),
				details: error instanceof BridgeError ? error.details : undefined,
			});
		});
	});
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const config = readBridgeConfig();
	const server = createBridgeServer({ config });
	server.listen(config.port, config.host, () => {
		const tokenStatus = config.bridgeToken ? "configured" : "not configured";
		const mutationStatus = config.enableMutations ? "enabled" : "disabled";
		console.error(
			`pi-hermes-bridge listening on http://${config.host}:${config.port}; bridge token ${tokenStatus}; mutations ${mutationStatus}`,
		);
	});
}
