<script lang="ts">
    import { MenuIcon } from "@lucide/svelte";
    import { popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";

    const {
        children
    }:{
        children: import("svelte").Snippet
    } = $props();
    
    let buttonId = Math.random()
</script>

<button data-popup-button onclick={async (e:MouseEvent) => {
    await sleep(0)
    // Close only while this button's popup is still shown: a popup closed by
    // a tap outside, a picked item or Back leaves openId behind, and the next
    // tap on the same button used to "close" it again instead of opening.
    if(popupStore.children && popupStore.openId === buttonId){
        popupStore.children = null
        popupStore.openId = 0
        return
    }
    popupStore.mouseX = e.clientX
    popupStore.mouseY = e.clientY
    popupStore.children = children
    popupStore.openId = buttonId
}} class="hover:text-primary transition-colors button-icon-menu">
    <MenuIcon size={20} />
</button>