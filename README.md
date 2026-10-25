# session-deck

A Claude Code mod that keeps a pane beside the chat with the things I kept stopping to check mid-session: how full the context is, how much of my plan's usage limits are left, where I am in the implementation plan, and what is scheduled to run.

## What it shows

- **Context**: the live window's fill as a bar, against a 50% handoff mark. A toast fires at 40% and again at 50%.
- **Limits**: the 5-hour and weekly windows, with the time until each one resets. A toast fires at 80% and 95%.
- **Plan**: the tasks of the last `docs/superpowers/plans/*.md` file Claude read or wrote, taken from its `### Task N:` headings and marked done, in progress or to do. Claude marks them through the mod's `plan_progress` tool, so the plan file is never edited. Progress is stored per plan, so a later session that opens the same plan picks up where the last one stopped.
- **Scheduled here**: this session's crons, `/loop` wakeups and background jobs, as of the end of the last turn.
- **Routines**: your cloud routines, with the time to each one's next run and how its last run went. Refreshed every 30 minutes and whenever Claude lists them.

A status line under the prompt carries the short version: `ctx 31% · 5h 52% · 7d 28%`.

## Install

At the prompt of a terminal session:

```
/plugin install session-deck --marketplace mehboobali98/session-deck
```

From a shell:

```
claude plugin install session-deck --marketplace mehboobali98/session-deck
```

Answer `y` to add the marketplace, then pick a scope.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `mehboobali98/session-deck`, then Add plugin.

## Use

The pane opens by itself on a terminal 144 columns wide or more. `/deck` opens it at any width and refreshes the routine list.

## Settings

Both show up as rows in `/config`, and a change there applies at once.

| Setting | Default | What it does |
| --- | --- | --- |
| Handoff mark (`handoffAt`) | `50` | The context percent the deck marks for a handoff. A toast fires when context reaches it, and a warning 10 points earlier. |
| Status line (`statusLine`) | `full` | What the deck pins under the prompt: `full` for context and limits, `limits` if your own status line already shows context, or `off`. |

`/config` keeps them in your `settings.json` under `pluginConfigs`.

## Notes

- The routine list comes from the `RemoteTrigger` tool, so it needs a claude.ai sign-in. The mod allows its own read-only `list` call so the 30-minute refresh never raises a permission prompt. Every other `RemoteTrigger` call goes through your normal permissions.
- Limits show only on a Claude subscription, after the first reply of a session.
- Mods are built on Claude Code's function hooks, an early-access API, so a later release may need changes here.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
