import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface HermesCommandItem {
	command: string;
	description: string;
}

const HERMES_COMMANDS: HermesCommandItem[] = [
	{ command: "/hermes", description: "Show this Hermes command index." },
	{ command: "/hermes-kanban", description: "Show the local Hermes development Kanban board." },
	{ command: "/hermes-card-create <title>", description: "Create a local development card." },
	{ command: "/hermes-card-move <id> backlog|ready|running|blocked|review|done", description: "Move a card." },
	{ command: "/hermes-card-show <id>", description: "Show one card." },
	{ command: "/hermes-card-run <id>", description: "Start a Hermes run from a card and link the run ID." },
	{ command: "/hermes-runs", description: "Show Pi-tracked Hermes runs." },
	{ command: "/hermes-run <goal>", description: "Start a bounded Hermes run." },
	{ command: "/hermes-run-show <run-id>", description: "Fetch current run status." },
	{ command: "/hermes-run-stop <run-id>", description: "Request a run stop." },
	{ command: "/hermes-run-approve <run-id> once|session|always|deny [message]", description: "Respond to a waiting approval." },
	{ command: "/hermes-status", description: "Check Hermes health, capabilities, and gateway models." },
	{ command: "/hermes-models", description: "Show gateway and local model catalogs." },
	{ command: "/hermes-model-use <model-id> [note]", description: "Store the preferred model for this project." },
	{ command: "/hermes-memory", description: "Show local project memory and task snapshots." },
	{ command: "/hermes-memory-capture <note>", description: "Capture a local project memory note." },
];

const HERMES_FEATURES = [
	"kanban: local development board and card handoff",
	"runs: launch, monitor, stop, and approve Hermes runs",
	"status: health, capabilities, and model checks",
	"models: gateway/local catalog visibility and preferred model notes",
	"memory: project-scoped local notes and task snapshots",
];

function formatHermesHelp(): string {
	return [
		"Hermes command index",
		"",
		"Type /hermes and keep typing the feature name to filter slash-command autocomplete.",
		"For example: /hermes-kanban, /hermes-run, /hermes-models, /hermes-memory.",
		"",
		"Features:",
		...HERMES_FEATURES.map((feature) => `- ${feature}`),
		"",
		"Commands:",
		...HERMES_COMMANDS.map((item) => `- ${item.command} - ${item.description}`),
	].join("\n");
}

function commandCompletions(prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = HERMES_COMMANDS.map((item) => ({
		value: item.command.replace(/^\/hermes-?/, ""),
		label: item.command,
		description: item.description,
	}));
	if (!normalizedPrefix) return items;
	return items.filter(
		(item) =>
			item.label.toLowerCase().includes(normalizedPrefix) ||
			item.value.toLowerCase().includes(normalizedPrefix) ||
			item.description.toLowerCase().includes(normalizedPrefix),
	);
}

export default function hermesHelpExtension(pi: ExtensionAPI) {
	for (const commandName of ["hermes", "hermes-help"]) {
		pi.registerCommand(commandName, {
			description: "Show available Hermes commands, features, and options",
			getArgumentCompletions: commandCompletions,
			handler: async (_args) => {
				pi.sendMessage({
					customType: "hermes-help",
					content: formatHermesHelp(),
					display: true,
					details: { commands: HERMES_COMMANDS, features: HERMES_FEATURES },
				});
			},
		});
	}
}
