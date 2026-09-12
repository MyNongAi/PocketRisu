<script lang="ts">
    import { type Database } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage, removeChar } from "src/ts/characters";
    import { promptActivateCharacter } from "src/ts/characterArchive";
    import { makeAgoText } from "src/ts/util";
    import { language } from "src/lang";
    import { MessageSquareIcon, PlusIcon, SquareMousePointer, TrashIcon } from "@lucide/svelte";
    import { getCharacterAssetCount } from "src/ts/gui/characterAssetCount";
    import { resolveCharacterSourceBadge } from "src/ts/gui/characterSourceBadge";

    interface Props {
        search: string;
        gridMode?: boolean;
        endGrid?: () => void;
    }

    let {search, gridMode = false, endGrid = () => {}}: Props = $props();

    function sortChar(db: Database) {
        const list = db.characters.map((c, i) => {
            const source = resolveCharacterSourceBadge(c.sourceInfo?.label)
            return {
                name: c.name || "Unnamed",
                image: c.image,
                chats: c.chats.length,
                i,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
                archived: false,
                chaId: c.chaId,
                assetCount: getCharacterAssetCount(c),
                sourceBadge: source.label,
            }
        }).filter((c) => !db.characters[c.i].trashTime)
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
                    assetCount: stub.assetCount ?? 0,
                    sourceBadge: resolveCharacterSourceBadge(stub.sourceInfo?.label).label,
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
    {#each sortChar(DBState.db) as char, i (char.chaId)}
        {#if char.name.replace(/ /g,"").toLocaleLowerCase().includes(search.replace(/ /g,"").toLocaleLowerCase())}
            <div class="flex w-full items-center gap-2 border-t-darkborderc p-2" class:border-t={i !== 0} class:opacity-60={char.archived}>
                <div class="shrink-0" class:grayscale={char.archived}>
                    <BarIcon onClick={() => void open(char)} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                </div>
                <button class="flex min-w-0 flex-1 flex-col items-start justify-start text-start" onclick={() => void open(char)}>
                    <span>{char.name}{#if char.archived}<span class="ml-1 rounded border border-darkborderc px-1 py-0.5 align-middle text-xs text-textcolor2">{language.deactivatedBadge}</span>{/if}</span>
                    <span class="text-xs text-textcolor2">[{char.sourceBadge}] · 에셋 {char.assetCount}개</span>
                    <div class="flex w-full flex-wrap items-center text-sm text-textcolor2">
                        <span class="mr-1">{char.chats}</span><MessageSquareIcon size={14}/><span class="mx-1">|</span><span>{char.agoText}</span>
                    </div>
                </button>
                {#if gridMode}
                    <div class="flex shrink-0 items-center gap-1">
                        <button class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor" title={language.selectChar} aria-label={language.selectChar} onclick={() => void open(char)}>
                            <SquareMousePointer size={20}/>
                        </button>
                        {#if !char.archived}
                            <button class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-red-500/10 hover:text-red-400" title={language.trash} aria-label={language.trash} onclick={() => removeChar(char.chaId, char.name)}>
                                <TrashIcon size={20}/>
                            </button>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}
    {/each}
</div>

{#if gridMode}
    <button class="absolute bottom-2 right-2 rounded-full bg-borderc p-4" onclick={() => addCharacter()}><PlusIcon size={24}/></button>
{/if}
