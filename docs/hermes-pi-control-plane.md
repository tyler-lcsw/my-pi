# Hermes Pi Control Plane

This project treats Pi as a frontend and control surface for Hermes Agent. Pi should not copy Hermes internals. Hermes owns model routing, memory, skills, runs, jobs, sessions, approvals, and persistent state. Pi should discover those surfaces, display them clearly, and send explicit control actions through stable APIs.

## Current Local Slice

The first local slices are `.pi/extensions/hermes-status.ts`, `.pi/extensions/hermes-board.ts`, and `.pi/extensions/hermes-control.ts`.

It provides:

- `/hermes-status`: read-only Hermes health, detailed health, capability, and model report.
- `hermes_status`: read-only tool for the agent to inspect the configured Hermes API surface.
- `/hermes-models`: read-only gateway/local model catalog report plus the project-scoped preferred local model.
- `/hermes-model-use <model-id> [note]`: records a project-scoped preferred local model for long-running coding or research work.
- `hermes_models`: tool for model catalog inspection and preferred-model selection.
- `/hermes-memory`: local project memory and Kanban task-state summary.
- `/hermes-memory-capture <note>`: captures a project-scoped local memory note. Do not include PHI, secrets, raw logs, or patient data.
- `hermes_memory`: tool for local project memory capture and task-state snapshots.
- Footer status: shows whether the configured Hermes API is reachable.

Configuration:

- `HERMES_API_BASE_URL` or `HERMES_API_URL`: defaults to `http://127.0.0.1:8642`.
- `HERMES_API_KEY`: optional bearer token for the Hermes API server.
- `HERMES_SESSION_KEY`: optional `X-Hermes-Session-Key` value to keep memory scoped to this Pi user/workspace.

The current extensions do not start Hermes, write Hermes long-term memory, mutate skills, or start runs. They can inspect model catalogs and store project-scoped Pi state locally. Hermes memory writes and run submission remain explicit future unlocks.

## bee01 Bridge

The recommended control path is a bee01-hosted bridge process:

```text
Local Pi
  -> Tailscale Serve HTTPS URL
    -> / dashboard proxy to 127.0.0.1:9119
    -> /bridge proxy to bee01 loopback bridge
      -> Hermes Gateway API on 127.0.0.1:8642
```

The bridge keeps `API_SERVER_KEY` on bee01. Pi uses a separate bridge bearer token when the bridge is exposed beyond bee01 loopback. Prefer `PI_HERMES_BRIDGE_TOKEN_FILE` for runtime launches so the token is not embedded in process arguments or shell history.

Bridge defaults:

- Script: `scripts/hermes-bridge.mjs`
- Bind: `127.0.0.1:8787`
- Hermes target: `http://127.0.0.1:8642`
- Mutations: disabled unless `PI_HERMES_BRIDGE_ENABLE_MUTATIONS=1`
- Auth: `PI_HERMES_BRIDGE_TOKEN_FILE` preferred; `PI_HERMES_BRIDGE_TOKEN` also supported

Bridge endpoints:

- `GET`/`HEAD /`: public bridge index for browser and uptime checks; browsers receive HTML and API clients receive JSON.
- `GET`/`HEAD /health`: public bridge plus Hermes health summary.
- `GET`/`HEAD /health/detailed`: public pass-through for Pi status compatibility.
- `GET /v1/status`: authenticated bridge/Hermes status summary.
- `GET /v1/models`: authenticated gateway model catalog.
- `GET /v1/local-models`: authenticated local model catalog. The bridge queries the local model router/LocalAI surface without forwarding the Hermes Gateway API key.
- `GET /v1/capabilities`: authenticated gateway capability contract.
- `GET /v1/runs/{run_id}`: authenticated run status.
- `GET /v1/runs/{run_id}/events`: authenticated run event stream.
- `POST /v1/runs`, `/v1/runs/{run_id}/approval`, `/v1/runs/{run_id}/stop`: disabled by default and reserved for explicit approval-gated workflows.

Local Pi can point `HERMES_API_BASE_URL` at the bridge URL and set `HERMES_API_KEY` to the bridge token. This avoids copying the Hermes Gateway `API_SERVER_KEY` to the Mac.

Current local-development access:

- Active dashboard exposure is Tailscale Serve HTTPS at `https://bee01.beagle-perch.ts.net/`, proxying to the Hermes dashboard on `127.0.0.1:9119`.
- The Pi-Hermes bridge is exposed at `https://bee01.beagle-perch.ts.net/bridge`, proxying to `127.0.0.1:8787`; Tailscale strips `/bridge` before forwarding.
- Bridge `/v1/*` routes require the bridge bearer token and mutations remain disabled unless explicitly enabled.
- bee01 does not use UFW for this path. The hostname is a Tailscale MagicDNS/Funnel-style tailnet endpoint served by `tailscaled`, and direct dashboard/bridge access stays on loopback.

## bee01 Endpoint Contract

bee01 runs Hermes as a manual-start Docker stack:

- Hermes Gateway API: `127.0.0.1:8642`
- Hermes dashboard: `127.0.0.1:9119`
- Local model router inside Docker: `http://hermes-model-router:18082/v1`
- Gateway auth: bearer token from `API_SERVER_KEY`, stored outside this repo in `/var/lib/ai/hermes-agent/gateway.env`

The Pi extension should target the gateway API, not the dashboard. For a Pi process running on bee01, the default `http://127.0.0.1:8642` is correct. For a local Mac process controlling bee01, expose a deliberate preview/control URL through Tailscale Serve or another approved local proxy surface before setting `HERMES_API_BASE_URL`.

Current gateway discovery surfaces:

- `GET /health`
- `GET /health/detailed`
- `GET /v1/models`
- `GET /v1/capabilities`

`/health` and `/health/detailed` are public health checks. `/v1/models` and `/v1/capabilities` require bearer auth. On the current bee01 image, `/v1/models` returns the gateway-level model `hermes-agent`; the local model router's internal catalog is separate and includes `hermes-local-auto`, Qwen Hermes aliases, the vision model, Toutetsu, and local TTS. The Pi-Hermes bridge exposes this local catalog through `/v1/local-models` for coordination only.

Current gateway control surfaces:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `POST /v1/runs/{run_id}/approval`
- `POST /v1/runs/{run_id}/stop`

The dashboard server on `127.0.0.1:9119` owns separate authenticated UI APIs such as `/api/sessions`. Pi should not treat dashboard APIs as the stable control-plane contract unless that becomes an explicit integration track.

Mutating run endpoints exist, but Pi should keep them behind explicit approval-gated commands.

## Architecture Direction

Use one shared Hermes contract with multiple focused Pi extensions.

```text
Pi TUI / CLI
  -> Pi Hermes extensions
    -> shared Hermes API client
      -> Hermes API server
      -> Hermes OpenAI-compatible model endpoints
      -> Hermes runs, approvals, session headers, skills, memory, and toolsets
      -> MCP only where model-visible tool/resource bridging is useful
```

Recommended modules:

- `pi-hermes-core`: shared client, auth, health, capabilities, error handling.
- `pi-hermes-provider`: dynamic `pi.registerProvider()` bridge from `/v1/models`.
- `pi-hermes-goals`: start, inspect, stop, resume, and approve long-running Hermes runs.
- `pi-hermes-memory-skills`: browse/search memory and skills through Hermes-supported surfaces first, later gated writes.
- `pi-hermes-tools`: optional MCP bridge for model-visible tools.
- `pi-hermes-status`: footer/status widgets, active runs, jobs, pending approvals.
- `pi-hermes-docs`: Tyler-specific commands and prompts explaining available Hermes abilities.

## HIPAA Boundaries

This is not a compliance attestation. It is an engineering control-plane plan.

Default posture:

- Keep Hermes behind localhost or Tailscale.
- Do not expose Hermes directly to the public internet.
- Treat `HERMES_API_KEY` / `API_SERVER_KEY` as backend secrets.
- Use per-project and per-workspace session keys to reduce memory bleed.
- Start with read-only memory and skill browsing.
- Require explicit approval for memory writes, skill writes, shell execution, background jobs, or data export.
- Do not place secrets, raw access tokens, patient chart data, or raw logs into Hermes memory.
- Preserve synthetic-only local development for referral-app work unless the scope is explicitly widened.
- Separate conduit transport questions from storage/processing vendor questions.

For LMHG work, Hermes should help create and review safeguards, runbooks, migration plans, and code. It should not become an uncontrolled PHI sink.

## Local Development Use Cases

1. Hermes status and capability browser
   - Confirm what a local or remote Hermes instance can do before asking it to act.
   - Show health, capabilities, gateway models, run support, session-header behavior, and pending approvals.

2. Local model provider bridge
   - Let Pi use Hermes-routed local models as selectable Pi models.
   - Current implementation exposes gateway and local model catalogs and stores a per-project preferred local model before chat-completion routing is enabled.
   - Keep LocalAI/Ollama/Hermes catalog drift visible instead of hiding it.

3. Overnight programming runs
   - Start a Hermes run from Pi with a bounded goal.
   - Show live progress, tool use, blockers, costs/tokens where available, and artifacts.
   - Require approval before destructive filesystem, network, or deployment actions.

4. Skill lifecycle review
   - Browse Hermes self-improving skills.
   - Diff proposed skill updates before approval.
   - Promote stable project procedures into Pi skills or a Codex plugin.

5. Memory inspection
   - Current implementation captures local Pi project memory notes and Kanban task-state snapshots under Pi extension state.
   - Next step is search/browse against Hermes long-term memory by project and session key when a stable API is available.
   - Show provenance, source session, and retention class.
   - Flag likely secrets or PHI before anything is saved.

6. Multi-project control
   - Switch between LMHG Astro, lmhg-expo, auth_forms, Dell operations, and my-pi contexts.
   - Keep profile/session separation visible in the UI.

## LMHG Infrastructure Use Cases

1. Google Workspace transition planning
   - Inventory documents, accounts, groups, calendars, forms, drives, and automations.
   - Build migration runbooks and verification checklists.
   - Keep PHI-bearing migrations separate from general administrative migrations.

2. lmhg-expo referral app support
   - Generate implementation plans against the Dell-first target.
   - Keep local development synthetic-only.
   - Use Hermes overnight for tests, dependency audits, API contract review, and runbook generation.

3. Dell and future infrastructure operations
   - Maintain deployment plans, service inventories, backup checks, provenance notes, and incident-response drafts.
   - Use Pi as the approval and visibility layer before Hermes starts long-running infrastructure work.

4. HIPAA program support
   - Draft safeguards documents, risk-analysis outlines, audit-log checklists, and vendor-classification notes.
   - Distinguish implemented engineering controls from remaining administrative obligations.

5. Research and documentation
   - Use Hermes for long-running source-grounded research.
   - Use Pi to inspect sources, citations, assumptions, and pending decisions before anything becomes project guidance.

## Codex Plugin Track

After the Pi control surface has a stable core client, create a Codex plugin for this project so Codex can also act as a Hermes control surface.

Likely contents:

- A skill explaining Tyler's Hermes/Pi/LMHG operating boundaries.
- A local Hermes API client wrapper or MCP toolset for status, runs, jobs, sessions, skills, and memory.
- A project brief generated from this document plus current implementation status.
- HIPAA Sidekick observer-mode hooks for compliance-sensitive planning.

The plugin should reuse the same Hermes contract as Pi. It should not fork behavior or keep separate assumptions.

## Custom Control Center Feasibility

A custom control center is feasible, but it should come after the shared contract exists.

Minimum useful version:

- Local-only web UI or TUI panel.
- Health, capabilities, models, active runs, jobs, sessions, memory search, skills, and approvals.
- No PHI display by default.
- No browser-held Hermes API secret.

The control center should use a small local backend that owns the Hermes API token, then exposes only Tyler-approved views/actions to the browser.

## Pi Extensibility Notes

Useful existing Pi ecosystem patterns:

- Pi packages can bundle extensions, skills, prompts, and themes and install with `pi install npm:<package>`.
- `pi-mcp-extension` shows direct MCP-to-Pi tool bridging.
- `pi-hermes-memory` is useful prior art for Pi-native memory, but it is not the live Hermes Agent control bridge.
- `pi-subagents`, `pi-crew`, and dynamic workflow packages show patterns for long-running and parallel work.
- Permission and approval packages are relevant before enabling mutating Hermes actions.

Sources:

- https://pi.dev/packages
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/custom-provider
- https://pi.dev/packages/pi-mcp-extension
- https://pi.dev/packages/pi-hermes-memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
