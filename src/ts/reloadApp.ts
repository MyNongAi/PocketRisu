// Reload from the sidebar menu: the installed phone app has no browser
// reload button.
//
// Reloading is also how the app picks up a new build: the server sends
// index.html uncached and every bundle under a new hashed name, and the
// service worker does not cache app files.

import { get } from 'svelte/store'
import { language } from 'src/lang'
import { allowNextUnload } from '../preload'
import { alertConfirm, notifyError } from './alert'
import { hasUnsavedWork, requestImmediateSave } from './globalApi.svelte'
import { doingChat } from './process/generationState'

export async function reloadApp(deps: { reload?: () => void } = {}): Promise<boolean> {
    if (get(doingChat) && !await alertConfirm(language.reloadWhileGenerating)) {
        return false
    }
    try {
        // Push anything typed since the last save before the page goes away.
        await requestImmediateSave()
    } catch (error) {
        notifyError(error, { source: 'save' })
        return false
    }
    // The save loop reports its own failures and keeps retrying rather than
    // throwing, so ask it directly. With work still pending, keep the
    // leave-site guard and do not reload.
    if (hasUnsavedWork()) {
        notifyError(language.reloadBlockedUnsaved, { source: 'save' })
        return false
    }
    allowNextUnload()
    ;(deps.reload ?? (() => location.reload()))()
    return true
}
