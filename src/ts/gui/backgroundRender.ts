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
 *
 * A parse also starts again whenever a chat variable the background reads
 * changes, and a bot's Lua display script can write those variables each
 * time it draws a message. Then every parse was overtaken before it ended,
 * so on entering the bot no background showed for seconds while the
 * greeting was already drawn (the same report, 2026-11-08: 얼티네이트
 * 헌터). The newest parse that has ended is shown now, even while a later
 * one is still running; an older one never replaces it.
 *
 * `waiting` (backgroundGate.svelte.ts) is told when a new bot's background
 * is pending and when it first shows (or fails, is cleared, or takes longer
 * than `waitLimitMs`), so message bodies can wait for its <style>.
 */
export class LatestBackground {
    #owner: string | undefined | null = null
    #serial = 0
    /** The first parse of the bot shown now: earlier ones are another bot's. */
    #ownerFrom = 0
    /** The parse on screen. */
    #shown = 0
    #stopped = false
    #waitTimer: ReturnType<typeof setTimeout> | null = null

    constructor(
        private readonly show: (html: string) => void,
        private readonly waiting: (waiting: boolean) => void = () => {},
        private readonly waitLimitMs = 3000,
    ) {}

    /**
     * Parse the background of `owner` (the bot's id). `parse` runs now, so a
     * caller's effect tracks what it reads, as the template expression did.
     */
    render(owner: string | undefined, parse: () => Promise<string>): void {
        const serial = ++this.#serial
        if (owner !== this.#owner) {
            this.#owner = owner
            this.#ownerFrom = serial
            this.#shown = serial - 1
            this.show('')
            this.#startWaiting()
        }
        let parsed: Promise<string>
        try {
            parsed = parse()
        } catch (error) {
            console.error(error)
            this.#stopWaiting()
            return
        }
        parsed.then((html) => {
            if (this.#stopped || serial < this.#ownerFrom || serial <= this.#shown) return
            this.#shown = serial
            this.show(html ?? '')
            this.#stopWaiting()
        }, (error) => {
            console.error(error)
            if (serial >= this.#ownerFrom) this.#stopWaiting()
        })
    }

    /** No background: empty it, and drop any parse in flight. */
    clear(): void {
        this.#owner = null
        this.#ownerFrom = ++this.#serial + 1
        this.show('')
        this.#stopWaiting()
    }

    /** The component went away: a parse in flight shows nothing. */
    stop(): void {
        this.#stopped = true
        this.#stopWaiting()
    }

    #startWaiting(): void {
        if (this.#waitTimer) clearTimeout(this.#waitTimer)
        this.#waitTimer = setTimeout(() => this.#stopWaiting(), this.waitLimitMs)
        this.waiting(true)
    }

    #stopWaiting(): void {
        if (!this.#waitTimer) return
        clearTimeout(this.#waitTimer)
        this.#waitTimer = null
        this.waiting(false)
    }
}
