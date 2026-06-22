import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeServer } from "./hermes-bridge.mjs";

async function listen(server) {
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.equal(typeof address, "object");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
	await new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function sendJson(response, status, payload) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(`${JSON.stringify(payload)}\n`);
}

async function withServers(callback, envOverrides = {}) {
	const hermesRequests = [];
	const localModelRequests = [];
	const hermes = createServer((request, response) => {
		hermesRequests.push({
			method: request.method,
			url: request.url,
			authorization: request.headers.authorization,
		});
		if (request.url === "/health") {
			sendJson(response, 200, { status: "ok", platform: "hermes-agent" });
			return;
		}
		if (request.url === "/health/detailed") {
			sendJson(response, 200, { status: "ok", gateway_state: "running" });
			return;
		}
		if (request.headers.authorization !== "Bearer hermes-secret") {
			sendJson(response, 401, { error: "bad hermes key" });
			return;
		}
		if (request.url === "/v1/models") {
			sendJson(response, 200, { object: "list", data: [{ id: "hermes-agent" }] });
			return;
		}
		if (request.url === "/v1/capabilities") {
			sendJson(response, 200, {
				features: { run_status: true, run_submission: true },
				endpoints: { runs: { method: "POST", path: "/v1/runs" } },
			});
			return;
		}
		if (request.url === "/v1/runs" && request.method === "POST") {
			sendJson(response, 202, { id: "run-1" });
			return;
		}
		sendJson(response, 404, { error: "missing" });
	});
	const localModels = createServer((request, response) => {
		localModelRequests.push({
			method: request.method,
			url: request.url,
			authorization: request.headers.authorization,
		});
		if (request.url === "/v1/models") {
			sendJson(response, 200, {
				object: "list",
				data: [{ id: "qwen3-coder-next-q5-k-m-hermes" }, { id: "hermes-local-auto" }],
			});
			return;
		}
		sendJson(response, 404, { error: "missing" });
	});

	const hermesBaseUrl = await listen(hermes);
	const localModelsBaseUrl = await listen(localModels);
	const bridge = createBridgeServer({
		env: {
			PI_HERMES_BRIDGE_HOST: "127.0.0.1",
			PI_HERMES_BRIDGE_TOKEN: "bridge-secret",
			HERMES_API_BASE_URL: hermesBaseUrl,
			HERMES_LOCAL_MODELS_BASE_URL: localModelsBaseUrl,
			HERMES_API_KEY: "hermes-secret",
			...envOverrides,
		},
	});
	const bridgeBaseUrl = await listen(bridge);

	try {
		await callback({ bridgeBaseUrl, hermesRequests, localModelRequests });
	} finally {
		await close(bridge);
		await close(localModels);
		await close(hermes);
	}
}

test("health is public and aggregates Hermes status without exposing the Hermes key", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const response = await fetch(`${bridgeBaseUrl}/health`);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.bridge.status, "ok");
		assert.equal(body.bridge.bridgeTokenConfigured, true);
		assert.equal(body.hermes.health.ok, true);
		assert.doesNotMatch(JSON.stringify(body), /hermes-secret/);
	});
});

test("root shows the bridge index without exposing the Hermes key", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const response = await fetch(`${bridgeBaseUrl}/`);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.object, "pi.hermes_bridge");
		assert.equal(body.endpoints.health, "/health");
		assert.equal(body.auth.bridgeTokenConfigured, true);
		assert.doesNotMatch(JSON.stringify(body), /hermes-secret/);
	});
});

test("browser root requests get a readable HTML index", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const response = await fetch(`${bridgeBaseUrl}/`, {
			headers: { accept: "text/html" },
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/html/);
		const body = await response.text();
		assert.match(body, /Pi Hermes Bridge/);
		assert.match(body, /\/health/);
		assert.doesNotMatch(body, /hermes-secret/);
	});
});

test("browser auxiliary paths do not look like bridge failures", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const favicon = await fetch(`${bridgeBaseUrl}/favicon.ico`, {
			headers: { accept: "image/avif,image/webp,*/*" },
		});
		assert.equal(favicon.status, 204);

		const browserPath = await fetch(`${bridgeBaseUrl}/chrome-probe`, {
			headers: { accept: "text/html" },
		});
		assert.equal(browserPath.status, 200);
		assert.match(await browserPath.text(), /Pi Hermes Bridge/);
	});
});

test("public browser paths support HEAD checks", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const root = await fetch(`${bridgeBaseUrl}/`, { method: "HEAD" });
		assert.equal(root.status, 200);
		assert.match(root.headers.get("content-type") ?? "", /text\/html/);

		const health = await fetch(`${bridgeBaseUrl}/health`, { method: "HEAD" });
		assert.equal(health.status, 200);
		assert.match(health.headers.get("content-type") ?? "", /application\/json/);

		const browserPath = await fetch(`${bridgeBaseUrl}/missing-browser-route`, { method: "HEAD" });
		assert.equal(browserPath.status, 200);

		const protectedPath = await fetch(`${bridgeBaseUrl}/v1/models`, { method: "HEAD" });
		assert.equal(protectedPath.status, 401);
	});
});

test("detailed health mirrors Hermes detailed health for Pi status compatibility", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const response = await fetch(`${bridgeBaseUrl}/health/detailed`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { status: "ok", gateway_state: "running" });
	});
});

test("protected gateway reads require the bridge token and use the Hermes key server-side", async () => {
	await withServers(async ({ bridgeBaseUrl, hermesRequests }) => {
		const rejected = await fetch(`${bridgeBaseUrl}/v1/models`);
		assert.equal(rejected.status, 401);

		const browserRejected = await fetch(`${bridgeBaseUrl}/v1/models`, {
			headers: { accept: "text/html" },
		});
		assert.equal(browserRejected.status, 401);

		const accepted = await fetch(`${bridgeBaseUrl}/v1/models`, {
			headers: { authorization: "Bearer bridge-secret" },
		});
		assert.equal(accepted.status, 200);
		assert.deepEqual(await accepted.json(), { object: "list", data: [{ id: "hermes-agent" }] });

		const modelProbe = hermesRequests.find((request) => request.url === "/v1/models");
		assert.equal(modelProbe?.authorization, "Bearer hermes-secret");
	});
});

test("protected local model reads use the local model router without the Hermes key", async () => {
	await withServers(async ({ bridgeBaseUrl, localModelRequests }) => {
		const rejected = await fetch(`${bridgeBaseUrl}/v1/local-models`);
		assert.equal(rejected.status, 401);

		const accepted = await fetch(`${bridgeBaseUrl}/v1/local-models`, {
			headers: { authorization: "Bearer bridge-secret" },
		});
		assert.equal(accepted.status, 200);
		assert.deepEqual(await accepted.json(), {
			object: "list",
			source: "local-model-router",
			data: [{ id: "qwen3-coder-next-q5-k-m-hermes" }, { id: "hermes-local-auto" }],
		});

		const modelProbe = localModelRequests.find((request) => request.url === "/v1/models");
		assert.equal(modelProbe?.authorization, undefined);
	});
});

test("status includes capabilities and models through the bridge token", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const response = await fetch(`${bridgeBaseUrl}/v1/status`, {
			headers: { authorization: "Bearer bridge-secret" },
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.hermes.capabilities.ok, true);
		assert.equal(body.hermes.models.payload.data[0].id, "hermes-agent");
	});
});

test("bridge token can be loaded from a file", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-hermes-bridge-"));
	const tokenPath = join(tempDir, "token");
	writeFileSync(tokenPath, "file-bridge-secret\n", "utf8");

	try {
		await withServers(
			async ({ bridgeBaseUrl }) => {
				const response = await fetch(`${bridgeBaseUrl}/v1/models`, {
					headers: { authorization: "Bearer file-bridge-secret" },
				});
				assert.equal(response.status, 200);
			},
			{
				PI_HERMES_BRIDGE_TOKEN: "",
				PI_HERMES_BRIDGE_TOKEN_FILE: tokenPath,
			},
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("run creation is blocked unless bridge mutations are explicitly enabled", async () => {
	await withServers(async ({ bridgeBaseUrl }) => {
		const response = await fetch(`${bridgeBaseUrl}/v1/runs`, {
			method: "POST",
			headers: {
				authorization: "Bearer bridge-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({ input: "test" }),
		});
		assert.equal(response.status, 403);
		const body = await response.json();
		assert.match(body.error, /disabled/);
	});
});
