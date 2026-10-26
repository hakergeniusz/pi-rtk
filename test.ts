/**
 * Smoke test: runs index.ts against a fake ExtensionAPI with a canned rtk
 * binary. No network, no real pi, no real rtk. `bun test.ts`.
 */

const { default: activate } = await import("./index.ts");

// --- fake pi -----------------------------------------------------------------

interface ExecCall {
	cmd: string;
	args: string[];
}

interface FakeRtk {
	version?: string; // undefined -> binary missing (exit 127)
	rewrites?: Record<string, string>; // raw command -> rewritten command
	gain?: Totals; // what `rtk gain --format json` reports
}

interface Totals {
	commands: number;
	input: number;
	output: number;
	saved: number;
}

interface Registers {
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	handlers: Record<string, (event: unknown, ctx: unknown) => unknown>;
	renderers: Record<string, (entry: unknown, rctx: unknown, theme: unknown) => unknown>;
	entries: { customType: string; data: unknown }[];
	execCalls: ExecCall[];
}

function makeFake(rtk: FakeRtk): { pi: unknown; reg: Registers; rtk: FakeRtk } {
	const reg: Registers = { commands: {}, handlers: {}, renderers: {}, entries: [], execCalls: [] };
	const pi = {
		registerCommand(name: string, options: (typeof reg.commands)[string]) {
			reg.commands[name] = options;
		},
		registerEntryRenderer(type: string, renderer: (typeof reg.renderers)[string]) {
			reg.renderers[type] = renderer;
		},
		on(event: string, handler: (typeof reg.handlers)[string]) {
			reg.handlers[event] = handler;
			return () => {};
		},
		appendEntry(customType: string, data?: unknown) {
			reg.entries.push({ customType, data });
		},
		async exec(cmd: string, args: string[]) {
			reg.execCalls.push({ cmd, args });
			if (args[0] === "--version") {
				if (!rtk.version) return { code: 127, stdout: "", killed: false };
				return { code: 0, stdout: `${rtk.version}\n`, killed: false };
			}
			if (args[0] === "rewrite") {
				const raw = args.slice(1).join(" ");
				const rewritten = rtk.rewrites?.[raw];
				if (rewritten === undefined) return { code: 1, stdout: "", killed: false };
				return { code: 0, stdout: `${rewritten}\n`, killed: false };
			}
			if (args[0] === "gain") {
				// rtk's real JSON uses total_* keys; keep the fake honest.
				const g = rtk.gain!;
				return {
					code: 0,
					stdout: JSON.stringify({
						summary: {
							total_commands: g.commands,
							total_input: g.input,
							total_output: g.output,
							total_saved: g.saved,
						},
					}),
					killed: false,
				};
			}
			return { code: 1, stdout: "", killed: false };
		},
	};
	return { pi, reg, rtk };
}

const fakeTheme = new Proxy({}, { get: () => (s: string) => s }) as Record<string, (s: string) => string>;
const notifications: string[] = [];
const fakeCtx = {
	mode: "tui",
	hasUI: true,
	ui: {
		notify: (message: string) => notifications.push(message),
		setStatus: () => {},
	},
};

// --- helpers -----------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
	if (cond) {
		passed += 1;
	} else {
		failed += 1;
		console.error(`FAIL: ${name}`);
	}
}

async function runBash(reg: Registers, command: string): Promise<string> {
	const event: { toolName: string; input: { command: string } } = {
		toolName: "bash",
		input: { command },
	};
	await reg.handlers.tool_call(event, fakeCtx);
	return event.input.command;
}

// --- the actual test ---------------------------------------------------------

const gainA: Totals = { commands: 100, input: 10000, output: 3000, saved: 7000 };
const { pi, reg, rtk } = makeFake({
	version: "rtk 0.50.0",
	rewrites: { "git status": "rtk git status", "ls -la": "rtk ls -la" },
	gain: gainA,
});

await (activate as (p: unknown) => Promise<void>)(pi);

check("registers /rtk command", reg.commands.rtk !== undefined);
check("registers savings entry renderer", reg.renderers["rtk-savings"] !== undefined);
check("registers tool_call", reg.handlers.tool_call !== undefined);
check("registers session_start", reg.handlers.session_start !== undefined);

// session_start snapshots rtk's totals for the session diff.
await reg.handlers.session_start({ type: "session_start" }, fakeCtx);
check("session snapshot queried gain", reg.execCalls.some((c) => c.args[0] === "gain"));

// Rewritable bash command is mutated and counted.
check("rewrites git status", (await runBash(reg, "git status")) === "rtk git status");
// Non-rewritable command passes through untouched.
check("passes echo through", (await runBash(reg, "echo hello")) === "echo hello");
// Already-rtk command is left alone.
check("leaves rtk commands alone", (await runBash(reg, "rtk ls")) === "rtk ls");
// Non-bash tools are untouched.
const readEvent: { toolName: string; input: { path: string } } = { toolName: "read", input: { path: "x" } };
await reg.handlers.tool_call(readEvent, fakeCtx);
check("ignores non-bash tools", readEvent.input.path === "x");

// Status reports the exact rewrite count.
await reg.commands.rtk.handler("status", fakeCtx);
check("status reports one rewrite", notifications.at(-1)?.includes("1 command rewritten") === true);
check("status reports version", notifications.at(-1)?.includes("0.50.0") === true);

// Savings card: session delta and lifetime totals from rtk's own tracker.
rtk.gain = { commands: 105, input: 15000, output: 4500, saved: 10500 };
await reg.commands.rtk.handler("saved", fakeCtx);
const card = reg.entries.at(-1)?.data as {
	rewrites: number;
	session: { commands: number; saved: number; pct: number | null };
	lifetime: { commands: number; saved: number; pct: number | null };
};
check("card appended", reg.entries.at(-1)?.customType === "rtk-savings");
check("session delta commands", card?.session?.commands === 5);
check("session delta saved", card?.session?.saved === 3500);
check("session delta pct 70%", Math.abs((card?.session?.pct ?? 0) - 0.7) < 1e-9);
check("lifetime totals", card?.lifetime?.saved === 10500 && card.lifetime.commands === 105);
check("lifetime pct 70%", Math.abs((card?.lifetime?.pct ?? 0) - 0.7) < 1e-9);
check("rewrite count in card", card?.rewrites === 1);

// Renderer returns a component.
check(
	"renderer returns a component",
	reg.renderers["rtk-savings"]({ type: "custom", customType: "rtk-savings", data: card }, { expanded: true }, fakeTheme) !==
		undefined,
);

// /rtk off pauses rewriting without touching the count; /rtk on resumes.
await reg.commands.rtk.handler("off", fakeCtx);
check("off pauses rewriting", (await runBash(reg, "git status")) === "git status");
await reg.commands.rtk.handler("on", fakeCtx);
check("on resumes rewriting", (await runBash(reg, "git status")) === "rtk git status");
await reg.commands.rtk.handler("saved", fakeCtx);
const cardOn = reg.entries.at(-1)?.data as typeof card;
check("rewrites counted across toggle", cardOn?.rewrites === 2);

// rtk gain --reset mid-session: negative deltas clamp to zero.
rtk.gain = { commands: 1, input: 10, output: 3, saved: 7 };
await reg.commands.rtk.handler("saved", fakeCtx);
const card2 = reg.entries.at(-1)?.data as typeof card;
check("reset clamps session delta to zero", card2?.session?.saved === 0 && card2.session.commands === 0);

// Multi-line scripts: rtk declines the whole command ($(pwd) is not a
// rewritable construct), so the extension retries line by line; the line rtk
// cannot rewrite passes through verbatim.
rtk.rewrites!["uv run pytest -q 2>&1 | tail -n 2"] = "uv run rtk pytest -q 2>&1 | tail -n 2";
const declinedScript = "export PYTHONPATH=$PYTHONPATH:$(pwd)/src\nuv run pytest -q 2>&1 | tail -n 2";
check(
	"rewrites lines of a declined script",
	(await runBash(reg, declinedScript)) ===
		"export PYTHONPATH=$PYTHONPATH:$(pwd)/src\nuv run rtk pytest -q 2>&1 | tail -n 2",
);

// Heredoc bodies are data: never rewritten even when a rule matches.
rtk.rewrites!["uv run pytest -q"] = "uv run rtk pytest -q";
const heredoc = "python3 - <<'PY'\nuv run pytest -q\nPY";
check("leaves heredoc bodies alone", (await runBash(reg, heredoc)) === heredoc);

// Continuation lines are collapsed into one command, rewritten, emitted as one line.
rtk.rewrites!["cd /x &&  git status"] = "cd /x && rtk git status";
check(
	"rewrites continued command",
	(await runBash(reg, "cd /x && \\\ngit status")) === "cd /x && rtk git status",
);

// A single-line command rtk declines still passes through untouched.
check("single-line decline passes through", (await runBash(reg, "echo $(date)")) === "echo $(date)");

// Unavailable rtk: factory bails before registering the rewrite handler.
const missing = makeFake({});
await (activate as (p: unknown) => Promise<void>)(missing.pi);
check("missing binary disables rewriting", missing.reg.handlers.tool_call === undefined);

const ancient = makeFake({ version: "rtk 0.10.0" });
await (activate as (p: unknown) => Promise<void>)(ancient.pi);
check("old rtk disables rewriting", ancient.reg.handlers.tool_call === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
