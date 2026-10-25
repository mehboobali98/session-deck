import type { SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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

test('context and limits show as bars, with a toast past the handoff mark', async ($, on) => {
  mock.clock(on, { now: NOW })
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
