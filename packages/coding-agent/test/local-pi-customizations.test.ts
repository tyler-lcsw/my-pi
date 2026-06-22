import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");
const TEST_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
} as unknown as Theme;

interface HermesFixture {
	baseUrl: string;
	close(): Promise<void>;
}

type SentMessage = Parameters<ExtensionActions["sendMessage"]>[0];

let sentMessages: SentMessage[];

const extensionActions: ExtensionActions = {
	sendMessage: (message) => {
		sentMessages.push(message);
	},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

function writeJson(response: ServerResponse, payload: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(`${JSON.stringify(payload)}\n`);
}

function handleHermesFixtureRequest(request: IncomingMessage, response: ServerResponse): void {
	switch (request.url) {
		case "/health":
			writeJson(response, { status: "ok" });
			return;
		case "/health/detailed":
			writeJson(response, { status: "ok", api_server: true });
			return;
		case "/v1/capabilities":
			writeJson(response, { runs: true, sessions: true, responses: true });
			return;
		case "/v1/models":
			writeJson(response, { data: [{ id: "local-fixture-model" }] });
			return;
		case "/v1/local-models":
			writeJson(response, {
				object: "list",
				source: "local-model-router",
				data: [
					{ id: "qwen3-coder-next-q5-k-m-hermes", owner: "localai" },
					{ id: "hermes-local-auto", owner: "hermes-router" },
				],
			});
			return;
		default:
			response.writeHead(404, { "content-type": "application/json" });
			response.end('{"error":"not found"}\n');
	}
}

async function startHermesFixture(): Promise<HermesFixture> {
	const server = createServer(handleHermesFixtureRequest);
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Hermes fixture did not bind to a TCP port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			}),
	};
}

function createStatusCapturingUi(statuses: Map<string, string>): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			if (text === undefined) {
				statuses.delete(key);
				return;
			}
			statuses.set(key, text);
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): Theme {
			return TEST_THEME;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not available in test" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("local Pi customizations", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;
	let previousHermesBaseUrl: string | undefined;
	let hermesFixture: HermesFixture;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-local-customizations-"));
		sentMessages = [];
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousHermesBaseUrl = process.env.HERMES_API_BASE_URL;
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
		hermesFixture = await startHermesFixture();
		process.env.HERMES_API_BASE_URL = hermesFixture.baseUrl;
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousHermesBaseUrl === undefined) {
			delete process.env.HERMES_API_BASE_URL;
		} else {
			process.env.HERMES_API_BASE_URL = previousHermesBaseUrl;
		}
		await hermesFixture.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers and starts project-local extensions, prompts, skills, and status customizations", async () => {
		const loader = new DefaultResourceLoader({
			cwd: REPO_ROOT,
			agentDir: join(tempDir, "agent"),
		});

		await loader.reload({ resolveProjectTrust: async () => true });

		const extensionsResult = loader.getExtensions();
		expect(extensionsResult.errors).toEqual([]);
		expect(extensionsResult.extensions.map((extension) => extension.path).sort()).toEqual([
			join(REPO_ROOT, ".pi", "extensions", "hermes-board.ts"),
			join(REPO_ROOT, ".pi", "extensions", "hermes-control.ts"),
			join(REPO_ROOT, ".pi", "extensions", "hermes-status.ts"),
			join(REPO_ROOT, ".pi", "extensions", "prompt-url-widget.ts"),
			join(REPO_ROOT, ".pi", "extensions", "redraws.ts"),
			join(REPO_ROOT, ".pi", "extensions", "tps.ts"),
		]);

		expect(loader.getPrompts().diagnostics).toEqual([]);
		expect(
			loader
				.getPrompts()
				.prompts.map((prompt) => prompt.name)
				.sort(),
		).toEqual(["cl", "is", "pr", "sa", "wr"]);

		expect(loader.getSkills().diagnostics).toEqual([]);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("add-llm-provider");
		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.path)).toContain(join(REPO_ROOT, "AGENTS.md"));

		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			REPO_ROOT,
			sessionManager,
			modelRegistry,
		);
		const extensionErrors: unknown[] = [];
		const statuses = new Map<string, string>();
		runner.onError((error) => extensionErrors.push(error));
		runner.bindCore(extensionActions, extensionContextActions);
		runner.setUIContext(createStatusCapturingUi(statuses), "tui");

		await runner.emit({ type: "session_start", reason: "startup" });

		expect(extensionErrors).toEqual([]);
		expect(
			runner
				.getRegisteredCommands()
				.map((command) => command.name)
				.sort(),
		).toEqual([
			"hermes-board",
			"hermes-card-create",
			"hermes-card-move",
			"hermes-card-review",
			"hermes-card-show",
			"hermes-memory",
			"hermes-memory-capture",
			"hermes-model-use",
			"hermes-models",
			"hermes-status",
			"tui",
		]);
		expect(
			runner
				.getAllRegisteredTools()
				.map((tool) => tool.definition.name)
				.sort(),
		).toEqual(["hermes_board", "hermes_memory", "hermes_models", "hermes_status"]);
		expect(statuses.get("hermes")).toContain("Hermes 1 model");
		expect(statuses.get("hermes-board")).toContain("Board 0 cards");
		expect(statuses.get("hermes-models")).toContain("Local models");

		const tools = new Map(runner.getAllRegisteredTools().map((tool) => [tool.definition.name, tool.definition]));
		const context = runner.createContext();
		const hermesStatus = tools.get("hermes_status");
		expect(hermesStatus).toBeDefined();
		const statusResult = await hermesStatus?.execute("status-call", {}, undefined, undefined, context);
		const statusText = statusResult?.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(statusText).toContain("Detailed health: status=ok, api_server=true");
		expect(statusText).toContain("Models: local-fixture-model");

		const hermesBoard = tools.get("hermes_board");
		expect(hermesBoard).toBeDefined();
		const createResult = await hermesBoard?.execute(
			"board-create-call",
			{ action: "create", title: "Tool-created development task", status: "ready" },
			undefined,
			undefined,
			context,
		);
		const createText = createResult?.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(createText).toContain("Tool-created development task");

		const listResult = await hermesBoard?.execute(
			"board-list-call",
			{ action: "list" },
			undefined,
			undefined,
			context,
		);
		const listText = listResult?.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(listText).toContain("READY (1)");
		expect(listText).toContain("Tool-created development task");

		const hermesModels = tools.get("hermes_models");
		expect(hermesModels).toBeDefined();
		const modelsResult = await hermesModels?.execute(
			"models-call",
			{ action: "select", model: "qwen3-coder-next-q5-k-m-hermes", note: "Use for code-heavy local work" },
			undefined,
			undefined,
			context,
		);
		const modelsText = modelsResult?.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(modelsText).toContain("Gateway models: local-fixture-model");
		expect(modelsText).toContain("Local models: hermes-local-auto, qwen3-coder-next-q5-k-m-hermes");
		expect(modelsText).toContain("Preferred local model: qwen3-coder-next-q5-k-m-hermes");

		const hermesMemory = tools.get("hermes_memory");
		expect(hermesMemory).toBeDefined();
		const memoryResult = await hermesMemory?.execute(
			"memory-call",
			{
				action: "capture",
				title: "Local model coordination",
				content: "Use qwen3-coder-next for coding tasks and keep board state linked to project memory.",
				tags: ["models", "task-state"],
			},
			undefined,
			undefined,
			context,
		);
		const memoryText = memoryResult?.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(memoryText).toContain("Local project memory");
		expect(memoryText).toContain("Local model coordination");
		expect(memoryText).toContain("Task state: 1 card");

		const createCommand = runner.getCommand("hermes-card-create");
		expect(createCommand).toBeDefined();
		await createCommand?.handler("Command-created development task", runner.createCommandContext());
		expect(
			sentMessages.some(
				(message) =>
					message.customType === "hermes-board" &&
					typeof message.content === "string" &&
					message.content.includes("Command-created development task"),
			),
		).toBe(true);
	});
});
