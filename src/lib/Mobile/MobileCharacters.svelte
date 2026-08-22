<script lang="ts">
    import { type Database } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage, removeChar } from "src/ts/characters";
    import { makeAgoText } from "src/ts/util";
    import { MessageSquareIcon, PlusIcon, SquareMousePointer, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";

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
</script>
<div class="flex flex-col items-center w-full overflow-y-auto h-full">
    {#each sortChar(DBState.db.characters, search) as char, i (char.chaId)}
        <div class="flex items-center border-t-darkborderc w-full" class:border-t={i !== 0}>
            <div class="shrink-0 p-2 pr-0">
                <BarIcon
                    onClick={() => {
                        changeChar(char.i)
                        endGrid()
                    }}
                    additionalStyle={() => getCharImage(char.image, 'css')}
                />
            </div>
            <button class="flex min-w-0 flex-1 p-2 text-left" onclick={() => {
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
    {/each}
</div>

{#if gridMode}
    <button class="p-4 rounded-full absolute bottom-2 right-2 bg-borderc" onclick={() => {
        addCharacter()
    }}>
        <PlusIcon size={24} />
    </button>
{/if}
