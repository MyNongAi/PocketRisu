//@name hide_floating_buttons
//@display-name 떠 있는 버튼 숨기기
//@api 3.0
//@version 1.0.0

// Hides a bot's floating buttons, per bot.
//
// Bots can draw launchers that stay on screen (a fixed stack of buttons that
// opens a status window, a map or a menu) in their messages or background
// HTML. With this plugin's switch on for a bot (chat input menu), an element
// in a message body or the background layer is hidden when it
//   - is fixed to the screen (a `position: fixed` rule in the bot's CSS, or
//     an inline style),
//   - covers at most 20% of the screen,
//   - and is, or holds, a button, label or trigger.
// Buttons in the message text (not fixed) and open popups (larger) stay.
//
// The switch is kept per bot in pluginStorage under
// `hide_floating_buttons:<chaId>`, so it follows the save file. The plugin
// needs main-document access, which the app asks for once.

(async () => {
    const STORAGE_PREFIX = 'hide_floating_buttons:'
    const BUTTON_ID = 'hide-floating-buttons-toggle'
    const MARK = 'x-hide-floating-buttons'
    const CSS_MARK = 'x-hide-floating-buttons-css'
    const MAX_SCREEN_SHARE = 0.2
    const MAX_CANDIDATES = 100 // per query and scan, so hostile markup cannot make a scan unbounded
    const SCAN_DELAY_MS = 250
    // Where bot markup is drawn: message bodies, and the background layer
    // (an attribute in some forks, else the markup of BackgroundDom.svelte).
    const ROOTS = ':is(.chattext, [data-pr-bot-background], .grow.h-full.relative > div.absolute.top-0.left-0.w-full.h-full)'
    const CONTROL = 'button, label, summary, [risu-btn], [risu-trigger], input[type="checkbox"], input[type="radio"], input[type="button"]'
    // Is or holds a control, and is not hidden already (nor inside a hidden one).
    const CANDIDATE = `:is(${CONTROL}, :has(${CONTROL})):not([${MARK}="1"], [${MARK}="1"] *)`
    const switchIcon = (on) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        + `<rect x="2" y="6" width="20" height="12" rx="6"/><circle cx="${on ? 16 : 8}" cy="12" r="3"${on ? ' fill="currentColor"' : ''}/></svg>`

    const doc = await risuai.getRootDocument()
    if (!doc) {
        console.log('Main document access was not granted, so nothing is hidden.')
        return
    }

    // Every element handed over stays alive on the app side until released.
    const release = (...refs) => { for (const ref of refs) if (ref) ref.release() }
    async function toArray(list, max = Infinity) {
        const length = Math.min(await list.length(), max)
        const items = await Promise.all(Array.from({ length }, (_, i) => list.at(i)))
        release(list)
        return items
    }

    // The fixed rules of a CSS text, as [selector, media conditions] pairs.
    // Parsed here, in the sandbox: a plugin cannot read the page's computed
    // styles or stylesheets, only the text of the bot's <style> elements.
    function fixedRulesOf(text) {
        const found = []
        const walk = (rules, media) => {
            for (const rule of rules) {
                if (rule.selectorText && rule.style?.getPropertyValue('position').trim() === 'fixed') found.push([rule.selectorText, media])
                if (rule.cssRules) walk(rule.cssRules, rule.media ? [...media, rule.media.mediaText] : media)
            }
        }
        try {
            const sheet = new CSSStyleSheet()
            sheet.replaceSync(text)
            walk(sheet.cssRules, [])
        } catch { /* not parseable here */ }
        return found
    }

    // Whether a media query list holds on a width x height screen. Only the
    // print type and px width/height conditions are read; any other condition
    // counts as holding (and a negated query with one, too).
    const SIZE_CONDITION = /\(\s*(min-|max-)?(width|height)\s*(:|<=|>=|<|>)\s*([\d.]+)px\s*\)/gi
    function mediaHolds(mediaText, width, height) {
        return mediaText.split(',').some((query) => {
            const sizes = [...query.matchAll(SIZE_CONDITION)]
            const holds = !/\bprint\b/i.test(query) && sizes.every(([, prefix, feature, op, px]) => {
                const size = feature.toLowerCase() === 'width' ? width : height
                const limit = Number(px)
                if (op === ':') op = prefix?.toLowerCase() === 'min-' ? '>=' : prefix?.toLowerCase() === 'max-' ? '<=' : '='
                return op === '<=' ? size <= limit : op === '>=' ? size >= limit : op === '<' ? size < limit : op === '>' ? size > limit : size === limit
            })
            if (!/^\s*not\b/i.test(query)) return holds
            return sizes.length === (query.match(/\(/g) || []).length ? !holds : true
        })
    }

    // Each bot <style> is read once: it is tagged with the id of its fixed
    // rules ('-' for none), and later scans only ask which ids are on screen.
    const groupIds = new Map() // rules as JSON -> id
    const groups = new Map() // id -> rules, while a <style> with that id is on screen
    let nextId = 0
    async function fixedSelectors(width, height) {
        // Untagged, or tagged with an id forgotten since: read (again).
        const known = ['-', ...groups.keys()].map((id) => `[${CSS_MARK}="${id}"]`).join(', ')
        const fresh = await toArray(await doc.querySelectorAll(`${ROOTS} style:not(${known})`))
        await Promise.all(fresh.map(async (style) => {
            const rules = fixedRulesOf((await style.textContent()) || '')
            const key = JSON.stringify(rules)
            if (rules.length && !groupIds.has(key)) { groupIds.set(key, nextId); groups.set(nextId++, rules) }
            await style.setAttribute(CSS_MARK, rules.length ? String(groupIds.get(key)) : '-')
        }))
        release(...fresh)
        const live = await Promise.all([...groups].map(async ([id, rules]) => {
            const style = await doc.querySelector(`${ROOTS} style[${CSS_MARK}="${id}"]`)
            if (style) { release(style); return rules }
            groups.delete(id) // gone with its message: forget it
            groupIds.delete(JSON.stringify(rules))
            return []
        }))
        return live.flat().filter(([, media]) => media.every((text) => mediaHolds(text, width, height))).map(([selector]) => selector)
    }

    const areaOf = (rect) => Math.max(0, rect.width) * Math.max(0, rect.height)
    // The area an element shows: its own box, or its controls' when it has no size of its own.
    async function shownArea(element) {
        const own = areaOf(await element.getBoundingClientRect())
        if (own > 0) return own
        const controls = await toArray(await element.querySelectorAll(CONTROL), MAX_CANDIDATES)
        const rects = await Promise.all(controls.map((control) => control.getBoundingClientRect()))
        release(...controls)
        return rects.reduce((sum, rect) => sum + areaOf(rect), 0)
    }

    // True at start: marks left by an earlier run of this plugin are cleared once.
    let hiddenSome = true
    async function hideMatching(selector, positionOk, limit) {
        let list
        try { list = await doc.querySelectorAll(selector) } catch { return } // a selector this browser cannot read
        for (const element of await toArray(list, MAX_CANDIDATES)) {
            try {
                if (!positionOk(await element.getStyle('position'))) continue
                const area = await shownArea(element)
                if (area > 0 && area <= limit) {
                    await element.setAttribute(MARK, '1')
                    hiddenSome = true
                }
            } finally {
                release(element)
            }
        }
    }

    let lastScreen = ''
    async function hideLaunchers() {
        const [width, height] = await Promise.all([doc.clientWidth(), doc.clientHeight()])
        // A hidden element cannot be measured, so a new screen size starts over.
        const screen = `${width}x${height}`
        if (screen !== lastScreen) {
            lastScreen = screen
            await showAll()
        }
        const limit = width * height * MAX_SCREEN_SHARE
        const selectors = await fixedSelectors(width, height)
        // Matched by a fixed rule, unless an inline style places it otherwise.
        if (selectors.length) await hideMatching(`${ROOTS} :is(${selectors.join(', ')})${CANDIDATE}`, (pos) => pos === '' || pos === 'fixed', limit)
        // style="position: fixed" (the attribute match is loose, hence the check).
        await hideMatching(`${ROOTS} [style*="position" i][style*="fixed" i]${CANDIDATE}`, (pos) => pos === 'fixed', limit)
    }

    async function showAll() {
        if (!hiddenSome) return
        hiddenSome = false
        const marked = await toArray(await doc.querySelectorAll(`[${MARK}="1"]`))
        await Promise.all(marked.map((element) => element.setAttribute(MARK, '')))
        release(...marked)
    }

    // The selected bot and its switch.
    let botIndex = null
    let botId = null
    let hideOn = false
    let shownName = ''
    async function syncBot(force = false) {
        const index = await risuai.getCurrentCharacterIndex()
        if (index === botIndex && !force) return
        const char = index >= 0 ? await risuai.getCharacter() : null
        const id = char?.chaId || null
        const on = !!id && !!(await risuai.pluginStorage.getItem(STORAGE_PREFIX + id))
        // Another bot was opened meanwhile: read again rather than mix the two.
        if (await risuai.getCurrentCharacterIndex() !== index) return syncBot(true)
        botIndex = index
        botId = id
        hideOn = on
        await showSwitch()
    }

    async function showSwitch() {
        const name = `떠 있는 버튼 숨기기: ${hideOn ? '켬' : '끔'}`
        if (name === shownName) return
        shownName = name
        await risuai.registerButton({ name, icon: switchIcon(hideOn), iconType: 'html', location: 'chat', id: BUTTON_ID }, toggle)
    }

    // One task at a time: a scan or a toggle.
    let chain = Promise.resolve()
    const serial = (task) => (chain = chain.then(task).catch((error) => console.log(`Error: ${error?.message || error}`)))

    async function scan() {
        await syncBot()
        if (hideOn) await hideLaunchers()
        else await showAll()
    }

    let unloaded = false
    let timer = 0
    let queued = false
    function schedule() {
        if (unloaded || timer || queued) return
        timer = setTimeout(() => {
            timer = 0
            queued = true
            serial(() => { queued = false; return unloaded ? undefined : scan() })
        }, SCAN_DELAY_MS)
    }

    function toggle() {
        return serial(async () => {
            await syncBot(true)
            if (!botId) return
            const next = !hideOn
            const key = STORAGE_PREFIX + botId
            const saved = next ? await risuai.pluginStorage.setItem(key, '1') : await risuai.pluginStorage.removeItem(key)
            if (saved === false) return
            // Another bot was opened meanwhile: its own state applies, not this one.
            if (await risuai.getCurrentCharacterIndex() !== botIndex) return syncBot(true)
            hideOn = next
            await showSwitch()
            await (hideOn ? hideLaunchers() : showAll())
        })
    }

    // The hiding rule. Removing it on unload shows everything again; the app
    // itself drops the observer, the listener and the menu entry.
    const style = await doc.createElement('style')
    await style.setTextContent(`[${MARK}="1"] { display: none !important; }`)
    const head = await doc.querySelector('head')
    await head.appendChild(style)
    release(head)
    await risuai.onUnload(() => {
        unloaded = true
        clearTimeout(timer)
        return style.remove()
    })

    // Rescan when the chat, the background or a toggle changes. A label or a
    // checkbox can open a popup with CSS alone, so clicks rescan as well.
    const observer = await risuai.createMutationObserver(schedule)
    const body = await doc.querySelector('body')
    await observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open'] })
    release(body)
    await doc.addEventListener('click', schedule)

    await serial(() => syncBot(true))
    schedule()
})()
