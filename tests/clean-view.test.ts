import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cleanName } from '../hooks/clean-view'

const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
} as never

// Lo que el motor haria debajo del plugin: ejecutar la herramienta y dibujar el band por defecto
const engineBottom = (on: On) => {
  mock.clock(on)
  mock.store(on)
  on('tool.call', () => ({ result: {} as never }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('classic.Notification', () => ({}) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {} }) as never)
}

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const BAND_TARGET = { plugin: 'clean-view', component: 'AbovePrompt', props: BAND } as const
const labelsOf = async ($: Engine) => {
  const ui = await $.ui.mount({ ...BAND_TARGET, surface: 'terminal' })
  const texts = await ui.findAll({ type: 'Text' })
  return texts.map(t => t.text)
}

test('cleanName strips code, paths and files, and trims long names', ($, on) => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Build the pricing section in \\src/Pricing.tsx\\')).toBe('Build the pricing section in')
  expect(cleanName('fix app/models/user.rb and Pricing.tsx now')).toBe('Fix and now')
  expect(cleanName('   ')).toBe('Working on it')
  expect(cleanName('`code` /a/b')).toBe('Working on it')
  const long = cleanName('Build the very long pricing section for the new landing page today')
  expect(long.length <= 40).toBe(true)
  expect(long.endsWith('…')).toBe(true)
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  engineBottom(on)
  const planned = await call($, { tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  let labels = await labelsOf($)
  expect(labels.some(t => /Working/.test(t ?? ''))).toBe(true)
  expect(labels.some(t => /Done/.test(t ?? ''))).toBe(false)

  const noted = await call($, { tool: PROGRESS, task: 'Read your brand notes', percent: 100 })
  expect(noted.result).toBe('Progress noted: 100%.')
  labels = await labelsOf($)
  expect(labels.some(t => /Done/.test(t ?? ''))).toBe(true)
  expect(labels.some(t => /Working/.test(t ?? ''))).toBe(true)
  expect(labels.some(t => /Next/.test(t ?? ''))).toBe(true)
})

test('any tool is denied before a plan exists and allowed after', async ($, on) => {
  engineBottom(on)
  const denied = await call($, { tool: 'Bash', command: 'ls' })
  expect(typeof denied.deny).toBe('string')
  expect((await call($, { tool: 'ToolSearch', query: 'x', max_results: 1 })).deny).toBe(undefined)

  await call($, { tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
  expect((await call($, { tool: 'Bash', command: 'ls' })).deny).toBe(undefined)
})

for (const surface of SURFACES) {
  test(`to-do list plus 60% report renders the rows (${surface})`, async ($, on) => {
    engineBottom(on)
    await call($, {
      tool: 'TodoWrite',
      todos: [
        { content: 'Read your brand notes', status: 'completed', activeForm: 'x' },
        { content: 'Build the pricing section', status: 'in_progress', activeForm: 'x' },
        { content: 'Add the contact form', status: 'pending', activeForm: 'x' },
        { content: 'Polish the footer', status: 'pending', activeForm: 'x' },
      ],
    })
    await call($, { tool: PROGRESS, task: 'Build the pricing section', percent: 60 })

    const ui = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: 'Done' })).not.toBe(undefined)
    expect(await ui.find({ text: /60%/ })).not.toBe(undefined)
    expect(await ui.find({ text: 'Next' })).not.toBe(undefined)
    expect(await ui.find({ text: /Up next/ })).not.toBe(undefined)
    expect(await ui.find({ key: 'toggle' })).not.toBe(undefined)
  })

  test(`a permission prompt shows Needs you (${surface})`, async ($, on) => {
    engineBottom(on)
    await call($, { tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
    await $.classic.Notification({ message: 'Claude needs permission', notification_type: 'permission_prompt' })

    const ui = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /Needs you/ })).not.toBe(undefined)
    expect(await ui.find({ text: /needs your OK/ })).not.toBe(undefined)
  })

  test(`/simple off hides the band but keeps the button (${surface})`, async ($, on) => {
    engineBottom(on)
    await call($, { tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
    await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'composer' }, presentation: {} } as never)

    const ui = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: 'Read your brand notes' })).toBe(undefined)
    expect(await ui.find({ key: 'toggle' })).not.toBe(undefined)
    expect(await ui.find({ text: /OFF/ })).not.toBe(undefined)
  })
}
