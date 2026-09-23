let unloadAllowed = false

/**
 * Let the next navigation through without the "leave site?" prompt. Only for
 * a reload the user asked for after pending edits were saved (see
 * src/ts/reloadApp.ts); everything else keeps the guard.
 */
export function allowNextUnload(){
    unloadAllowed = true
}

export function preLoadCheck(){
    //Add beforeunload event listener to prevent the user from leaving the page
    window.addEventListener('beforeunload', (e) => {
        if (unloadAllowed) return
        e.preventDefault()
        //legacy browser
        e.returnValue = true
    })

    return true;
}
