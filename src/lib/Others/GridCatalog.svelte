<script lang="ts">
    import { cancelCharacterChatPrefetch, changeChar, getCharThumbnail, prefetchCharacterChat, removeChar, scheduleCharacterChatPrefetch } from "../../ts/characters";
    import { promptActivateCharacter } from "../../ts/characterArchive";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { findCharacterIndexbyId } from "../../ts/util";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, MessageSquareIcon, PaletteIcon, User, SquareMousePointer, TrashIcon, Undo2Icon } from "@lucide/svelte";
    import { selectedCharID } from "../../ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { makeAgoText, parseMultilangString } from "src/ts/util";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    import { getCharacterAssetCount } from "src/ts/gui/characterAssetCount";
    import { resolveCharacterSourceBadge } from "src/ts/gui/characterSourceBadge";
    import { editCharacterTitleColor } from "src/ts/gui/characterTitleColor";
    import { isRealmAssetRecoveryAvailable, listTitleColor } from "src/ts/gui/titleColors";
    import VirtualGrid from "../UI/Virtual/VirtualGrid.svelte";
    import VirtualList from "../UI/Virtual/VirtualList.svelte";

    interface Props { endGrid?: () => void }
    let { endGrid = () => {} }: Props = $props();
    let search = $state('')
    let selected = $state(3)

    function selectAndClose(index = -1){ changeChar(index); endGrid() }

    type CatalogEntry = {
        image:string; index:number; name:string; desc:string; chaId:string; archived:boolean;
        assetCount:number; sourceBadge:string; sourceRecorded:boolean;
        chats:number; interaction:number; agoText:string;
        missingAssetCount:number; realmRecoveryAvailable:boolean; titleColor?:string;
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
                missingAssetCount: c.sourceInfo?.missingAssetCount ?? 0,
                realmRecoveryAvailable: isRealmAssetRecoveryAvailable(c),
                titleColor: c.titleColor,
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
                    missingAssetCount: stub.sourceInfo?.missingAssetCount ?? 0,
                    realmRecoveryAvailable: isRealmAssetRecoveryAvailable(stub),
                    titleColor: stub.titleColor,
                })
            }
        }
        return charas.sort((a, b) => b.interaction - a.interaction || a.name.localeCompare(b.name))
    }

    function schedulePrefetch(index:number){ if(index >= 0) scheduleCharacterChatPrefetch(index) }
    function cancelPrefetch(index:number){ if(index >= 0) cancelCharacterChatPrefetch(index) }
    function immediatePrefetch(index:number){ if(index >= 0) void prefetchCharacterChat(index) }

    const characters = $derived(formatChars(search, DBState.db))
    const trashedCharacters = $derived(formatChars(search, DBState.db, true))
</script>

<div class="flex h-full w-full justify-center">
    <div class="flex h-full w-2xl max-w-full flex-col overflow-hidden bg-darkbg p-6">
        <div class="mx-4 mb-6 flex shrink-0 flex-col">
            <div class="mb-2 flex items-center gap-3">
                <button class="flex shrink-0 items-center justify-center rounded-lg p-2 transition-colors hover:bg-selected" onclick={endGrid} title={language.goback}><ArrowLeft size={20}/></button>
                <div class="flex-1"><TextInput placeholder={language.search} bind:value={search} autocomplete="off" fullwidth={true}/></div>
            </div>
            <div class="mt-2 flex flex-wrap gap-2">
                <Button styled={selected === 3 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 3}>{language.simple}</Button>
                <Button styled={selected === 0 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 0}>{language.grid}</Button>
                <Button styled={selected === 1 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 1}>{language.list}</Button>
                <Button styled={selected === 2 ? 'primary' : 'outlined'} size="sm" onclick={() => selected = 2}>{language.trash}</Button>
                <div class="grow"></div><span class="text-sm text-textcolor2">{characters.length} {language.character}</span>
            </div>
        </div>
        {#if selected === 0}
            <VirtualGrid items={characters} minItemWidth={64} gap={8} className="min-h-0 flex-1" key={(char) => char.chaId}>
                {#snippet children(char)}
                    <div class="relative flex h-full w-full items-center justify-center text-textcolor" class:opacity-40={char.archived} class:grayscale={char.archived} title={`${char.name} · ${char.sourceBadge} · 에셋 ${char.assetCount}개`}>
                        {#if char.image}
                            <BarIcon
                                onPrefetch={() => schedulePrefetch(char.index)}
                                onPrefetchCancel={() => cancelPrefetch(char.index)}
                                onPrefetchImmediate={() => immediatePrefetch(char.index)}
                                onClick={() => void openChar(char)}
                                additionalStyle={() => getCharThumbnail(char.image, 'css')}
                            />
                        {:else}
                            <BarIcon
                                onPrefetch={() => schedulePrefetch(char.index)}
                                onPrefetchCancel={() => cancelPrefetch(char.index)}
                                onPrefetchImmediate={() => immediatePrefetch(char.index)}
                                onClick={() => void openChar(char)}
                                additionalStyle={char.index === $selectedCharID ? 'background:var(--risu-theme-selected)' : ''}
                            ><User/></BarIcon>
                        {/if}
                        <span class="pointer-events-none absolute -bottom-1 left-0 rounded border border-darkborderc bg-darkbg/95 px-0.5 text-[8px]">[{char.sourceBadge}]</span>
                        {#if char.missingAssetCount > 0}
                            <span class="pointer-events-none absolute right-0 top-0 text-xs" class:text-emerald-400={char.realmRecoveryAvailable} aria-label={char.realmRecoveryAvailable ? 'Realm 에셋 복구 가능' : '에셋 누락'}>{char.realmRecoveryAvailable ? '!' : '❗'}</span>
                        {/if}
                    </div>
                {/snippet}
            </VirtualGrid>
        {:else if selected === 1}
            <VirtualList items={characters} itemHeight={142} className="min-h-0 flex-1" key={(char) => char.chaId}>
                {#snippet children(char)}
                    <div class="m-1 flex h-[134px] rounded-md border border-darkborderc p-2" class:opacity-60={char.archived}>
                        <div class:grayscale={char.archived}>
                            <BarIcon
                                onPrefetch={() => schedulePrefetch(char.index)}
                                onPrefetchCancel={() => cancelPrefetch(char.index)}
                                onPrefetchImmediate={() => immediatePrefetch(char.index)}
                                onClick={() => void openChar(char)}
                                additionalStyle={() => getCharThumbnail(char.image, 'css')}
                            />
                        </div>
                        <div class="ml-2 flex min-w-0 flex-1 flex-col">
                            <h4 class="mb-1 flex min-w-0 items-center gap-1 text-lg font-bold text-textcolor" style:color={listTitleColor(char.titleColor, char.missingAssetCount > 0)}>
                                <span class="truncate">{char.name || 'Unnamed'}</span>
                                {#if char.missingAssetCount > 0}
                                    {#if char.realmRecoveryAvailable}<span class="shrink-0 font-black text-emerald-400" aria-label="Realm 에셋 복구 가능">!</span>{:else}<span class="shrink-0" aria-label="에셋 누락">❗</span>{/if}
                                {/if}
                                {#if char.archived}<span class="shrink-0 rounded border border-darkborderc px-1 text-xs font-normal text-textcolor2">{language.deactivatedBadge}</span>{/if}
                                <span class="shrink-0 text-xs font-normal text-textcolor2">[{char.sourceBadge}]</span>
                            </h4>
                            <span class="line-clamp-2 text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                            <div class="mt-1 flex items-center text-sm text-textcolor2">
                                <span class="mr-1">{char.chats}</span><MessageSquareIcon size={14}/><span class="mx-1">|</span><span>{char.agoText}</span><span class="mx-1">|</span><span>에셋 {char.assetCount.toLocaleString()}개</span>
                                {#if char.missingAssetCount > 0}<span class="ml-1 text-red-400">· 누락 {char.missingAssetCount.toLocaleString()}개</span>{/if}
                            </div>
                            <div class="flex justify-end gap-2">
                                {#if !char.archived}<button class="text-textcolor2 hover:text-textcolor" title="제목 색변경" aria-label="제목 색변경" onclick={() => editCharacterTitleColor(char.chaId)}><PaletteIcon/></button>{/if}
                                <button class="text-textcolor2 hover:text-textcolor" title={language.selectChar} aria-label={language.selectChar} onclick={() => void openChar(char)}><SquareMousePointer/></button>
                                {#if !char.archived}<button class="text-textcolor2 hover:text-textcolor" title={language.trash} aria-label={language.trash} onclick={() => removeChar(char.chaId, char.name)}><TrashIcon/></button>{/if}
                            </div>
                        </div>
                    </div>
                {/snippet}
            </VirtualList>
        {:else if selected === 2}
            <span class="mb-2 shrink-0 text-sm text-textcolor2">{language.trashDesc}</span>
            <VirtualList items={trashedCharacters} itemHeight={126} className="min-h-0 flex-1" key={(char) => char.chaId}>
                {#snippet children(char)}
                    <div class="m-1 flex h-[118px] rounded-md border border-darkborderc p-2">
                        <BarIcon onClick={() => selectAndClose(char.index)} additionalStyle={() => getCharThumbnail(char.image, 'css')}/>
                        <div class="ml-2 flex flex-1 flex-col">
                            <h4 class="mb-1 text-lg font-bold text-textcolor" style:color={listTitleColor(char.titleColor, char.missingAssetCount > 0)}>{char.name || 'Unnamed'}</h4>
                            <div class="flex justify-end gap-2">
                                <button class="text-textcolor2 hover:text-textcolor" onclick={() => { const idx=findCharacterIndexbyId(char.chaId); if(idx!==-1){DBState.db.characters[idx].trashTime=undefined; checkCharOrder()} }}><Undo2Icon/></button>
                                <button class="text-textcolor2 hover:text-textcolor" onclick={() => removeChar(char.chaId, char.name, 'permanent')}><TrashIcon/></button>
                            </div>
                        </div>
                    </div>
                {/snippet}
            </VirtualList>
        {:else}
            <MobileCharacters {search} gridMode endGrid={endGrid}/>
        {/if}
    </div>
</div>
