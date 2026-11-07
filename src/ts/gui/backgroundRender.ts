/**
 * The bot's background HTML on screen (BackgroundDom.svelte).
 *
 * A redraw signal (ReloadGUIPointer: an HTML button's trigger, Lua
 * reloadDisplay, a module change) parses the background again. Upstream
 * re-keyed it, so it was empty until the new parse was ready. Message bodies
 * here re-parse in place and keep showing what they showed (ChatBody.svelte),
 * so a bot whose panel CSS lives only in its background (나히아) showed its
 * panels and buttons without that <style> for the parse's length (about a
 * second with a large Lua display script), then styled again (the user's
 * report, 2026-11-07). The last background of the same bot now stays until
 * the new one is ready; another bot's is cleared at once.
 */
export class LatestBackground {
    #owner: string | undefined | null = null
    #serial = 0

    constructor(private readonly show: (html: string) => void) {}

    /**
     * Parse the background of `owner` (the bot's id). `parse` runs now, so a
     * caller's effect tracks what it reads, as the template expression did.
     * A later call wins over one still in flight.
     */
    render(owner: string | undefined, parse: () => Promise<string>): void {
        const serial = ++this.#serial
        if (owner !== this.#owner) {
            this.#owner = owner
            this.show('')
        }
        let parsed: Promise<string>
        try {
            parsed = parse()
        } catch (error) {
            console.error(error)
            return
        }
        parsed.then((html) => {
            if (serial === this.#serial) this.show(html ?? '')
        }, (error) => {
            console.error(error)
        })
    }

    /** No background: empty it, and drop any parse in flight. */
    clear(): void {
        this.#serial++
        this.#owner = null
        this.show('')
    }

    /** The component went away: a parse in flight shows nothing. */
    stop(): void {
        this.#serial++
    }
}
