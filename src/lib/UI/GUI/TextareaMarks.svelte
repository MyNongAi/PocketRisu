<script lang="ts">
    // Marks a search text inside a textarea (the user's request, 2026-10-26).
    // A textarea cannot color part of its text, so a copy of the text with the
    // matches wrapped in <mark> lies behind it: transparent text, the same
    // font, padding, box and scroll as the textarea, which has no background
    // of its own. Put it in the textarea's positioned box, under the textarea.
    import { splitAtMatches, type TextMatch } from 'src/ts/gui/textMatches'

    interface Props {
        textarea: HTMLTextAreaElement | undefined
        /** The text the textarea shows. */
        text: string
        matches: readonly TextMatch[]
        /** The match the find bar is on, drawn stronger; -1 for none. */
        current?: number
        /** The textarea's px-4 py-2. */
        padding?: boolean
    }
    let { textarea, text, matches, current = -1, padding = true }: Props = $props()

    let backdrop = $state<HTMLDivElement>()
    // While the textarea shows a scrollbar the copy shows one too (with no
    // thumb), so the browser leaves the same room and lines wrap at the same
    // place. Measuring the bar instead rounds it to whole pixels, and a line
    // a fraction of a pixel from the edge wrapped in the copy only.
    let scrolls = $state(false)
    const segments = $derived(splitAtMatches(text, matches))

    function syncScroll() {
        if (backdrop && textarea) backdrop.scrollTop = textarea.scrollTop
    }

    $effect(() => {
        const field = textarea
        if (!field) return
        const measure = () => {
            scrolls = field.offsetWidth > field.clientWidth
            syncScroll()
        }
        measure()
        field.addEventListener('scroll', syncScroll, { passive: true })
        const observer = new ResizeObserver(measure)
        observer.observe(field)
        return () => {
            field.removeEventListener('scroll', syncScroll)
            observer.disconnect()
        }
    })

    // The copy's scroll can lag the textarea's when its text grew past the old end.
    $effect(() => {
        segments
        scrolls
        syncScroll()
    })

    /** Scrolls the textarea so match `index` shows a third of the way down. */
    export function reveal(index: number) {
        if (!backdrop || !textarea) return
        const mark = backdrop.querySelector<HTMLElement>(`mark[data-mark="${index}"]`)
        if (!mark) return
        textarea.scrollTop = Math.max(0, mark.offsetTop - textarea.clientHeight / 3)
        syncScroll()
    }
</script>

<div
    bind:this={backdrop}
    class="textarea-marks absolute top-0 left-0 h-full w-full pointer-events-none whitespace-pre-wrap wrap-break-word text-transparent"
    class:px-4={padding}
    class:py-2={padding}
    style:overflow-y={scrolls ? 'scroll' : 'hidden'}
    aria-hidden="true"
>{#each segments as segment, i (i)}{#if segment.mark >= 0}<mark data-mark={segment.mark} class:current={segment.mark === current}>{segment.text}</mark>{:else}{segment.text}{/if}{/each}{'​'}</div>

<style>
    /* No scrollbar-color here: it would drop the app's ::-webkit-scrollbar
       width, which the copy's bar must share with the textarea's. */
    .textarea-marks {
        overflow-x: hidden;
    }
    .textarea-marks::-webkit-scrollbar-thumb,
    .textarea-marks::-webkit-scrollbar-track {
        background: transparent !important;
    }
    mark {
        color: transparent;
        background: rgb(250 204 21 / 0.4);
        border-radius: 2px;
    }
    mark.current {
        background: rgb(249 115 22 / 0.75);
    }
</style>
