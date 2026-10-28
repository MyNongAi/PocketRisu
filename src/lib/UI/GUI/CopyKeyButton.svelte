<script lang="ts">
    // Copies an API key to the clipboard (the user's request, 2026-10-28, for
    // model presets), the way the request logs copy: a check for a moment, an
    // error when the browser refuses.
    import { CheckIcon, CopyIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { notifyError, notifySuccess } from 'src/ts/alert'

    interface Props {
        text: string | null | undefined
        size?: number
        className?: string
    }

    let { text, size = 18, className = '' }: Props = $props()
    let copied = $state(false)
    let timer: ReturnType<typeof setTimeout> | undefined

    async function copy() {
        if (!text) return
        try {
            await navigator.clipboard.writeText(text)
            copied = true
            notifySuccess(language.apiKeyCopied)
            clearTimeout(timer)
            timer = setTimeout(() => { copied = false }, 1500)
        } catch (error) {
            notifyError(String(error))
        }
    }
</script>

<button
    type="button"
    class={'shrink-0 p-1 text-textcolor2 hover:text-textcolor disabled:opacity-40 disabled:pointer-events-none ' + className}
    title={language.apiKeyCopy}
    aria-label={language.apiKeyCopy}
    disabled={!text}
    onclick={copy}
    data-copy-key
>
    {#if copied}<CheckIcon {size} />{:else}<CopyIcon {size} />{/if}
</button>
