import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const RUN_ACTIONS = ["start", "list", "show", "stop", "approve", "run_card"] as const;
const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
const RUN_STORAGE_KEY = "hermes-runs";
const BOARD_STORAGE_KEY = "hermes-board";
const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:8642";
const DEFAULT_ENDPOINT_TIMEOUT_MS = 30_000;
const RUN_REGISTRY_VERSION = 1;
const BOARD_LOCK_STALE_MS = 120_000;
const BOARD_LOCK_RETRY_MS = 50;

type JsonRecord = Record<string, unknown>;
type RunAction = (typeof RUN_ACTIONS)[number];
type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

interface RunRecord {
	id: string;
	status: string;
	input: string;
	instructions?: string;
	cardId?: string;
	sessionId?: string;
	model?: string;
	createdAt: string;
	updatedAt: string;
	lastStatus?: JsonRecord;
}

interface RunRegistry {
	version: typeof RUN_REGISTRY_VERSION;
	runs: RunRecord[];
}

interface BoardCard extends JsonRecord {
	id: string;
	title: string;
	status: string;
	goal: string;
	project: string;
	repoPath: string;
	safetyLevel: string;
	expectedDuration: string;
	verificationCommand?: string;
	hermesRunId?: string;
	notes: string[];
	updatedAt: string;
}

interface BoardState extends JsonRecord {
	cards: JsonRecord[];
}

interface RunStartResult {
	runId: string;
	status: string;
	sessionId?: string;
	payload: JsonRecord;
}

interface RunActionDetails {
	action: RunAction;
	storagePath: string;
	baseUrl: string;
	run?: RunRecord;
	runStatus?: JsonRecord;
	registry?: RunRegistry;
	card?: BoardCard;
	response?: JsonRecord;
	error?: string;
}

const RUN_PARAMS = Type.Object({
	action: StringEnum(RUN_ACTIONS),
	input: Type.Optional(Type.String({ description: "Hermes run input or goal. Do not include PHI or secrets." })),
	instructions: Type.Optional(Type.String({ description: "Optional run instructions." })),
	sessionId: Type.Optional(Type.String({ description: "Optional Hermes session ID." })),
	previousResponseId: Type.Optional(Type.String({ description: "Optional previous response ID." })),
	runId: Type.Optional(Type.String({ description: "Hermes run ID." })),
	cardId: Type.Optional(Type.String({ description: "Hermes board card ID, such as HB-0001." })),
	choice: Type.Optional(StringEnum(APPROVAL_CHOICES)),
	message: Type.Optional(Type.String({ description: "Optional approval or denial message." })),
});

type RunParams = Static<typeof RUN_PARAMS>;

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

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function isApprovalChoice(value: string | undefined): value is ApprovalChoice {
	return value !== undefined && APPROVAL_CHOICES.some((choice) => choice === value);
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function projectStorageKey(cwd: string): string {
	return Buffer.from(cwd, "utf-8").toString("base64url");
}

function normalizeBaseUrl(value: string | undefined): string {
	const raw = value?.trim() || DEFAULT_HERMES_BASE_URL;
	return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function getHermesBaseUrl(): string {
	return normalizeBaseUrl(process.env.HERMES_API_BASE_URL ?? process.env.HERMES_API_URL);
}

function getEndpointTimeoutMs(): number {
	const raw = process.env.HERMES_RUN_TIMEOUT_MS?.trim() ?? process.env.HERMES_API_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_ENDPOINT_TIMEOUT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ENDPOINT_TIMEOUT_MS;
}

function getRequestHeaders(hasBody: boolean): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (hasBody) headers["content-type"] = "application/json";
	const apiKey = process.env.HERMES_API_KEY?.trim();
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const sessionKey = process.env.HERMES_SESSION_KEY?.trim();
	if (sessionKey) headers["x-hermes-session-key"] = sessionKey;
	return headers;
}

function registryPath(ctx: ExtensionContext): string {
	return join(getAgentDir(), "extension-state", RUN_STORAGE_KEY, projectStorageKey(ctx.cwd), "runs.json");
}

function boardPath(ctx: ExtensionContext): string {
	return join(getAgentDir(), "extension-state", BOARD_STORAGE_KEY, projectStorageKey(ctx.cwd), "board.json");
}

function createEmptyRegistry(): RunRegistry {
	return { version: RUN_REGISTRY_VERSION, runs: [] };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as unknown;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

function readStringField(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(record: JsonRecord, key: string): string[] {
	const value = record[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseRunRecord(value: unknown): RunRecord | undefined {
	if (!isRecord(value)) return undefined;
	const id = readStringField(value, "id");
	const status = readStringField(value, "status");
	const input = readStringField(value, "input");
	const createdAt = readStringField(value, "createdAt");
	const updatedAt = readStringField(value, "updatedAt");
	if (!id || !status || !input || !createdAt || !updatedAt) return undefined;
	return {
		id,
		status,
		input,
		instructions: readStringField(value, "instructions"),
		cardId: readStringField(value, "cardId"),
		sessionId: readStringField(value, "sessionId"),
		model: readStringField(value, "model"),
		createdAt,
		updatedAt,
		lastStatus: isRecord(value.lastStatus) ? value.lastStatus : undefined,
	};
}

async function loadRegistry(ctx: ExtensionContext): Promise<RunRegistry> {
	const payload = await readJsonFile(registryPath(ctx));
	if (!isRecord(payload) || payload.version !== RUN_REGISTRY_VERSION || !Array.isArray(payload.runs)) {
		return createEmptyRegistry();
	}
	return {
		version: RUN_REGISTRY_VERSION,
		runs: payload.runs.map(parseRunRecord).filter((record): record is RunRecord => record !== undefined),
	};
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	try {
		await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

async function saveRegistry(ctx: ExtensionContext, registry: RunRegistry): Promise<void> {
	await writeJsonAtomic(registryPath(ctx), registry);
}

async function upsertRunRecord(ctx: ExtensionContext, record: RunRecord): Promise<RunRegistry> {
	const storagePath = registryPath(ctx);
	let registry = createEmptyRegistry();
	await withFileMutationQueue(storagePath, async () => {
		registry = await loadRegistry(ctx);
		const index = registry.runs.findIndex((candidate) => candidate.id === record.id);
		if (index === -1) {
			registry.runs.push(record);
		} else {
			registry.runs[index] = { ...registry.runs[index], ...record, createdAt: registry.runs[index].createdAt };
		}
		await saveRegistry(ctx, registry);
	});
	return registry;
}

async function updateRunStatus(ctx: ExtensionContext, runId: string, statusPayload: JsonRecord): Promise<RunRecord | undefined> {
	const storagePath = registryPath(ctx);
	let updatedRun: RunRecord | undefined;
	await withFileMutationQueue(storagePath, async () => {
		const registry = await loadRegistry(ctx);
		const run = registry.runs.find((candidate) => candidate.id === runId);
		if (run) {
			run.status = readStringField(statusPayload, "status") ?? run.status;
			run.sessionId = readStringField(statusPayload, "session_id") ?? run.sessionId;
			run.model = readStringField(statusPayload, "model") ?? run.model;
			run.updatedAt = nowIso();
			run.lastStatus = statusPayload;
			updatedRun = run;
			await saveRegistry(ctx, registry);
		}
	});
	return updatedRun;
}

function createEndpointSignal(signal: AbortSignal | undefined): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Hermes run request timed out after ${getEndpointTimeoutMs()}ms`));
	}, getEndpointTimeoutMs());
	const abortFromParent = () => {
		controller.abort(signal?.reason);
	};
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromParent);
		},
	};
}

async function readResponseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

async function requestJson(path: string, method: "GET" | "POST", body: JsonRecord | undefined, signal?: AbortSignal): Promise<unknown> {
	const endpointSignal = createEndpointSignal(signal);
	try {
		const response = await fetch(`${getHermesBaseUrl()}${path}`, {
			method,
			headers: getRequestHeaders(body !== undefined),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: endpointSignal.signal,
		});
		if (!response.ok) {
			const responseText = await readResponseText(response);
			const detail = responseText.trim() ? `: ${responseText.trim().slice(0, 300)}` : "";
			throw new HermesEndpointError(path, response.status, `${path} returned HTTP ${response.status}${detail}`);
		}
		return response.json();
	} catch (error) {
		if (endpointSignal.signal.aborted && !(error instanceof HermesEndpointError)) {
			const reason = endpointSignal.signal.reason;
			const message = reason instanceof Error ? reason.message : `Hermes run request timed out after ${getEndpointTimeoutMs()}ms`;
			throw new HermesEndpointError(path, undefined, message);
		}
		throw error;
	} finally {
		endpointSignal.cleanup();
	}
}

function requireRunId(params: RunParams): string {
	const runId = normalizeText(params.runId);
	if (!runId) throw new Error("Run ID is required");
	return runId;
}

function extractRunStart(payload: unknown): RunStartResult {
	if (!isRecord(payload)) throw new Error("Hermes run response must be an object");
	const runId = readStringField(payload, "run_id") ?? readStringField(payload, "id");
	if (!runId) throw new Error("Hermes run response did not include run_id");
	return {
		runId,
		status: readStringField(payload, "status") ?? "started",
		sessionId: readStringField(payload, "session_id"),
		payload,
	};
}

function buildRunBody(params: RunParams, input: string, instructions: string | undefined): JsonRecord {
	const body: JsonRecord = { input };
	const sessionId = normalizeText(params.sessionId);
	const previousResponseId = normalizeText(params.previousResponseId);
	if (instructions) body.instructions = instructions;
	if (sessionId) body.session_id = sessionId;
	if (previousResponseId) body.previous_response_id = previousResponseId;
	return body;
}

async function startHermesRun(
	ctx: ExtensionContext,
	params: RunParams,
	inputOverride: string | undefined,
	instructionsOverride: string | undefined,
	cardId: string | undefined,
	signal?: AbortSignal,
): Promise<{ start: RunStartResult; run: RunRecord; registry: RunRegistry }> {
	const input = normalizeText(inputOverride ?? params.input);
	if (!input) throw new Error("Run input is required");
	const instructions = normalizeText(instructionsOverride ?? params.instructions);
	const start = extractRunStart(await requestJson("/v1/runs", "POST", buildRunBody(params, input, instructions), signal));
	const timestamp = nowIso();
	const run: RunRecord = {
		id: start.runId,
		status: start.status,
		input,
		instructions,
		cardId,
		sessionId: start.sessionId,
		createdAt: timestamp,
		updatedAt: timestamp,
		lastStatus: start.payload,
	};
	const registry = await upsertRunRecord(ctx, run);
	setRunStatus(ctx, registry);
	return { start, run, registry };
}

async function showHermesRun(ctx: ExtensionContext, params: RunParams, signal?: AbortSignal): Promise<JsonRecord> {
	const runId = requireRunId(params);
	const payload = await requestJson(`/v1/runs/${encodeURIComponent(runId)}`, "GET", undefined, signal);
	if (!isRecord(payload)) throw new Error("Hermes run status response must be an object");
	await updateRunStatus(ctx, runId, payload);
	setRunStatus(ctx, await loadRegistry(ctx));
	return payload;
}

async function stopHermesRun(ctx: ExtensionContext, params: RunParams, signal?: AbortSignal): Promise<JsonRecord> {
	const runId = requireRunId(params);
	const payload = await requestJson(`/v1/runs/${encodeURIComponent(runId)}/stop`, "POST", {}, signal);
	if (!isRecord(payload)) throw new Error("Hermes run stop response must be an object");
	await updateRunStatus(ctx, runId, { run_id: runId, status: readStringField(payload, "status") ?? "stopping" });
	setRunStatus(ctx, await loadRegistry(ctx));
	return payload;
}

async function approveHermesRun(params: RunParams, signal?: AbortSignal): Promise<JsonRecord> {
	const runId = requireRunId(params);
	if (!isApprovalChoice(params.choice)) throw new Error(`Approval choice must be one of ${APPROVAL_CHOICES.join(", ")}`);
	const body: JsonRecord = { choice: params.choice };
	const message = normalizeText(params.message);
	if (message) body.message = message;
	const payload = await requestJson(`/v1/runs/${encodeURIComponent(runId)}/approval`, "POST", body, signal);
	if (!isRecord(payload)) throw new Error("Hermes run approval response must be an object");
	return payload;
}

function parseBoardCard(value: unknown): BoardCard | undefined {
	if (!isRecord(value)) return undefined;
	const id = readStringField(value, "id");
	const title = readStringField(value, "title");
	const status = readStringField(value, "status");
	const goal = readStringField(value, "goal");
	if (!id || !title || !status || !goal) return undefined;
	return {
		...value,
		id,
		title,
		status,
		goal,
		project: readStringField(value, "project") ?? "local-project",
		repoPath: readStringField(value, "repoPath") ?? "",
		safetyLevel: readStringField(value, "safetyLevel") ?? "local-only",
		expectedDuration: readStringField(value, "expectedDuration") ?? "one focused session",
		verificationCommand: readStringField(value, "verificationCommand"),
		hermesRunId: readStringField(value, "hermesRunId"),
		notes: readStringArray(value, "notes"),
		updatedAt: readStringField(value, "updatedAt") ?? nowIso(),
	};
}

async function loadBoard(ctx: ExtensionContext): Promise<BoardState> {
	const payload = await readJsonFile(boardPath(ctx));
	if (!isRecord(payload) || !Array.isArray(payload.cards)) {
		throw new Error("Hermes board is empty or unreadable");
	}
	return { ...payload, cards: payload.cards.filter(isRecord) };
}

function requireCard(board: BoardState, cardId: string | undefined): BoardCard {
	const normalizedCardId = normalizeText(cardId);
	if (!normalizedCardId) throw new Error("Card ID is required");
	const card = board.cards.map(parseBoardCard).find((candidate) => candidate?.id === normalizedCardId);
	if (!card) throw new Error(`Card ${normalizedCardId} was not found`);
	return card;
}

function addUniqueNote(card: BoardCard, note: string): void {
	if (!card.notes.includes(note)) card.notes.push(note);
}

async function releaseLock(lockPath: string): Promise<void> {
	await rm(lockPath, { recursive: true, force: true });
}

async function acquireBoardLock(storagePath: string, signal: AbortSignal | undefined): Promise<() => Promise<void>> {
	const lockPath = `${storagePath}.lock`;
	await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });
	while (true) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Hermes run operation was aborted");
		try {
			await mkdir(lockPath, { mode: 0o700 });
			return () => releaseLock(lockPath);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > BOARD_LOCK_STALE_MS) {
					await releaseLock(lockPath);
					continue;
				}
			} catch (statError) {
				if (!isErrno(statError, "ENOENT")) throw statError;
			}
			await delay(BOARD_LOCK_RETRY_MS, undefined, { signal });
		}
	}
}

async function withBoardLock<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	const storagePath = boardPath(ctx);
	const release = await acquireBoardLock(storagePath, signal);
	try {
		return await withFileMutationQueue(storagePath, fn);
	} finally {
		await release();
	}
}

function buildCardInstructions(card: BoardCard): string {
	return [
		"Pi Hermes board handoff.",
		`Card: ${card.id} ${card.title}`,
		`Project: ${card.project}`,
		`Repo: ${card.repoPath}`,
		`Safety: ${card.safetyLevel}`,
		`Expected duration: ${card.expectedDuration}`,
		`Verification: ${card.verificationCommand ?? "not set"}`,
		"Use local-only or explicitly approved data. Do not include PHI, secrets, credentials, or patient data in outputs.",
		"Report progress through the run status API and wait for approval when a step requires mutation beyond the card safety level.",
	].join("\n");
}

async function linkBoardCardToRun(ctx: ExtensionContext, cardId: string, runId: string, signal?: AbortSignal): Promise<BoardCard> {
	let linkedCard: BoardCard | undefined;
	await withBoardLock(ctx, signal, async () => {
		const board = await loadBoard(ctx);
		const card = requireCard(board, cardId);
		card.status = "running";
		card.hermesRunId = runId;
		card.updatedAt = nowIso();
		addUniqueNote(card, `Hermes run started: ${runId}`);
		const index = board.cards.findIndex((candidate) => isRecord(candidate) && candidate.id === card.id);
		if (index === -1) throw new Error(`Card ${card.id} was not found`);
		board.cards[index] = card;
		await writeJsonAtomic(boardPath(ctx), board);
		linkedCard = card;
	});
	if (!linkedCard) throw new Error(`Card ${cardId} was not linked`);
	return linkedCard;
}

async function startCardRun(
	ctx: ExtensionContext,
	params: RunParams,
	signal?: AbortSignal,
): Promise<{ run: RunRecord; registry: RunRegistry; card: BoardCard }> {
	const board = await loadBoard(ctx);
	const card = requireCard(board, params.cardId);
	const input = card.goal;
	const instructions = buildCardInstructions(card);
	const start = await startHermesRun(ctx, params, input, instructions, card.id, signal);
	const linkedCard = await linkBoardCardToRun(ctx, card.id, start.run.id, signal);
	return { run: start.run, registry: start.registry, card: linkedCard };
}

function activeRunCount(registry: RunRegistry): number {
	return registry.runs.filter((run) => ["queued", "running", "waiting_for_approval", "started", "stopping"].includes(run.status)).length;
}

function setRunStatus(ctx: ExtensionContext, registry: RunRegistry): void {
	if (!ctx.hasUI) return;
	const active = activeRunCount(registry);
	const label = active === 1 ? "1 active run" : `${active} active runs`;
	ctx.ui.setStatus(RUN_STORAGE_KEY, ctx.ui.theme.fg(active > 0 ? "accent" : "dim", `Hermes ${label}`));
}

function formatRegistry(registry: RunRegistry, storagePath: string): string {
	const lines = ["Hermes runs", `Storage: ${storagePath}`, `Runs: ${registry.runs.length}`, `Active: ${activeRunCount(registry)}`, ""];
	if (registry.runs.length === 0) {
		lines.push("- none");
		return lines.join("\n");
	}
	for (const run of registry.runs.slice(-20)) {
		const card = run.cardId ? ` card=${run.cardId}` : "";
		lines.push(`- ${run.id} [${run.status}]${card} ${run.input}`);
	}
	return lines.join("\n");
}

function formatRunRecord(run: RunRecord, storagePath: string): string {
	const lines = [
		"Hermes run",
		`Run: ${run.id}`,
		`Status: ${run.status}`,
		`Session: ${run.sessionId ?? "not set"}`,
		`Model: ${run.model ?? "not reported"}`,
		`Card: ${run.cardId ?? "not linked"}`,
		`Input: ${run.input}`,
		`Created: ${run.createdAt}`,
		`Updated: ${run.updatedAt}`,
		`Storage: ${storagePath}`,
	];
	if (run.instructions) lines.push("Instructions:", run.instructions);
	return lines.join("\n");
}

function formatRunStatus(status: JsonRecord): string {
	const lines = [
		"Hermes run",
		`Run: ${readStringField(status, "run_id") ?? readStringField(status, "id") ?? "unknown"}`,
		`Status: ${readStringField(status, "status") ?? "unknown"}`,
		`Session: ${readStringField(status, "session_id") ?? "not set"}`,
		`Model: ${readStringField(status, "model") ?? "not reported"}`,
	];
	const output = readStringField(status, "output");
	if (output) lines.push("Output:", output);
	return lines.join("\n");
}

function formatStop(runId: string, response: JsonRecord): string {
	return ["Hermes run", `Run: ${runId}`, `Stop: ${readStringField(response, "status") ?? "requested"}`].join("\n");
}

function formatApproval(runId: string, response: JsonRecord): string {
	return [
		"Hermes run",
		`Run: ${runId}`,
		`Approval: ${readStringField(response, "status") ?? "submitted"}`,
		`Choice: ${readStringField(response, "choice") ?? "not reported"}`,
	].join("\n");
}

function formatCardRun(card: BoardCard, run: RunRecord): string {
	return [
		`${card.id}: ${card.title}`,
		`Status: ${card.status}`,
		`Hermes run: ${run.id}`,
		`Goal: ${card.goal}`,
		`Verification: ${card.verificationCommand ?? "not set"}`,
	].join("\n");
}

function formatActionResult(details: RunActionDetails): string {
	if (details.error) return `Hermes run error: ${details.error}`;
	if (details.action === "list" && details.registry) return formatRegistry(details.registry, details.storagePath);
	if (details.action === "show" && details.runStatus) return formatRunStatus(details.runStatus);
	if (details.action === "stop" && details.response) return formatStop(details.run?.id ?? "unknown", details.response);
	if (details.action === "approve" && details.response) return formatApproval(details.run?.id ?? "unknown", details.response);
	if (details.action === "run_card" && details.card && details.run) return formatCardRun(details.card, details.run);
	if (details.run) return formatRunRecord(details.run, details.storagePath);
	return "Hermes run action completed";
}

async function runAction(ctx: ExtensionContext, params: RunParams, signal?: AbortSignal): Promise<RunActionDetails> {
	const storagePath = registryPath(ctx);
	const baseUrl = getHermesBaseUrl();
	switch (params.action) {
		case "start": {
			const result = await startHermesRun(ctx, params, undefined, undefined, undefined, signal);
			return { action: params.action, storagePath, baseUrl, run: result.run, registry: result.registry };
		}
		case "list": {
			const registry = await loadRegistry(ctx);
			setRunStatus(ctx, registry);
			return { action: params.action, storagePath, baseUrl, registry };
		}
		case "show":
			return { action: params.action, storagePath, baseUrl, runStatus: await showHermesRun(ctx, params, signal) };
		case "stop": {
			const runId = requireRunId(params);
			const response = await stopHermesRun(ctx, params, signal);
			const registry = await loadRegistry(ctx);
			const run = registry.runs.find((candidate) => candidate.id === runId) ?? {
				id: runId,
				status: readStringField(response, "status") ?? "stopping",
				input: "unknown",
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			return { action: params.action, storagePath, baseUrl, run, response };
		}
		case "approve": {
			const runId = requireRunId(params);
			const response = await approveHermesRun(params, signal);
			const registry = await loadRegistry(ctx);
			const run = registry.runs.find((candidate) => candidate.id === runId) ?? {
				id: runId,
				status: "waiting_for_approval",
				input: "unknown",
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			return { action: params.action, storagePath, baseUrl, run, response };
		}
		case "run_card": {
			const result = await startCardRun(ctx, params, signal);
			return { action: params.action, storagePath, baseUrl, run: result.run, registry: result.registry, card: result.card };
		}
	}
}

async function sendRunAction(pi: ExtensionAPI, ctx: ExtensionContext, params: RunParams): Promise<void> {
	try {
		const details = await runAction(ctx, params, ctx.signal);
		pi.sendMessage({
			customType: "hermes-runs",
			content: formatActionResult(details),
			display: true,
			details,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pi.sendMessage({
			customType: "hermes-runs",
			content: `Hermes run error: ${message}`,
			display: true,
			details: { action: params.action, storagePath: registryPath(ctx), baseUrl: getHermesBaseUrl(), error: message },
		});
	}
}

function firstToken(input: string): { token: string | undefined; rest: string } {
	const trimmed = input.trim();
	if (!trimmed) return { token: undefined, rest: "" };
	const spaceIndex = trimmed.search(/\s/);
	if (spaceIndex === -1) return { token: trimmed, rest: "" };
	return { token: trimmed.slice(0, spaceIndex), rest: trimmed.slice(spaceIndex).trim() };
}

export default function hermesRunsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			setRunStatus(ctx, await loadRegistry(ctx));
		} catch {
			if (ctx.hasUI) ctx.ui.setStatus(RUN_STORAGE_KEY, ctx.ui.theme.fg("warning", "Hermes runs unavailable"));
		}
	});

	pi.registerCommand("hermes-run", {
		description: "Start a Hermes Agent run from Pi",
		handler: async (args, ctx) => {
			const input = normalizeText(args);
			if (!input) {
				ctx.ui.notify("Usage: /hermes-run <goal>", "warning");
				return;
			}
			await sendRunAction(pi, ctx, { action: "start", input });
		},
	});

	pi.registerCommand("hermes-runs", {
		description: "Show Pi-tracked Hermes Agent runs",
		handler: async (_args, ctx) => {
			await sendRunAction(pi, ctx, { action: "list" });
		},
	});

	pi.registerCommand("hermes-run-show", {
		description: "Fetch one Hermes Agent run status",
		handler: async (args, ctx) => {
			const runId = normalizeText(args);
			if (!runId) {
				ctx.ui.notify("Usage: /hermes-run-show <run-id>", "warning");
				return;
			}
			await sendRunAction(pi, ctx, { action: "show", runId });
		},
	});

	pi.registerCommand("hermes-run-stop", {
		description: "Request stop for a Hermes Agent run",
		handler: async (args, ctx) => {
			const runId = normalizeText(args);
			if (!runId) {
				ctx.ui.notify("Usage: /hermes-run-stop <run-id>", "warning");
				return;
			}
			await sendRunAction(pi, ctx, { action: "stop", runId });
		},
	});

	pi.registerCommand("hermes-run-approve", {
		description: "Approve or deny a waiting Hermes Agent run step",
		handler: async (args, ctx) => {
			const runPart = firstToken(args);
			const choicePart = firstToken(runPart.rest);
			if (!runPart.token || !isApprovalChoice(choicePart.token)) {
				ctx.ui.notify(`Usage: /hermes-run-approve <run-id> ${APPROVAL_CHOICES.join("|")} [message]`, "warning");
				return;
			}
			await sendRunAction(pi, ctx, {
				action: "approve",
				runId: runPart.token,
				choice: choicePart.token,
				message: choicePart.rest,
			});
		},
	});

	pi.registerCommand("hermes-card-run", {
		description: "Start a Hermes Agent run from a local Hermes board card",
		handler: async (args, ctx) => {
			const cardId = normalizeText(args);
			if (!cardId) {
				ctx.ui.notify("Usage: /hermes-card-run <card-id>", "warning");
				return;
			}
			await sendRunAction(pi, ctx, { action: "run_card", cardId });
		},
	});

	pi.registerTool({
		name: "hermes_runs",
		label: "Hermes Runs",
		description: "Start, inspect, stop, approve, and link Hermes Agent runs from Pi, including Kanban card handoff.",
		promptSnippet: "Use hermes_runs to launch a Hermes run, monitor status, stop a run, approve a waiting step, or hand off a board card.",
		promptGuidelines: [
			"Do not include PHI, secrets, credentials, or patient data in run input or approval messages.",
			"Use run_card for development-task handoff from the local Hermes board.",
			"Cards with remote-mutation or phi-sensitive safety levels still require explicit user approval before unsafe actions.",
			"Use show before approving or stopping when the current run state is unclear.",
		],
		parameters: RUN_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const details = await runAction(ctx, params, signal);
				return { content: [{ type: "text", text: formatActionResult(details) }], details };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const details: RunActionDetails = {
					action: params.action,
					storagePath: registryPath(ctx),
					baseUrl: getHermesBaseUrl(),
					error: message,
				};
				return {
					content: [{ type: "text", text: formatActionResult(details) }],
					details,
					isError: true,
				};
			}
		},
	});
}
