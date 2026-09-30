# pi-rtk

Every bash command pi runs, quietly rewritten into its
[rtk](https://github.com/rtk-ai/rtk) equivalent before execution — and
`/rtk saved` shows what that saved.

rtk is a CLI proxy that filters and summarizes command output before it reaches
an LLM's context (`rtk grep` instead of `grep`, `rtk git status` instead of
`git status`, ...). This extension hooks pi's `tool_call` event, asks
`rtk rewrite` what the command should be, and mutates the call when there is an
equivalent. Commands with no rtk equivalent, already-rtk commands, and non-bash
tools pass through untouched.

## Commands

| Command | What it does |
|---|---|
| `/rtk saved` | Token savings card — this session and rtk's lifetime totals — rendered in the transcript, never sent to the model |
| `/rtk status` | Detected rtk version, rewrite state, commands rewritten this session |
| `/rtk off` | Pause rewriting for this session; commands run raw |
| `/rtk on` | Resume rewriting |

Set `RTK_DISABLED=1` in the environment for a hard kill switch that `/rtk on`
cannot override.

## How the savings are measured

The savings card does not guess — it reads rtk's own tracker (`rtk gain`), which
measures the raw vs. compressed output of every command rtk runs:

- **This session (pi)** — the difference in rtk's tracker since this pi session
  started, plus the exact count of commands this extension rewrote. The delta
  counts all rtk usage in that window, so if another tool on the machine also
  runs rtk concurrently, its savings appear here too. If rtk's tracker was
  reset mid-session (`rtk gain --reset`), the delta clamps to zero.
- **rtk lifetime (all tools)** — rtk's global totals, as reported by
  `rtk gain`.

Savings cards are custom transcript entries: they never reach the model, so the
extension costs your context nothing. On rtk's own numbers it more than pays
for itself — rtk reports 60–90% fewer tokens on common dev commands.

## Install

Requires [rtk](https://github.com/rtk-ai/rtk) >= 0.23.0 in `PATH` (when
`rtk rewrite` was introduced). Older versions disable the extension with a
status-bar notice instead of breaking anything.

```bash
pi install git:github.com/hakergeniusz/pi-rtk
```

Try it without installing:

```bash
pi -e https://github.com/hakergeniusz/pi-rtk
```

All rewrite decisions are delegated to `rtk rewrite` — the extension contains
no rules of its own, so rtk's registry stays the single source of truth.

## Credits

- [rtk-ai/rtk](https://github.com/rtk-ai/rtk) (Apache-2.0) — does all the work.
  This extension is a thin delegator around `rtk rewrite` and `rtk gain`.
- Sibling project: [pi-caveman](https://github.com/hakergeniusz/pi-caveman) —
  caveman lite mode for pi, with the same style of savings card.

## License

[MIT](LICENSE)
