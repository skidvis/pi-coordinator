/**
 * Coordinator — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary agent has NO codebase tools. It can ONLY delegate work
 * to 3 specialist subagents via the `dispatch_agent` tool:
 *   - researcher   (read,write,grep,find,ls)
 *   - implementer  (read,write,edit,bash)
 *   - verifier     (read,write,grep,find,ls,bash)
 *
 * Four-phase workflow: Research → Synthesis → Implementation → Verification
 * Shared scratchpad at .pi/scratchpad/ for cross-agent knowledge sharing.
 * 
 * Author: skidvis
 * Usage: pi -e extensions/coordinator.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readdirSync, existsSync, mkdirSync, unlinkSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	sessionFile: string | null;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agentStates: Map<string, AgentState> = new Map();
	let allAgentDefs: AgentDef[] = [];
	let gridCols = 1;
	let animFrame = 0;
	let widgetCtx: any;
	let widgetInvalidate: (() => void) | null = null;
	let sessionDir = "";
	let scratchpadDir = "";
	let tmuxLogFile: string | null = null;

	function initTmuxLogPane(cwd: string) {
		if (!process.env.TMUX) return;
		tmuxLogFile = join(tmpdir(), `pi-agents-${Date.now()}.log`);
		writeFileSync(tmuxLogFile, "");
		const pane = process.env.TMUX_PANE;
		spawn("tmux", [
			"split-window", "-v", "-d", "-l", "33%",
			"-c", cwd,
			...(pane ? ["-t", pane] : []),
			"tail", "-f", tmuxLogFile,
		], { stdio: "ignore" });
	}

	function tmuxLog(agentName: string, line: string) {
		if (!tmuxLogFile) return;
		try { appendFileSync(tmuxLogFile, `[${agentName}] ${line}\n`); } catch {}
	}

	function loadAgents(cwd: string) {
		// Create session storage dir
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// Hardcoded 3-agent team — no teams.yaml required
		allAgentDefs = [
			{
				name: "researcher",
				description: "Read-only codebase investigator. Explores structure, reads files, greps for patterns, and writes findings to the scratchpad. Never modifies source files.",
				tools: "read,write,grep,find,ls",
				systemPrompt: `You are a researcher agent. You investigate codebases and write findings.
You have READ-ONLY access to the codebase. Never modify source files (you may only write to the scratchpad directory you are given).
When dispatched, focus on your assigned investigation angle only.
Write your findings to the scratchpad file path specified in your task.
Be specific: include file paths, line numbers, function names, and exact code snippets.`,
				file: "",
			},
			{
				name: "implementer",
				description: "Code writer. Implements changes based on a precise spec written by the coordinator. Works serially, one file set at a time.",
				tools: "read,write,edit,bash",
				systemPrompt: `You are an implementer agent. You write code based on exact specs.
You will be given a precise implementation spec with specific file paths, line numbers, and exactly what to change.
Follow the spec exactly. Do not improvise or expand scope.
After implementing, write a brief summary of what you changed to the scratchpad file path specified in your task.`,
				file: "",
			},
			{
				name: "verifier",
				description: "Quality gate. Verifies that implemented changes actually work. Runs tests, checks types, reads diffs. Never the same agent that implemented.",
				tools: "read,write,grep,find,ls,bash",
				systemPrompt: `You are a verifier agent. You verify that code changes work correctly.
You are NOT the implementer — approach verification with genuine skepticism.
Verification means PROVING the code works, not confirming it exists.
Run tests, check for type errors, read the actual changed code carefully.
Investigate any failures rather than dismissing them as unrelated.
Write your verification report to the scratchpad file path specified in your task.`,
				file: "",
			},
		];
	}

	function activateAgents() {
		agentStates.clear();
		for (const def of allAgentDefs) {
			const key = def.name.toLowerCase().replace(/\s+/g, "-");
			const sessionFile = join(sessionDir, `${key}.json`);
			agentStates.set(def.name.toLowerCase(), {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				sessionFile: existsSync(sessionFile) ? sessionFile : null,
				runCount: 0,
			});
		}
	}

	// ── Animated Dots ────────────────────────────

	function renderAnimatedDots(numDots: number, frame: number, theme: any): string {
		// Repeating groups of 3 colored dots scrolling left→right between agent name and status.
		// Pattern: "XXX···XXX···" where each XXX block cycles through accent/success/warning.
		const period = 6;      // 3 colored + 3 dim
		const groupSize = 3;
		const colors = ["accent", "success", "warning"];

		let result = "";
		for (let i = 0; i < numDots; i++) {
			const shifted = i - frame;
			const pos = ((shifted % period) + period) % period;
			if (pos < groupSize) {
				// Determine which group this dot belongs to (for alternating color)
				const groupIndex = ((Math.floor((shifted - pos) / period)) % colors.length + colors.length) % colors.length;
				result += theme.fg(colors[groupIndex], "·");
			} else {
				result += theme.fg("dim", "·");
			}
		}
		return result;
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + "…" : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusStr = `${statusIcon}${timeStr}`;

		// name · dotted leader · status right-aligned
		const nameMaxLen = colWidth - statusStr.length - 2;
		const truncatedName = truncate(name, nameMaxLen);
		const dots = Math.max(1, colWidth - truncatedName.length - statusStr.length - 2);
		const line = theme.fg("accent", theme.bold(truncatedName)) +
			" " + (state.status === "running"
			? renderAnimatedDots(dots, animFrame, theme)
			: theme.fg("dim", "·".repeat(dots))) + " " +
			theme.fg(statusColor, statusStr);

		return [line];
	}

	function initWidget() {
		if (!widgetCtx) return;
		widgetInvalidate = null;

		widgetCtx.ui.setWidget("agent-team", (tui: any, theme: any) => {
			const text = new Text("", 0, 1);
			widgetInvalidate = () => tui.requestRender();

			return {
				render(width: number): string[] {
					if (agentStates.size === 0) {
						text.setText(theme.fg("dim", "No agents found. Add .md files to agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(1).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	function updateWidget() {
		animFrame++;
		if (!widgetCtx) return;
		if (widgetInvalidate) {
			widgetInvalidate();
		} else {
			initWidget();
		}
	}

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "running") {
			return Promise.resolve({
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.runCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const model = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";

		// Session file for this agent
		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);

		// Build args — first run creates session, subsequent runs resume
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", `in cwd, ${state.def.systemPrompt}`,
			"--session", agentSessionFile,
		];

		// Continue existing session if we have one
		if (state.sessionFile) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		let textLineBuffer = "";
		const agentLabel = displayName(state.def.name);

		return new Promise((resolve) => {
			const bin = process.platform === "win32" ? "pi.cmd" : "pi";
			const proc = spawn(bin, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			let buffer = "";

			const argPreview = (args: any): string => {
				if (!args || typeof args !== "object") return "";
				const first = Object.values(args).find(v => typeof v === "string") as string | undefined;
				if (!first) return "";
				return first;
			};

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								const chunk = delta.delta || "";
								textChunks.push(chunk);
								textLineBuffer += chunk;
								const newlineIdx = textLineBuffer.lastIndexOf("\n");
								if (newlineIdx !== -1) {
									const completed = textLineBuffer.slice(0, newlineIdx);
									textLineBuffer = textLineBuffer.slice(newlineIdx + 1);
									const lastLine = completed.split("\n").filter((l: string) => l.trim()).pop();
									if (lastLine) {
										state.lastWork = lastLine;
										tmuxLog(agentLabel, lastLine);
									}
								}
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							const preview = argPreview(event.args);
							tmuxLog(agentLabel, preview ? `→ ${event.toolName}: ${preview}` : `→ ${event.toolName}`);
						} else if (event.type === "tool_execution_end") {
							tmuxLog(agentLabel, `${event.isError ? "✗" : "✓"} ${event.toolName}`);
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				// Mark session file as available for resume
				if (code === 0) {
					state.sessionFile = agentSessionFile;
				}

				const full = textChunks.join("");
				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastWork = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };

			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching" },
					});
				}

				const result = await dispatchAgent(agent, task, ctx);

				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;

				const status = result.exitCode === 0 ? "done" : "error";
				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

				return {
					content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
					details: {
						agent,
						task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Build dynamic agent catalog from active team only
		const agentCatalog = Array.from(agentStates.values())
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
			.join("\n\n");

		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

		return {
			systemPrompt: `You are a coordinator. You orchestrate specialist agents to accomplish tasks.
You have NO direct access to the codebase — no read, write, grep, bash, or any file tools.
You MUST delegate ALL work through the dispatch_agent tool.
You are not a rubber-stamp. You are the decision-maker, the synthesizer, and the quality gate.

---

## Active Team: coordinator
Members: ${teamMembers}
You can ONLY dispatch to agents listed in the ## Agents section below. Do not attempt to dispatch to agents outside this team.

## Scratchpad
Path: ${scratchpadDir}
This directory is shared working memory for this session. All workers can read and write here freely without permission prompts.
Instruct workers to write their findings, specs, and reports here.
You will read scratchpad files yourself during Synthesis — do not skip this step.
Naming conventions (enforce these when you task workers):
  research-<topic>.md   — findings from researcher agents
  spec-<topic>.md       — implementation specs you produce
  verify-<topic>.md     — verification reports from verifier agents

---

## Workflow: Four Mandatory Phases

You MUST execute every non-trivial task through all four phases in order.
Do not skip phases. Do not compress phases. Do not begin Implementation before Synthesis is complete.

### Phase 1 — Research

Dispatch researchers IN PARALLEL to investigate the codebase from multiple independent angles.
Each researcher should focus on a distinct concern (e.g., data model, API layer, test suite, config).
Instruct each researcher to write their findings to the scratchpad as \`research-<topic>.md\`.

Rules:
- Dispatch at least two researchers for any non-trivial task.
- Do not attempt to interpret findings until ALL parallel researchers have returned.
- Do not guess at structure — wait for actual findings.

### Phase 2 — Synthesis (YOU do this personally)

After all researchers return, YOU must read their scratchpad files by dispatching an agent with read-only tools to read from the scratchpad, then synthesize all findings yourself.

**BANNED PHRASE: "based on your findings"**
You may NEVER say this phrase. You must demonstrate that you have personally read and understood the actual content of the research outputs. Quote specific file paths, line numbers, function names, and type signatures from the research notes in your spec.

The implementation spec MUST include:
- Every file to be modified, with its full path
- The exact location of each change (function name, line number range, or code anchor)
- The exact code to add, remove, or replace — not paraphrases, actual code or pseudocode
- Any new files to create, with full paths and complete initial content
- The order in which changes must be made if there are dependencies

Write the spec to the scratchpad as \`spec-<topic>.md\` before dispatching any implementer.

### Phase 3 — Implementation (serial per file set)

Dispatch implementers one at a time for each non-overlapping file set.
Two implementers MUST NOT edit the same file simultaneously.

Each implementer task message must:
- Reference the spec file in the scratchpad (give the full path)
- State exactly which files the implementer is responsible for
- State what the expected outcome is

Rules:
- If two changes affect different files with no shared dependency, you MAY dispatch them in parallel.
- If two changes affect the same file or one depends on the other, they MUST be serial.

### Phase 4 — Verification

Dispatch a DIFFERENT agent than the implementer to verify the work.
A verifier who implemented the same code carries implementation assumptions and will miss their own mistakes.
Always use a designated verifier agent — never the implementer.

The verifier task message must:
- Reference the spec file in the scratchpad
- Explicitly instruct: run tests with the feature enabled, investigate type errors rather than dismissing them as unrelated, be genuinely skeptical
- Ask the verifier to write a report to the scratchpad as \`verify-<topic>.md\`

Verification means PROVING the code works, not confirming it exists.
A verifier that rubber-stamps weak work undermines everything.

---

## How to Work
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- You can chain agents: use researchers to explore, synthesize yourself, then use implementers
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Rules
- NEVER bypass the four-phase workflow for non-trivial tasks
- NEVER say "based on your findings" — synthesize personally
- NEVER have two workers edit the same file simultaneously
- NEVER use the same agent for both implementation and verification of the same change
- ALWAYS write specs to the scratchpad before dispatching implementers
- ALWAYS have verification done by a different worker

## Agents

${agentCatalog}`,
		};
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clear widgets from previous session
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
			widgetInvalidate = null;
		}
		widgetCtx = _ctx;

		// Wipe old agent session files so subagents start fresh
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// ── Scratchpad — wiped fresh each session ─────────────────
		scratchpadDir = join(_ctx.cwd, ".pi", "scratchpad");
		if (existsSync(scratchpadDir)) {
			for (const f of readdirSync(scratchpadDir)) {
				try { unlinkSync(join(scratchpadDir, f)); } catch {}
			}
		} else {
			mkdirSync(scratchpadDir, { recursive: true });
		}
		writeFileSync(
			join(scratchpadDir, "README.md"),
			[
				"# Coordinator Scratchpad",
				"",
				"Shared working memory for this session. Workers may read and write freely.",
				"No permission prompts apply inside this directory.",
				"",
				"## Naming Conventions",
				"- `research-<topic>.md`  — findings from researcher agents",
				"- `spec-<topic>.md`      — implementation specs produced by the coordinator",
				"- `verify-<topic>.md`    — verification reports from verifier agents",
				"- `notes-<anything>.md`  — any other persistent notes",
				"",
				"Files are wiped at the start of each new session.",
			].join("\n"),
		);

		loadAgents(_ctx.cwd);
		initTmuxLogPane(_ctx.cwd);
		activateAgents();

		// Lock down to dispatcher-only
		pi.setActiveTools(["dispatch_agent"]);

		_ctx.ui.setStatus("agent-team", `Coordinator (${agentStates.size} agents)`);
		const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
		_ctx.ui.notify(
			`Coordinator mode active — ${members}\n\n` +
			"info",
		);
		updateWidget();
	});
}
