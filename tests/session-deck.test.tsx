import type { On, SessionMeasureInput, TurnStepInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const PLAN_PATH = '/work/acme-cli/docs/superpowers/plans/2026-10-23-demo.md'
const PLAN = [
  '# `/demo` Implementation Plan',
  '',
  '### Task 0: Spike one recorded scene',
  '- [ ] step',
  '### Task 1: `lib.mjs` pure functions',
  '### Task 2: Dry run on a real ticket',
].join('\n')
const ROUTINES = `HTTP 200\n${JSON.stringify({
  data: [
    {
      id: 'trig_old',
      name: 'rehearsal (delete me)',
      enabled: false,
      next_run_at: '2026-10-21T14:07:20Z',
      last_run: { status: 'ROUTINE_RUN_STATUS_SUCCEEDED' },
    },
    {
      id: 'trig_digest',
      name: 'Daily digest',
      enabled: true,
      next_run_at: '2026-10-26T04:00:00Z',
      last_run: { status: 'ROUTINE_RUN_STATUS_FAILED', fired_at: '2026-10-23T04:05:51Z' },
    },
  ],
})}`

const PANE = {
  plugin: 'session-deck',
  component: 'Pane',
  requestId: 'session-deck',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'Find where session-deck keeps its settings',
  description: 'find session-deck files',
  subagentType: 'scout',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

const answerSteps = (on: On) =>
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

async function runStep($: Engine, e: Pick<TurnStepInput, 'model' | 'effort' | 'agentId'>) {
  const stream = $.turn.step({ turnId: 't1', index: 0, messageCount: 3, ...e })
  for await (const _ of stream);
  return stream.result
}

const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()

test('context and limits show as bars, with a toast past the handoff mark', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  const lines: (string | undefined)[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1_000_000, tokens: 520_000, percent: 52 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 81.5, resetsAt: '2026-10-25T14:30:00Z' },
      { kind: 'seven_day', percentUsed: 40 },
    ],
    changed: ['context', 'rateLimits'],
  })

  expect(lines.at(-1)).toBe('ctx 52% · 5h 82% · 7d 40%')
  expect(toasts).toEqual([
    'Context at 52%: write the handoff before starting anything new',
    '5h limit at 81.5%, resets in 2h 30m',
    '5h limit runs out in ~34m at this pace, 1h 56m before reset',
  ])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /handoff at 50%/ }))?.text).toContain('52%')
    expect((await ui.find({ type: 'Text', text: /^5h/ }))?.text).toContain('82%')
    await ui.unmount()
  }
})

test('reading a plan loads its tasks, and plan_progress marks them', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('fs.read', () => ({ value: PLAN }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const marked = await $.tool.call({ tool: 'mcp__session-deck__plan_progress', task: 1, status: 'done' })
  await $.tool.call({ tool: 'mcp__session-deck__plan_progress', task: 2, status: 'doing' })

  expect(marked.result).toBe('acme-cli · /demo: 1 of 3 tasks done.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'acme-cli · /demo' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 of 3 done' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /2 Dry run/ }))?.text).toContain('▸')
    await ui.unmount()
  }
})

test('a plan read in a later session keeps the progress stored for it', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { [`plan:${PLAN_PATH}`]: { 0: 'done', 1: 'done' } })
  on('fs.read', () => ({ value: PLAN }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '2 of 3 done' })).toBeDefined()
  await ui.unmount()
})

test('plan_progress refuses a task the plan does not have', async ($, on) => {
  mock.store(on)
  on('fs.read', () => ({ value: PLAN }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const refused = await $.tool.call({ tool: 'mcp__session-deck__plan_progress', task: 9, status: 'done' })

  expect(refused.deny).toBe('Pass task as one of 0, 1, 2 and status as todo, doing or done.')
})

test('a routine listing shows enabled routines first with their next run and last result', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: {}, text: ROUTINES }))

  await $.tool.call({ tool: 'RemoteTrigger', action: 'list' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const daily = await ui.find({ type: 'Text', text: /Daily digest/ })
    expect(daily?.text).toContain('✗')
    expect(await ui.find({ type: 'Text', text: 'in 16h 0m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'off' })).toBeDefined()
    await ui.unmount()
  }
})

test('crons and wakeups from the end of a turn are listed', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('classic.Stop', () => ({}))

  await $.classic.Stop({
    stop_hook_active: false,
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check the deploy' }],
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /check the deploy/ }))?.text).toContain('⟳')
  expect((await ui.find({ type: 'Text', text: /npm test/ }))?.text).toContain('shell running')
  await ui.unmount()
})

test('the model and effort of the latest main request show under Model', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSteps(on)

  await runStep($, { model: 'claude-opus-5-5[1m]', effort: 'xhigh' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5 (1M) · xhigh' })).toBeDefined()
    await ui.unmount()
  }
})

test('a running subagent shows its type, model, effort, task and current tool', async ($, on) => {
  mock.clock(on, { now: NOW })
  answerSteps(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))

  await $.agent.spawn(SPAWN)
  await runStep($, { model: 'claude-haiku-5-5', effort: 'low', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: '/work/acme-cli/hooks/register.tsx', agentId: 'a1' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = (await ui.find({ type: 'Text', text: /scout/ }))?.text
    expect(row).toContain('▸')
    expect(row).toContain('haiku · low')
    expect(row).toContain('find session-deck files')
    expect(await ui.find({ type: 'Text', text: /↳ Read register.tsx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 running' })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished subagent stays listed with how long ago it finished', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('classic.SubagentStop', () => ({}))

  await $.agent.spawn(SPAWN)
  await $.classic.SubagentStop({
    stop_hook_active: false,
    agent_id: 'a1',
    agent_type: 'scout',
    agent_transcript_path: '/tmp/a1.jsonl',
  })
  await clock.advance(4 * 60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /scout/ }))?.text).toContain('✓')
  expect(await ui.find({ type: 'Text', text: '4m ago' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 done' })).toBeDefined()
  await ui.unmount()
})

test('a subagent running on Opus is drawn in the warning color', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))

  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const marks = await ui.findAll({ type: 'Text', text: 'opus' })
  expect(marks.some(mark => mark.props.color === 'warning')).toBe(true)
  await ui.unmount()
})

test('a limit on pace to run out before its reset says when, with one toast per window', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const week = (percentUsed: number): SessionMeasureInput => ({
    context: { window: 1_000_000, tokens: 50_000, percent: 5 },
    rateLimits: [{ kind: 'seven_day', percentUsed, resetsAt: inHours(100) }],
    changed: ['rateLimits'],
  })

  await $.session.measure(week(85))
  await $.session.measure(week(86))

  expect(toasts.filter(t => t.includes('at this pace'))).toEqual([
    '7d limit runs out in ~12h 0m at this pace, 3d 16h before reset',
  ])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /at this pace/ }))?.text).toContain('before reset')
  await ui.unmount()
})

test('a store that cannot be read still leaves the other toasts', async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1_000_000, tokens: 50_000, percent: 5 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 85, resetsAt: inHours(100) }],
    changed: ['rateLimits'],
  })

  expect(toasts).toEqual(['7d limit at 85%, resets in 4d 4h'])
})

test('no forecast early in a window or for a limit that lasts to its reset', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1_000_000, tokens: 50_000, percent: 5 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 10, resetsAt: inHours(4.5) },
      { kind: 'seven_day', percentUsed: 20, resetsAt: inHours(100) },
    ],
    changed: ['rateLimits'],
  })

  expect(toasts.filter(t => t.includes('at this pace'))).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /at this pace/ })).toBeUndefined()
  await ui.unmount()
})

test('a /clear puts the status line and routines back for the new session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const lines: (string | undefined)[] = []
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1_000_000, tokens: 0 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 85 }],
    },
  }))
  on('tool.call', () => ({ result: {}, text: ROUTINES }))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'clear' })
  await clock.settle()

  expect(lines).toEqual(['7d 85%'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Daily digest/ })).toBeDefined()
  await ui.unmount()
})

const MEASURE: SessionMeasureInput = {
  context: { window: 1_000_000, tokens: 620_000, percent: 62 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 30 }],
  changed: ['context', 'rateLimits'],
}

const COMPOSER = { kind: 'composer' } as const

const NUDGE =
  'session-deck: context is at 62%, past the 50% handoff mark. ' +
  'Tell the person, finish the step in hand, then prepare the handoff before starting anything new.'

test('crossing the handoff mark adds a note for Claude to the next prompt, once', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.session.measure(MEASURE)
  const first = await $.prompt.submit({ text: 'next step', wait: false, origin: COMPOSER })
  const second = await $.prompt.submit({ text: 'and then', wait: false, origin: COMPOSER })

  expect(first.context).toEqual([NUDGE])
  expect(second.context).toBeUndefined()
})

test('the early warning alone adds no note for Claude', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  await $.session.measure({ ...MEASURE, context: { window: 1_000_000, tokens: 420_000, percent: 42 } })
  const sent = await $.prompt.submit({ text: 'next step', wait: false, origin: COMPOSER })

  expect(sent.context).toBeUndefined()
})

test('the handoff mark comes from the settings', { options: { handoffAt: 70 } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure(MEASURE)

  expect(toasts).toEqual(['Context at 62%: aim for a clean stopping point by 70%'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /handoff at 70%/ })).toBeDefined()
  await ui.unmount()
})

for (const [statusLine, expected] of [
  ['limits', '5h 30%'],
  ['off', undefined],
] as const) {
  test(`the status line setting ${statusLine} shows ${expected ?? 'nothing'}`, { options: { statusLine } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const lines: (string | undefined)[] = []
    on('ui.toast', () => ({ value: undefined }))
    on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.measure(MEASURE)

    expect(lines).toEqual([expected])
  })
}
