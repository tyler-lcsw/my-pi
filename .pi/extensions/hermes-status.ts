import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonRecord = Record<string, unknown>;

interface HermesStatusSnapshot {
	baseUrl: string;
	checkedAt: string;
	authConfigured: boolean;
	reachable: boolean;
	health?: JsonRecord;
	detailedHealth?: JsonRecord;
	capabilities?: JsonRecord;
	models: string[];
	errors: EndpointErrorDetails[];
}

interface EndpointErrorDetails {
	path: string;
	status?: number;
	message: string;
}

const STATUS_PARAMS = Type.Object({});
const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:8642";
const DEFAULT_ENDPOINT_TIMEOUT_MS = 1_500;
const HERMES_STATUS_KEY = "hermes";

class HermesEndpointError extends Error {
	readonly path: string;
	readonly status: number | undefined;

	constructor(path: string, status: number | undefined, message: string) {
		super(message);
		this.name = "HermesEndpointError";
		this.path = path;
		this.status = status;
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string | undefined): string {
	const raw = value?.trim() || DEFAULT_HERMES_BASE_URL;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function getHermesBaseUrl(): string {
	return normalizeBaseUrl(process.env.HERMES_API_BASE_URL ?? process.env.HERMES_API_URL);
}

function getRequestHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
	};
	const apiKey = process.env.HERMES_API_KEY?.trim();
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}
	const sessionKey = process.env.HERMES_SESSION_KEY?.trim();
	if (sessionKey) {
		headers["x-hermes-session-key"] = sessionKey;
	}
	return headers;
}

function getEndpointTimeoutMs(): number {
	const raw = process.env.HERMES_API_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_ENDPOINT_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ENDPOINT_TIMEOUT_MS;
}

function createEndpointSignal(signal: AbortSignal | undefined): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Hermes endpoint timed out after ${getEndpointTimeoutMs()}ms`));
	}, getEndpointTimeoutMs());
	const abortFromParent = () => {
		controller.abort(signal?.reason);
	};
	if (signal?.aborted) {
		abortFromParent();
	} else {
		signal?.addEventListener("abort", abortFromParent, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromParent);
		},
	};
}

async function fetchJson(baseUrl: string, path: string, signal?: AbortSignal): Promise<unknown> {
	const endpointSignal = createEndpointSignal(signal);
	try {
		const response = await fetch(`${baseUrl}${path}`, {
			headers: getRequestHeaders(),
			signal: endpointSignal.signal,
		});
		if (!response.ok) {
			throw new HermesEndpointError(path, response.status, `${path} returned HTTP ${response.status}`);
		}
		return response.json();
	} catch (error) {
		if (endpointSignal.signal.aborted && !(error instanceof HermesEndpointError)) {
			const reason = endpointSignal.signal.reason;
			const message = reason instanceof Error ? reason.message : `Hermes endpoint timed out after ${getEndpointTimeoutMs()}ms`;
			throw new HermesEndpointError(path, undefined, message);
		}
		throw error;
	} finally {
		endpointSignal.cleanup();
	}
}

function readStringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractNamedItems(payload: unknown): string[] {
	const source = isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
	const names = source
		.map((item) => {
			if (typeof item === "string") return item;
			if (!isRecord(item)) return undefined;
			return readStringField(item, "id") ?? readStringField(item, "name") ?? readStringField(item, "title");
		})
		.filter((item): item is string => item !== undefined);
	return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function asRecord(payload: unknown): JsonRecord | undefined {
	return isRecord(payload) ? payload : undefined;
}

function endpointErrorDetails(path: string, error: unknown): EndpointErrorDetails {
	if (error instanceof HermesEndpointError) {
		return {
			path: error.path,
			status: error.status,
			message: error.message,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		path,
		message,
	};
}

async function captureEndpoint<T>(
	snapshot: HermesStatusSnapshot,
	path: string,
	reader: (payload: unknown) => T,
	signal?: AbortSignal,
): Promise<T | undefined> {
	try {
		const payload = await fetchJson(snapshot.baseUrl, path, signal);
		return reader(payload);
	} catch (error) {
		snapshot.errors.push(endpointErrorDetails(path, error));
		return undefined;
	}
}

async function readHermesStatus(signal?: AbortSignal): Promise<HermesStatusSnapshot> {
	const snapshot: HermesStatusSnapshot = {
		baseUrl: getHermesBaseUrl(),
		checkedAt: new Date().toISOString(),
		authConfigured: Boolean(process.env.HERMES_API_KEY?.trim()),
		reachable: false,
		models: [],
		errors: [],
	};

	const [health, detailedHealth, capabilities, models] = await Promise.all([
		captureEndpoint(snapshot, "/health", asRecord, signal),
		captureEndpoint(snapshot, "/health/detailed", asRecord, signal),
		captureEndpoint(snapshot, "/v1/capabilities", asRecord, signal),
		captureEndpoint(snapshot, "/v1/models", extractNamedItems, signal),
	]);
	snapshot.health = health;
	snapshot.reachable = snapshot.health !== undefined;
	snapshot.detailedHealth = detailedHealth;
	snapshot.capabilities = capabilities;
	snapshot.models = models ?? [];

	return snapshot;
}

function plural(count: number, label: string): string {
	return count === 1 ? `${count} ${label}` : `${count} ${label}s`;
}

function formatList(label: string, values: string[]): string {
	if (values.length === 0) return `${label}: none`;
	if (values.length <= 8) return `${label}: ${values.join(", ")}`;
	return `${label}: ${values.slice(0, 8).join(", ")} (+${values.length - 8} more)`;
}

function formatJsonSummary(label: string, value: JsonRecord | undefined): string {
	if (!value) return `${label}: unavailable`;
	const entries = Object.entries(value)
		.filter(([, entryValue]) => typeof entryValue === "string" || typeof entryValue === "number" || typeof entryValue === "boolean")
		.slice(0, 6)
		.map(([key, entryValue]) => `${key}=${String(entryValue)}`);
	return entries.length > 0 ? `${label}: ${entries.join(", ")}` : `${label}: available`;
}

function formatSnapshot(snapshot: HermesStatusSnapshot): string {
	const lines = [
		`Hermes status: ${snapshot.reachable ? "reachable" : "offline"}`,
		`Base URL: ${snapshot.baseUrl}`,
		`API key: ${snapshot.authConfigured ? "configured" : "not configured"}`,
		`Checked: ${snapshot.checkedAt}`,
		formatJsonSummary("Health", snapshot.health),
		formatJsonSummary("Detailed health", snapshot.detailedHealth),
		formatJsonSummary("Capabilities", snapshot.capabilities),
		formatList("Models", snapshot.models),
	];

	if (snapshot.errors.length > 0) {
		lines.push("Errors:");
		for (const error of snapshot.errors) {
			const status = error.status === undefined ? "" : ` HTTP ${error.status}`;
			lines.push(`- ${error.path}${status}: ${error.message}`);
		}
	}

	return lines.join("\n");
}

function setHermesStatus(ctx: ExtensionContext, snapshot: HermesStatusSnapshot): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const needsAuth = snapshot.reachable && !snapshot.authConfigured && snapshot.errors.some((error) => error.status === 401);
	const statusText = !snapshot.reachable
		? "Hermes offline"
		: needsAuth
			? "Hermes reachable, API key needed"
			: snapshot.models.length > 0
				? `Hermes ${plural(snapshot.models.length, "model")}`
				: "Hermes reachable";
	ctx.ui.setStatus(
		HERMES_STATUS_KEY,
		snapshot.reachable && !needsAuth ? theme.fg("success", statusText) : theme.fg("warning", statusText),
	);
}

export default function hermesStatusExtension(pi: ExtensionAPI) {
	async function refresh(ctx: ExtensionContext, showReport: boolean): Promise<HermesStatusSnapshot> {
		const snapshot = await readHermesStatus(ctx.signal);
		setHermesStatus(ctx, snapshot);
		if (showReport) {
			pi.sendMessage({
				customType: "hermes-status",
				content: formatSnapshot(snapshot),
				display: true,
				details: snapshot,
			});
		}
		return snapshot;
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx, false);
	});

	pi.registerCommand("hermes-status", {
		description: "Check local Hermes Agent health, capabilities, and models",
		handler: async (_args, ctx) => {
			await refresh(ctx, true);
		},
	});

	pi.registerTool({
		name: "hermes_status",
		label: "Hermes Status",
		description: "Check whether the configured Hermes Agent API server is reachable and summarize health, capabilities, and models.",
		promptSnippet: "Check the local Hermes Agent status and summarize its health, capabilities, and exposed models.",
		promptGuidelines: [
			"Use hermes_status only for read-only Hermes Agent discovery.",
			"Do not infer bee01 or production state from this local status check.",
		],
		parameters: STATUS_PARAMS,
		async execute(_toolCallId, _params, signal) {
			const snapshot = await readHermesStatus(signal);
			return {
				content: [{ type: "text", text: formatSnapshot(snapshot) }],
				details: snapshot,
				isError: !snapshot.reachable,
			};
		},
	});
}
