import { describe, expect, it } from 'vitest'
import { EDIT_MODE_MAX_TOOL_STEPS, MODEL_PRESET_MAX_TOOL_STEPS, maxToolStepsFor } from './toolSteps'

describe('tool rounds per request (2026-11-08)', () => {
    it('gives the bot edit mode\'s tools more rounds than other tools', () => {
        expect(maxToolStepsFor([{ name: 'roll-dice' }])).toBe(MODEL_PRESET_MAX_TOOL_STEPS)
        expect(maxToolStepsFor([])).toBe(MODEL_PRESET_MAX_TOOL_STEPS)
        expect(maxToolStepsFor([{ name: 'roll-dice' }, { name: 'risu-get-character-lorebook' }])).toBe(EDIT_MODE_MAX_TOOL_STEPS)
        expect(EDIT_MODE_MAX_TOOL_STEPS).toBeGreaterThan(MODEL_PRESET_MAX_TOOL_STEPS)
    })
})
