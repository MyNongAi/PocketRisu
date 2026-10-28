<script lang="ts">
    import { XIcon, LinkIcon, SunIcon, MoonIcon, PaletteIcon, CheckIcon, BookCopyIcon, FolderIcon, FolderOpen, PlusIcon } from "@lucide/svelte";
    import { isAutoIllustration, loreRole, setLoreRole, type LoreRole } from "src/ts/process/auxLorebook";
    import ShContextMenu from "../../UI/GUI/ShContextMenu.svelte";
    import ShDropdownMenuItem from "../../UI/GUI/ShDropdownMenuItem.svelte";
    import { v4 } from "uuid";
    import { language } from "../../../lang";
    import { getCurrentCharacter, getCurrentChat, type loreBook } from "../../../ts/storage/database.svelte";
    import { alertConfirm, alertMd } from "../../../ts/alert";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import Help from "../../Others/Help.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import TextAreaInput from "../../UI/GUI/TextAreaInput.svelte";
    import { tokenizeAccurate } from "src/ts/tokenizer";
    import { DBState } from "src/ts/stores.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import type { LoreComparisonStatus } from "src/ts/gui/loreBookComparison";
    import { findTextMatches, splitAtMatches } from "src/ts/gui/textMatches";
    import { countChars } from "src/ts/gui/charCount";

    interface Props {
        value: loreBook;
        onRemove?: () => void;
        onClose?: (isDetail?: boolean) => void;
        onOpen?: (isDetail?: boolean) => void;
        idx: number;
        externalLoreBooks?: loreBook[];
        idgroup: string;
        isOpen?: boolean;
        openFolders?: number;
        isLastInContainer?: boolean;
        comparisonStatus?: LoreComparisonStatus;
        comparisonStatuses?: ReadonlyMap<loreBook, LoreComparisonStatus>;
        /** The list's search text (loreBookSearch.ts), marked in the entry. */
        searchText?: string;
    }

    let {
        value = $bindable(),
        onRemove = () => {},
        onClose = (isDetail = true) => {},
        onOpen = (isDetail = true) => {},
        idx,
        externalLoreBooks = $bindable(),
        idgroup,
        isOpen = false,
        openFolders = 0,
        isLastInContainer = false,
        comparisonStatus,
        comparisonStatuses,
        searchText = '',
    }: Props = $props();
    // The search text is marked where it was found (the user's request,
    // 2026-10-26): in the title, around a name or key field that holds it,
    // and inside the content (TextAreaInput searchText).
    const searchHit = (text: string | undefined) =>
        searchText && findTextMatches(text, searchText, 1).length > 0 ? ' ring-2 ring-yellow-400/60' : ''
    // Where this entry goes (auxLorebook.ts), and the right-click choices.
    let role = $derived<LoreRole>(loreRole(value))
    // Illustration-only by Lightboard's title: the 🎨 in orange, like a module
    // on by itself; a 🎨 the user set stays pink (2026-10-28).
    let autoIllustration = $derived(isAutoIllustration(value))
    const roleChoices: { role: LoreRole, label: string }[] = [
        { role: 'main', label: language.loreRoleMain },
        { role: 'asset', label: language.loreRoleAsset },
        { role: 'illustration', label: language.loreRoleIllustration },
    ]
    
    let open = $derived(isOpen)
    let loreComparisonClass = $derived(comparisonStatus === 'match'
        ? 'lore-compare-match'
        : comparisonStatus === 'different' ? 'lore-compare-different' : '')
    let loreComparisonTitle = $derived(comparisonStatus === 'match'
        ? '유사 후보의 다른 봇/모듈과 로어북 제목·내용이 일치'
        : comparisonStatus === 'different' ? '유사 후보에서 일치하는 로어북 제목·내용 없음' : undefined)

    let tokens = $state(0)
    let tokenTimer: ReturnType<typeof setTimeout> | null = null
    let tokenSeq = 0
    // Re-count tokens on a debounce instead of on every content change — the
    // tokenizer runs a full CBS parse + encode, which is too heavy to do live.
    // Only when this entry is open: the token count UI renders only while open,
    // so closed entries (a big lorebook can have hundreds) must not tokenize.
    // The generation is bumped here (on content change), not in the timer, so an
    // in-flight tokenize is invalidated the moment the input changes — not only
    // once the next debounce fires 400ms later.
    $effect(() => {
        if (!open) return
        const content = value.content
        const seq = ++tokenSeq
        if (tokenTimer) clearTimeout(tokenTimer)
        tokenTimer = setTimeout(() => {
            tokenizeAccurate(content).then(result => { if (seq === tokenSeq) tokens = result })
        }, 400)
        return () => { if (tokenTimer) clearTimeout(tokenTimer) }
    })
    // Live, unlike the tokens: counting is cheap, and it is read only while open.
    let chars = $derived(countChars(value.content))

    function isLocallyActivated(book: loreBook){
        return book.id ? getCurrentChat()?.localLore.some(e => e.id === book.id) : false
    }
    function activateLocally(book: loreBook){
        if(!book.id){
            book.id = v4()
        }
        
        const childLore: loreBook = {
            key: '',
            comment: '',
            content: '',
            mode: 'child',
            insertorder: 100,
            alwaysActive: true,
            secondkey: '',
            selective: false,
            id: book.id,
        }
        getCurrentChat().localLore.push(childLore)
    }
    function deactivateLocally(book: loreBook){
        if(!book.id) return
        const chat = getCurrentChat()
        const childLore = chat?.localLore?.find(e => e.id === book.id)
        if(childLore){
            chat.localLore = chat.localLore.filter(e => e.id !== book.id)
        }
    }
    function toggleLocalActive(check: boolean, book: loreBook){
        if(check){
            activateLocally(book)
        }else{
            deactivateLocally(book)
        }
    }
    function getParentLoreName(book: loreBook){
        if(book.mode === 'child'){
            const value = getCurrentCharacter()?.globalLore.find(e => e.id === book.id)
            if(value){
                return value.comment.length === 0 ? value.key.length === 0 ? "Unnamed Lore" : value.key : value.comment
            }
        }
    }

    
</script>
<div class={"w-full flex flex-col " + (
    isLastInContainer ? 
        'pb-0 mb-0 border-0' : // Last item in container: no border
        'pb-2 mb-2 border-b border-b-selected last:pb-0 last:mb-0 last:border-0'
)}
    class:no-sort={value.mode === 'folder' && openFolders > 0}
    data-risu-idx={idx} data-risu-idgroup={idgroup}
>
    <div class="flex items-center transition-colors w-full p-1">

    {#if value.mode !== 'child'}
        <button class="endflex valuer border-darkborderc flex items-center" onclick={() => {
            value.secondkey = value.secondkey ?? ''
            if(!open){
                open = true
                onOpen(value.mode !== 'folder') // If not a folder, pass true
            }
            else{
                open = false
                onClose(value.mode !== 'folder') // If not a folder, pass true
            }
        }}>
            {#if value.mode === 'folder'}
                {#if open}
                    <FolderOpen size={20} class="mr-1" />
                {:else}
                    <FolderIcon size={20} class="mr-1" />
                {/if}
            {/if}
            {#if value.mode === 'folder'}
                <span class={loreComparisonClass} title={loreComparisonTitle}>{value.comment.length === 0 ? "Unnamed Folder" : value.comment}</span>
            {:else}
                <span class={loreComparisonClass} title={loreComparisonTitle}>{@render marked(value.comment.length === 0 ? value.key.length === 0 ? "Unnamed Lore" : value.key : value.comment)}</span>
            {/if}
        </button>
        <!-- Right-click (a long press on touch) picks where the entry goes:
             the main model, 🌙 asset tagging or 🎨 illustrations
             (auxLorebook.ts); a click on 🌙/🎨 brings it back to the main one. -->
        <ShContextMenu>
        {#snippet items()}
            {#each roleChoices as choice (choice.role)}
                <ShDropdownMenuItem onSelect={() => setLoreRole(value, externalLoreBooks ?? [], choice.role)}>
                    {#if choice.role === 'asset'}
                        <MoonIcon size={16} class="text-emerald-400" />
                    {:else if choice.role === 'illustration'}
                        <PaletteIcon size={16} class="text-pink-400" />
                    {:else if value.alwaysActive}
                        <SunIcon size={16} />
                    {:else}
                        <LinkIcon size={16} />
                    {/if}
                    <span class="grow">{choice.label}</span>
                    {#if role === choice.role}<CheckIcon size={14} />{/if}
                </ShDropdownMenuItem>
            {/each}
        {/snippet}
        {#snippet trigger(props)}
        <button
            {...props}
            class="mr-1"
            class:text-textcolor2={!value.alwaysActive && role === 'main'}
            class:text-textcolor={value.alwaysActive && role === 'main'}
            class:text-emerald-400={role === 'asset'}
            class:text-pink-400={role === 'illustration' && !autoIllustration}
            class:text-orange-400={autoIllustration}
            data-lore-auto-illustration={autoIllustration ? '' : undefined}
            title={autoIllustration ? language.loreAutoIllustration : role === 'asset' ? language.loreAuxModelIcon : role === 'illustration' ? language.loreRoleIllustrationIcon : language.loreRoleMenu}
            onclick={async () => {
                // By its title it stays for illustrations; the menu can still pick 🌙 or a pink 🎨.
                if(autoIllustration) return
                if(role !== 'main'){
                    setLoreRole(value, externalLoreBooks ?? [], 'main')
                    return
                }
                if(value.mode === 'folder'){
                    for(let i = 0; i < externalLoreBooks.length; i++){
                        if(externalLoreBooks[i].folder === value.key){
                            externalLoreBooks[i].alwaysActive = !value.alwaysActive
                        }
                    }
                }
                value.alwaysActive = !value.alwaysActive
            }}
        >
            {#if role === 'asset'}
                <MoonIcon size={20} />
            {:else if role === 'illustration'}
                <PaletteIcon size={20} />
            {:else if value.alwaysActive}
                <SunIcon size={20} />
            {:else}
                <LinkIcon size={20} />
            {/if}
        </button>
        {/snippet}
        </ShContextMenu>
        <button class="valuer" onclick={async () => {
            let shouldRemove = true;
            if (value.mode === 'folder' && externalLoreBooks.some(e => e.folder === value.key)) {
                const firstConfirm = await alertConfirm(language.folderRemoveConfirm);
                if (!firstConfirm) {
                    shouldRemove = false;
                }
            }

            if (shouldRemove) {
                const secondConfirm = await alertConfirm(language.removeConfirm + (value.comment || 'Unnamed Folder'));
                if (secondConfirm) {
                    // onRemove in LoreBookList already closes the entry when it is
                    // open; closing a closed one here drove openedDetails negative
                    // and permanently killed drag reordering.
                    deactivateLocally(value);
                    onRemove();
                }
            }
        }}>
            <XIcon size={20} />
        </button>
    {:else}
        <button class="endflex valuer border-darkborderc" onclick={() => alertMd(language.childLoreDesc)}>
            <BookCopyIcon size={20} class="mr-1" />
            <span>{getParentLoreName(value)}</span>
        </button>
        <button class="valuer" onclick={async () => {
            const d = await alertConfirm(language.removeConfirm + getParentLoreName(value))
            if(d){
                onRemove()
            }
        }}>
            <XIcon size={20} />
        </button>
    {/if}
    </div>
    {#if open}
        {#if value.mode === 'folder'}
        <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2">
            <span class="text-textcolor mt-6 mb-2">{language.folderName}</span>
            <TextInput deferred bind:value={value.comment} className={loreComparisonClass}/>

            <div class="mt-4">
                <LoreBookList externalLoreBooks={externalLoreBooks} showFolder={value.key} {comparisonStatuses} />
            </div>
            
            <div class="mt-2 flex gap-1">
                <button class="text-textcolor2 hover:text-textcolor" onclick={() => {
                    externalLoreBooks.push({
                        key: '',
                        comment: '',
                        content: '',
                        mode: 'normal',
                        insertorder: 100,
                        alwaysActive: true,
                        secondkey: '',
                        selective: false,
                        folder: value.key,
                    })
                }}>
                    <PlusIcon size={20} />
                </button>
            </div>
        </div>
        {:else}
        <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2">
            <span class="text-textcolor mt-6">{language.name} <Help key="loreName"/></span>
            <TextInput deferred bind:value={value.comment} className={loreComparisonClass + searchHit(value.comment)}/>
            {#if !value.alwaysActive}
                <span class="text-textcolor mt-6">{language.activationKeys} <Help key="loreActivationKey"/></span>
                <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
                <TextInput deferred bind:value={value.key} className={searchHit(value.key)}/>

                {#if value.selective}
                    <span class="text-textcolor mt-6">{language.SecondaryKeys}</span>
                    <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
                    <TextInput deferred bind:value={value.secondkey} className={searchHit(value.secondkey)}/>
                {/if}
            {/if}
            {#if !(value.activationPercent === undefined || value.activationPercent === null)}
                <span class="text-textcolor mt-6">{language.activationProbability}</span>
                <NumberInput bind:value={value.activationPercent} onChange={() => {
                    if(isNaN(value.activationPercent) || !value.activationPercent || value.activationPercent < 0){
                        value.activationPercent = 0
                    }
                    if(value.activationPercent > 100){
                        value.activationPercent = 100
                    }
                }} />
            {/if}
            <span class="text-textcolor mt-4">{language.insertOrder} <Help key="loreorder"/></span>
            <NumberInput bind:value={value.insertorder} min={0} max={1000}/>
            <span class="text-textcolor mt-4 mb-2">{language.prompt}</span>
            <TextAreaInput highlight autocomplete="off" bind:value={value.content} className={loreComparisonClass} resizeKey="lorebook" {searchText} findable />
            <span class="text-textcolor2 mt-2 mb-2 text-sm">{tokens} {language.tokens} <span class="whitespace-nowrap" title={language.loreCharCountTitle}>{language.loreCharCount.replace('{}', String(chars.noSpace)).replace('{}', String(chars.withSpace))}</span></span>
            <div class="flex items-center mt-4">
                <Check bind:check={value.alwaysActive} name={language.alwaysActive}/>
            </div>
            <div class="flex items-center mt-2">
                <Check check={role === 'asset'} onChange={(check: boolean) => setLoreRole(value, externalLoreBooks ?? [], check ? 'asset' : 'main')} name={language.loreAuxModel}/>
                <Help key="loreAuxModel" name={language.loreAuxModel}/>
            </div>
            <div class="flex items-center mt-2">
                <Check check={role === 'illustration'} onChange={(check: boolean) => setLoreRole(value, externalLoreBooks ?? [], check ? 'illustration' : 'main')} name={language.loreIllustration}/>
                <Help key="loreIllustration" name={language.loreIllustration}/>
            </div>
            {#if !value.alwaysActive && getCurrentCharacter()?.globalLore?.includes(value) && DBState.db.localActivationInGlobalLorebook}
                <div class="flex items-center mt-2">
                    <Check check={isLocallyActivated(value)} onChange={(check: boolean) => toggleLocalActive(check, value)} name={language.alwaysActiveInChat}/>
                </div>
            {/if}
            {#if !value.useRegex}
                <div class="flex items-center mt-2">
                    <Check bind:check={value.selective} name={language.selective}/>
                    <Help key="loreSelective" name={language.selective}/>
                </div>
            {/if}
            {#if !value.alwaysActive}
                <div class="flex items-center mt-2">
                    <Check bind:check={value.useRegex} name={language.useRegexLorebook}/>
                    <Help key="useRegexLorebook" name={language.useRegexLorebook}/>
                </div>
            {/if}
        </div>
        {/if}
    {/if}
</div>



{#snippet marked(text: string)}{#each splitAtMatches(text, findTextMatches(text, searchText)) as segment, i (i)}{#if segment.mark >= 0}<mark class="lore-search-mark">{segment.text}</mark>{:else}{segment.text}{/if}{/each}{/snippet}

<style>
    .lore-search-mark {
        color: inherit;
        background: rgb(250 204 21 / 0.4);
        border-radius: 2px;
    }
    .valuer:hover{
        color: rgba(16, 185, 129, 1);
        cursor: pointer;
    }

    .endflex{
        display: flex;
        flex-grow: 1;
        cursor: pointer;
    }

    /* Styles for SortableJS drag-and-drop feedback */
    :global(.risu-lore-chosen-item) {
        /* The item being dragged */
        padding-bottom: 0.5rem;
        margin-bottom: 0.5rem;
        border-bottom: 1px solid;
        border-bottom-color: var(--risu-theme-selected);
        opacity: 0.7;
    }

    :global(.risu-lore-ghost-item) {
        /* The placeholder for the drop location */
        background-color: rgba(var(--risu-theme-selected-rgb), 0.2);

    }

    :global(.lore-compare-match),
    :global(.lore-compare-match textarea),
    :global(.lore-compare-match [contenteditable]),
    :global(.lore-compare-match [contenteditable] *) {
        color: #4ade80 !important;
    }

    :global(.lore-compare-different),
    :global(.lore-compare-different textarea),
    :global(.lore-compare-different [contenteditable]),
    :global(.lore-compare-different [contenteditable] *) {
        color: #facc15 !important;
    }
</style>
