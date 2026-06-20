# Hermes Pi Control Plane

This project treats Pi as a frontend and control surface for Hermes Agent. Pi should not copy Hermes internals. Hermes owns model routing, memory, skills, runs, jobs, sessions, approvals, and persistent state. Pi should discover those surfaces, display them clearly, and send explicit control actions through stable APIs.

## Current Local Slice

The first local slice is `.pi/extensions/hermes-status.ts`.

It provides:

- `/hermes-status`: read-only Hermes health, capability, model, skill, and toolset report.
- `hermes_status`: read-only tool for the agent to inspect the configured Hermes API surface.
- Footer status: shows whether the configured Hermes API is reachable.

Configuration:

- `HERMES_API_BASE_URL` or `HERMES_API_URL`: defaults to `http://127.0.0.1:8642`.
- `HERMES_API_KEY`: optional bearer token for the Hermes API server.
- `HERMES_SESSION_KEY`: optional `X-Hermes-Session-Key` value to keep memory scoped to this Pi user/workspace.

The extension does not start Hermes, write memory, mutate skills, start runs, or contact bee01.

## Architecture Direction

Use one shared Hermes contract with multiple focused Pi extensions.

```text
Pi TUI / CLI
  -> Pi Hermes extensions
    -> shared Hermes API client
      -> Hermes API server
      -> Hermes OpenAI-compatible model endpoints
      -> Hermes runs, jobs, sessions, skills, memory, and toolsets
      -> MCP only where model-visible tool/resource bridging is useful
```

Recommended modules:

- `pi-hermes-core`: shared client, auth, health, capabilities, error handling.
- `pi-hermes-provider`: dynamic `pi.registerProvider()` bridge from `/v1/models`.
- `pi-hermes-goals`: start, inspect, stop, resume, and approve long-running Hermes runs.
- `pi-hermes-memory-skills`: browse/search memory and skills first, later gated writes.
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
   - Show models, skills, toolsets, runs, jobs, sessions, and pending approvals.

2. Local model provider bridge
   - Let Pi use Hermes-routed local models as selectable Pi models.
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
   - Search long-term memory by project and session key.
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
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
