import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

type JsonRecord = Record<string, unknown>;

interface ModelCoordinationState {
	version: 1;
	preferredModel?: string;
	notes: string[];
	updatedAt: string;
}

interface ProjectMemoryEntry {
	id: string;
	title: string;
	content: string;
	tags: string[];
	source: "manual" | "task-snapshot";
	project: string;
	repoPath: string;
	createdAt: string;
}

interface ProjectMemoryState {
	version: 1;
	nextId: number;
	entries: ProjectMemoryEntry[];
}

interface BoardSummary {
	total: number;
	statusCounts: Record<string, number>;
}

interface ModelSummary {
	baseUrl: string;
	gatewayModels: string[];
	localModels: string[];
	preferredModel?: string;
	notes: string[];
	errors: string[];
}

const MODEL_ACTIONS = ["summary", "select"] as const;
const MEMORY_ACTIONS = ["summary", "capture", "task_snapshot"] as const;
const CONTROL_STORAGE_KEY = "hermes-models";
const MEMORY_STORAGE_KEY = "hermes-memory";
const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:8642";
const DEFAULT_ENDPOINT_TIMEOUT_MS = 1_500;

const MODEL_PARAMS = Type.Object({
	action: StringEnum(MODEL_ACTIONS),
	model: Type.Optional(Type.String({ description: "Preferred local model ID to select for this project." })),
	note: Type.Optional(Type.String({ description: "Optional coordination note for why the model was selected." })),
});

const MEMORY_PARAMS = Type.Object({
	action: StringEnum(MEMORY_ACTIONS),
	title: Type.Optional(Type.String({ description: "Short memory entry title." })),
	content: Type.Optional(Type.String({ description: "Project memory content. Do not include PHI or secrets." })),
	tags: Type.Optional(Type.Array(Type.String())),
});

type ModelParams = Static<typeof MODEL_PARAMS>;
type MemoryParams = Static<typeof MEMORY_PARAMS>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function nowIso(): string {
	return new Date().toISOString();
}

function projectStorageKey(cwd: string): string {
	return Buffer.from(cwd, "utf-8").toString("base64url");
}

function projectName(ctx: ExtensionContext): string {
	return basename(ctx.cwd) || "local-project";
}

function normalizeText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string {
	const raw = value?.trim() || DEFAULT_HERMES_BASE_URL;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function getHermesBaseUrl(): string {
	return normalizeBaseUrl(process.env.HERMES_API_BASE_URL ?? process.env.HERMES_API_URL);
}

function getRequestHeaders(): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	const apiKey = process.env.HERMES_API_KEY?.trim();
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const sessionKey = process.env.HERMES_SESSION_KEY?.trim();
	if (sessionKey) headers["x-hermes-session-key"] = sessionKey;
	return headers;
}

function getEndpointTimeoutMs(): number {
	const raw = process.env.HERMES_API_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_ENDPOINT_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ENDPOINT_TIMEOUT_MS;
}

async function fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Hermes control request timed out after ${getEndpointTimeoutMs()}ms`));
	}, getEndpointTimeoutMs());
	const abortFromParent = () => {
		controller.abort(signal?.reason);
	};
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const response = await fetch(`${getHermesBaseUrl()}${path}`, {
			headers: getRequestHeaders(),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
		return response.json();
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortFromParent);
	}
}

function readStringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractModelIds(payload: unknown): string[] {
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

function modelStatePath(ctx: ExtensionContext): string {
	return join(getAgentDir(), "extension-state", CONTROL_STORAGE_KEY, projectStorageKey(ctx.cwd), "models.json");
}

function memoryStatePath(ctx: ExtensionContext): string {
	return join(getAgentDir(), "extension-state", MEMORY_STORAGE_KEY, projectStorageKey(ctx.cwd), "memory.json");
}

function boardStatePath(ctx: ExtensionContext): string {
	return join(getAgentDir(), "extension-state", "hermes-board", projectStorageKey(ctx.cwd), "board.json");
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	try {
		await writeFileAtomic(tempPath, payload);
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function writeFileAtomic(path: string, payload: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

function createEmptyModelState(): ModelCoordinationState {
	return { version: 1, notes: [], updatedAt: nowIso() };
}

function createEmptyMemoryState(): ProjectMemoryState {
	return { version: 1, nextId: 1, entries: [] };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as unknown;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function loadModelState(ctx: ExtensionContext): Promise<ModelCoordinationState> {
	const payload = await readJsonFile(modelStatePath(ctx));
	if (!isRecord(payload) || payload.version !== 1) return createEmptyModelState();
	const notes = Array.isArray(payload.notes) ? payload.notes.filter((item): item is string => typeof item === "string") : [];
	return {
		version: 1,
		preferredModel: readStringField(payload, "preferredModel"),
		notes,
		updatedAt: readStringField(payload, "updatedAt") ?? nowIso(),
	};
}

async function loadMemoryState(ctx: ExtensionContext): Promise<ProjectMemoryState> {
	const payload = await readJsonFile(memoryStatePath(ctx));
	if (!isRecord(payload) || payload.version !== 1) return createEmptyMemoryState();
	const entries = Array.isArray(payload.entries)
		? payload.entries.filter(isRecord).map((entry) => ({
				id: readStringField(entry, "id") ?? "unknown",
				title: readStringField(entry, "title") ?? "Untitled",
				content: readStringField(entry, "content") ?? "",
				tags: Array.isArray(entry.tags) ? entry.tags.filter((item): item is string => typeof item === "string") : [],
				source: entry.source === "task-snapshot" ? ("task-snapshot" as const) : ("manual" as const),
				project: readStringField(entry, "project") ?? projectName(ctx),
				repoPath: readStringField(entry, "repoPath") ?? ctx.cwd,
				createdAt: readStringField(entry, "createdAt") ?? nowIso(),
			}))
		: [];
	const nextId = typeof payload.nextId === "number" && Number.isInteger(payload.nextId) && payload.nextId > 0 ? payload.nextId : 1;
	return { version: 1, nextId, entries };
}

async function loadBoardSummary(ctx: ExtensionContext): Promise<BoardSummary> {
	const payload = await readJsonFile(boardStatePath(ctx));
	if (!isRecord(payload) || !Array.isArray(payload.cards)) return { total: 0, statusCounts: {} };
	const statusCounts: Record<string, number> = {};
	for (const card of payload.cards) {
		if (!isRecord(card)) continue;
		const status = readStringField(card, "status") ?? "unknown";
		statusCounts[status] = (statusCounts[status] ?? 0) + 1;
	}
	return { total: payload.cards.length, statusCounts };
}

async function readModelSummary(ctx: ExtensionContext, signal?: AbortSignal): Promise<ModelSummary> {
	const state = await loadModelState(ctx);
	const errors: string[] = [];
	let gatewayModels: string[] = [];
	let localModels: string[] = [];
	try {
		gatewayModels = extractModelIds(await fetchJson("/v1/models", signal));
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	try {
		localModels = extractModelIds(await fetchJson("/v1/local-models", signal));
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	return {
		baseUrl: getHermesBaseUrl(),
		gatewayModels,
		localModels,
		preferredModel: state.preferredModel,
		notes: state.notes,
		errors,
	};
}

function formatList(label: string, values: string[]): string {
	if (values.length === 0) return `${label}: none`;
	if (values.length <= 8) return `${label}: ${values.join(", ")}`;
	return `${label}: ${values.slice(0, 8).join(", ")} (+${values.length - 8} more)`;
}

function formatBoardSummary(summary: BoardSummary): string {
	const label = summary.total === 1 ? "1 card" : `${summary.total} cards`;
	const statuses = Object.entries(summary.statusCounts)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([status, count]) => `${status}=${count}`);
	return statuses.length > 0 ? `Task state: ${label} (${statuses.join(", ")})` : `Task state: ${label}`;
}

function formatModelSummary(summary: ModelSummary): string {
	const lines = [
		"Hermes local model coordination",
		`Base URL: ${summary.baseUrl}`,
		formatList("Gateway models", summary.gatewayModels),
		formatList("Local models", summary.localModels),
		`Preferred local model: ${summary.preferredModel ?? "not selected"}`,
	];
	if (summary.notes.length > 0) lines.push("Notes:", ...summary.notes.map((note) => `- ${note}`));
	if (summary.errors.length > 0) lines.push("Errors:", ...summary.errors.map((error) => `- ${error}`));
	return lines.join("\n");
}

function formatMemoryState(state: ProjectMemoryState, boardSummary: BoardSummary, storagePath: string): string {
	const lines = ["Local project memory", `Storage: ${storagePath}`, formatBoardSummary(boardSummary), ""];
	if (state.entries.length === 0) {
		lines.push("Entries: none");
		return lines.join("\n");
	}
	lines.push("Entries:");
	for (const entry of state.entries.slice(-10)) {
		const tags = entry.tags.length > 0 ? ` tags=${entry.tags.join(",")}` : "";
		lines.push(`- ${entry.id}: ${entry.title} (${entry.source}; ${entry.project}; ${entry.createdAt}${tags})`);
	}
	return lines.join("\n");
}

async function selectModel(ctx: ExtensionContext, params: ModelParams, signal?: AbortSignal): Promise<ModelSummary> {
	const model = normalizeText(params.model);
	if (!model) throw new Error("Model ID is required");
	const storagePath = modelStatePath(ctx);
	await withFileMutationQueue(storagePath, async () => {
		const state = await loadModelState(ctx);
		state.preferredModel = model;
		state.updatedAt = nowIso();
		const note = normalizeText(params.note);
		if (note && !state.notes.includes(note)) state.notes.push(note);
		await writeJsonFile(storagePath, state);
	});
	return readModelSummary(ctx, signal);
}

async function captureMemory(ctx: ExtensionContext, params: MemoryParams): Promise<ProjectMemoryState> {
	const title = normalizeText(params.title);
	const content = normalizeText(params.content);
	if (!title) throw new Error("Memory title is required");
	if (!content) throw new Error("Memory content is required");
	const storagePath = memoryStatePath(ctx);
	let state = createEmptyMemoryState();
	await withFileMutationQueue(storagePath, async () => {
		state = await loadMemoryState(ctx);
		const id = `HM-${String(state.nextId).padStart(4, "0")}`;
		state.nextId += 1;
		state.entries.push({
			id,
			title,
			content,
			tags: params.tags ?? [],
			source: "manual",
			project: projectName(ctx),
			repoPath: ctx.cwd,
			createdAt: nowIso(),
		});
		await writeJsonFile(storagePath, state);
	});
	return state;
}

async function captureTaskSnapshot(ctx: ExtensionContext): Promise<ProjectMemoryState> {
	const boardSummary = await loadBoardSummary(ctx);
	const storagePath = memoryStatePath(ctx);
	let state = createEmptyMemoryState();
	await withFileMutationQueue(storagePath, async () => {
		state = await loadMemoryState(ctx);
		const id = `HM-${String(state.nextId).padStart(4, "0")}`;
		state.nextId += 1;
		state.entries.push({
			id,
			title: `Task snapshot ${nowIso()}`,
			content: formatBoardSummary(boardSummary),
			tags: ["task-state"],
			source: "task-snapshot",
			project: projectName(ctx),
			repoPath: ctx.cwd,
			createdAt: nowIso(),
		});
		await writeJsonFile(storagePath, state);
	});
	return state;
}

function setModelStatus(ctx: ExtensionContext, summary: ModelSummary): void {
	if (!ctx.hasUI) return;
	const text =
		summary.localModels.length > 0
			? `Local models ${summary.localModels.length}${summary.preferredModel ? `, preferred ${summary.preferredModel}` : ""}`
			: "Local models unavailable";
	ctx.ui.setStatus(CONTROL_STORAGE_KEY, ctx.ui.theme.fg(summary.localModels.length > 0 ? "accent" : "warning", text));
}

async function sendModelSummary(pi: ExtensionAPI, ctx: ExtensionContext, params: ModelParams): Promise<void> {
	try {
		const summary = params.action === "select" ? await selectModel(ctx, params, ctx.signal) : await readModelSummary(ctx, ctx.signal);
		setModelStatus(ctx, summary);
		pi.sendMessage({ customType: "hermes-models", content: formatModelSummary(summary), display: true, details: summary });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pi.sendMessage({ customType: "hermes-models", content: `Hermes model coordination error: ${message}`, display: true });
	}
}

async function sendMemorySummary(pi: ExtensionAPI, ctx: ExtensionContext, params: MemoryParams): Promise<void> {
	try {
		const state =
			params.action === "capture"
				? await captureMemory(ctx, params)
				: params.action === "task_snapshot"
					? await captureTaskSnapshot(ctx)
					: await loadMemoryState(ctx);
		const boardSummary = await loadBoardSummary(ctx);
		pi.sendMessage({
			customType: "hermes-memory",
			content: formatMemoryState(state, boardSummary, memoryStatePath(ctx)),
			display: true,
			details: { storagePath: memoryStatePath(ctx), state, boardSummary },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pi.sendMessage({ customType: "hermes-memory", content: `Hermes memory error: ${message}`, display: true });
	}
}

function firstToken(input: string): { token: string | undefined; rest: string } {
	const trimmed = input.trim();
	if (!trimmed) return { token: undefined, rest: "" };
	const spaceIndex = trimmed.search(/\s/);
	if (spaceIndex === -1) return { token: trimmed, rest: "" };
	return { token: trimmed.slice(0, spaceIndex), rest: trimmed.slice(spaceIndex).trim() };
}

export default function hermesControlExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			setModelStatus(ctx, await readModelSummary(ctx, ctx.signal));
		} catch {
			if (ctx.hasUI) ctx.ui.setStatus(CONTROL_STORAGE_KEY, ctx.ui.theme.fg("warning", "Local models unavailable"));
		}
	});

	pi.registerCommand("hermes-models", {
		description: "Show Hermes gateway and bee01 local model catalogs",
		handler: async (_args, ctx) => {
			await sendModelSummary(pi, ctx, { action: "summary" });
		},
	});

	pi.registerCommand("hermes-model-use", {
		description: "Select a preferred bee01 local model for this project",
		handler: async (args, ctx) => {
			const parsed = firstToken(args);
			if (!parsed.token) {
				ctx.ui.notify("Usage: /hermes-model-use <model-id> [note]", "warning");
				return;
			}
			await sendModelSummary(pi, ctx, { action: "select", model: parsed.token, note: parsed.rest });
		},
	});

	pi.registerCommand("hermes-memory", {
		description: "Show local project memory and task-state snapshots",
		handler: async (_args, ctx) => {
			await sendMemorySummary(pi, ctx, { action: "summary" });
		},
	});

	pi.registerCommand("hermes-memory-capture", {
		description: "Capture a local project memory note",
		handler: async (args, ctx) => {
			const content = normalizeText(args);
			if (!content) {
				ctx.ui.notify("Usage: /hermes-memory-capture <note>", "warning");
				return;
			}
			await sendMemorySummary(pi, ctx, {
				action: "capture",
				title: content.length > 80 ? `${content.slice(0, 77)}...` : content,
				content,
				tags: ["manual"],
			});
		},
	});

	pi.registerTool({
		name: "hermes_models",
		label: "Hermes Models",
		description: "Inspect Hermes gateway and bee01 local model catalogs, and store a project-scoped preferred local model.",
		promptSnippet: "Use hermes_models to inspect local model availability or set the preferred model for this project.",
		promptGuidelines: [
			"Use this for model coordination only; it does not change Hermes router configuration.",
			"Prefer local models for long-running coding and research work when cloud model use is unnecessary.",
		],
		parameters: MODEL_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const summary = params.action === "select" ? await selectModel(ctx, params, signal) : await readModelSummary(ctx, signal);
				setModelStatus(ctx, summary);
				return { content: [{ type: "text", text: formatModelSummary(summary) }], details: summary };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Hermes model coordination error: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "hermes_memory",
		label: "Hermes Memory",
		description: "Capture and summarize local project memory and task-state snapshots without writing to Hermes long-term memory.",
		promptSnippet: "Use hermes_memory to capture durable project notes or summarize current task state.",
		promptGuidelines: [
			"Do not include PHI, secrets, raw logs, or patient data.",
			"Treat this as project-scoped Pi memory until a Hermes memory write API is explicitly enabled.",
		],
		parameters: MEMORY_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const state =
					params.action === "capture"
						? await captureMemory(ctx, params)
						: params.action === "task_snapshot"
							? await captureTaskSnapshot(ctx)
							: await loadMemoryState(ctx);
				const boardSummary = await loadBoardSummary(ctx);
				return {
					content: [{ type: "text", text: formatMemoryState(state, boardSummary, memoryStatePath(ctx)) }],
					details: { storagePath: memoryStatePath(ctx), state, boardSummary },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Hermes memory error: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
}
