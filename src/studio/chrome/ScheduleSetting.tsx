/**
 * The task schedule picker in the settings (SPEC §10.6, ARCHITECTURE §11.3): round-robin, or the
 * random policy with a seed and a quantum, so a program with tasks can be run again under another
 * interleaving. "Next seed" moves to the next schedule seed.
 */
import { useId } from 'react'
import { MAX_SCHEDULE_SEED, MAX_SETTINGS_QUANTUM } from '../state/defaults'
import type { StudioSchedule } from '../state/types'

export function ScheduleSetting(props: {
  readonly value: StudioSchedule
  readonly onChange: (schedule: StudioSchedule) => void
}) {
  const { value, onChange } = props
  const seedId = useId()
  const quantumId = useId()
  const random = value.policy === 'random'
  const number = (text: string, min: number, max: number, fallback: number): number => {
    const parsed = text.trim() === '' ? Number.NaN : Math.floor(Number(text))
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  }
  return (
    <fieldset className="ch-group">
      <legend className="ch-label">Task schedule</legend>
      <div className="ch-group-body">
        <label className="ch-choice">
          <input
            type="radio"
            name="ch-schedule"
            checked={!random}
            onChange={() => onChange({ ...value, policy: 'round-robin' })}
          />
          <span>Round-robin</span>
        </label>
        <label className="ch-choice">
          <input
            type="radio"
            name="ch-schedule"
            checked={random}
            onChange={() => onChange({ ...value, policy: 'random' })}
          />
          <span>Random</span>
        </label>
      </div>
      {random && (
        <div className="ch-schedule-fields">
          <label htmlFor={seedId} className="ch-note">
            Seed
          </label>
          <input
            id={seedId}
            className="ch-number"
            type="number"
            min={0}
            max={MAX_SCHEDULE_SEED}
            value={value.seed}
            onChange={(event) =>
              onChange({
                ...value,
                seed: number(event.target.value, 0, MAX_SCHEDULE_SEED, value.seed),
              })
            }
          />
          <label htmlFor={quantumId} className="ch-note">
            Quantum
          </label>
          <input
            id={quantumId}
            className="ch-number"
            type="number"
            min={1}
            max={MAX_SETTINGS_QUANTUM}
            value={value.quantum}
            onChange={(event) =>
              onChange({
                ...value,
                quantum: number(event.target.value, 1, MAX_SETTINGS_QUANTUM, value.quantum),
              })
            }
          />
          <button
            type="button"
            className="ch-button"
            onClick={() => onChange({ ...value, seed: (value.seed + 1) % (MAX_SCHEDULE_SEED + 1) })}
          >
            Next seed
          </button>
        </div>
      )}
      <p className="ch-note">
        {random
          ? 'Tasks are preempted at random; the same seed gives the same run'
          : 'A task runs until it waits, yields or ends'}
      </p>
    </fieldset>
  )
}
