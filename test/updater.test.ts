import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createKeepEntries, createSkipMoveEntries } = require('../scripts/updater.cjs') as {
  createKeepEntries: (options?: { windows?: boolean; skipBinReplacement?: boolean }) => Set<string>
  createSkipMoveEntries: (options?: { windows?: boolean; skipBinReplacement?: boolean }) => Set<string>
}

describe('portable updater preserved roots', () => {
  it('never backs up the default external asset store during replacement', () => {
    expect(createKeepEntries({ windows: false })).toContain('external-assets')
    expect(createKeepEntries({ windows: true })).toContain('external-assets')
  })

  it('never installs a packaged external asset store over user data', () => {
    expect(createSkipMoveEntries({ windows: false })).toContain('external-assets')
    expect(createSkipMoveEntries({ windows: true })).toContain('external-assets')
  })

  it('keeps the existing conditional bin behavior', () => {
    expect(createKeepEntries({ windows: false, skipBinReplacement: false })).not.toContain('bin')
    expect(createSkipMoveEntries({ windows: false, skipBinReplacement: false })).not.toContain('bin')
    expect(createKeepEntries({ windows: false, skipBinReplacement: true })).toContain('bin')
    expect(createSkipMoveEntries({ windows: true, skipBinReplacement: false })).toContain('bin')
  })
})
