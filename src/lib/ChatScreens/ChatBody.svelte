<script lang="ts">
    import isEqual from "lodash/isEqual"
    import { DBState } from 'src/ts/stores.svelte'
    import { sleep } from "src/ts/util"
    import { alertError } from "../../ts/alert"
    import { onDestroy, tick } from 'svelte'
    import { addMetadataToElement, getDistance, ParseMarkdown, postTranslationParse, resolveInlayPlaceholders, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getLLMCache, translateHTML } from "../../ts/translator/translator"
    import { getModuleAssets } from "src/ts/process/modules";
    import { getCurrentCharacter } from "src/ts/storage/database.svelte";
    import { getFileSrc } from "src/ts/globalApi.svelte";

    interface Props {
        character?: simpleCharacterArgument|string|null
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        name?: string
        role: string|null
        translated: boolean
        translating: boolean
        retranslate: boolean
        bodyRoot?: HTMLElement|null
        modelShortName: string
        renderRawStreaming?: boolean
        rawStreamingText?: string
        resolveAssets?: boolean
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        bodyRoot,
        modelShortName = '',
        renderRawStreaming = false,
        rawStreamingText = '',
        resolveAssets = true,
    }: Props =  $props()

    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    let stopInlayResolution = () => {}
    let destroyed = false

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }

    let shouldRenderRawStreaming = $derived(renderRawStreaming && !translated && !retranslate)

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, tries?:number) => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        let lastParsedQueue = ''
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg)) || (chatID !== lastChatId)){
                lastParsedQueue = ''
                lastCharArg = charArg
                lastChatId = chatID
                let translateText = false
                try {
                    if(DBState.db.autoTranslate){
                        if(DBState.db.autoTranslateCachedOnly && DBState.db.translatorType === 'llm'){
                            const cache = DBState.db.translateBeforeHTMLFormatting
                            ? await getLLMCache(data)
                            : !DBState.db.legacyTranslation
                            ? await getLLMCache(await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition(), { resolveAssets }))
                            : await getLLMCache(await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), { resolveAssets }))
                  
                            translateText = cache !== null
                        }
                        else{
                            translateText = true
                        }
                    }

                    const lastTranslated = translated

                    setTimeout(() => {
                            translated = translateText
                    }, 10)

                    // State change of `translated` triggers markParsing again,
                    // causing redundant translation attempts
                    if (lastTranslated !== translateText) {
                        return;
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(retranslate || translated){
                if (DBState.db.showTranslationLoading) {
                    lastParsed = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`
                }

                let transResult
                
                if(DBState.db.translatorType === 'llm' && DBState.db.translateBeforeHTMLFormatting){
                    await sleep(100)
                    translating = true
                    data = await translateHTML(data, false, charArg, chatID, retranslate)
                    translating = false
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), { resolveAssets })
                    lastParsedQueue = marked
                    lastCharArg = charArg
                    transResult = marked
                }
                else if(!DBState.db.legacyTranslation){
                    const marked = await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition(), { resolveAssets })
                    translating = true
                    const translated = await postTranslationParse(await translateHTML(marked, false, charArg, chatID, retranslate))
                    translating = false
                    lastParsedQueue = translated
                    lastCharArg = charArg
                    transResult = translated
                }
                else{
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), { resolveAssets })
                    translating = true
                    const translated = await translateHTML(marked, false, charArg, chatID, retranslate)
                    translating = false
                    lastParsedQueue = translated
                    lastCharArg = charArg
                    transResult = translated
                }

                setTimeout(() => {
                    retranslate = false
                }, 10);

                return transResult
            }
            else{
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), { resolveAssets })
                lastParsedQueue = marked
                lastCharArg = charArg
                return marked
            }   
        } catch (error) {
            //retry
            if(tries > 2){

                alertError(`Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`)
                return data
            }
            return await markParsing(data, charArg, chatID, (tries ?? 0) + 1)
        }
        finally{
            //since trimMarkdown is fast, we don't need to cache it
            lastParsed = lastParsedQueue
        }
    }

    const checkImg = () => {
        if(!resolveAssets || !DBState.db.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([src^="/"]):not([noimage])') as NodeListOf<HTMLImageElement>
        
        if (imgs.length > 0) {
            const currentCharacter = getCurrentCharacter()
            const styl = currentCharacter.prebuiltAssetStyle
            const assets = getModuleAssets().concat(currentCharacter.additionalAssets ?? [])
            const normalizedAssets = assets.map((asset) => {
                return {
                    name: asset[0].toLocaleLowerCase(),
                    path: asset[1]
                }
            })
            const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))

            imgs.forEach(async (img) => {
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''
                console.log(name)

                if(
                    name.length > 200 ||
                    name.includes(':')
                ){
                    img.setAttribute('noimage', 'true')
                    return
                }
                
                const foundAsset = exactAssets.get(name)
                console.log('Checking image:', name, 'Assets:', assets)
                if(foundAsset){
                    img.classList.add('root-loaded-image')
                    img.classList.add('root-loaded-image-' + styl)
                    const got = await getFileSrc(foundAsset)
                    if(resolveAssets && img.isConnected){
                        img.src = got
                    }
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const prefixLoc = name.lastIndexOf('.')
                const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
                let currentDistance = 1000
                let currentFound = ''
                for(const asset of normalizedAssets){
                    if(!asset.name.startsWith(prefix)){
                        continue
                    }
                    const distance = getDistance(name, asset.name)
                    if(distance < currentDistance){
                        currentDistance = distance
                        currentFound = asset.path
                    }
                }
                if(currentFound){
                    const got = await getFileSrc(currentFound)
                    const name2 = img.getAttribute('src')?.toLocaleLowerCase() || ''
                    if(resolveAssets && img.isConnected && name === name2){
                        img.setAttribute('src', got)
                    }

                    if(img.classList.length === 0){
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.removeAttribute('noimage')
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    function releaseRenderedAssets(){
        stopInlayResolution()
        stopInlayResolution = () => {}
        if(!bodyRoot) return

        const media = Array.from(bodyRoot.querySelectorAll('img, video, audio, source'))
        media.forEach((element) => {
            if(element instanceof HTMLMediaElement){
                element.pause()
            }
        })
        media.forEach((element) => {
            const src = element.getAttribute('src')
            element.removeAttribute('src')
            element.removeAttribute('srcset')

            // Chat-owned blob URLs must not survive after the message leaves
            // the active asset window.
            if(src?.startsWith('blob:')){
                URL.revokeObjectURL(src)
            }

        })
        media.forEach((element) => {
            if(element instanceof HTMLMediaElement) element.load()
        })
    }

    function showExternalAssetError(event: Event){
        const element = event.target
        if(!(element instanceof HTMLImageElement || element instanceof HTMLMediaElement || element instanceof HTMLSourceElement)) return
        const src = element.getAttribute('src') ?? ''
        if(!src.includes('/api/external-assets/content/')) return
        const displayTarget = element instanceof HTMLSourceElement
            ? element.closest('video, audio')
            : element
        if(!displayTarget || displayTarget.getAttribute('data-external-asset-error') === 'true') return

        displayTarget.setAttribute('data-external-asset-error', 'true')
        if(displayTarget instanceof HTMLMediaElement) displayTarget.pause()
        element.removeAttribute('src')
        displayTarget.removeAttribute('src')
        const placeholder = document.createElement('span')
        placeholder.className = 'risu-external-asset-error'
        placeholder.textContent = 'External asset unavailable'
        placeholder.title = 'The external store and its internal/trash fallbacks could not provide this asset.'
        displayTarget.replaceWith(placeholder)
    }

    $effect(() => {
        if(!bodyRoot) return
        bodyRoot.addEventListener('error', showExternalAssetError, true)
        return () => bodyRoot?.removeEventListener('error', showExternalAssetError, true)
    })

    onDestroy(() => {
        destroyed = true
        releaseRenderedAssets()
    })

    let markParsingResult = $derived.by(() => markParsing(msgDisplay, character, idx))

    $effect(() => {
        if(!resolveAssets){
            releaseRenderedAssets()
        }

        if(shouldRenderRawStreaming){
            return
        }
        markParsingResult
        checkImg()
        markParsingResult.then(async () => {
            if(destroyed || !resolveAssets || !bodyRoot?.isConnected) return
            checkImg()
            await tick() // Wait for Svelte to re-render the {:then} block into DOM
            if (!destroyed && resolveAssets && bodyRoot?.isConnected){
                stopInlayResolution()
                stopInlayResolution = resolveInlayPlaceholders(bodyRoot)
            }
        })
    })
</script>

{#if shouldRenderRawStreaming}
    <span class="whitespace-pre-wrap">{rawStreamingText}</span>
{:else}
    {#await markParsingResult}
        {@html addMetadataToElement(trimMarkdown(lastParsed), modelShortName)}
    {:then md}
        {@html addMetadataToElement(trimMarkdown(md), modelShortName)}
    {/await}
{/if}

<style>
    :global(.risu-external-asset-error) {
        display: inline-flex;
        align-items: center;
        min-height: 2rem;
        padding: 0.35rem 0.6rem;
        border: 1px solid rgb(248 113 113 / 0.65);
        border-radius: 0.375rem;
        color: rgb(248 113 113);
        font-size: 0.75rem;
    }
</style>
