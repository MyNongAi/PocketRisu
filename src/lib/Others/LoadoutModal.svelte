<script lang="ts">
    import {
        XIcon,
        StarIcon,
        ClockIcon,
        UserIcon,
        ListIcon,
        SaveIcon,
        TrashIcon,
    } from "@lucide/svelte";
    import { DBState } from "src/ts/stores.svelte";
    import { loadoutModalStore } from "src/ts/stores.svelte";
    import { applyLoadout, saveCurrentLoadout, type Loadout } from "src/ts/loadout";
    import { getCurrentCharacter } from "src/ts/storage/database.svelte";

    type LoadoutApplyOption = 'modules' | 'globalVariables' | 'preset' | 'persona';

    let loadOptions: Record<LoadoutApplyOption, boolean> = $state({
        modules: true,
        globalVariables: true,
        preset: true,
        persona: true,
    });

    const loadOptionLabels: Record<LoadoutApplyOption, string> = {
        modules: 'Modules',
        globalVariables: 'Global Variables',
        preset: 'Preset',
        persona: 'Persona',
    };

    let saveName = $state('');

    function close() {
        loadoutModalStore.open = false;
    }

    const RECENT_LIMIT = 3;

    function getSortedLoadouts(): Loadout[] {
        return [...(DBState.db.loadouts ?? [])].sort(
            (a, b) => b.lastUsed - a.lastUsed,
        );
    }

    function getRecentLoadouts(): Loadout[] {
        return getSortedLoadouts().slice(0, RECENT_LIMIT);
    }

    function getCharacterLoadouts(): Loadout[] {
        const chaId = getCurrentCharacter()?.chaId;
        if (!chaId) return [];
        return getSortedLoadouts()
            .filter((l) => l.characterIds?.includes(chaId))
            .slice(0, RECENT_LIMIT);
    }

    function getFavoriteLoadouts(): Loadout[] {
        return getSortedLoadouts().filter((l) => l.favorite);
    }

    function getAllLoadouts(): Loadout[] {
        return getSortedLoadouts();
    }

    function onSelect(loadout: Loadout) {
        const apply = (Object.keys(loadOptions) as LoadoutApplyOption[]).filter(k => loadOptions[k]);
        applyLoadout(loadout, apply);
        close();
    }

    function toggleFavorite(loadout: Loadout, e: MouseEvent) {
        e.stopPropagation();
        loadout.favorite = !loadout.favorite;
    }

    function formatDate(ts: number): string {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    function removeLoadout(loadout: Loadout) {
        const index = DBState.db.loadouts.findIndex(l => l.id === loadout.id);
        if (index !== -1) {
            DBState.db.loadouts.splice(index, 1);
        }
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed top-0 left-0 w-full h-full bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
    onclick={() => close()}
>
    <div
        class="bg-darkbg rounded-lg p-4 w-11/12 max-w-2xl max-h-[85vh] flex flex-col gap-3"
        onclick={(e) => e.stopPropagation()}
    >
        <!-- Header -->
        <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold text-textcolor">Loadout</h2>
            <button
                class="text-textcolor2 hover:text-red-500 cursor-pointer"
                onclick={() => close()}
            >
                <XIcon size={20} />
            </button>
        </div>

        <!-- Apply Options -->
        <div class="flex flex-wrap gap-2 text-sm">
            {#each Object.entries(loadOptionLabels) as [key, label]}
                <label class="flex items-center gap-1 text-textcolor2">
                    <input type="checkbox" bind:checked={loadOptions[key as LoadoutApplyOption]} />
                    {label}
                </label>
            {/each}
        </div>

        <!-- Save New -->
        <div class="flex gap-2">
            <input
                class="flex-1 bg-bgcolor border border-darkborderc rounded px-2 py-1 text-sm text-textcolor"
                placeholder="New loadout name..."
                bind:value={saveName}
            />
            <button
                class="bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 transition text-sm flex items-center gap-1"
                onclick={() => {
                    if (saveName.trim()) {
                        saveCurrentLoadout(saveName.trim());
                        saveName = '';
                    }
                }}
            >
                <SaveIcon size={14} /> Save
            </button>
        </div>

        <!-- Loadout List -->
        <div class="flex-1 overflow-y-auto flex flex-col gap-3">
            <!-- Recent -->
            {#if getRecentLoadouts().length > 0}
                <div>
                    <div class="flex items-center gap-1 text-textcolor2 text-xs mb-1">
                        <ClockIcon size={12} /> Recent
                    </div>
                    {#each getRecentLoadouts() as loadout}
                        <button
                            class="w-full flex items-center justify-between p-2 rounded hover:bg-bgcolor cursor-pointer text-left"
                            onclick={() => onSelect(loadout)}
                        >
                            <div class="flex items-center gap-2 text-textcolor">
                                <span class="font-medium">{loadout.name}</span>
                                <span class="text-xs text-textcolor2">{formatDate(loadout.lastUsed)}</span>
                            </div>
                            <div class="flex items-center gap-1">
                                <button class="p-1 hover:text-yellow-400" onclick={(e) => toggleFavorite(loadout, e)}>
                                    <StarIcon size={14} fill={loadout.favorite ? 'currentColor' : 'none'} />
                                </button>
                                <button class="p-1 hover:text-red-400" onclick={(e) => { e.stopPropagation(); removeLoadout(loadout); }}>
                                    <TrashIcon size={14} />
                                </button>
                            </div>
                        </button>
                    {/each}
                </div>
            {/if}

            <!-- Character -->
            {#if getCharacterLoadouts().length > 0}
                <div>
                    <div class="flex items-center gap-1 text-textcolor2 text-xs mb-1">
                        <UserIcon size={12} /> This Character
                    </div>
                    {#each getCharacterLoadouts() as loadout}
                        <button
                            class="w-full flex items-center justify-between p-2 rounded hover:bg-bgcolor cursor-pointer text-left"
                            onclick={() => onSelect(loadout)}
                        >
                            <div class="flex items-center gap-2 text-textcolor">
                                <span class="font-medium">{loadout.name}</span>
                                <span class="text-xs text-textcolor2">{formatDate(loadout.lastUsed)}</span>
                            </div>
                            <div class="flex items-center gap-1">
                                <button class="p-1 hover:text-yellow-400" onclick={(e) => toggleFavorite(loadout, e)}>
                                    <StarIcon size={14} fill={loadout.favorite ? 'currentColor' : 'none'} />
                                </button>
                                <button class="p-1 hover:text-red-400" onclick={(e) => { e.stopPropagation(); removeLoadout(loadout); }}>
                                    <TrashIcon size={14} />
                                </button>
                            </div>
                        </button>
                    {/each}
                </div>
            {/if}

            <!-- Favorites -->
            {#if getFavoriteLoadouts().length > 0}
                <div>
                    <div class="flex items-center gap-1 text-textcolor2 text-xs mb-1">
                        <StarIcon size={12} /> Favorites
                    </div>
                    {#each getFavoriteLoadouts() as loadout}
                        <button
                            class="w-full flex items-center justify-between p-2 rounded hover:bg-bgcolor cursor-pointer text-left"
                            onclick={() => onSelect(loadout)}
                        >
                            <div class="flex items-center gap-2 text-textcolor">
                                <span class="font-medium">{loadout.name}</span>
                                <span class="text-xs text-textcolor2">{formatDate(loadout.lastUsed)}</span>
                            </div>
                            <div class="flex items-center gap-1">
                                <button class="p-1 hover:text-yellow-400" onclick={(e) => toggleFavorite(loadout, e)}>
                                    <StarIcon size={14} fill={loadout.favorite ? 'currentColor' : 'none'} />
                                </button>
                                <button class="p-1 hover:text-red-400" onclick={(e) => { e.stopPropagation(); removeLoadout(loadout); }}>
                                    <TrashIcon size={14} />
                                </button>
                            </div>
                        </button>
                    {/each}
                </div>
            {/if}

            <!-- All -->
            {#if getAllLoadouts().length > 0}
                <div>
                    <div class="flex items-center gap-1 text-textcolor2 text-xs mb-1">
                        <ListIcon size={12} /> All Loadouts
                    </div>
                    {#each getAllLoadouts() as loadout}
                        <button
                            class="w-full flex items-center justify-between p-2 rounded hover:bg-bgcolor cursor-pointer text-left"
                            onclick={() => onSelect(loadout)}
                        >
                            <div class="flex items-center gap-2 text-textcolor">
                                <span class="font-medium">{loadout.name}</span>
                                <span class="text-xs text-textcolor2">{formatDate(loadout.lastUsed)}</span>
                            </div>
                            <div class="flex items-center gap-1">
                                <button class="p-1 hover:text-yellow-400" onclick={(e) => toggleFavorite(loadout, e)}>
                                    <StarIcon size={14} fill={loadout.favorite ? 'currentColor' : 'none'} />
                                </button>
                                <button class="p-1 hover:text-red-400" onclick={(e) => { e.stopPropagation(); removeLoadout(loadout); }}>
                                    <TrashIcon size={14} />
                                </button>
                            </div>
                        </button>
                    {/each}
                </div>
            {:else}
                <div class="text-center text-textcolor2 text-sm py-4">
                    No loadouts saved yet. Save one above!
                </div>
            {/if}
        </div>
    </div>
</div>
