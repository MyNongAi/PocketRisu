<script lang="ts">
    import DOMPurify from 'dompurify';
    import { getFileSrc } from 'src/ts/globalApi.svelte';

    let {
        ico,
        className = 'w-5 h-5'
    }: {
        ico: {
            iconType:'html'|'img'|'none',
            icon:string
        },
        className?:string
    } = $props()
    let imageFailed = $state(false)

    const iconPurify = (icon:string) => {
        
        return DOMPurify.sanitize(icon, {
            FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
            FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style', 'class']
        });
    }

    const resolveImageIcon = async (url:string) => {
        if (url.startsWith('assets/') || url.startsWith('external://')) {
            try {
                return await getFileSrc(url)
            } catch (error) {
                console.warn(`Unable to resolve plugin asset icon: ${url}`, error)
                return ''
            }
        }
        try {
            // Resolve against the page so a relative icon path is allowed;
            // the protocol check below still applies to the resolved URL.
            const parsedUrl = new URL(url, location.href);
            const allowedProtocols = ['http:', 'https:', 'data:', 'blob:'];
            if (allowedProtocols.includes(parsedUrl.protocol)) {
                return parsedUrl.href;
            } else {
                console.warn(`Blocked URL with unsafe protocol: ${parsedUrl.protocol}`);
                return '';
            }
        } catch (e) {
            console.warn(`Invalid URL: ${url}`);
            return '';
        }
    }

    $effect(() => {
        void ico.icon
        imageFailed = false
    })

</script>

<div class={className}>
    {#if ico.iconType === 'html'}
        {@html iconPurify(ico.icon)}
    {:else if ico.iconType === 'img'}
        {#await resolveImageIcon(ico.icon)}
            <span class="block h-full w-full rounded bg-selected/40" aria-hidden="true"></span>
        {:then iconSrc}
            {#if iconSrc && !imageFailed}
                <img src={iconSrc} alt="icon" onerror={() => { imageFailed = true }} />
            {:else}
                <span class="flex h-full w-full items-center justify-center rounded bg-selected/40 text-[0.65em] text-textcolor2" aria-label="icon unavailable">◇</span>
            {/if}
        {/await}
    {/if}
</div>
