import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonRecord = Record<string, unknown>;

interface HermesStatusSnapshot {
	baseUrl: string;
	checkedAt: string;
	reachable: boolean;
	health?: JsonRecord;
	capabilities?: JsonRecord;
	models: string[];
	skills: string[];
	toolsets: string[];
	errors: string[];
}

const STATUS_PARAMS = Type.Object({});
const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:8642";
const HERMES_STATUS_KEY = "hermes";

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

function getRequestHeaders(): HeadersInit {
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

async function fetchJson(baseUrl: string, path: string, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(`${baseUrl}${path}`, {
		headers: getRequestHeaders(),
		signal,
	});
	if (!response.ok) {
		throw new Error(`${path} returned HTTP ${response.status}`);
	}
	return response.json();
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
		const message = error instanceof Error ? error.message : String(error);
		snapshot.errors.push(message);
		return undefined;
	}
}

async function readHermesStatus(signal?: AbortSignal): Promise<HermesStatusSnapshot> {
	const snapshot: HermesStatusSnapshot = {
		baseUrl: getHermesBaseUrl(),
		checkedAt: new Date().toISOString(),
		reachable: false,
		models: [],
		skills: [],
		toolsets: [],
		errors: [],
	};

	snapshot.health = await captureEndpoint(snapshot, "/health", asRecord, signal);
	snapshot.reachable = snapshot.health !== undefined;
	snapshot.capabilities = await captureEndpoint(snapshot, "/v1/capabilities", asRecord, signal);
	snapshot.models = (await captureEndpoint(snapshot, "/v1/models", extractNamedItems, signal)) ?? [];
	snapshot.skills = (await captureEndpoint(snapshot, "/v1/skills", extractNamedItems, signal)) ?? [];
	snapshot.toolsets = (await captureEndpoint(snapshot, "/v1/toolsets", extractNamedItems, signal)) ?? [];

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
		`Checked: ${snapshot.checkedAt}`,
		formatJsonSummary("Health", snapshot.health),
		formatJsonSummary("Capabilities", snapshot.capabilities),
		formatList("Models", snapshot.models),
		formatList("Skills", snapshot.skills),
		formatList("Toolsets", snapshot.toolsets),
	];

	if (snapshot.errors.length > 0) {
		lines.push("Errors:");
		for (const error of snapshot.errors) {
			lines.push(`- ${error}`);
		}
	}

	return lines.join("\n");
}

function setHermesStatus(ctx: ExtensionContext, snapshot: HermesStatusSnapshot): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const statusText = snapshot.reachable
		? `Hermes ${plural(snapshot.models.length, "model")}, ${plural(snapshot.skills.length, "skill")}`
		: "Hermes offline";
	ctx.ui.setStatus(
		HERMES_STATUS_KEY,
		snapshot.reachable ? theme.fg("success", statusText) : theme.fg("warning", statusText),
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
		description: "Check local Hermes Agent health, models, skills, and toolsets",
		handler: async (_args, ctx) => {
			await refresh(ctx, true);
		},
	});

	pi.registerTool({
		name: "hermes_status",
		label: "Hermes Status",
		description: "Check whether the configured Hermes Agent API server is reachable and summarize models, skills, and toolsets.",
		promptSnippet: "Check the local Hermes Agent status and summarize its exposed models, skills, and toolsets.",
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
