/**
 * pi-rtk — rtk integration for the pi coding agent.
 *
 * Rewrites the agent's bash commands to their rtk equivalents
 * (https://github.com/rtk-ai/rtk) before execution, so tool output reaches the
 * model token-optimized instead of raw. Adds /rtk saved, which reports the
 * token savings rtk itself measured, as a transcript card.
 *
 * Commands:
 *   /rtk saved   Token savings — this session and rtk's lifetime totals
 *   /rtk status  Rewrite state, session rewrite count, detected rtk version
 *   /rtk off     Stop rewriting for this session (/rtk on to resume)
 *
 * This is a thin delegating extension: all rewrite logic lives in `rtk rewrite`,
 * which is the single source of truth (src/discover/registry.rs).
 * To add or change rewrite rules, edit the Rust registry — not this file.
 *
 * Exit code contract for `rtk rewrite`:
 *   0 + stdout  Rewrite found → mutate command
 *   1           No RTK equivalent → pass through unchanged
 *   3 + stdout  Rewrite (advisory) → mutate command
 *
 * Savings numbers come from rtk's own tracking (`rtk gain`), which measures the
 * raw vs. compressed output of every command it runs. Session numbers are the
 * diff of that tracker since this pi session started; the rewrite count is
 * exact (counted here, one per actually rewritten command).
 *
 * Requires: rtk >= 0.23.0 in PATH (when `rtk rewrite` was introduced).
 */

import type {
	BashToolCallEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const REWRITE_TIMEOUT_MS = 2_000;
const GAIN_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;

const SAVINGS_ENTRY = "rtk-savings";

/** Totals from `rtk gain --format json`. */
interface GainSummary {
	total_commands: number;
	total_input: number;
	total_output: number;
	total_saved: number;
	avg_savings_pct?: number;
}

interface GainJson {
	summary?: GainSummary;
}

interface Totals {
	commands: number;
	input: number;
	output: number;
	saved: number;
}

interface SavingsData {
	at: string;
	/** Commands this extension actually rewrote during this session. */
	rewrites: number;
	/** rtk-reported totals minus the session-start snapshot; null when unavailable. */
	session: { commands: number; saved: number; pct: number | null } | null;
	lifetime: { commands: number; saved: number; pct: number | null } | null;
}

// Local reimplementation of the package's `isToolCallEventType("bash", event)` type
// guard. That helper is a value export, so importing it pulls in the whole
// `@earendil-works/pi-coding-agent` barrel at extension load — profiled at ~250ms
// warmed, vs ~10ms for a type-only import. `BashToolCallEvent`/`ToolCallEvent`
// below are type-only imports and are erased at compile time, so they carry none
// of that cost. See #2753.
function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
	return event.toolName === "bash"
}

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
	const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
	if (!m) return null
	return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

// Calls `rtk rewrite`; returns the rewritten command or null (pass through).
async function rewriteCommand(
	pi: ExtensionAPI,
	cmd: string,
	signal?: AbortSignal
): Promise<string | null> {
	const result = await pi.exec("rtk", ["rewrite", cmd], {
		timeout: REWRITE_TIMEOUT_MS,
		signal,
	})
	if (result.killed) return null
	if (result.code !== 0 && result.code !== 3) return null
	return result.stdout.trim() || null
}

function parseGain(stdout: string): Totals | null {
	try {
		const json = JSON.parse(stdout) as GainJson;
		const s = json.summary;
		if (!s || typeof s.total_saved !== "number" || typeof s.total_input !== "number") return null;
		return {
			commands: s.total_commands ?? 0,
			input: s.total_input,
			output: s.total_output ?? 0,
			saved: s.total_saved,
		};
	} catch {
		return null;
	}
}

/** Difference of two rtk totals; clamps at zero (e.g. after `rtk gain --reset`). */
function diffTotals(current: Totals, snapshot: Totals): { commands: number; saved: number; pct: number | null } {
	const dInput = Math.max(0, current.input - snapshot.input);
	const dSaved = Math.max(0, current.saved - snapshot.saved);
	const dCommands = Math.max(0, current.commands - snapshot.commands);
	return { commands: dCommands, saved: dSaved, pct: dInput > 0 ? dSaved / dInput : null };
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function pct(p: number | null | undefined): string {
	return typeof p === "number" ? `${(p * 100).toFixed(1)}%` : "n/a";
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Non-interactive modes may have no UI at all.
	}
}

type StatusContext = {
	ui?: {
		setStatus?: (key: string, text: string) => void
	}
}

// Register before the async version probe so a host cannot miss the handler
// while the probe is in flight. If session_start happens first, retain its
// context and apply the status as soon as the probe reports a failure.
// pi.notify is intentionally not used here — some hosts wipe it on the
// initial render; the status bar survives.
function registerRtkUnavailableNotice(pi: ExtensionAPI) {
	let reason: string | undefined
	let sessionContext: StatusContext | undefined

	const applyStatus = () => {
		if (!reason || !sessionContext) return
		try {
			sessionContext.ui?.setStatus?.("rtk", `RTK disabled: ${reason}`)
		} catch {
			// Status reporting must never affect the extension's fail-open behavior.
		}
	}

	try {
		pi.on("session_start", (_event: unknown, ctx: unknown) => {
			sessionContext = ctx as StatusContext
			applyStatus()
		})
	} catch {
		// Runtimes without a session_start event: nothing to report.
		return (_reason: string) => {}
	}

	return (nextReason: string) => {
		reason = nextReason
		applyStatus()
	}
}

export default async function (pi: ExtensionAPI) {
	const reportRtkUnavailable = registerRtkUnavailableNotice(pi)

	let rtkVersion: string | undefined
	let enabled = process.env.RTK_DISABLED !== "1"
	/** Commands this extension actually rewrote since the session started. */
	let rewrites = 0
	/** rtk gain totals when this session started; null if the query failed. */
	let snapshot: Totals | null = null

	async function fetchTotals(): Promise<Totals | null> {
		try {
			const result = await pi.exec("rtk", ["gain", "--format", "json"], { timeout: GAIN_TIMEOUT_MS })
			if (result.code !== 0) return null
			return parseGain(result.stdout)
		} catch {
			return null;
		}
	}

	// Probe rtk version at load time; disables extension if missing or too old.
	const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
	if (ver.code !== 0) {
		reportRtkUnavailable("rtk binary not found in PATH")
		console.warn("[rtk] rtk binary not found in PATH — extension disabled")
		return
	}
	rtkVersion = ver.stdout.trim().replace(/^rtk\s+/, "")

	// Warn and bail if rtk predates 0.23.0 (when `rtk rewrite` was introduced).
	const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""))
	if (parsed) {
		const [major, minor] = parsed
		if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
			reportRtkUnavailable(`rtk ${parsed.join(".")} is too old (need >= 0.23.0)`)
			console.warn(`[rtk] rtk ${ver.stdout.trim()} is too old (need >= 0.23.0) — extension disabled`)
			return
		}
	}

	pi.on("session_start", async (_event, _ctx) => {
		rewrites = 0;
		snapshot = await fetchTotals();
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isBashToolCallEvent(event)) return

			const cmd = event.input.command
			if (typeof cmd !== "string" || cmd.trim() === "") return

			if (cmd.startsWith("rtk ")) return
			if (!enabled) return
			if (process.env.RTK_DISABLED === "1") return

			// Delegate to RTK.
			const rewritten = await rewriteCommand(pi, cmd, ctx.signal)
			if (rewritten && rewritten !== cmd) {
				event.input.command = rewritten
				rewrites += 1
			}
		} catch (err) {
			// Fail open: never block execution on an unexpected error.
			console.warn("[rtk] unexpected error in tool_call handler; passing through command", err)
			return
		}
	});

	pi.registerCommand("rtk", {
		description: "rtk integration status and token savings",
		getArgumentCompletions: (prefix: string) =>
			(
				[
					["saved", "Show token savings reported by rtk"],
					["status", "Show rewrite state and rtk version"],
					["on", "Resume rewriting bash commands via rtk"],
					["off", "Pause rewriting for this session"],
				] as const
			)
				.filter(([value]) => value.startsWith(prefix))
				.map(([value, description]) => ({ value, label: value, description })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			switch (arg === "" ? "status" : arg) {
				case "saved":
				case "stats": {
					const current = await fetchTotals();
					const data: SavingsData = {
						at: new Date().toISOString(),
						rewrites,
						session: current && snapshot ? diffTotals(current, snapshot) : null,
						lifetime: current
							? {
									commands: current.commands,
									saved: current.saved,
									pct: current.input > 0 ? current.saved / current.input : null,
								}
							: null,
					};
					pi.appendEntry<SavingsData>(SAVINGS_ENTRY, data);
					if (ctx.mode !== "tui") {
						const s = data.session;
						notify(
							ctx,
							`rtk savings: session ${s ? `${fmt(s.saved)} tok (${pct(s.pct)}), ${data.rewrites} rewritten` : "snapshot unavailable"}, lifetime ${data.lifetime ? `${fmt(data.lifetime.saved)} tok (${pct(data.lifetime.pct)})` : "unavailable"}`,
						);
					}
					break;
				}
				case "on": {
					enabled = true;
					notify(ctx, "rtk rewriting ON. Commands route through rtk again.");
					break;
				}
				case "off": {
					enabled = false;
					notify(ctx, "rtk rewriting OFF for this session. Commands run raw until /rtk on.");
					break;
				}
				case "status": {
					notify(
						ctx,
						`rtk ${rtkVersion ?? "?"} — rewriting ${enabled ? "ON" : "OFF"}, ${fmt(rewrites)} command${rewrites === 1 ? "" : "s"} rewritten this session. /rtk saved | on | off`,
					);
					break;
				}
				default:
					notify(ctx, "Usage: /rtk saved | status | on | off", "warning");
			}
		},
	});

	// Render savings cards as transcript blocks that never reach the model.
	pi.registerEntryRenderer<SavingsData>(SAVINGS_ENTRY, (entry, _renderCtx, theme) => {
		const d = (entry.data ?? {}) as Partial<SavingsData>;
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		const row = (label: string, value: string) =>
			box.addChild(new Text(`  ${theme.fg("dim", label.padEnd(30))}${value}`, 0, 0));

		box.addChild(new Text(theme.fg("accent", "⚡ rtk token savings"), 0, 0));
		box.addChild(
			new Text(theme.fg("dim", "Basis: rtk's own raw vs. compressed output measurement"), 0, 0),
		);
		box.addChild(new Text("", 0, 0));
		box.addChild(new Text(theme.bold("This session (pi)"), 0, 0));
		row("Commands rewritten by pi-rtk:", String(d.rewrites ?? 0));
		row(
			"rtk-reported saved:",
			d.session ? `${fmt(d.session.saved)} tokens (${pct(d.session.pct)})` : "snapshot unavailable",
		);
		box.addChild(new Text("", 0, 0));
		box.addChild(new Text(theme.bold("rtk lifetime (all tools)"), 0, 0));
		row("Commands through rtk:", d.lifetime ? fmt(d.lifetime.commands) : "unavailable");
		row(
			"Saved:",
			d.lifetime ? `${fmt(d.lifetime.saved)} tokens (${pct(d.lifetime.pct)})` : "unavailable",
		);
		return box;
	});
}
