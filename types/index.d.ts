export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = { percent?: number; window: number; limits: Limit[] }

export type Routine = {
  id: string
  name: string
  isEnabled: boolean
  nextRunAt?: string
  lastFiredAt?: string
  lastStatus?: string
}

export type Routines = { fetchedAt: number; items: Routine[]; error?: string }

export type Cron = { id: string; schedule: string; isRecurring: boolean; prompt: string }

export type Job = { id: string; type: string; status: string; description: string }

export type Wakeups = { crons: Cron[]; jobs: Job[] }

export type TaskStatus = 'todo' | 'doing' | 'done'

export type PlanTask = { n: number; title: string; status: TaskStatus }

export type Plan = { path: string; title: string; tasks: PlanTask[] }

declare module 'claude-code' {
  interface PluginState {
    'session-deck': {
      usage: Shaped<Usage | null>
      routines: Shaped<Routines | null>
      wakeups: Shaped<Wakeups>
      plan: Shaped<Plan | null>
      now: number
    }
  }
}
