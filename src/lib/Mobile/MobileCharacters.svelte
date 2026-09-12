<script lang="ts">
    import { type Database } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, cancelCharacterChatPrefetch, changeChar, getCharThumbnail, prefetchCharacterChat, removeChar, scheduleCharacterChatPrefetch } from "src/ts/characters";
    import { promptActivateCharacter } from "src/ts/characterArchive";
    import { makeAgoText } from "src/ts/util";
    import { language } from "src/lang";
    import { MessageSquareIcon, PaletteIcon, PlusIcon, SquareMousePointer, TrashIcon } from "@lucide/svelte";
    import { getCharacterAssetCount } from "src/ts/gui/characterAssetCount";
    import { resolveCharacterSourceBadge } from "src/ts/gui/characterSourceBadge";
    import { editCharacterTitleColor } from "src/ts/gui/characterTitleColor";
    import { isRealmAssetRecoveryAvailable, listTitleColor } from "src/ts/gui/titleColors";
    import VirtualList from "../UI/Virtual/VirtualList.svelte";

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
                missingAssetCount: c.sourceInfo?.missingAssetCount ?? 0,
                realmRecoveryAvailable: isRealmAssetRecoveryAvailable(c),
                titleColor: c.titleColor,
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
                    missingAssetCount: stub.sourceInfo?.missingAssetCount ?? 0,
                    realmRecoveryAvailable: isRealmAssetRecoveryAvailable(stub),
                    titleColor: stub.titleColor,
                })
            }
        }
        const normalizedSearch = search.replace(/ /g, "").toLocaleLowerCase()
        return list
            .filter((char) => char.name.replace(/ /g, "").toLocaleLowerCase().includes(normalizedSearch))
            .sort((a, b) => b.interaction - a.interaction || a.name.localeCompare(b.name));
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

    function schedulePrefetch(index: number) {
        if (index >= 0) scheduleCharacterChatPrefetch(index)
    }

    function cancelPrefetch(index: number) {
        if (index >= 0) cancelCharacterChatPrefetch(index)
    }

    function immediatePrefetch(index: number) {
        if (index >= 0) void prefetchCharacterChat(index)
    }

    const sortedCharacters = $derived(sortChar(DBState.db))
</script>

<VirtualList items={sortedCharacters} itemHeight={76} className="h-full w-full" key={(char) => char.chaId}>
    {#snippet children(char, i)}
        <div class="flex h-full w-full items-center border-t-darkborderc" class:border-t={i !== 0} class:opacity-60={char.archived}>
            <div class="shrink-0 p-2 pr-0" class:grayscale={char.archived}>
                <BarIcon
                    onPrefetch={() => schedulePrefetch(char.i)}
                    onPrefetchCancel={() => cancelPrefetch(char.i)}
                    onPrefetchImmediate={() => immediatePrefetch(char.i)}
                    onClick={() => void open(char)}
                    additionalStyle={() => getCharThumbnail(char.image, 'css')}
                />
            </div>
            <button
                class="flex min-w-0 flex-1 p-2 text-left"
                onpointerenter={() => schedulePrefetch(char.i)}
                onpointerleave={() => cancelPrefetch(char.i)}
                onpointerdown={() => immediatePrefetch(char.i)}
                onfocus={() => schedulePrefetch(char.i)}
                onblur={() => cancelPrefetch(char.i)}
                onclick={() => void open(char)}
            >
                <div class="flex w-full min-w-0 flex-1 flex-col items-start justify-start text-start">
                    <div class="flex max-w-full min-w-0 items-center gap-1">
                        <span class="truncate" style:color={listTitleColor(char.titleColor, char.missingAssetCount > 0)}>{char.name}</span>
                        {#if char.missingAssetCount > 0}
                            {#if char.realmRecoveryAvailable}<span class="shrink-0 font-black text-emerald-400" aria-label="Realm 에셋 복구 가능" title="Realm 에셋 복구 가능">!</span>{:else}<span class="shrink-0" aria-label="에셋 누락" title="확인된 Realm 복구 원본 없음">❗</span>{/if}
                        {/if}
                        {#if char.archived}<span class="shrink-0 rounded border border-darkborderc px-1 py-0.5 text-xs text-textcolor2">{language.deactivatedBadge}</span>{/if}
                        <span class="shrink-0 text-[10px] text-textcolor2">[{char.sourceBadge}]</span>
                    </div>
                    <div class="flex w-full items-center overflow-hidden whitespace-nowrap text-sm text-textcolor2">
                        <span class="mr-1">{char.chats}</span><MessageSquareIcon size={14}/><span class="mx-1">|</span>
                        <span>{char.agoText}</span><span class="mx-1">|</span>
                        <span>에셋 {char.assetCount.toLocaleString()}개</span>
                        {#if char.missingAssetCount > 0}<span class="ml-1 text-red-400">· 누락 {char.missingAssetCount.toLocaleString()}개</span>{/if}
                    </div>
                </div>
            </button>
            {#if !char.archived}
                <button class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor" title="제목 색변경" aria-label="제목 색변경" onclick={() => editCharacterTitleColor(char.chaId)}><PaletteIcon size={20}/></button>
            {/if}
            {#if gridMode}
                <div class="flex shrink-0 items-center gap-1 pr-2">
                    <button class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor" title={language.selectChar} aria-label={language.selectChar} onclick={() => void open(char)}><SquareMousePointer size={20}/></button>
                    {#if !char.archived}<button class="rounded-md p-2 text-textcolor2 transition-colors hover:bg-red-500/10 hover:text-red-400" title={language.trash} aria-label={language.trash} onclick={() => removeChar(char.chaId, char.name)}><TrashIcon size={20}/></button>{/if}
                </div>
            {/if}
        </div>
    {/snippet}
</VirtualList>

{#if gridMode}
    <button class="absolute bottom-2 right-2 rounded-full bg-borderc p-4" onclick={() => addCharacter()}><PlusIcon size={24}/></button>
{/if}
