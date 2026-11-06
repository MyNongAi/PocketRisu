export type ProtonLinkDestination = 'character' | 'module'

export const protonLinkPromptState = $state<{
    open: boolean
    destination: ProtonLinkDestination
    text: string
}>({ open: false, destination: 'character', text: '' })

let resolveLink: ((link: string | null) => void) | null = null

/** Ask only for the link; the caller keeps its existing import and fallback flow. */
export function askProtonLink(destination: ProtonLinkDestination): Promise<string | null> {
    closeProtonLinkPrompt()
    protonLinkPromptState.destination = destination
    protonLinkPromptState.text = ''
    return new Promise((resolve) => {
        resolveLink = resolve
        protonLinkPromptState.open = true
    })
}

export function closeProtonLinkPrompt(text: string | null = null): void {
    const resolve = resolveLink
    resolveLink = null
    protonLinkPromptState.open = false
    protonLinkPromptState.text = ''
    resolve?.(text?.trim() || null)
}
