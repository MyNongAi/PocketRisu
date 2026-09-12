<script lang="ts">
    import { changeChar, getCharImage, removeChar } from "../../ts/characters";
    import { promptActivateCharacter } from "../../ts/characterArchive";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { findCharacterIndexbyId } from "../../ts/util";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, MessageSquareIcon, User, SquareMousePointer, TrashIcon, Undo2Icon } from "@lucide/svelte";
    import { selectedCharID } from "../../ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { makeAgoText, parseMultilangString } from "src/ts/util";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    import { getCharacterAssetCount } from "src/ts/gui/characterAssetCount";
    import { resolveCharacterSourceBadge } from "src/ts/gui/characterSourceBadge";

    interface Props { endGrid?: () => void }
    let { endGrid = () => {} }: Props = $props();
    let search = $state('')
    let selected = $state(3)

    function selectAndClose(index = -1){ changeChar(index); endGrid() }

    type CatalogEntry = {
        image:string; index:number; name:string; desc:string; chaId:string; archived:boolean;
        assetCount:number; sourceBadge:string; sourceRecorded:boolean;
        chats:number; interaction:number; agoText:string;
    }

    async function openChar(char: CatalogEntry){
        if(char.archived){
            const opened = await promptActivateCharacter(char.chaId)
            if(opened) endGrid()
            return
        }
        selectAndClose(char.index)
    }

    function matchesSearch(name:string, value:string){
        return (name ?? '').replace(/ /g,"").toLocaleLowerCase().includes(value.toLocaleLowerCase().replace(/ /g,""))
    }

    function formatChars(value:string, db:Database, trash = false){
        const charas:CatalogEntry[] = []
        for(let i=0;i<db.characters.length;i++){
            const c = db.characters[i]
            if(!!c.trashTime !== trash || !matchesSearch(c.name, value)) continue
            const source = resolveCharacterSourceBadge(c.sourceInfo?.label)
            charas.push({
                image: c.image, index: i, name: c.name, desc: c.creatorNotes ?? 'No description',
                chaId: c.chaId, archived: false, assetCount: getCharacterAssetCount(c),
                sourceBadge: source.label, sourceRecorded: source.recorded,
                chats: c.chats.length, interaction: c.lastInteraction ?? 0,
                agoText: makeAgoText(c.lastInteraction ?? 0),
            })
        }
        if(!trash && !db.nodeOnlyHideArchivedCharacters){
            for(const stub of db.nodeOnlyArchivedCharacters ?? []){
                if(!stub?.chaId || stub.trashedAt || !matchesSearch(stub.name, value)) continue
                const source = resolveCharacterSourceBadge(stub.sourceInfo?.label)
                charas.push({
                    image: stub.image, index: -1, name: stub.name, desc: language.deactivatedBadge,
                    chaId: stub.chaId, archived: true, assetCount: stub.assetCount ?? 0,
                    sourceBadge: source.label, sourceRecorded: source.recorded,
                    chats: stub.chatCount ?? 0, interaction: stub.lastInteraction ?? 0,
                    agoText: makeAgoText(stub.lastInteraction ?? 0),
                })
            }
        }
        return charas
    }
</script>

<div class="flex h-full w-full justify-center">
    <div class="flex h-full w-2xl max-w-full flex-col overflow-y-auto bg-darkbg p-6">
        <div class="mx-4 mb-6 flex flex-col">
            <div class="mb-2 flex items-center gap-3">
                <button class="flex shrink-0 items-center justify-center rounded-lg p-2 transition-colors hover:bg-selected" onclick={endGrid} title={language.goback}><ArrowLeft size={20}/></button>
                <div class="flex-1"><TextInput placeholder={language.search} bind:value={search} autocomplete="off" fullwidth={true}/></div>
            </div>
            <div class="mt-2 flex flex-wrap gap-2">
                <Button styled={selected === 3 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 3}>{language.simple}</Button>
                <Button styled={selected === 0 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 0}>{language.grid}</Button>
                <Button styled={selected === 1 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 1}>{language.list}</Button>
                <Button styled={selected === 2 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 2}>{language.trash}</Button>
                <div class="grow"></div><span class="text-sm text-textcolor2">{formatChars(search, DBState.db).length} {language.character}</span>
            </div>
        </div>
        {#if selected === 0}
            <div class="flex w-full flex-wrap justify-center gap-2">
                {#each formatChars(search, DBState.db) as char}
                    <div class="relative flex items-center text-textcolor" class:opacity-40={char.archived} class:grayscale={char.archived} title={`${char.name} · ${char.sourceBadge} · 에셋 ${char.assetCount}개`}>
                        {#if char.image}<BarIcon onClick={() => openChar(char)} additionalStyle={getCharImage(char.image, 'css')}/>{:else}<BarIcon onClick={() => openChar(char)} additionalStyle={char.index === $selectedCharID ? 'background:var(--risu-theme-selected)' : ''}><User/></BarIcon>{/if}
                        <span class="pointer-events-none absolute -bottom-1 left-0 rounded border border-darkborderc bg-darkbg/95 px-0.5 text-[8px]">[{char.sourceBadge}]</span>
                    </div>
                {/each}
            </div>
        {:else if selected === 1}
            {#each formatChars(search, DBState.db) as char}
                <div class="mb-2 flex rounded-md border border-darkborderc p-2" class:opacity-60={char.archived}>
                    <div class:grayscale={char.archived}><BarIcon onClick={() => openChar(char)} additionalStyle={getCharImage(char.image, 'css')}/></div>
                    <div class="ml-2 flex flex-1 flex-col"><h4 class="mb-1 text-lg font-bold text-textcolor">{char.name || 'Unnamed'}</h4>
                        <span class="text-xs text-textcolor2">[{char.sourceBadge}] · 에셋 {char.assetCount}개</span>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="mt-1 flex items-center text-sm text-textcolor2"><span class="mr-1">{char.chats}</span><MessageSquareIcon size={14}/><span class="mx-1">|</span><span>{char.agoText}</span></div>
                        <div class="flex justify-end gap-2"><button class="text-textcolor2 hover:text-textcolor" onclick={() => openChar(char)}><SquareMousePointer/></button>{#if !char.archived}<button class="text-textcolor2 hover:text-textcolor" onclick={() => removeChar(char.chaId, char.name)}><TrashIcon/></button>{/if}</div>
                    </div>
                </div>
            {/each}
        {:else if selected === 2}
            <span class="mb-2 text-sm text-textcolor2">{language.trashDesc}</span>
            {#each formatChars(search, DBState.db, true) as char}
                <div class="mb-2 flex rounded-md border border-darkborderc p-2"><BarIcon onClick={() => selectAndClose(char.index)} additionalStyle={getCharImage(char.image, 'css')}/><div class="ml-2 flex flex-1 flex-col"><h4 class="mb-1 text-lg font-bold text-textcolor">{char.name || 'Unnamed'}</h4><div class="flex justify-end gap-2"><button class="text-textcolor2 hover:text-textcolor" onclick={() => { const idx=findCharacterIndexbyId(char.chaId); if(idx!==-1){DBState.db.characters[idx].trashTime=undefined; checkCharOrder()} }}><Undo2Icon/></button><button class="text-textcolor2 hover:text-textcolor" onclick={() => removeChar(char.chaId, char.name, 'permanent')}><TrashIcon/></button></div></div></div>
            {/each}
        {:else}
            <MobileCharacters {search} gridMode endGrid={endGrid}/>
        {/if}
    </div>
</div>
