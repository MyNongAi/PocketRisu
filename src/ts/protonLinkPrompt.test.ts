import { afterEach, describe, expect, it } from 'vitest'
import { askProtonLink, closeProtonLinkPrompt, protonLinkPromptState } from 'src/ts/protonLinkPrompt.svelte'

afterEach(() => {
    closeProtonLinkPrompt()
})

describe('Proton link prompt helper', () => {
    it('resolves the trimmed text on submit and clears the prompt', async () => {
        const result = askProtonLink('character')
        expect(protonLinkPromptState.open).toBe(true)
        expect(protonLinkPromptState.destination).toBe('character')
        closeProtonLinkPrompt('  https://drive.proton.me/urls/share#key \n')
        expect(await result).toBe('https://drive.proton.me/urls/share#key')
        expect(protonLinkPromptState.open).toBe(false)
        expect(protonLinkPromptState.text).toBe('')
    })

    it('resolves null on cancel', async () => {
        const result = askProtonLink('module')
        closeProtonLinkPrompt()
        expect(await result).toBeNull()
        expect(protonLinkPromptState.open).toBe(false)
    })

    it('cancels an earlier pending call before opening the next one', async () => {
        const first = askProtonLink('character')
        protonLinkPromptState.text = 'old link'
        const second = askProtonLink('module')
        expect(await first).toBeNull()
        expect(protonLinkPromptState).toMatchObject({ open: true, destination: 'module', text: '' })
        closeProtonLinkPrompt('  realm-address  ')
        expect(await second).toBe('realm-address')
    })

    it('ignores repeated closes after a call has resolved', async () => {
        const result = askProtonLink('module')
        closeProtonLinkPrompt('link')
        closeProtonLinkPrompt()
        expect(await result).toBe('link')
    })
})
