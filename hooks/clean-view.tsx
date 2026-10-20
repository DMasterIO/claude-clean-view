import { atom, read, update } from 'claude-code'
import type { On, RenderElement } from 'claude-code'

import type { Checklist, Phase, Task } from '../types'

const PLUGIN = 'clean-view'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const PROGRESS_TOOL = 'mcp__clean-view__report_progress'

const MAX_NAME = 40
const FALLBACK_NAME = 'Working on it'
const DEFAULT_TITLE = 'Working on your request'
const WAIT_REASON = 'Claude is waiting for your reply'
const CELLS = 10
const COLLAPSE_MS = 5000
const FRAME_MS = 250
const FAILURE_LIMIT = 3
const GATE_MESSAGE =
  'Clean View: call plan_steps first (load it with ToolSearch if it is deferred) with 2 to 8 short plain-English step names, then retry this tool.'
const ALWAYS_ALLOWED = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
])

const EMPTY: Checklist = {
  title: '',
  phase: 'idle',
  tasks: [],
  needsYouReason: null,
  stuckReason: null,
  startedAt: 0,
  finishedAt: null,
  isCollapsed: false,
}

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, EMPTY)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const PROMPT_SECTION = `# Clean View

The person is using Clean View: tool calls are hidden and a checklist above the prompt shows your plan and progress. Keep it accurate.

- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- For every request, even a quick question, call plan_steps first (mcp__clean-view__plan_steps; load it with ToolSearch if it is deferred). Then call report_progress as real progress happens, and with percent 100 the moment a step finishes.
- If the session has TodoWrite or TaskCreate, you can use its to-do list as the plan instead.`

const CODE_EXTENSIONS =
  'tsx?|jsx?|mjs|cjs|rb|py|json|ya?ml|md|erb|css|scss|html?|sh|go|rs|java|php|sql|toml|lock|cpp|c|h|vue|svelte|kt|swift'
const FILE_NAME = new RegExp(`\\b[\\w.-]+\\.(?:${CODE_EXTENSIONS})\\b`, 'gi')

type Dollar = Parameters<Parameters<On>[2]>[0]

/** Limpia un nombre de paso: sin codigo, rutas ni archivos; max 40 caracteres. */
export function cleanName(raw: string): string {
  let text = raw
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .replace(FILE_NAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s,;:([{"'-]+$/, '')

  if (text.length > MAX_NAME) {
    const cut = text.slice(0, MAX_NAME - 1)
    const space = cut.lastIndexOf(' ')
    text = `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
  }
  if (text === '' || text === '…') return FALLBACK_NAME

  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function meter(percent: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * CELLS)

  return '█'.repeat(filled) + '░'.repeat(CELLS - filled)
}

export function sweep(frame: number): string {
  const start = (frame % (CELLS + 3)) - 2

  return Array.from({ length: CELLS }, (_, i) => (i >= start && i < start + 3 ? '█' : '░')).join('')
}

const isPlaceholder = (task: Task) => task.id.startsWith('ph-')
const isRunning = (phase: Phase) => phase === 'working' || phase === 'needs-you' || phase === 'stuck'
const hasRealPlan = (c: Checklist) => c.tasks.some(task => !isPlaceholder(task))

const makeTask = (id: string, name: string, status: Task['status']): Task => ({
  id,
  name: cleanName(name),
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: status === 'done',
})

/** Deja exactamente un paso activo: el primero que no esta hecho. */
function normalize(tasks: Task[]): Task[] {
  let hasActive = false

  return tasks.map(task => {
    if (task.status === 'done') return task
    if (!hasActive) {
      hasActive = true

      return task.status === 'active' ? task : { ...task, status: 'active' }
    }

    return task.status === 'upcoming' ? task : { ...task, status: 'upcoming', percent: 0 }
  })
}

const withoutPlaceholders = (tasks: Task[]) => tasks.filter(task => !isPlaceholder(task))

function startJob(now: number): Checklist {
  return {
    ...EMPTY,
    title: DEFAULT_TITLE,
    phase: 'working',
    startedAt: now,
    tasks: normalize([
      makeTask('ph-1', 'Understand your request', 'active'),
      makeTask('ph-2', 'Plan the steps', 'upcoming'),
    ]),
  }
}

function applyPlan(c: Checklist, steps: string[]): Checklist {
  const tasks = steps.map((name, i) => makeTask(`p${i + 1}`, name, i === 0 ? 'active' : 'upcoming'))

  return { ...c, tasks: normalize(tasks) }
}

function applyProgress(c: Checklist, taskName: string, rawPercent: number): Checklist {
  const name = cleanName(taskName)
  const percent = Number.isFinite(rawPercent) ? Math.min(100, Math.max(0, Math.round(rawPercent))) : 0
  let tasks = withoutPlaceholders(c.tasks)
  let index = tasks.findIndex(task => task.name.toLowerCase() === name.toLowerCase())

  if (index === -1) {
    tasks = [...tasks, makeTask(`x${tasks.length + 1}`, name, 'upcoming')]
    index = tasks.length - 1
  }

  const next = tasks.map((task, i) => {
    if (i < index) return task.status === 'done' ? task : { ...task, status: 'done' as const, percent: 100, hasReported: true }
    if (i === index) {
      return { ...task, status: percent >= 100 ? ('done' as const) : ('active' as const), percent, hasReported: true }
    }

    return task
  })

  return { ...c, tasks: normalize(next) }
}

const STATUS_FROM_TODO = {
  completed: 'done',
  in_progress: 'active',
  pending: 'upcoming',
} as const

function applyTodos(c: Checklist, todos: ReadonlyArray<{ content: string; status: string }>): Checklist {
  const tasks = todos.map((todo, i) =>
    makeTask(
      `todo-${i + 1}`,
      todo.content,
      STATUS_FROM_TODO[todo.status as keyof typeof STATUS_FROM_TODO] ?? 'upcoming',
    ),
  )
  // Conserva el avance ya reportado de los pasos que siguen en curso
  const merged = tasks.map(task => {
    const before = c.tasks.find(old => old.name === task.name)

    return before && task.status === 'active' && before.hasReported
      ? { ...task, percent: before.percent, hasReported: true }
      : task
  })

  return { ...c, tasks: normalize(merged) }
}

function applyTaskCreate(c: Checklist, id: string, subject: string): Checklist {
  const tasks = [...withoutPlaceholders(c.tasks), makeTask(`task-${id}`, subject, 'upcoming')]

  return { ...c, tasks: normalize(tasks) }
}

function applyTaskUpdate(c: Checklist, id: string, status: string | undefined): Checklist {
  if (status === undefined) return c
  if (status === 'deleted') {
    return { ...c, tasks: normalize(c.tasks.filter(task => task.id !== `task-${id}`)) }
  }
  const mapped = STATUS_FROM_TODO[status as keyof typeof STATUS_FROM_TODO]
  if (mapped === undefined) return c

  const tasks = c.tasks.map(task =>
    task.id === `task-${id}`
      ? { ...task, status: mapped, percent: mapped === 'done' ? 100 : task.percent, hasReported: mapped === 'done' || task.hasReported }
      : task,
  )

  return { ...c, tasks: normalize(tasks) }
}

const ERROR_REASONS: ReadonlyArray<[RegExp, string]> = [
  [/rate.?limit|usage limit|quota|429/i, 'you hit your usage limit, try again a little later'],
  [/overloaded|529|capacity|busy/i, "Claude's servers are busy, try again in a minute"],
  [/context|too long|too many tokens/i, 'type /compact and try again'],
  [/network|connection|ECONN|ENOTFOUND|fetch failed|socket|timed? ?out|offline/i, 'the internet connection dropped'],
  [/auth|401|403|api key|credential|login|token expired/i, 'type /login'],
]

export function describeError(answer: string): string {
  return ERROR_REASONS.find(([pattern]) => pattern.test(answer))?.[1] ?? 'something went wrong, try again'
}

const USER_SAID_NO = /user (doesn't|does not) want|rejected|denied|declined|permission .* (not|denied)/i

let clock: { cancel: () => void } | undefined
let failures = 0

function setChecklist($: Dollar, fn: (c: Checklist) => Checklist) {
  return update($, checklistAtom, fn)
}

/** El reloj de animacion solo corre mientras se trabaja o se espera al usuario. */
function syncClock($: Dollar, phase: Phase) {
  const isAnimated = phase === 'working' || phase === 'needs-you'
  if (isAnimated && clock === undefined) {
    clock = $.clock.every(FRAME_MS, () => {
      void update($, tickAtom, n => n + 1)
    })
  } else if (!isAnimated && clock !== undefined) {
    clock.cancel()
    clock = undefined
  }
}

async function setPhase($: Dollar, patch: Partial<Checklist> & { phase: Phase }) {
  const now = await $.clock.now()
  const finished = patch.phase === 'stopped' || patch.phase === 'done' || patch.phase === 'stuck'
  await setChecklist($, c => ({
    ...c,
    needsYouReason: null,
    stuckReason: null,
    finishedAt: finished ? now : null,
    ...patch,
  }))
  syncClock($, patch.phase)
}

async function ensureJob($: Dollar) {
  const c = await read($, checklistAtom)
  if (isRunning(c.phase)) return
  const now = await $.clock.now()
  await setChecklist($, () => ({ ...startJob(now), tasks: [] }))
  failures = 0
  syncClock($, 'working')
}

async function setEnabled($: Dollar, isOn: boolean) {
  await update($, enabledAtom, () => isOn)
  await $.store.set('enabled', isOn)
  $.ui.toast(isOn ? 'Clean View is on' : 'Clean View is off')
}

async function flip($: Dollar) {
  return setEnabled($, !(await read($, enabledAtom)))
}


async function nameJob($: Dollar, text: string, startedAt: number) {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 24,
      timeoutMs: 15000,
      system: 'You name jobs. Reply with only the name: 2 to 6 plain words, starting with a verb, no punctuation, no quotes.',
      prompt: `Name this job:\n\n${text.slice(0, 600)}`,
    })
    if (!reply.isAnswered) return
    const title = cleanName(reply.text.replace(/["'.\n]/g, ' ')).split(' ').slice(0, 6).join(' ')
    await setChecklist($, c => (c.startedAt === startedAt && title !== FALLBACK_NAME ? { ...c, title } : c))
  } catch {
    // El nombre es cosmetico: si falla, queda el titulo por defecto
  }
}


export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('enabled')
    if (typeof saved === 'boolean') await update($, enabledAtom, () => saved)

    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off',
      argumentHint: 'on|off',
    })
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front, 2 to 8 short plain-English names in order (no file paths, commands or code). The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step. percent is 0 to 100; use 100 the moment the step finishes and the next one starts.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, percent: { type: 'number' } },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!(await read($, enabledAtom))) return result

    return {
      sections: [...result.sections, { id: `${PLUGIN}:plan`, text: PROMPT_SECTION, scope: 'session' as const }],
    }
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    const c = await read($, checklistAtom)

    if (c.phase === 'needs-you' && c.needsYouReason === WAIT_REASON) {
      await setPhase($, { phase: 'working', needsYouReason: null })
    } else if (isRunning(c.phase)) {
      if (c.phase === 'needs-you') await setPhase($, { phase: 'working' })
    } else if (e.text.trim() !== '' && !e.text.trim().startsWith('/')) {
      const now = await $.clock.now()
      failures = 0
      await setChecklist($, () => startJob(now))
      syncClock($, 'working')

      const text = e.text
      $.clock.after(0, () => {
        void nameJob($, text, now)
      })
    }

    return result
  })

  on('classic.Notification', async ($, e, next) => {
    const c = await read($, checklistAtom)
    if ((c.phase === 'working' || c.phase === 'stuck') && e.notification_type !== 'idle_prompt') {
      const isPermission = e.notification_type === 'permission_prompt'
      await setPhase($, {
        phase: 'needs-you',
        needsYouReason: isPermission ? 'Claude needs your OK to continue' : 'Claude has a question for you',
      })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const tool = String(e.tool)
    const isOn = await read($, enabledAtom)
    let c = await read($, checklistAtom)

    if (isOn && !ALWAYS_ALLOWED.has(tool) && !hasRealPlan(c)) return { deny: GATE_MESSAGE }

    if (tool === PLAN_TOOL) {
      const input = e as unknown as { steps?: unknown }
      const steps = (Array.isArray(input.steps) ? input.steps : [])
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 8)
        .map(cleanName)
      if (steps.length === 0) return { deny: 'Give 2 to 8 short step names in plan_steps.' }

      await ensureJob($)
      await setChecklist($, current => applyPlan(current, steps))

      return { result: `Planned ${steps.length} steps. The first one has started.` }
    }

    if (tool === PROGRESS_TOOL) {
      const input = e as unknown as { task?: unknown; percent?: unknown }
      const percent = Number(input.percent)
      await ensureJob($)
      await setChecklist($, current => applyProgress(current, String(input.task ?? ''), percent))

      return { result: `Progress noted: ${Math.min(100, Math.max(0, Math.round(Number.isFinite(percent) ? percent : 0)))}%.` }
    }

    if (c.phase === 'needs-you' && c.needsYouReason !== WAIT_REASON) await setPhase($, { phase: 'working' })

    if (tool === 'AskUserQuestion') {
      await setPhase($, { phase: 'needs-you', needsYouReason: 'Claude has a question for you' })
    }

    const ran = await next(e)

    c = await read($, checklistAtom)
    if (c.phase === 'needs-you' && c.needsYouReason !== WAIT_REASON) await setPhase($, { phase: 'working' })

    const text = ran.deny ?? ran.text ?? ''
    const isFailure = ran.deny !== undefined || ran.isError === true

    if (isFailure) {
      if (USER_SAID_NO.test(String(text))) {
        await setPhase($, { phase: 'stuck', stuckReason: 'you said no to a step, so Claude paused' })
      } else {
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          await setPhase($, { phase: 'stuck', stuckReason: 'a step keeps failing, Claude is trying another way' })
        }
      }

      return ran
    }

    failures = 0
    if (c.phase === 'stuck') await setPhase($, { phase: 'working' })

    if (tool === 'TodoWrite') {
      const todos = (e as unknown as { todos?: ReadonlyArray<{ content: string; status: string }> }).todos ?? []
      await ensureJob($)
      await setChecklist($, current => applyTodos(current, todos))
    } else if (tool === 'TaskCreate') {
      const subject = String((e as unknown as { subject?: unknown }).subject ?? '')
      const id = String((ran.result as { task?: { id?: unknown } } | undefined)?.task?.id ?? '')
      await ensureJob($)
      await setChecklist($, current => applyTaskCreate(current, id, subject))
    } else if (tool === 'TaskUpdate') {
      const input = e as unknown as { taskId?: unknown; status?: string }
      await setChecklist($, current => applyTaskUpdate(current, String(input.taskId ?? ''), input.status))
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const c = await read($, checklistAtom)
    if (!isRunning(c.phase)) return result

    if (e.reason === 'aborted') {
      await setPhase($, { phase: 'stopped' })
    } else if (e.reason === 'error') {
      await setPhase($, { phase: 'stuck', stuckReason: describeError(e.answer) })
    } else if (e.reason === 'refusal') {
      await setPhase($, { phase: 'stuck', stuckReason: "Claude couldn't help with that request" })
    } else if (c.tasks.some(task => !isPlaceholder(task) && task.status !== 'done')) {
      await setPhase($, { phase: 'needs-you', needsYouReason: WAIT_REASON })
    } else {
      const now = await $.clock.now()
      await setChecklist($, current => ({
        ...current,
        tasks: current.tasks.map(task => ({ ...task, status: 'done' as const, percent: 100, hasReported: true })),
      }))
      await setPhase($, { phase: 'done' })
      $.clock.after(COLLAPSE_MS, () => {
        void setChecklist($, current =>
          current.phase === 'done' && current.finishedAt !== null && current.finishedAt >= now
            ? { ...current, isCollapsed: true }
            : current,
        )
      })
    }

    return result
  })

  // Los comandos /simple se contestan aqui para no ocupar un turno
  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') await setEnabled($, true)
    else if (arg === 'off') await setEnabled($, false)
    else if (arg === '') await flip($)
    else return { text: 'Usage: /simple on|off' }

    return { text: (await read($, enabledAtom)) ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)

    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isOn = await read($, enabledAtom)
    const c = await read($, checklistAtom)
    const tick = await read($, tickAtom)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    const toggle = (
      <Button
        key="toggle"
        label={`● Clean View: ${isOn ? 'ON' : 'OFF'}`}
        variant={isOn ? 'primary' : 'secondary'}
        onPress={() => flip($)}
      />
    )

    if (!isOn) {
      const base = await next(e)

      return (
        <Box flexDirection="column">
          {base}
          <Box justifyContent="flex-end">{toggle}</Box>
        </Box>
      )
    }

    // Keep drawing what the plugins beneath draw (e.g. status-vitals) below the checklist.
    const below = await next(e)
    const stack = (view: RenderElement) => (
      <Box flexDirection="column">
        {view}
        {below}
      </Box>
    )

    const headerRow = (left: RenderElement) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1}>
          {left}
        </Box>
        <Box flexShrink={0}>{toggle}</Box>
      </Box>
    )

    if (c.phase === 'idle') return stack(headerRow(<Text> </Text>))

    const elapsed = formatDuration((c.finishedAt ?? now) - c.startedAt)

    if (c.phase === 'done' && c.isCollapsed) {
      return stack(
        headerRow(
          <Text wrap="truncate" color="green">{`✓ All done · ${c.title} · took ${elapsed}`}</Text>,
        ),
      )
    }

    const header =
      c.phase === 'needs-you' ? (
        <Text wrap="truncate">
          <Text inverse bold>{' Needs you '}</Text>
          {` ${c.needsYouReason ?? ''}`}
        </Text>
      ) : c.phase === 'stuck' ? (
        <Text wrap="truncate" color="yellow">{`⚠ Stuck: ${c.stuckReason ?? 'something went wrong'}`}</Text>
      ) : c.phase === 'stopped' ? (
        <Text wrap="truncate">{`■ Stopped · ${c.title} · you pressed Esc`}</Text>
      ) : c.phase === 'done' ? (
        <Text wrap="truncate" color="green" bold>{`✓ All done · ${c.title} · took ${elapsed}`}</Text>
      ) : (
        <Text wrap="truncate" bold>{`${c.title} · ${elapsed}`}</Text>
      )

    const nameWidth = Math.max(6, e.props.bodyColumns - 25)
    const firstUpcoming = c.tasks.findIndex(task => task.status === 'upcoming')

    const rows = c.tasks.map((task, i) => {
      const isActive = task.status === 'active'
      const icon =
        task.status === 'done' ? '✓' : isActive ? (c.phase === 'needs-you' ? '‖' : '▶') : '○'
      const bar =
        task.status === 'done'
          ? meter(100)
          : isActive
            ? task.hasReported
              ? meter(task.percent)
              : sweep(tick)
            : meter(0)
      const label =
        task.status === 'done'
          ? 'Done'
          : isActive
            ? task.hasReported
              ? `${task.percent}%`
              : 'Working'
            : i === firstUpcoming
              ? 'Next'
              : 'Up next'

      return (
        <Box key={`row-${task.id}`} flexDirection="row">
          <Text color={task.status === 'done' ? 'green' : isActive ? 'cyan' : undefined} dimColor={task.status === 'upcoming'}>
            {`${icon} `}
          </Text>
          <Box width={nameWidth} flexShrink={0}>
            <Text wrap="truncate" bold={isActive} dimColor={task.status !== 'active'}>
              {task.name}
            </Text>
          </Box>
          <Text dimColor={task.status !== 'active'}>{`  ${bar}  ${label}`}</Text>
        </Box>
      )
    })

    return stack(
      <Box flexDirection="column">
        {headerRow(header)}
        {rows}
      </Box>,
    )
  })
}
