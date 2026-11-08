// The 🎨 album popup (IllustrationAlbum.svelte; process/illustrationAlbum.ts):
// opened for one bot and its open chat, from the 🎨 row of the sidebar and
// the 🎨 ⚙ presets.
export type IllustrationAlbumTab = 'chat' | 'bot' | 'samples'

export const illustrationAlbumStore = $state<{
    open: boolean
    chaId: string
    chatId: string
    tab: IllustrationAlbumTab
}>({
    open: false,
    chaId: '',
    chatId: '',
    tab: 'chat',
})

export function openIllustrationAlbum(chaId: string, chatId: string, tab: IllustrationAlbumTab = 'chat'): void {
    illustrationAlbumStore.chaId = chaId
    illustrationAlbumStore.chatId = chatId
    illustrationAlbumStore.tab = tab
    illustrationAlbumStore.open = true
}

export function closeIllustrationAlbum(): void {
    illustrationAlbumStore.open = false
}
