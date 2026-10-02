<script lang="ts">
    import { popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import { onDestroy, onMount } from "svelte";

    let styleString = $derived.by(() => {
        let styleString = '';
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const mouseX = popupStore.mouseX;
        const mouseY = popupStore.mouseY;

        if(mouseX < windowWidth / 2) {
            styleString += `left: ${mouseX}px;`;
        } else {
            styleString += `right: ${windowWidth - mouseX}px;`;
        }
        if(mouseY < windowHeight / 2) {
            styleString += `top: ${mouseY}px;`;
        } else {
            styleString += `bottom: ${windowHeight - mouseY}px;`;
        }
        return styleString;
    });

    const close = ((e: MouseEvent) => {
        // A menu button opens, switches or closes the popup itself; closing
        // here as well would undo another message's menu right after it opened.
        if((e.target as Element | null)?.closest?.('[data-popup-button]')) return
        setTimeout(() => {
            popupStore.children = null;
            popupStore.openId = 0;
        }, 10);
    });

    onMount(async () => {
        await sleep(0)
        document.addEventListener('click', close);
    })

    onDestroy(() => {
        document.removeEventListener('click', close);
    })

</script>

{#if popupStore.children}
    <div class="bg-darkbg border-darkborderc border rounded-md p-4 gap-2 flex flex-col fixed z-50 items-start" style={styleString}>
        {@render popupStore.children()}
    </div>
{/if}
