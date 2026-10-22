<script lang="ts">
    import { TrashIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { removeBlockedRealmCard, removeBlockedRealmCreator } from "src/ts/realmBlocking";
    import { DBState } from "src/ts/stores.svelte";

    interface Props {
        onClose?: () => void;
        onUnblock?: () => void | Promise<void>;
    }

    let { onClose = () => {}, onUnblock = () => {} }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="fixed left-0 top-0 z-60 flex h-full w-full items-center justify-center bg-black/50 text-textcolor" role="button" tabindex="0" onclick={onClose}>
    <div class="flex max-h-full w-xl max-w-full flex-col gap-4 overflow-y-auto rounded-md bg-darkbg p-6" role="presentation" onclick={(e) => e.stopPropagation()}>
        <div class="flex items-center justify-between gap-4">
            <h1 class="text-2xl font-bold">{language.blockedRealmBots}</h1>
            <button class="text-textcolor2 hover:text-green-500" onclick={onClose} aria-label="Close">
                <XIcon />
            </button>
        </div>

        <!-- PocketRisu: bots blocked one by one (realmBlocking.ts). -->
        {#if (DBState.db.nodeOnlyBlockedRealmCards ?? []).length === 0}
            <p class="text-textcolor2">{language.noBlockedRealmBots}</p>
        {:else}
            <div class="flex flex-col gap-2">
                {#each DBState.db.nodeOnlyBlockedRealmCards ?? [] as card (card.id)}
                    <div class="flex items-center gap-3 rounded-md border border-darkborderc p-3">
                        <div class="min-w-0 grow">
                            <div class="truncate font-bold">{card.name}</div>
                            <div class="truncate text-xs text-textcolor2">{card.id}</div>
                        </div>
                        <button class="flex items-center gap-2 rounded-md bg-selected p-2 hover:ring-3" onclick={async () => {
                            DBState.db.nodeOnlyBlockedRealmCards = removeBlockedRealmCard(
                                DBState.db.nodeOnlyBlockedRealmCards ?? [],
                                card.id,
                            )
                            await onUnblock()
                        }}>
                            <TrashIcon size={18} />
                            <span>{language.unblockRealmCreator}</span>
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

        {#if DBState.db.blockedRealmCreators.length > 0}
            <h2 class="text-lg font-bold">{language.blockedRealmCreators}</h2>
            <div class="flex flex-col gap-2">
                {#each DBState.db.blockedRealmCreators as creator (creator.id)}
                    <div class="flex items-center gap-3 rounded-md border border-darkborderc p-3">
                        <div class="min-w-0 grow">
                            <div class="truncate font-bold">{creator.name}</div>
                            <div class="truncate text-xs text-textcolor2">{creator.id}</div>
                        </div>
                        <button class="flex items-center gap-2 rounded-md bg-selected p-2 hover:ring-3" onclick={async () => {
                            DBState.db.blockedRealmCreators = removeBlockedRealmCreator(
                                DBState.db.blockedRealmCreators,
                                creator.id,
                            )
                            await onUnblock()
                        }}>
                            <TrashIcon size={18} />
                            <span>{language.unblockRealmCreator}</span>
                        </button>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</div>
