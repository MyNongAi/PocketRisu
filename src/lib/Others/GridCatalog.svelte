<script lang="ts">
    import { cancelCharacterChatPrefetch, changeChar, getCharThumbnail, prefetchCharacterChat, removeChar, scheduleCharacterChatPrefetch } from "../../ts/characters";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { findCharacterIndexbyId } from "../../ts/util";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, MessageSquareIcon, User, SquareMousePointer, TrashIcon, Undo2Icon, PaletteIcon } from "@lucide/svelte";
    import { listTitleColor } from "src/ts/gui/titleColors";
    import { editCharacterTitleColor } from "src/ts/gui/characterTitleColor";
    import { selectedCharID } from "../../ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { makeAgoText, parseMultilangString } from "src/ts/util";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    import VirtualGrid from "../UI/Virtual/VirtualGrid.svelte";
    import VirtualList from "../UI/Virtual/VirtualList.svelte";
    interface Props {
        endGrid?: any;
    }

    let { endGrid = () => {} }: Props = $props();
    let search = $state('')
    let selected = $state(3)

    function selectAndClose(index = -1){
        changeChar(index)
        endGrid()
    }

    function formatChars(search:string, db:Database, trash = false){
        let charas:{
            image:string
            index:number
            type:string,
            name:string
            desc:string
            chaId:string
            chats:number
            interaction:number
            agoText:string
            missingAssetCount:number
            titleColor?:string
        }[] = []

        for(let i=0;i<db.characters.length;i++){
            const c = db.characters[i]
            if(c.trashTime && !trash){
                continue
            }
            if(!c.trashTime && trash){
                continue
            }
            if(c.name.replace(/ /g,"").toLocaleLowerCase().includes(search.toLocaleLowerCase().replace(/ /g,""))){
                charas.push({
                    image: c.image,
                    index: i,
                    type: c.type,
                    name: c.name,
                    desc: c.creatorNotes ?? 'No description',
                    chaId: c.chaId,
                    chats: c.chats.length,
                    interaction: c.lastInteraction ?? 0,
                    agoText: makeAgoText(c.lastInteraction ?? 0),
                    missingAssetCount: c.sourceInfo?.missingAssetCount ?? 0,
                    titleColor: c.titleColor,
                })
            }
        }
        return charas.sort((a, b) => {
            if(a.interaction === b.interaction){
                return a.name.localeCompare(b.name)
            }
            return b.interaction - a.interaction
        })
    }
    let characters = $derived(formatChars(search, DBState.db))
    let trashedCharacters = $derived(formatChars(search, DBState.db, true))
</script>

<div class="h-full w-full flex justify-center">
    <div class="h-full p-6 bg-darkbg max-w-full w-2xl flex flex-col overflow-hidden">
        <div class="mx-4 mb-6 flex shrink-0 flex-col">
            <div class="flex items-center gap-3 mb-2">
                <button 
                    class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
                    onclick={() => endGrid()}
                    title="Back"
                >
                    <ArrowLeft size={20} />
                </button>
                <div class="flex-1">
                    <TextInput placeholder="Search" bind:value={search} autocomplete="off" fullwidth={true}/>
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mt-2">
                <Button styled={selected === 3 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 3}}>
                    {language.simple}
                </Button>
                <Button styled={selected === 0 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 0}}>
                    {language.grid}
                </Button>
                <Button styled={selected === 1  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 1}}>
                    {language.list}
                </Button>
                <Button styled={selected === 2  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 2}}>
                    {language.trash}
                </Button>
                <div class="grow"></div>
                <span class="text-textcolor2 text-sm">
                    {characters.length} {language.character}
                </span>
            </div>
        </div>
        {#if selected === 0}
            <VirtualGrid items={characters} minItemWidth={64} gap={8} className="min-h-0 flex-1" key={(char) => char.chaId}>
                {#snippet children(char)}
                        <div class="flex h-full w-full items-center justify-center text-textcolor">
                            {#if char.image}
                                <BarIcon
                                    onPrefetch={() => scheduleCharacterChatPrefetch(char.index)}
                                    onPrefetchCancel={() => cancelCharacterChatPrefetch(char.index)}
                                    onPrefetchImmediate={() => void prefetchCharacterChat(char.index)}
                                    onClick={() => {selectAndClose(char.index)}}
                                    additionalStyle={() => getCharThumbnail(char.image, 'css')}
                                ></BarIcon>
                            {:else}
                                <BarIcon
                                    onPrefetch={() => scheduleCharacterChatPrefetch(char.index)}
                                    onPrefetchCancel={() => cancelCharacterChatPrefetch(char.index)}
                                    onPrefetchImmediate={() => void prefetchCharacterChat(char.index)}
                                    onClick={() => {selectAndClose(char.index)}}
                                    additionalStyle={char.index === $selectedCharID ? 'background:var(--risu-theme-selected)' : ''}
                                >
                                            <User/>
                                </BarIcon>
                            {/if}
                        </div>
                {/snippet}
            </VirtualGrid>
        {:else if selected === 1}
            <VirtualList items={characters} itemHeight={142} className="min-h-0 flex-1" key={(char) => char.chaId}>
              {#snippet children(char)}
                <div class="m-1 flex h-[134px] p-2 border border-darkborderc rounded-md">
                    <BarIcon
                        onPrefetch={() => scheduleCharacterChatPrefetch(char.index)}
                        onPrefetchCancel={() => cancelCharacterChatPrefetch(char.index)}
                        onPrefetchImmediate={() => void prefetchCharacterChat(char.index)}
                        onClick={() => {selectAndClose(char.index)}}
                        additionalStyle={() => getCharThumbnail(char.image, 'css')}
                    ></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="font-bold text-lg mb-1 text-textcolor" style:color={listTitleColor(char.titleColor, char.missingAssetCount > 0)}>{char.name || "Unnamed"}</h4>
                        <span class="line-clamp-2 text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="mt-1 flex items-center text-sm text-textcolor2">
                            <span class="mr-1">{char.chats}</span>
                            <MessageSquareIcon size={14} />
                            <span class="mx-1">|</span>
                            <span>{char.agoText}</span>
                        </div>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" title="제목 색변경" aria-label="제목 색변경" onclick={() => editCharacterTitleColor(char.chaId)}>
                                <PaletteIcon />
                            </button>
                            <button
                                class="hover:text-textcolor text-textcolor2"
                                title={language.selectChar}
                                aria-label={language.selectChar}
                                onpointerenter={() => scheduleCharacterChatPrefetch(char.index)}
                                onpointerleave={() => cancelCharacterChatPrefetch(char.index)}
                                onpointerdown={() => void prefetchCharacterChat(char.index)}
                                onclick={() => {
                                selectAndClose(char.index)
                            }}>
                                <SquareMousePointer />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" title={language.trash} aria-label={language.trash} onclick={() => {
                                removeChar(char.chaId, char.name)
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
              {/snippet}
            </VirtualList>
        {:else if selected === 2}
            <span class="shrink-0 text-textcolor2 text-sm mb-2">{language.trashDesc}</span>
            <VirtualList items={trashedCharacters} itemHeight={126} className="min-h-0 flex-1" key={(char) => char.chaId}>
              {#snippet children(char)}
                <div class="m-1 flex h-[118px] p-2 border border-darkborderc rounded-md">
                    <BarIcon onClick={() => {selectAndClose(char.index)}} additionalStyle={() => getCharThumbnail(char.image, 'css')}></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="font-bold text-lg mb-1 text-textcolor" style:color={listTitleColor(char.titleColor, char.missingAssetCount > 0)}>{char.name || "Unnamed"}</h4>
                        <span class="line-clamp-2 text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                const restoreIdx = findCharacterIndexbyId(char.chaId)
                                if (restoreIdx !== -1) {
                                    DBState.db.characters[restoreIdx].trashTime = undefined
                                    checkCharOrder()
                                }
                            }}>
                                <Undo2Icon />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                removeChar(char.chaId, char.name, 'permanent')
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
              {/snippet}
            </VirtualList>
        {:else if selected === 3}
            <MobileCharacters {search} gridMode endGrid={endGrid} />
        {/if}
    </div>
</div>
