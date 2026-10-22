<script lang="ts">
    import { BanIcon, BookIcon, FlagIcon, ImageIcon, PackageIcon, PaperclipIcon, SmileIcon, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertInput, alertNormal, notifyInfo } from "src/ts/alert";
    import { hubURL, type hubType, downloadRisuHub, getCharacterRealmId, getRealmInfo } from "src/ts/characterCards";
    import { findProtonShareLinks, importRealmDescriptionModules } from "src/ts/realmCompanionModule";
    
    import { DBState } from 'src/ts/stores.svelte';
    import RealmLicense from "./RealmLicense.svelte";
    import MultiLangDisplay from "../GUI/MultiLangDisplay.svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import Portal from "../GUI/Portal.svelte";
    import { addBlockedRealmCard } from "src/ts/realmBlocking";

    interface Props {
        openedData: hubType;
        /** PocketRisu: the id of the bot just blocked (blocking is per bot). */
        onBlock?: (cardId: string) => void;
    }

    let { openedData = $bindable(), onBlock = () => {} }: Props = $props();

    // PocketRisu: the module behind a Proton link in the description, without
    // the bot (the user's request, 2026-10-22). The window stays open.
    let hasModuleLink = $derived(findProtonShareLinks(openedData?.desc ?? '').length > 0)
    let moduleBusy = $state(false)

    async function importModule() {
        const realmId = openedData.id
        moduleBusy = true
        try {
            await importRealmDescriptionModules(openedData.desc ?? '', () =>
                DBState.db.characters.filter((character) => getCharacterRealmId(character) === realmId))
        } finally {
            moduleBusy = false
        }
    }

</script>


<!-- Mounted on <body>: inside the main view it shared that view's stacking
     context, so the sidebar (z-30) and its thumbnail badges painted over it.
     z-40 keeps it under the alerts it opens (terms, report: z-50). -->
<Portal>
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="top-0 left-0 z-40 fixed w-full h-full bg-black/50 flex justify-center items-center text-textcolor" role="button" tabindex="0" onclick={() => {
    openedData = null
}}>
    <div class="p-6 max-w-full bg-darkbg rounded-md flex flex-col gap-4 w-2xl overflow-y-auto max-h-full">
        <div class="w-full flex flex-col">
            <h1 class="text-2xl font-bold max-w-full overflow-hidden whitespace-nowrap text-ellipsis">{openedData.name}</h1>
            {#if openedData.authorname}
                <span class="text-borderc">Made by {openedData.authorname}</span>
            {/if}
            {#if openedData.original}
                <button class="text-blue-400 text-start" onclick={() => {
                    const original = openedData.original
                    openedData = null
                    getRealmInfo(original)
                }}>Forked</button>
            {/if}
            <!-- PocketRisu: on a phone the picture sits above the description,
                 and the description column may shrink, so a long link wraps
                 instead of pushing the text past the screen's edge (and the
                 picture to half its width). -->
            <div class="flex flex-col sm:flex-row justify-start gap-4 mt-4">
                {#if DBState.db.hideAllImages}
                    <div class="h-36 w-36 shrink-0 rounded-md bg-darkbutton flex items-center justify-center text-textcolor2">
                        <span class="text-4xl">?</span>
                    </div>
                {:else}
                    <img class="h-36 w-36 shrink-0 rounded-md object-top object-cover" alt={openedData.name} src={`${hubURL}/resource/` + openedData.img}>
                {/if}
                <div class="min-w-0 flex-1">
                    <MultiLangDisplay value={openedData.desc} markdown={true} />
                </div>
            </div>
            <RealmLicense license={openedData.license}/>

            <div class="flex justify-start gap-2  mt-2">
                {#each openedData.tags as tag, i}
                    <div class="text-xs p-1 text-blue-400">{tag}</div>
                {/each}
            </div>
            <div class="flex flex-wrap w-full flex-row gap-1 mt-2">
                <span class="text-textcolor2" use:tooltip={language.popularityLevelDesc}>
                    {language.popularityLevel.replace('{}', openedData.download.toString())}
                </span>
                
                <div class="border-l-selected border-l ml-1 mr-1"></div>
                {#if openedData.hasEmotion}
                    <button class="text-textcolor2 hover:text-primary transition-colors" onclick={((e) => {
                        notifyInfo("This character includes emotion images")
                    })}><SmileIcon /></button>
                {/if}
                {#if openedData.hasAsset}
                    <button class="text-textcolor2 hover:text-primary transition-colors" onclick={((e) => {
                        notifyInfo("This character includes additional Assets")
                    })}><ImageIcon /></button>
                {/if}
                {#if openedData.hasLore}
                    <button class="text-textcolor2 hover:text-primary transition-colors" onclick={((e) => {
                        notifyInfo("This character includes lorebook")
                    })}><BookIcon /></button>
                {/if}
            </div>

        </div>

        <div class="flex flex-row-reverse gap-2">
            <!-- PocketRisu: blocks this bot only, not all of its creator's
                 (the user's request, 2026-10-22). -->
            {#if openedData.id && (DBState.db.account?.token?.split('-') ?? [])[1] !== openedData.creator}
                <button class="text-textcolor2 hover:text-red-500" use:tooltip={language.blockRealmBot} onclick={async (e) => {
                    e.stopPropagation()
                    const cardId = openedData.id
                    if(!cardId){
                        return
                    }
                    const conf = await alertConfirm(language.blockRealmBotConfirm.replace('{{name}}', openedData.name || cardId))
                    if(!conf){
                        return
                    }
                    DBState.db.nodeOnlyBlockedRealmCards = addBlockedRealmCard(
                        DBState.db.nodeOnlyBlockedRealmCards ?? [],
                        { id: cardId, name: openedData.name || cardId },
                    )
                    onBlock(cardId)
                    openedData = null
                    alertNormal(language.realmBotBlockedSuccess)
                }}>
                    <BanIcon />
                </button>
            {/if}
            <button class="text-textcolor2 hover:text-red-500" onclick={(async (e) => {
                e.stopPropagation()
                const conf = await alertConfirm('Report this character?')
                if(conf){
                    const report = await alertInput('Write a report text that would be sent to the admin (for copyright issues, use email)')
                    const da = await fetch(hubURL + '/hub/report', {
                        method: "POST",
                        body: JSON.stringify({
                            id: openedData.id,
                            report: report
                        })
                    })
                    alertNormal(await da.text())
                }
            })}>
                <FlagIcon />
            </button>
            {#if (DBState.db.account?.token?.split('-') ?? [])[1] === openedData.creator}
                <button class="text-textcolor2 hover:text-red-500" onclick={(async (e) => {
                    e.stopPropagation()
                    const conf = await alertConfirm('Do you want to remove this character from Realm?')
                    if(conf){
                        const da = await fetch(hubURL + '/hub/remove', {
                            method: "POST",
                            body: JSON.stringify({
                                id: openedData.id,
                                token: DBState.db.account?.token
                            })
                        })
                        alertNormal(await da.text())
                    }
                })}>
                    <TrashIcon />
                </button>
            {/if}
            <button class="text-textcolor2 hover:text-primary" onclick={(async (e) => {
                e.stopPropagation()
                await navigator.clipboard.writeText(`https://realm.risuai.net/character/${openedData.id}`)
                notifyInfo(language.clipboardSuccess)
            })}>
                <PaperclipIcon />
            </button>
            {#if hasModuleLink}
                <button class="shrink-0 flex items-center gap-1 border border-selected hover:ring-3 p-2 font-bold rounded-md disabled:opacity-50" disabled={moduleBusy} use:tooltip={language.realmModuleImportDesc} onclick={(e) => {
                    e.stopPropagation()
                    void importModule()
                }}>
                    <PackageIcon size={18} />
                    <span>{language.realmModuleImport}</span>
                </button>
            {/if}
            <button class="bg-selected hover:ring-3 grow p-2 font-bold rounded-md mr-2" onclick={() => {
                downloadRisuHub(openedData.id, { creator: openedData.creator })
                openedData = null
            }}>
                Chat
            </button>
            
        </div>
    </div>
</div>
</Portal>
