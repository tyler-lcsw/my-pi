import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const BOARD_STATUSES = ["backlog", "ready", "running", "blocked", "review", "done"] as const;
const CARD_TYPES = [
	"coding-run",
	"repo-audit",
	"refactor",
	"docs-maintenance",
	"research-dossier",
	"infra-coordination",
	"workspace-transition",
	"monitor-alert",
	"memory-review",
	"skill-proposal",
] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const SAFETY_LEVELS = ["local-only", "remote-read", "remote-mutation", "phi-sensitive"] as const;
const BOARD_STORAGE_KEY = "hermes-board";
const BOARD_VERSION = 1;
const BOARD_LOCK_STALE_MS = 120_000;
const BOARD_LOCK_RETRY_MS = 50;

type BoardStatus = (typeof BOARD_STATUSES)[number];
type CardType = (typeof CARD_TYPES)[number];
type Priority = (typeof PRIORITIES)[number];
type SafetyLevel = (typeof SAFETY_LEVELS)[number];

interface DevelopmentCard {
	id: string;
	title: string;
	type: CardType;
	status: BoardStatus;
	priority: Priority;
	project: string;
	repoPath: string;
	goal: string;
	safetyLevel: SafetyLevel;
	expectedDuration: string;
	verificationCommand?: string;
	hermesRunId?: string;
	hermesJobId?: string;
	artifacts: string[];
	approvals: string[];
	blockers: string[];
	notes: string[];
	createdAt: string;
	updatedAt: string;
}

interface BoardState {
	version: typeof BOARD_VERSION;
	nextId: number;
	cards: DevelopmentCard[];
}

type JsonRecord = Record<string, unknown>;

const BOARD_TOOL_PARAMS = Type.Object({
	action: StringEnum(["summary", "list", "create", "show", "move", "review", "block", "add_note", "link"] as const),
	id: Type.Optional(Type.String({ description: "Card ID, such as HB-0001." })),
	title: Type.Optional(Type.String({ description: "Card title for create." })),
	cardType: Type.Optional(StringEnum(CARD_TYPES)),
	status: Type.Optional(StringEnum(BOARD_STATUSES)),
	priority: Type.Optional(StringEnum(PRIORITIES)),
	project: Type.Optional(Type.String()),
	repoPath: Type.Optional(Type.String()),
	goal: Type.Optional(Type.String()),
	expectedDuration: Type.Optional(Type.String()),
	verificationCommand: Type.Optional(Type.String()),
	safetyLevel: Type.Optional(StringEnum(SAFETY_LEVELS)),
	note: Type.Optional(Type.String()),
	blocker: Type.Optional(Type.String()),
	artifact: Type.Optional(Type.String()),
	approval: Type.Optional(Type.String()),
	hermesRunId: Type.Optional(Type.String()),
	hermesJobId: Type.Optional(Type.String()),
});

type BoardToolParams = Static<typeof BOARD_TOOL_PARAMS>;

interface BoardToolDetails {
	action: BoardToolParams["action"];
	storagePath: string;
	card?: DevelopmentCard;
	board: BoardState;
	error?: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function abortError(signal: AbortSignal | undefined): Error | undefined {
	if (!signal?.aborted) return undefined;
	const reason = signal.reason;
	return reason instanceof Error ? reason : new Error("Hermes board operation was aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	const error = abortError(signal);
	if (error) throw error;
}

function isEnumValue<const TValues extends readonly string[]>(
	values: TValues,
	value: unknown,
): value is TValues[number] {
	return typeof value === "string" && values.some((candidate) => candidate === value);
}

function requiredString(record: JsonRecord, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Board card is missing required string field ${key}`);
	}
	return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(record: JsonRecord, key: string): string[] {
	const value = record[key];
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`Board card field ${key} must be a string array`);
	}
	return [...value];
}

function requiredEnum<TValues extends readonly string[]>(
	record: JsonRecord,
	key: string,
	values: TValues,
): TValues[number] {
	const value = record[key];
	if (!isEnumValue(values, value)) {
		throw new Error(`Board card field ${key} has unsupported value`);
	}
	return value;
}

function parseCard(value: unknown): DevelopmentCard {
	if (!isRecord(value)) throw new Error("Board card must be an object");
	return {
		id: requiredString(value, "id"),
		title: requiredString(value, "title"),
		type: requiredEnum(value, "type", CARD_TYPES),
		status: requiredEnum(value, "status", BOARD_STATUSES),
		priority: requiredEnum(value, "priority", PRIORITIES),
		project: requiredString(value, "project"),
		repoPath: requiredString(value, "repoPath"),
		goal: requiredString(value, "goal"),
		safetyLevel: requiredEnum(value, "safetyLevel", SAFETY_LEVELS),
		expectedDuration: requiredString(value, "expectedDuration"),
		verificationCommand: optionalString(value, "verificationCommand"),
		hermesRunId: optionalString(value, "hermesRunId"),
		hermesJobId: optionalString(value, "hermesJobId"),
		artifacts: stringArray(value, "artifacts"),
		approvals: stringArray(value, "approvals"),
		blockers: stringArray(value, "blockers"),
		notes: stringArray(value, "notes"),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
	};
}

function parseBoard(raw: string): BoardState {
	const payload = JSON.parse(raw) as unknown;
	if (!isRecord(payload)) throw new Error("Hermes board file must contain an object");
	const version = payload.version;
	if (version !== BOARD_VERSION) {
		throw new Error(`Unsupported Hermes board version: ${String(version)}`);
	}
	const nextId = payload.nextId;
	if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1) {
		throw new Error("Hermes board nextId must be a positive integer");
	}
	const cards = payload.cards;
	if (!Array.isArray(cards)) throw new Error("Hermes board cards must be an array");
	return {
		version: BOARD_VERSION,
		nextId,
		cards: cards.map(parseCard),
	};
}

function createEmptyBoard(): BoardState {
	return {
		version: BOARD_VERSION,
		nextId: 1,
		cards: [],
	};
}

function projectStorageKey(cwd: string): string {
	return Buffer.from(cwd, "utf-8").toString("base64url");
}

function boardPath(ctx: ExtensionContext): string {
	return join(getAgentDir(), "extension-state", "hermes-board", projectStorageKey(ctx.cwd), "board.json");
}

async function loadBoard(ctx: ExtensionContext): Promise<BoardState> {
	try {
		return parseBoard(await readFile(boardPath(ctx), "utf-8"));
	} catch (error) {
		if (isErrno(error, "ENOENT")) return createEmptyBoard();
		throw error;
	}
}

async function writeBoard(ctx: ExtensionContext, board: BoardState): Promise<void> {
	const storagePath = boardPath(ctx);
	await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });
	const tempPath = join(dirname(storagePath), `.${basename(storagePath)}.${process.pid}.${Date.now()}.tmp`);
	try {
		await writeFile(tempPath, `${JSON.stringify(board, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		await rename(tempPath, storagePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function nextCardId(board: BoardState): string {
	const id = `HB-${String(board.nextId).padStart(4, "0")}`;
	board.nextId += 1;
	return id;
}

function normalizedText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function optionalTextList(value: string | undefined): string[] {
	const normalized = normalizedText(value);
	return normalized ? [normalized] : [];
}

function defaultProject(ctx: ExtensionContext): string {
	return basename(ctx.cwd) || "local-project";
}

function createCard(board: BoardState, ctx: ExtensionContext, params: BoardToolParams): DevelopmentCard {
	const title = normalizedText(params.title);
	if (!title) throw new Error("Card title is required");
	const timestamp = nowIso();
	const card: DevelopmentCard = {
		id: nextCardId(board),
		title,
		type: params.cardType ?? "coding-run",
		status: params.status ?? "backlog",
		priority: params.priority ?? "normal",
		project: normalizedText(params.project) ?? defaultProject(ctx),
		repoPath: normalizedText(params.repoPath) ?? ctx.cwd,
		goal: normalizedText(params.goal) ?? title,
		safetyLevel: params.safetyLevel ?? "local-only",
		expectedDuration: normalizedText(params.expectedDuration) ?? "one focused session",
		verificationCommand: normalizedText(params.verificationCommand) ?? "npm run check",
		hermesRunId: normalizedText(params.hermesRunId),
		hermesJobId: normalizedText(params.hermesJobId),
		artifacts: optionalTextList(params.artifact),
		approvals: optionalTextList(params.approval),
		blockers: optionalTextList(params.blocker),
		notes: optionalTextList(params.note),
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	board.cards.push(card);
	return card;
}

function findCard(board: BoardState, id: string | undefined): DevelopmentCard {
	const normalizedId = normalizedText(id);
	if (!normalizedId) throw new Error("Card ID is required");
	const card = board.cards.find((candidate) => candidate.id === normalizedId);
	if (!card) throw new Error(`Card ${normalizedId} was not found`);
	return card;
}

function touch(card: DevelopmentCard): void {
	card.updatedAt = nowIso();
}

function addUnique(values: string[], value: string | undefined): void {
	const normalized = normalizedText(value);
	if (!normalized || values.includes(normalized)) return;
	values.push(normalized);
}

function moveCard(board: BoardState, params: BoardToolParams): DevelopmentCard {
	if (!params.status) throw new Error("Target status is required");
	const card = findCard(board, params.id);
	card.status = params.status;
	addUnique(card.notes, params.note);
	touch(card);
	return card;
}

function reviewCard(board: BoardState, params: BoardToolParams): DevelopmentCard {
	const card = findCard(board, params.id);
	card.status = "review";
	addUnique(card.notes, params.note ?? "Ready for review");
	addUnique(card.artifacts, params.artifact);
	addUnique(card.approvals, params.approval);
	touch(card);
	return card;
}

function blockCard(board: BoardState, params: BoardToolParams): DevelopmentCard {
	const card = findCard(board, params.id);
	card.status = "blocked";
	addUnique(card.blockers, params.blocker ?? params.note ?? "Blocked");
	touch(card);
	return card;
}

function addNote(board: BoardState, params: BoardToolParams): DevelopmentCard {
	const card = findCard(board, params.id);
	addUnique(card.notes, params.note);
	addUnique(card.artifacts, params.artifact);
	addUnique(card.approvals, params.approval);
	addUnique(card.blockers, params.blocker);
	touch(card);
	return card;
}

function linkCard(board: BoardState, params: BoardToolParams): DevelopmentCard {
	const card = findCard(board, params.id);
	card.hermesRunId = normalizedText(params.hermesRunId) ?? card.hermesRunId;
	card.hermesJobId = normalizedText(params.hermesJobId) ?? card.hermesJobId;
	addUnique(card.notes, params.note);
	touch(card);
	return card;
}

function cardSummary(card: DevelopmentCard): string {
	const run = card.hermesRunId ? ` run=${card.hermesRunId}` : "";
	const job = card.hermesJobId ? ` job=${card.hermesJobId}` : "";
	return `- ${card.id} [${card.priority}] ${card.title} (${card.type}; ${card.project}; ${card.safetyLevel}${run}${job})`;
}

function formatBoard(board: BoardState, storagePath: string): string {
	const lines = ["Hermes development board", `Storage: ${storagePath}`, ""];
	for (const status of BOARD_STATUSES) {
		const cards = board.cards.filter((card) => card.status === status);
		lines.push(`${status.toUpperCase()} (${cards.length})`);
		if (cards.length === 0) {
			lines.push("- none");
		} else {
			lines.push(...cards.map(cardSummary));
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function formatCard(card: DevelopmentCard, storagePath: string): string {
	const lines = [
		`${card.id}: ${card.title}`,
		`Status: ${card.status}`,
		`Type: ${card.type}`,
		`Priority: ${card.priority}`,
		`Project: ${card.project}`,
		`Repo: ${card.repoPath}`,
		`Safety: ${card.safetyLevel}`,
		`Expected duration: ${card.expectedDuration}`,
		`Goal: ${card.goal}`,
		`Verification: ${card.verificationCommand ?? "not set"}`,
		`Hermes run: ${card.hermesRunId ?? "not linked"}`,
		`Hermes job: ${card.hermesJobId ?? "not linked"}`,
		`Created: ${card.createdAt}`,
		`Updated: ${card.updatedAt}`,
		`Storage: ${storagePath}`,
	];
	if (card.blockers.length > 0) lines.push("Blockers:", ...card.blockers.map((item) => `- ${item}`));
	if (card.approvals.length > 0) lines.push("Approvals:", ...card.approvals.map((item) => `- ${item}`));
	if (card.artifacts.length > 0) lines.push("Artifacts:", ...card.artifacts.map((item) => `- ${item}`));
	if (card.notes.length > 0) lines.push("Notes:", ...card.notes.map((item) => `- ${item}`));
	return lines.join("\n");
}

function formatActionResult(details: BoardToolDetails): string {
	if (details.error) return `Hermes board error: ${details.error}`;
	if (details.card) return formatCard(details.card, details.storagePath);
	return formatBoard(details.board, details.storagePath);
}

async function releaseLock(lockPath: string): Promise<void> {
	await rm(lockPath, { recursive: true, force: true });
}

async function acquireBoardLock(storagePath: string, signal: AbortSignal | undefined): Promise<() => Promise<void>> {
	const lockPath = `${storagePath}.lock`;
	await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });

	while (true) {
		throwIfAborted(signal);
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

async function withBoardFileLock<T>(
	storagePath: string,
	signal: AbortSignal | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await acquireBoardLock(storagePath, signal);
	try {
		throwIfAborted(signal);
		return await fn();
	} finally {
		await release();
	}
}

function setBoardStatus(ctx: ExtensionContext, board: BoardState): void {
	if (!ctx.hasUI) return;
	const running = board.cards.filter((card) => card.status === "running").length;
	const blocked = board.cards.filter((card) => card.status === "blocked").length;
	const review = board.cards.filter((card) => card.status === "review").length;
	const summary = `Board ${board.cards.length} cards, ${running} running, ${blocked} blocked, ${review} review`;
	const severity = blocked > 0 ? "warning" : running > 0 || review > 0 ? "accent" : "dim";
	ctx.ui.setStatus(BOARD_STORAGE_KEY, ctx.ui.theme.fg(severity, summary));
}

async function runBoardAction(
	ctx: ExtensionContext,
	params: BoardToolParams,
	signal?: AbortSignal,
): Promise<BoardToolDetails> {
	const storagePath = boardPath(ctx);
	return withBoardFileLock(storagePath, signal, () =>
		withFileMutationQueue(storagePath, async () => {
			throwIfAborted(signal);
			const board = await loadBoard(ctx);
			let card: DevelopmentCard | undefined;
			let changed = false;

			switch (params.action) {
				case "summary":
				case "list":
					break;
				case "create":
					card = createCard(board, ctx, params);
					changed = true;
					break;
				case "show":
					card = findCard(board, params.id);
					break;
				case "move":
					card = moveCard(board, params);
					changed = true;
					break;
				case "review":
					card = reviewCard(board, params);
					changed = true;
					break;
				case "block":
					card = blockCard(board, params);
					changed = true;
					break;
				case "add_note":
					card = addNote(board, params);
					changed = true;
					break;
				case "link":
					card = linkCard(board, params);
					changed = true;
					break;
			}

			if (changed) {
				throwIfAborted(signal);
				await writeBoard(ctx, board);
			}

			setBoardStatus(ctx, board);
			return {
				action: params.action,
				storagePath,
				card,
				board,
			};
		}),
	);
}

async function sendBoardAction(pi: ExtensionAPI, ctx: ExtensionContext, params: BoardToolParams): Promise<void> {
	try {
		const details = await runBoardAction(ctx, params, ctx.signal);
		pi.sendMessage({
			customType: "hermes-board",
			content: formatActionResult(details),
			display: true,
			details,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pi.sendMessage({
			customType: "hermes-board",
			content: `Hermes board error: ${message}`,
			display: true,
			details: { action: params.action, storagePath: boardPath(ctx), board: createEmptyBoard(), error: message },
		});
	}
}

function firstToken(input: string): { token: string | undefined; rest: string } {
	const trimmed = input.trim();
	if (!trimmed) return { token: undefined, rest: "" };
	const spaceIndex = trimmed.search(/\s/);
	if (spaceIndex === -1) return { token: trimmed, rest: "" };
	return {
		token: trimmed.slice(0, spaceIndex),
		rest: trimmed.slice(spaceIndex).trim(),
	};
}

function filterCompletions(
	items: Array<{ value: string; label: string; description?: string }>,
	prefix: string,
): Array<{ value: string; label: string; description?: string }> {
	const normalizedPrefix = prefix.trim().toLowerCase();
	if (!normalizedPrefix) return items;
	return items.filter(
		(item) =>
			item.value.toLowerCase().includes(normalizedPrefix) ||
			item.label.toLowerCase().includes(normalizedPrefix) ||
			item.description?.toLowerCase().includes(normalizedPrefix),
	);
}

function cardIdCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
	return filterCompletions(
		[
			{
				value: "HB-0001",
				label: "<card-id>",
				description: "Card ID from /hermes-kanban or /hermes-card-show output",
			},
		],
		prefix,
	);
}

function titleCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
	return filterCompletions(
		[
			{
				value: "Implement next development task",
				label: "<title>",
				description: "Short title for the new development card",
			},
		],
		prefix,
	);
}

function reviewCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
	return filterCompletions(
		[
			{
				value: "HB-0001 Ready for review",
				label: "<card-id> [note]",
				description: "Move a card to review with an optional note",
			},
		],
		prefix,
	);
}

function cardMoveCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
	const parsed = firstToken(prefix);
	if (!parsed.token) {
		return cardIdCompletions(prefix);
	}
	const statusPrefix = parsed.rest.trim().toLowerCase();
	return BOARD_STATUSES.filter((status) => status.startsWith(statusPrefix)).map((status) => ({
		value: `${parsed.token} ${status}`,
		label: status,
		description: `Move ${parsed.token} to ${status}`,
	}));
}

export default function hermesBoardExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			setBoardStatus(ctx, await loadBoard(ctx));
		} catch {
			if (ctx.hasUI) ctx.ui.setStatus(BOARD_STORAGE_KEY, ctx.ui.theme.fg("warning", "Board storage error"));
		}
	});

	pi.registerCommand("hermes-board", {
		description: "Show the local Hermes development Kanban board",
		handler: async (_args, ctx) => {
			await sendBoardAction(pi, ctx, { action: "summary" });
		},
	});

	pi.registerCommand("hermes-kanban", {
		description: "Show the local Hermes development Kanban board",
		handler: async (_args, ctx) => {
			await sendBoardAction(pi, ctx, { action: "summary" });
		},
	});

	pi.registerCommand("hermes-card-create", {
		description: "Create a local Hermes development card",
		getArgumentCompletions: titleCompletions,
		handler: async (args, ctx) => {
			const title = args.trim();
			if (!title) {
				ctx.ui.notify("Usage: /hermes-card-create <title>", "warning");
				return;
			}
			await sendBoardAction(pi, ctx, { action: "create", title });
		},
	});

	pi.registerCommand("hermes-card-move", {
		description: "Move a Hermes development card to another board column",
		getArgumentCompletions: cardMoveCompletions,
		handler: async (args, ctx) => {
			const idPart = firstToken(args);
			const status = idPart.rest.trim();
			if (!idPart.token || !isEnumValue(BOARD_STATUSES, status)) {
				ctx.ui.notify(`Usage: /hermes-card-move <id> ${BOARD_STATUSES.join("|")}`, "warning");
				return;
			}
			await sendBoardAction(pi, ctx, { action: "move", id: idPart.token, status });
		},
	});

	pi.registerCommand("hermes-card-show", {
		description: "Show one local Hermes development card",
		getArgumentCompletions: cardIdCompletions,
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /hermes-card-show <id>", "warning");
				return;
			}
			await sendBoardAction(pi, ctx, { action: "show", id });
		},
	});

	pi.registerCommand("hermes-card-review", {
		description: "Move a Hermes development card to review with an optional note",
		getArgumentCompletions: reviewCompletions,
		handler: async (args, ctx) => {
			const idPart = firstToken(args);
			if (!idPart.token) {
				ctx.ui.notify("Usage: /hermes-card-review <id> [note]", "warning");
				return;
			}
			await sendBoardAction(pi, ctx, { action: "review", id: idPart.token, note: idPart.rest });
		},
	});

	pi.registerTool({
		name: "hermes_board",
		label: "Hermes Board",
		description:
			"Manage the local Hermes development Kanban board. This writes only to local project state and does not start Hermes jobs.",
		promptSnippet:
			"Use hermes_board to create, list, move, block, review, and annotate local Hermes development Kanban cards.",
		promptGuidelines: [
			"Use hermes_board only for local development-task tracking.",
			"Do not treat a board card as approval to mutate remote systems, write memory, install skills, or start long-running jobs.",
			"Cards with remote-mutation or phi-sensitive safety levels require explicit user approval before execution.",
		],
		parameters: BOARD_TOOL_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const details = await runBoardAction(ctx, params, signal);
				return {
					content: [{ type: "text", text: formatActionResult(details) }],
					details,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const details: BoardToolDetails = {
					action: params.action,
					storagePath: boardPath(ctx),
					board: createEmptyBoard(),
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
