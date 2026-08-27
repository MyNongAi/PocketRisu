<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    import { DBState } from 'src/ts/stores.svelte';
    import { changeUserPersona } from "src/ts/persona";
    import LazyAssetPreview from "src/lib/Others/LazyAssetPreview.svelte";

    interface Props {
        close?: () => void;
        onSelect?: ((index: number) => void) | null;
    }

    let { close = () => {}, onSelect = null }: Props = $props();

    function selectPersona(index: number) {
        if (onSelect) onSelect(index)
        else changeUserPersona(index)
        close()
    }

    function closeFromBackdrop(event: MouseEvent) {
        if (event.target === event.currentTarget) close()
    }

    function closeFromKeyboard(event: KeyboardEvent) {
        if (event.key === 'Escape') close()
    }
</script>

<svelte:window onkeydown={closeFromKeyboard} />

<div
    class="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-3 sm:p-6"
    role="presentation"
    onclick={closeFromBackdrop}
>
    <div
        class="break-any flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-darkborderc bg-darkbg shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={language.persona}
    >
        <div class="flex shrink-0 items-center border-b border-darkborderc px-4 py-3 text-textcolor">
            <h2 class="mt-0 mb-0 font-bold">{language.persona}</h2>
            <div class="grow flex justify-end">
                <button
                    type="button"
                    aria-label={language.close}
                    class="cursor-pointer items-center text-textcolor2 hover:text-primary"
                    onclick={close}
                >
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        <div class="flex min-h-0 flex-1 content-start flex-wrap gap-3 overflow-y-auto p-4">
            {#each DBState.db.personas as persona, i}
                <button
                    type="button"
                    aria-label={persona.name || 'User'}
                    aria-pressed={i === DBState.db.selectedPersona}
                    onclick={() => selectPersona(i)}
                    class={`group relative h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-selected/20 text-textcolor shadow-lg transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary
                        ${i === DBState.db.selectedPersona ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc'}`}
                >
                    <div class="relative h-full w-full overflow-hidden bg-selected/45">
                        {#if persona.icon}
                            <LazyAssetPreview
                                path={persona.icon}
                                kind="image"
                                alt={persona.name || 'User'}
                                mediaClass="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                                wrapperClass="h-full w-full"
                                rootMargin="160px"
                            />
                        {:else}
                            <div class="flex h-full w-full items-center justify-center p-2 text-center text-xs font-semibold leading-tight text-textcolor">
                                <span class="line-clamp-4 wrap-break-word">{persona.name || 'User'}</span>
                            </div>
                        {/if}
                        {#if persona.sourceInfo?.label}
                            <span class="absolute right-2 bottom-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-darkbg/85 px-2 py-0.5 text-[10px] text-textcolor">
                                {persona.sourceInfo.label}
                            </span>
                        {/if}
                    </div>
                </button>
            {/each}
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
