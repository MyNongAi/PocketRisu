<script lang="ts">
    import { type Database } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage } from "src/ts/characters";
    import { promptActivateCharacter } from "src/ts/characterArchive";
    import { makeAgoText } from "src/ts/util";
    import { language } from "src/lang";
    import { MessageSquareIcon, PlusIcon } from "@lucide/svelte";

    interface Props {
        search: string;
        gridMode?: boolean;
        endGrid?: () => void;
    }

    let {search, gridMode = false, endGrid = () => {}}: Props = $props();

    function sortChar(db: Database) {
        const list = db.characters.map((c, i) => ({
            name: c.name || "Unnamed",
            image: c.image,
            chats: c.chats.length,
            i,
            interaction: c.lastInteraction || 0,
            agoText: makeAgoText(c.lastInteraction || 0),
            archived: false,
            chaId: c.chaId,
        })).filter((c) => !db.characters[c.i].trashTime)
        if (!db.nodeOnlyHideArchivedCharacters) {
            for (const stub of db.nodeOnlyArchivedCharacters ?? []) {
                if (!stub?.chaId || stub.trashedAt) continue
                list.push({
                    name: stub.name || "Unnamed",
                    image: stub.image,
                    chats: stub.chatCount ?? 0,
                    i: -1,
                    interaction: stub.lastInteraction || 0,
                    agoText: makeAgoText(stub.lastInteraction || 0),
                    archived: true,
                    chaId: stub.chaId,
                })
            }
        }
        return list.sort((a, b) => b.interaction - a.interaction || a.name.localeCompare(b.name));
    }

    async function open(char: { i: number; archived: boolean; chaId: string }) {
        if (char.archived) {
            const opened = await promptActivateCharacter(char.chaId)
            if (opened) endGrid()
            return
        }
        changeChar(char.i)
        endGrid()
    }
</script>

<div class="flex h-full w-full flex-col items-center overflow-y-auto">
    {#each sortChar(DBState.db) as char, i}
        {#if char.name.replace(/ /g,"").toLocaleLowerCase().includes(search.replace(/ /g,"").toLocaleLowerCase())}
            <button class="flex w-full gap-2 p-2 border-t-darkborderc" class:border-t={i !== 0} class:opacity-60={char.archived} onclick={() => void open(char)}>
                <div class:grayscale={char.archived}>
                    <BarIcon additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                </div>
                <div class="flex w-full flex-1 flex-col items-start justify-start text-start">
                    <span>{char.name}{#if char.archived}<span class="ml-1 rounded border border-darkborderc px-1 py-0.5 align-middle text-xs text-textcolor2">{language.deactivatedBadge}</span>{/if}</span>
                    <div class="flex w-full flex-wrap items-center text-sm text-textcolor2">
                        <span class="mr-1">{char.chats}</span><MessageSquareIcon size={14}/><span class="mx-1">|</span><span>{char.agoText}</span>
                    </div>
                </div>
            </button>
        {/if}
    {/each}
</div>

{#if gridMode}
    <button class="absolute bottom-2 right-2 rounded-full bg-borderc p-4" onclick={() => addCharacter()}><PlusIcon size={24}/></button>
{/if}
