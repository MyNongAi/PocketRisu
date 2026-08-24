<script lang="ts">
    import { type Database } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, cancelCharacterChatPrefetch, changeChar, getCharThumbnail, prefetchCharacterChat, removeChar, scheduleCharacterChatPrefetch } from "src/ts/characters";
    import { makeAgoText } from "src/ts/util";
    import { MessageSquareIcon, PlusIcon, SquareMousePointer, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import VirtualList from "../UI/Virtual/VirtualList.svelte";

    interface Props {
        search: string;
        gridMode?: boolean;
        endGrid?: () => void;
    }

    let {search, gridMode = false, endGrid = () => {}}: Props = $props();

    function sortChar(char: Database['characters'], searchText: string) {
        const normalizedSearch = searchText.replace(/ /g, "").toLocaleLowerCase()
        return char.map((c, i) => ({
                name: c.name || "Unnamed",
                image: c.image,
                chats: c.chats.length,
                i: i,
                type: c.type,
                chaId: c.chaId,
                trashTime: c.trashTime,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
            }))
            .filter((c) => !c.trashTime && c.name.replace(/ /g, "").toLocaleLowerCase().includes(normalizedSearch))
            .sort((a, b) => {
            if (a.interaction === b.interaction) {
                return a.name.localeCompare(b.name);
            }
            return b.interaction - a.interaction;
        });
    }
    let sortedCharacters = $derived(sortChar(DBState.db.characters, search))
</script>
<VirtualList items={sortedCharacters} itemHeight={76} className="w-full h-full" key={(char) => char.chaId}>
    {#snippet children(char, i)}
        <div class="flex h-full items-center border-t-darkborderc w-full" class:border-t={i !== 0}>
            <div class="shrink-0 p-2 pr-0">
                <BarIcon
                    onPrefetch={() => scheduleCharacterChatPrefetch(char.i)}
                    onPrefetchCancel={() => cancelCharacterChatPrefetch(char.i)}
                    onPrefetchImmediate={() => void prefetchCharacterChat(char.i)}
                    onClick={() => {
                        changeChar(char.i)
                        endGrid()
                    }}
                    additionalStyle={() => getCharThumbnail(char.image, 'css')}
                />
            </div>
            <button
                class="flex min-w-0 flex-1 p-2 text-left"
                onpointerenter={() => scheduleCharacterChatPrefetch(char.i)}
                onpointerleave={() => cancelCharacterChatPrefetch(char.i)}
                onpointerdown={() => void prefetchCharacterChat(char.i)}
                onfocus={() => scheduleCharacterChatPrefetch(char.i)}
                onblur={() => cancelCharacterChatPrefetch(char.i)}
                onclick={() => {
                    changeChar(char.i)
                    endGrid()
                }}>
                <div class="flex flex-1 w-full flex-col justify-start items-start text-start">
                    <span>{char.name}</span>
                    <div class="text-sm text-textcolor2 flex items-center w-full flex-wrap">
                        <span class="mr-1">{char.chats}</span>
                        <MessageSquareIcon size={14} />
                        <span class="mr-1 ml-1">|</span>
                        <span>{char.agoText}</span>
                    </div>
                </div>
            </button>
            {#if gridMode}
                <div class="flex shrink-0 items-center gap-1 pr-2">
                    <button
                        class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor"
                        title={language.selectChar}
                        aria-label={language.selectChar}
                        onpointerenter={() => scheduleCharacterChatPrefetch(char.i)}
                        onpointerleave={() => cancelCharacterChatPrefetch(char.i)}
                        onpointerdown={() => void prefetchCharacterChat(char.i)}
                        onclick={() => {
                            changeChar(char.i)
                            endGrid()
                        }}
                    >
                        <SquareMousePointer size={20} />
                    </button>
                    <button
                        class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-red-500/10 hover:text-red-400"
                        title={language.trash}
                        aria-label={language.trash}
                        onclick={() => removeChar(char.chaId, char.name)}
                    >
                        <TrashIcon size={20} />
                    </button>
                </div>
            {/if}
        </div>
    {/snippet}
</VirtualList>

{#if gridMode}
    <button class="p-4 rounded-full absolute bottom-2 right-2 bg-borderc" onclick={() => {
        addCharacter()
    }}>
        <PlusIcon size={24} />
    </button>
{/if}
