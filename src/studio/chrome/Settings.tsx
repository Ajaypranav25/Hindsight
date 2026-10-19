import { useId, type ReactNode } from 'react'
import { formatSteps } from '../lib/format'
import { useStudio, useStudioActions } from '../state/context'
import { STEP_BUDGETS } from '../state/defaults'
import type { Settings as SettingsShape, ThemeSetting } from '../state/types'
import { SettingsIcon } from './icons'
import { usePopover } from './usePopover'

const THEMES: readonly { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

type ToggleKey = 'justMyCode' | 'autoRun' | 'instructionLevel'

const TOGGLES: readonly { key: ToggleKey; label: string; note: string }[] = [
  { key: 'justMyCode', label: 'Just my code', note: 'Skip library functions when stepping' },
  { key: 'autoRun', label: 'Auto-run', note: 'Record again shortly after each edit' },
  {
    key: 'instructionLevel',
    label: 'Instruction-level stepping',
    note: 'Show bytecode detail and step single instructions',
  },
]

/** The settings button and its popover. */
export function Settings() {
  const { open, toggle, rootRef, triggerRef } = usePopover()
  const panelId = useId()
  return (
    <div className="ch-anchor" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ch-button ch-icon-button"
        aria-label="Settings"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        <SettingsIcon />
      </button>
      {open && <SettingsPanel id={panelId} />}
    </div>
  )
}

function SettingsPanel(props: { id: string }) {
  const settings = useStudio((s) => s.settings)
  const { updateSettings } = useStudioActions()
  const update = (patch: Partial<SettingsShape>) => updateSettings(patch)
  return (
    <div id={props.id} className="ch-pop ch-settings-panel" role="dialog" aria-label="Settings">
      <Group legend="Step budget" note="Applies to the next run">
        {STEP_BUDGETS.map((budget) => (
          <Choice
            key={budget}
            name="ch-budget"
            label={`${formatSteps(budget)} steps`}
            checked={settings.maxSteps === budget}
            onSelect={() => update({ maxSteps: budget })}
          />
        ))}
      </Group>
      <Group legend="Stepping and runs" stacked>
        {TOGGLES.map((toggle) => (
          <label key={toggle.key} className="ch-check">
            <input
              type="checkbox"
              checked={settings[toggle.key]}
              onChange={(event) => update({ [toggle.key]: event.target.checked })}
            />
            <span>
              <span className="ch-check-label">{toggle.label}</span>
              <span className="ch-note">{toggle.note}</span>
            </span>
          </label>
        ))}
      </Group>
      <Group legend="Theme">
        {THEMES.map((theme) => (
          <Choice
            key={theme.value}
            name="ch-theme"
            label={theme.label}
            checked={settings.theme === theme.value}
            onSelect={() => update({ theme: theme.value })}
          />
        ))}
      </Group>
      <PlaybackSpeed
        value={settings.playbackSpeed}
        onChange={(playbackSpeed) => update({ playbackSpeed })}
      />
    </div>
  )
}

function Group(props: { legend: string; note?: string; stacked?: boolean; children: ReactNode }) {
  return (
    <fieldset className="ch-group">
      <legend className="ch-label">{props.legend}</legend>
      <div className={props.stacked ? 'ch-group-body ch-group-stacked' : 'ch-group-body'}>
        {props.children}
      </div>
      {props.note && <p className="ch-note">{props.note}</p>}
    </fieldset>
  )
}

function Choice(props: { name: string; label: string; checked: boolean; onSelect: () => void }) {
  return (
    <label className="ch-choice">
      <input type="radio" name={props.name} checked={props.checked} onChange={props.onSelect} />
      <span>{props.label}</span>
    </label>
  )
}

function PlaybackSpeed(props: { value: number; onChange: (value: number) => void }) {
  const id = useId()
  return (
    <div className="ch-group">
      <label className="ch-label" htmlFor={id}>
        Playback speed
      </label>
      <div className="ch-speed">
        <input
          id={id}
          type="range"
          min={1}
          max={60}
          step={1}
          value={props.value}
          aria-valuetext={`${props.value} statements per second`}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />
        <output htmlFor={id} className="ch-speed-value">
          {props.value}/s
        </output>
      </div>
      <p className="ch-note">Statements per second while playing</p>
    </div>
  )
}
