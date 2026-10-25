import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  SessionContextUsage,
  SessionRateLimit,
  TurnStepInput,
} from 'claude-code'

import type { Agent, Effort, Limit, Plan, Routine, TaskStatus, Usage } from '../types'

const PANE = 'session-deck'
const TITLE = 'Session'
const TOOL = 'mcp__session-deck__plan_progress'
const PLAN_FILE = /\/docs\/superpowers\/plans\/[^/]+\.md$/
const TASK_HEADING = /^#{2,4}[ \t]+Task[ \t]+(\d+)[ \t]*[:.)–-]?[ \t]*(.*)$/gm
const LIMIT_WARN_AT = 80
const LIMIT_ALARM_AT = 95
const ROUTINE_REFRESH_MS = 30 * 60_000
const PLAN_ROWS = 8
const AGENTS_KEPT = 4
const HOUR_MS = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS }
const COSTLY_MODEL = /opus|fable/i
const ARG_KEYS = ['description', 'pattern', 'file_path', 'command', 'query', 'url'] as const

const PLAN_TOOL_DESCRIPTION =
  "Marks a task of the implementation plan in the person's session deck pane as todo, doing or done. " +
  'The deck loads a plan when you read or write a docs/superpowers/plans/*.md file. ' +
  'While executing such a plan, call this with status doing when you start a task and done once its verification passes. ' +
  "task is the number in the plan's '### Task N:' heading."

const usage = atom({ plugin: 'session-deck', key: 'usage' } as const, null, { shape: 'usage-1' })
const routines = atom({ plugin: 'session-deck', key: 'routines' } as const, null, {
  shape: 'routines-1',
})
const wakeups = atom(
  { plugin: 'session-deck', key: 'wakeups' } as const,
  { crons: [], jobs: [] },
  { shape: 'wakeups-1' },
)
const plan = atom({ plugin: 'session-deck', key: 'plan' } as const, null, { shape: 'plan-1' })
const model = atom({ plugin: 'session-deck', key: 'model' } as const, null, { shape: 'model-1' })
const agents = atom({ plugin: 'session-deck', key: 'agents' } as const, [], { shape: 'agents-1' })
const nudge = atom({ plugin: 'session-deck', key: 'nudge' } as const, null, { shape: 'nudge-1' })
const clock = atom({ plugin: 'session-deck', key: 'now' } as const, 0)

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

const label = (kind: string) => LIMIT_LABELS[kind] ?? kind

const isStatus = (value: unknown): value is TaskStatus =>
  value === 'todo' || value === 'doing' || value === 'done'

const storeKey = (path: string) => `plan:${path}`

type StatusMode = 'full' | 'limits' | 'off'

type Settings = { handoffAt: number; warnAt: number; statusLine: StatusMode }

/**
 * @return [Settings] the manifest's userConfig values, with the early warning 10 points
 *   before the handoff mark
 */
function settingsFrom(options: PluginOptions): Settings {
  const handoffAt = Math.min(95, Math.max(10, Math.round(Number(options.handoffAt) || 50)))
  const statusLine = options.statusLine === 'limits' || options.statusLine === 'off' ? options.statusLine : 'full'

  return { handoffAt, warnAt: handoffAt - 10, statusLine }
}

const toUsage = (context: SessionContextUsage, limits: readonly SessionRateLimit[]): Usage => ({
  percent: context.percent,
  window: context.window,
  limits: limits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
})

function statusText(u: Usage, mode: StatusMode): string | undefined {
  if (mode === 'off') return undefined

  const parts = [
    ...(mode === 'full' && u.percent !== undefined ? [`ctx ${u.percent}%`] : []),
    ...u.limits.map(l => `${label(l.kind)} ${Math.round(l.percentUsed)}%`),
  ]

  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * @return [number, undefined] the highest mark `after` reached that `before` was under
 */
function crossed(before: number | undefined, after: number | undefined, marks: number[]) {
  return marks.filter(mark => (before ?? 0) < mark && (after ?? 0) >= mark).pop()
}

const reachedHandoff = (before: Usage | null, after: Usage, { warnAt, handoffAt }: Settings) =>
  crossed(before?.percent, after.percent, [warnAt, handoffAt]) === handoffAt

const handoffNote = (percent: number | undefined, handoffAt: number) =>
  `session-deck: context is at ${percent ?? handoffAt}%, past the ${handoffAt}% handoff mark. ` +
  'Tell the person, finish the step in hand, then prepare the handoff before starting anything new.'

function alerts(before: Usage | null, after: Usage, at: number, { warnAt, handoffAt }: Settings): string[] {
  const lines: string[] = []
  const mark = crossed(before?.percent, after.percent, [warnAt, handoffAt])

  if (mark === handoffAt) {
    lines.push(`Context at ${after.percent}%: write the handoff before starting anything new`)
  } else if (mark !== undefined) {
    lines.push(`Context at ${after.percent}%: aim for a clean stopping point by ${handoffAt}%`)
  }

  for (const limit of after.limits) {
    const was = before?.limits.find(l => l.kind === limit.kind)?.percentUsed

    if (crossed(was, limit.percentUsed, [LIMIT_WARN_AT, LIMIT_ALARM_AT]) !== undefined) {
      const reset = limit.resetsAt ? `, resets ${relative(limit.resetsAt, at)}` : ''
      lines.push(`${label(limit.kind)} limit at ${limit.percentUsed}%${reset}`)
    }
  }

  return lines
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function relative(iso: string, at: number): string {
  const ms = Date.parse(iso) - at
  if (Number.isNaN(ms)) return ''

  return ms >= 0 ? `in ${span(ms)}` : `${span(-ms)} ago`
}

/**
 * @return [String, undefined] when the limit runs out at its pace since the window opened, or
 *   undefined when it lasts to its reset or the window is too young to tell
 */
function pace(limit: Limit, at: number): string | undefined {
  const length = WINDOW_MS[limit.kind]
  const resetsAt = Date.parse(limit.resetsAt ?? '')
  const used = limit.percentUsed
  if (length === undefined || Number.isNaN(resetsAt) || used <= 0 || used >= 100) return undefined

  const elapsed = at - (resetsAt - length)
  if (elapsed < length / 5) return undefined

  const outAt = at + ((100 - used) / used) * elapsed

  return outAt < resetsAt
    ? `runs out in ~${span(outAt - at)} at this pace, ${span(resetsAt - outAt)} before reset`
    : undefined
}

/**
 * @return [Array<String>] a toast for each limit newly on pace to run out before its reset,
 *   once per window across sessions
 */
async function paceAlerts($: EngineInterface, limits: readonly Limit[], at: number): Promise<string[]> {
  const lines: string[] = []

  for (const limit of limits) {
    const text = pace(limit, at)
    const key = `paced:${limit.kind}`
    if (text === undefined || (await $.store.get(key)) === limit.resetsAt) continue

    await $.store.set(key, limit.resetsAt)
    lines.push(`${label(limit.kind)} limit ${text}`)
  }

  return lines
}

/**
 * @return [String] a model id as people say it: `claude-opus-5-5[1m]` is "Opus 5.5 (1M)"
 */
function modelName(id: string): string {
  const match = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const family = match?.[1]
  if (family === undefined) return id

  const version = match?.[3] === undefined ? match?.[2] : `${match[2]}.${match[3]}`
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${version ?? ''}`.trim()

  return /\[1m\]/i.test(id) ? `${name} (1M)` : name
}

const modelFamily = (id: string) => /opus|sonnet|haiku|fable/i.exec(id)?.[0]?.toLowerCase() ?? id

const withEffort = (name: string, effort: Effort | undefined) =>
  effort === undefined ? name : `${name} · ${effort}`

/**
 * @return [String] the tool and the argument that says most about the call, `Read register.tsx`
 */
function doing(tool: string, input: Record<string, unknown>): string {
  const key = ARG_KEYS.find(k => typeof input[k] === 'string' && (input[k] as string).trim() !== '')
  if (key === undefined) return tool

  const arg = String(input[key]).replace(/\s+/g, ' ').trim()

  return `${tool} ${key === 'file_path' ? (arg.split('/').pop() ?? arg) : arg}`
}

/**
 * @return [Array<Agent>] the running agents, then the newest finished ones
 */
function kept(list: readonly Agent[]): Agent[] {
  const running = list.filter(a => a.isRunning)
  const finished = list.filter(a => !a.isRunning).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))

  return [...running, ...finished.slice(0, AGENTS_KEPT)]
}

const finish = ({ doing: _doing, ...agent }: Agent, at: number): Agent => ({ ...agent, isRunning: false, finishedAt: at })

function agentCounts(list: readonly Agent[]): string {
  const running = list.filter(a => a.isRunning).length
  const finished = list.length - running

  return [running > 0 ? `${running} running` : '', finished > 0 ? `${finished} done` : ''].filter(Boolean).join(' · ')
}

async function noteStep($: EngineInterface, e: TurnStepInput): Promise<void> {
  const ran = e.effort === undefined ? { model: e.model } : { model: e.model, effort: e.effort }
  const id = e.agentId

  if (id === undefined) {
    const last = await read($, model)
    if (last?.model !== ran.model || last.effort !== e.effort) await update($, model, () => ran)
    return
  }

  await update($, agents, list => list.map(a => (a.id === id ? { ...a, ...ran } : a)))
}

const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text

function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const tone = (percent: number, warnAt: number, alarmAt: number) =>
  percent >= alarmAt ? 'error' : percent >= warnAt ? 'warning' : 'success'

type RawRoutine = {
  id?: string
  name?: string
  enabled?: boolean
  next_run_at?: string
  last_run?: { status?: string; fired_at?: string } | null
}

/**
 * @return [Array<Routine>, undefined] the routines in a RemoteTrigger list answer, enabled ones
 *   by next run first, or undefined when the answer holds no listing
 */
function parseRoutines(text: string): Routine[] | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return undefined

  try {
    const body = JSON.parse(text.slice(start, end + 1)) as { data?: RawRoutine[] }
    if (!Array.isArray(body.data)) return undefined

    const items = body.data.map(raw => ({
      id: raw.id ?? '',
      name: raw.name ?? raw.id ?? 'routine',
      isEnabled: raw.enabled === true,
      nextRunAt: raw.next_run_at,
      lastFiredAt: raw.last_run?.fired_at,
      lastStatus: raw.last_run?.status?.replace('ROUTINE_RUN_STATUS_', '').toLowerCase(),
    }))

    return items.sort(
      (a, b) =>
        Number(b.isEnabled) - Number(a.isEnabled) ||
        (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''),
    )
  } catch {
    return undefined
  }
}

async function refreshRoutines($: EngineInterface): Promise<void> {
  const ran = await $.tool.call({ tool: 'RemoteTrigger', action: 'list' })
  const fetchedAt = await $.clock.now()
  const items = ran.deny === undefined && ran.isError !== true ? parseRoutines(ran.text ?? '') : undefined
  const error = ran.deny ?? fit(ran.text ?? 'no answer', 120)

  await update($, routines, last =>
    items ? { fetchedAt, items } : { fetchedAt, items: last?.items ?? [], error },
  )
}

function parsePlan(path: string, text: string): Plan {
  const heading = /^#[ \t]+(.+)$/m.exec(text)?.[1] ?? path.split('/').pop() ?? path
  const title = heading.replace(/`/g, '').replace(/\s+implementation plan$/i, '').trim()
  const project = /([^/]+)\/docs\/superpowers\/plans\//.exec(path)?.[1]
  const tasks = [...text.matchAll(TASK_HEADING)].map(match => ({
    n: Number(match[1] ?? 0),
    title: (match[2] ?? '').replace(/`/g, '').trim(),
    status: 'todo' as TaskStatus,
  }))

  return { path, title: project ? `${project} · ${title}` : title, tasks }
}

async function loadPlan($: EngineInterface, path: string): Promise<void> {
  const fresh = parsePlan(path, await $.fs.read(path))
  if (fresh.tasks.length === 0) return

  const saved = ((await $.store.get(storeKey(path))) ?? {}) as Record<string, unknown>

  await update($, plan, last => ({
    ...fresh,
    tasks: fresh.tasks.map(task => {
      const kept = last?.path === path ? last.tasks.find(t => t.n === task.n)?.status : undefined
      const stored = saved[String(task.n)]

      return { ...task, status: kept ?? (isStatus(stored) ? stored : 'todo') }
    }),
  }))
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, clock, () => at)
}

async function seed($: EngineInterface, mode: StatusMode): Promise<void> {
  const { context, rateLimits } = await $.session.usage()
  const seeded = toUsage(context, rateLimits)
  await update($, usage, () => seeded)
  $.ui.status(statusText(seeded, mode))
  await tick($)
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'Open the session deck: context, limits, plan progress and scheduled tasks',
    })
    await $.tool.register({
      name: 'plan_progress',
      description: PLAN_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'integer', description: "N from the plan's '### Task N:' heading" },
          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        },
        required: ['task', 'status'],
      },
      isDeferred: false,
    })

    await seed($, settings.statusLine)

    if (e.isInteractive) {
      $.clock.every(60_000, () => void tick($))
      $.clock.every(ROUTINE_REFRESH_MS, () => void refreshRoutines($))
      $.clock.after(0, () => void refreshRoutines($))
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await seed($, settings.statusLine)
      $.clock.after(0, () => void refreshRoutines($))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'deck' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(0, () => void refreshRoutines($))

    return { text: opened.isPlaced ? 'Session deck opened.' : `Session deck waits: ${opened.reason}` }
  })

  on('session.measure', async ($, e, next) => {
    const before = await read($, usage)
    const after = toUsage(e.context, e.rateLimits)
    const at = await $.clock.now()

    await update($, usage, () => after)
    $.ui.status(statusText(after, settings.statusLine))
    if (reachedHandoff(before, after, settings)) await update($, nudge, () => 'due')

    const paced = await paceAlerts($, after.limits, at).catch(() => [])
    const lines = [...alerts(before, after, at, settings), ...paced]
    for (const line of lines) $.ui.toast(line, { timeoutMs: 8000 })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || (await read($, nudge)) !== 'due') return next(e)

    const percent = (await read($, usage))?.percent
    await update($, nudge, () => 'sent')

    return next({ ...e, context: [...(e.context ?? []), handoffNote(percent, settings.handoffAt)] })
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await noteStep($, e).catch(() => undefined)

    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      const row: Agent = {
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description,
        model: spawned.model,
        isRunning: true,
      }
      await update($, agents, list => kept([row, ...list.filter(a => a.id !== row.id)]))
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, agents, list => kept(list.map(a => (a.id === e.agent_id ? finish(a, at) : a))))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId

    if (id !== undefined) {
      const now = doing(e.tool, e as Record<string, unknown>)
      await update($, agents, list => list.map(a => (a.id === id && a.isRunning ? { ...a, doing: now } : a))).catch(
        () => undefined,
      )
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    await update($, wakeups, () => ({
      crons: (e.session_crons ?? []).map(c => ({
        id: c.id,
        schedule: c.schedule,
        isRecurring: c.recurring,
        prompt: c.prompt,
      })),
      jobs: (e.background_tasks ?? []).map(t => ({
        id: t.id,
        type: t.type,
        status: t.status,
        description: t.description,
      })),
    }))

    return next(e)
  })

  on('tool.call', { tool: ['Read', 'Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && PLAN_FILE.test(e.file_path)) {
      await loadPlan($, e.file_path).catch(() => undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'RemoteTrigger' }, async ($, e, next) => {
    const ran = await next(e)

    if (e.action === 'list' && e.cursor === undefined && ran.deny === undefined && ran.isError !== true) {
      const items = parseRoutines(ran.text ?? '')
      const fetchedAt = await $.clock.now()
      if (items) await update($, routines, () => ({ fetchedAt, items }))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'RemoteTrigger' }, ($, e, next) =>
    next.origin.plugin === $.plugin.name && (e.input as { action?: unknown }).action === 'list'
      ? { decision: 'allow', reason: 'session-deck reads the routine list' }
      : next(e),
  ).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { task, status } = e as { task?: unknown; status?: unknown }
    const current = await read($, plan)

    if (current === null) {
      return { deny: 'No plan is loaded. Read the docs/superpowers/plans/*.md file first.' }
    }
    if (!isStatus(status) || !current.tasks.some(t => t.n === task)) {
      const numbers = current.tasks.map(t => t.n).join(', ')
      return { deny: `Pass task as one of ${numbers} and status as todo, doing or done.` }
    }

    const marked = { ...current, tasks: current.tasks.map(t => (t.n === task ? { ...t, status } : t)) }
    await update($, plan, () => marked)
    await $.store.set(storeKey(marked.path), Object.fromEntries(marked.tasks.map(t => [t.n, t.status])))
    const done = marked.tasks.filter(t => t.status === 'done').length

    return { result: `${marked.title}: ${done} of ${marked.tasks.length} tasks done.` }
  }).catch(() => ({ deny: 'session-deck could not record that; carry on without it.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [u, r, w, p, m, a, ticked] = await Promise.all([
      read($, usage),
      read($, routines),
      read($, wakeups),
      read($, plan),
      read($, model),
      read($, agents),
      read($, clock),
    ])
    const at = ticked || (await $.clock.now())
    const cols = e.props.bodyColumns
    const barWidth = Math.max(6, Math.min(24, cols - 30))

    const heading = (text: string) => (
      <Box marginTop={1}>
        <Text weight="bold">{text}</Text>
      </Box>
    )

    const done = p?.tasks.filter(t => t.status === 'done').length ?? 0
    const firstOpen = Math.max(0, p?.tasks.findIndex(t => t.status !== 'done') ?? 0)
    const planStart = p && p.tasks.length > PLAN_ROWS ? Math.max(0, Math.min(firstOpen - 1, p.tasks.length - PLAN_ROWS)) : 0
    const planRows = p?.tasks.slice(planStart, planStart + PLAN_ROWS) ?? []
    const planRest = (p?.tasks.length ?? 0) - planStart - planRows.length

    return (
      <Box flexDirection="column">
        <Text weight="bold">Model</Text>
        {m === null ? <Text dimColor>No reply yet</Text> : <Text>{withEffort(modelName(m.model), m.effort)}</Text>}

        {heading('Context')}
        {u?.percent === undefined ? (
          <Text dimColor>No reading yet</Text>
        ) : (
          <Text>
            <Text color={tone(u.percent, settings.warnAt, settings.handoffAt)}>{bar(u.percent, barWidth)}</Text>{' '}
            {u.percent}%<Text dimColor>  handoff at {settings.handoffAt}%</Text>
          </Text>
        )}

        {heading('Limits')}
        {(u?.limits.length ?? 0) === 0 && <Text dimColor>No reading yet</Text>}
        {(u?.limits ?? []).map(l => {
          const ahead = pace(l, at)

          return (
            <Box flexDirection="column">
              <Text>
                {label(l.kind).padEnd(3)}{' '}
                <Text color={tone(l.percentUsed, LIMIT_WARN_AT, LIMIT_ALARM_AT)}>{bar(l.percentUsed, barWidth)}</Text>{' '}
                {Math.round(l.percentUsed)}%
                {l.resetsAt !== undefined && <Text dimColor>  resets {relative(l.resetsAt, at)}</Text>}
              </Text>
              {ahead !== undefined && <Text color="warning">    {ahead}</Text>}
            </Box>
          )
        })}

        {heading('Plan')}
        {p === null ? (
          <Text dimColor>None yet. Opening a docs/superpowers/plans file loads it.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>{fit(p.title, cols)}</Text>
            <Text dimColor>
              {done} of {p.tasks.length} done
            </Text>
            {planStart > 0 && <Text dimColor>  … {planStart} done above</Text>}
            {planRows.map(t => (
              <Text dimColor={t.status === 'todo'}>
                <Text color={t.status === 'done' ? 'success' : t.status === 'doing' ? 'claude' : undefined}>
                  {t.status === 'done' ? '✓' : t.status === 'doing' ? '▸' : '·'}
                </Text>{' '}
                {fit(`${t.n} ${t.title}`, cols - 2)}
              </Text>
            ))}
            {planRest > 0 && <Text dimColor>  … {planRest} more</Text>}
          </Box>
        )}

        {heading('Agents')}
        <Text dimColor>{a.length === 0 ? 'None this session' : agentCounts(a)}</Text>
        {a.map(agent => {
          const runsOn = agent.model === undefined ? undefined : withEffort(modelFamily(agent.model), agent.effort)
          const when = agent.isRunning ? '' : `${span(Math.max(0, at - (agent.finishedAt ?? at)))} ago`
          const room = Math.max(8, cols - agent.type.length - (runsOn?.length ?? 0) - when.length - 6)
          const isCostly = COSTLY_MODEL.test(agent.model ?? '')

          return (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text>
                  <Text color={agent.isRunning ? 'claude' : 'success'}>{agent.isRunning ? '▸' : '✓'}</Text> {agent.type}{' '}
                  {runsOn !== undefined && (
                    <Text color={isCostly ? 'warning' : undefined} dimColor={!isCostly}>
                      {runsOn}
                    </Text>
                  )}{' '}
                  {fit(agent.description, room)}
                </Text>
                {when !== '' && <Text dimColor>{when}</Text>}
              </Box>
              {agent.isRunning && agent.doing !== undefined && <Text dimColor>  ↳ {fit(agent.doing, cols - 4)}</Text>}
            </Box>
          )
        })}

        {heading('Scheduled here')}
        {w.crons.length === 0 && w.jobs.length === 0 && <Text dimColor>No crons, wakeups or background jobs</Text>}
        {w.crons.map(c => (
          <Text>
            {c.isRecurring ? '⟳' : '◷'} <Text dimColor>{c.schedule}</Text> {fit(c.prompt, Math.max(8, cols - c.schedule.length - 3))}
          </Text>
        ))}
        {w.jobs.map(j => (
          <Text>
            <Text dimColor>{j.type} {j.status}</Text> {fit(j.description, Math.max(8, cols - j.type.length - j.status.length - 3))}
          </Text>
        ))}

        {heading('Routines')}
        {r === null && <Text dimColor>Checking…</Text>}
        {r?.error !== undefined && <Text color="warning">{fit(`Not refreshed: ${r.error}`, cols)}</Text>}
        {r?.items.map(item => {
          const glyph = !item.isEnabled ? ' ' : item.lastStatus === 'succeeded' ? '✓' : item.lastStatus === 'failed' ? '✗' : item.lastStatus === undefined ? '·' : '◌'
          const when = item.isEnabled && item.nextRunAt ? relative(item.nextRunAt, at) : 'off'

          return (
            <Box justifyContent="space-between">
              <Text dimColor={!item.isEnabled}>
                <Text color={glyph === '✗' ? 'error' : glyph === '✓' ? 'success' : undefined}>{glyph}</Text>{' '}
                {fit(item.name, Math.max(8, cols - when.length - 3))}
              </Text>
              <Text dimColor>{when}</Text>
            </Box>
          )
        })}
        {r !== null && r.items.length > 0 && <Text dimColor>checked {span(Math.max(0, at - r.fetchedAt))} ago</Text>}
      </Box>
    )
  })
}
