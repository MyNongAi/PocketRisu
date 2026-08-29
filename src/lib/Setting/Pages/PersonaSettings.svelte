<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import BaseRoundedButton from "src/lib/UI/BaseRoundedButton.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertError, alertSelect } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { changeUserPersona, exportUserPersona, importUserPersona, saveUserPersona, selectUserImg, setUserPersonaImage } from "src/ts/persona";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import { onDestroy, onMount } from "svelte";
    import { GripHorizontal, Maximize2, Minimize2, RotateCcw } from '@lucide/svelte';
    import { sleep, sortableOptions } from "src/ts/util";
    import { DBState } from 'src/ts/stores.svelte';
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { MAX_PERSONA_IMAGE_BYTES } from "src/ts/personaImage";
    import { v4 } from "uuid"

    // selectedPersona can point past the array (persona removed by a plugin or
    // stale index in an imported DB) — clamp before the template dereferences it.
    if(!DBState.db.personas[DBState.db.selectedPersona] && DBState.db.personas.length > 0){
        DBState.db.selectedPersona = 0
    }

    let stb: Sortable = null
    let ele: HTMLDivElement = $state()
    let sorted = $state(0)
    let selectedId:string = null
    let personaImageDropTarget = $state<number | null>(null)
    let personaPanel: HTMLDivElement | null = $state(null)
    let personaPanelCollapsed = $state(false)
    let panelLayout = $state({ x: -1, y: -1, width: 640, height: 320 })
    let stopPanelDrag: (() => void) | null = null
    let panelResizeObserver: ResizeObserver | null = null

    const PERSONA_PANEL_LAYOUT_KEY = 'pocketrisu:persona-panel-layout'

    function clampPanelLayout(layout = panelLayout) {
        if (typeof window === 'undefined') return layout
        const margin = 12
        const width = Math.min(Math.max(layout.width, 340), Math.max(340, window.innerWidth - margin * 2))
        const height = Math.min(Math.max(layout.height, 190), Math.max(190, window.innerHeight - margin * 2))
        return {
            width,
            height,
            x: Math.min(Math.max(layout.x, margin), Math.max(margin, window.innerWidth - width - margin)),
            y: Math.min(Math.max(layout.y, margin), Math.max(margin, window.innerHeight - height - margin)),
        }
    }

    function savePanelLayout() {
        try {
            localStorage.setItem(PERSONA_PANEL_LAYOUT_KEY, JSON.stringify({
                ...panelLayout,
                collapsed: personaPanelCollapsed,
            }))
        } catch {
            // The panel still works for this session when storage is denied.
        }
    }

    function resetPanelLayout() {
        const width = Math.min(640, Math.max(340, window.innerWidth - 32))
        const height = Math.min(320, Math.max(190, window.innerHeight - 32))
        panelLayout = clampPanelLayout({
            width,
            height,
            x: window.innerWidth - width - 20,
            y: window.innerHeight - height - 20,
        })
        personaPanelCollapsed = false
        savePanelLayout()
    }

    function beginPanelDrag(event: PointerEvent) {
        if (!personaPanel || window.matchMedia('(max-width: 640px)').matches) return
        if ((event.target as HTMLElement).closest('button')) return
        event.preventDefault()
        const startX = event.clientX
        const startY = event.clientY
        const originX = panelLayout.x
        const originY = panelLayout.y

        const move = (moveEvent: PointerEvent) => {
            panelLayout = clampPanelLayout({
                ...panelLayout,
                x: originX + moveEvent.clientX - startX,
                y: originY + moveEvent.clientY - startY,
            })
        }
        const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
            stopPanelDrag = null
            savePanelLayout()
        }
        stopPanelDrag?.()
        stopPanelDrag = stop
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
    }

    function isFileDrag(event: DragEvent) {
        return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    function markPersonaImageDrop(event: DragEvent, personaIndex: number) {
        if (!isFileDrag(event)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        personaImageDropTarget = personaIndex
    }

    function clearPersonaImageDrop(event: DragEvent, personaIndex: number) {
        const relatedTarget = event.relatedTarget
        if (relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(relatedTarget)) return
        if (personaImageDropTarget === personaIndex) personaImageDropTarget = null
    }

    async function dropPersonaImage(event: DragEvent, personaIndex: number) {
        const file = event.dataTransfer?.files?.[0]
        if (!file) return

        event.preventDefault()
        event.stopPropagation()
        personaImageDropTarget = null

        try {
            if (file.size > MAX_PERSONA_IMAGE_BYTES) {
                const maxMegabytes = Math.floor(MAX_PERSONA_IMAGE_BYTES / (1024 * 1024))
                throw new Error(`Persona image must be ${maxMegabytes} MB or smaller`)
            }
            await setUserPersonaImage(new Uint8Array(await file.arrayBuffer()), personaIndex)
        } catch (error) {
            alertError(error)
        }
    }

    const createStb = () => {
        stb = Sortable.create(ele, {
            onStart: async () => {
                DBState.db.personas[DBState.db.selectedPersona].id ??= v4()
                selectedId = DBState.db.personas[DBState.db.selectedPersona].id
                saveUserPersona()
            },
            onEnd: async () => {
                let idx:number[] = []
                ele.querySelectorAll('[data-risu-idx]').forEach((e, i) => {
                    idx.push(parseInt(e.getAttribute('data-risu-idx')))
                })
                let newValue:{
                    personaPrompt:string
                    name:string
                    icon:string
                    note?:string
                    largePortrait?:boolean
                    id?:string
                }[] = []
                idx.forEach((i) => {
                    newValue.push(DBState.db.personas[i])
                })
                DBState.db.personas = newValue
                const selectedPersona = DBState.db.personas.findIndex((e) => e.id === selectedId)
                changeUserPersona(selectedPersona !== -1 ? selectedPersona : 0, 'noSave')
                void requestImmediateSave()
                try {
                    stb.destroy()
                } catch (error) {}
                sorted += 1
                await sleep(1)
                createStb()
            },
            ...sortableOptions
        })
    }

    onMount(() => {
        createStb()
        try {
            const saved = JSON.parse(localStorage.getItem(PERSONA_PANEL_LAYOUT_KEY) ?? 'null')
            if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
                panelLayout = {
                    x: Number.isFinite(saved.x) ? saved.x : -1,
                    y: Number.isFinite(saved.y) ? saved.y : -1,
                    width: saved.width,
                    height: saved.height,
                }
                personaPanelCollapsed = saved.collapsed === true
            }
        } catch {
            // Invalid old layout data falls back to the compact default.
        }
        if (panelLayout.x < 0 || panelLayout.y < 0) resetPanelLayout()
        else panelLayout = clampPanelLayout(panelLayout)

        const onWindowResize = () => {
            panelLayout = clampPanelLayout(panelLayout)
            savePanelLayout()
        }
        window.addEventListener('resize', onWindowResize)

        if (personaPanel && typeof ResizeObserver !== 'undefined') {
            panelResizeObserver = new ResizeObserver(([entry]) => {
                if (personaPanelCollapsed || window.matchMedia('(max-width: 640px)').matches) return
                const rect = personaPanel?.getBoundingClientRect()
                const width = Math.round(rect?.width ?? entry.contentRect.width)
                const height = Math.round(rect?.height ?? entry.contentRect.height)
                if (Math.abs(width - panelLayout.width) < 2 && Math.abs(height - panelLayout.height) < 2) return
                panelLayout = clampPanelLayout({ ...panelLayout, width, height })
                savePanelLayout()
            })
            panelResizeObserver.observe(personaPanel)
        }

        return () => window.removeEventListener('resize', onWindowResize)
    })

    onDestroy(() => {
        saveUserPersona()
        stopPanelDrag?.()
        panelResizeObserver?.disconnect()
        savePanelLayout()
        if(stb){
            try {
                stb.destroy()
            } catch (error) {}
        }
    })
</script>
<SettingPage title={language.persona}>
{#if DBState.db.personas.some((persona) => persona.sourceInfo?.label)}
    <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-darkborderc p-3 text-xs text-textcolor2">
        <span class="font-semibold text-textcolor">병합 출처</span>
        {#each [...new Set(DBState.db.personas.map((persona) => persona.sourceInfo?.label).filter(Boolean))] as source}
            <span class="rounded-full bg-primary/15 px-2 py-1 text-primary">{source}</span>
        {/each}
    </div>
{/if}
{#key sorted}
<div class="p-4 rounded-md border-darkborderc border mb-2 flex-wrap flex gap-2 w-full max-w-full min-w-0" bind:this={ele}>
    {#each DBState.db.personas as persona, i}
        <button
            type="button"
            class="relative"
            data-risu-idx={i}
            aria-label={persona.name}
            class:drop-persona-image={personaImageDropTarget === i}
            ondragenter={(event) => markPersonaImageDrop(event, i)}
            ondragover={(event) => markPersonaImageDrop(event, i)}
            ondragleave={(event) => clearPersonaImageDrop(event, i)}
            ondrop={(event) => dropPersonaImage(event, i)}
            onclick={() => {
                changeUserPersona(i)
            }}>
            {#if persona.icon === ''}
                <div class="flex h-20 w-20 cursor-pointer items-center justify-center rounded-md bg-textcolor2 p-2 text-center text-xs font-semibold leading-tight text-darkbg shadow-lg hover:text-primary" class:ring-3={i === DBState.db.selectedPersona}>
                    <span class="line-clamp-4 wrap-break-word">{persona.name || 'User'}</span>
                </div>
            {:else}
                {#await getCharImage(persona.icon, 'css')}
                    <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" class:ring-3={i === DBState.db.selectedPersona}></div>
                {:then im} 
                    <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-primary" style={im} class:ring-3={i === DBState.db.selectedPersona}></div>                
                {/await}
            {/if}
            {#if persona.sourceInfo?.label}
                <span class="persona-source-badge" title={`병합 출처: ${persona.sourceInfo.label}`}>
                    {persona.sourceInfo.label}
                </span>
            {/if}
        </button>
    {/each}
    <div class="flex justify-center items-center ml-2 mr-2">
        <BaseRoundedButton
            onClick={async () => {
                const sel = parseInt(await alertSelect([language.createfromScratch, language.importCharacter]))
                if(sel === 0){
                    DBState.db.personas.push({
                        name: 'New Persona',
                        icon: '',
                        personaPrompt: '',
                        note: ''
                    })
                    changeUserPersona(DBState.db.personas.length - 1)
                    void requestImmediateSave()
                } else if(sel === 1){
                    await importUserPersona()
                    void requestImmediateSave()
                }
            }}
            ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
                ><path
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                /></svg
            >
        </BaseRoundedButton>
    </div>
</div>
{/key}

<div
    class="persona-detail-panel flex rounded-md border border-darkborderc bg-darkbg"
    class:persona-panel-collapsed={personaPanelCollapsed}
    bind:this={personaPanel}
    style:left={`${panelLayout.x}px`}
    style:top={`${panelLayout.y}px`}
    style:width={`${panelLayout.width}px`}
    style:height={`${panelLayout.height}px`}
>
    <div
        class="persona-panel-grip flex h-9 shrink-0 items-center gap-2 border-b border-darkborderc px-3 text-xs text-textcolor2"
        role="toolbar"
        aria-label="Persona panel controls"
        tabindex="0"
        onpointerdown={beginPanelDrag}
    >
        <GripHorizontal size={16} />
        <span class="font-semibold text-textcolor">페르소나 정보</span>
        <span class="grow truncate">드래그하여 이동 · 우측 아래에서 크기 조절</span>
        <button
            type="button"
            class="rounded p-1 hover:bg-selected hover:text-textcolor"
            title="기본 크기와 위치로 복원"
            aria-label="Reset persona panel layout"
            onclick={resetPanelLayout}
        ><RotateCcw size={15} /></button>
        <button
            type="button"
            class="rounded p-1 hover:bg-selected hover:text-textcolor"
            title={personaPanelCollapsed ? '정보 패널 펼치기' : '정보 패널 접기'}
            aria-label={personaPanelCollapsed ? 'Expand persona panel' : 'Collapse persona panel'}
            onclick={() => {
                personaPanelCollapsed = !personaPanelCollapsed
                savePanelLayout()
            }}
        >{#if personaPanelCollapsed}<Maximize2 size={15} />{:else}<Minimize2 size={15} />{/if}</button>
    </div>
    {#if !personaPanelCollapsed}
    <div class="flex min-h-0 min-w-0 grow flex-col overflow-y-auto p-4">
        {#if DBState.db.personas[DBState.db.selectedPersona].sourceInfo?.label}
            <div class="mb-2 w-fit rounded-full bg-primary/15 px-2 py-1 text-xs font-semibold text-primary">
                병합 출처 · {DBState.db.personas[DBState.db.selectedPersona].sourceInfo.label}
            </div>
        {/if}
        <span class="text-sm text-textcolor2">{language.name} <Help key="personaName" /></span>
        <TextInput className="mt-2" marginBottom placeholder="User" bind:value={DBState.db.username}/>
        <span class="text-sm text-textcolor2">{language.note} <Help key="personaNote" /></span>
        {#if DBState.db.personaNote}
            <TextInput className="mt-2" marginBottom bind:value={DBState.db.userNote} placeholder={`Put a unique identifier for this persona here.\nExample: [Alternate Hunters persona]`} />
        {/if}
        <span class="text-sm text-textcolor2">{language.description} <Help key="personaDescription" /></span>
        <TextAreaInput className="mt-2 mb-4" autocomplete="off" bind:value={DBState.db.personaPrompt} placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`} />
        <div class="mt-4 flex max-w-full items-end justify-between gap-3 border-t border-darkborderc pt-3">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
                <Button onclick={exportUserPersona}>{language.export}</Button>
                <Button onclick={importUserPersona}>{language.import}</Button>
                <Button onclick={() => {
                    saveUserPersona()
                    const clone = $state.snapshot(DBState.db.personas[DBState.db.selectedPersona])
                    DBState.db.personas.push({
                        ...clone,
                        name: clone.name + ' (Copy)',
                        id: v4()
                    })
                    changeUserPersona(DBState.db.personas.length - 1, 'noSave')
                    void requestImmediateSave()
                }}>{language.personaDuplicate}</Button>

                <Button styled="danger" onclick={async () => {
                    if(DBState.db.personas.length === 1){
                        return
                    }
                    const d = await alertConfirm(`${language.removeConfirm}${DBState.db.personas[DBState.db.selectedPersona].name}`)
                    if(d){
                        saveUserPersona()
                        let personas = DBState.db.personas
                        personas.splice(DBState.db.selectedPersona, 1)
                        DBState.db.personas = personas
                        changeUserPersona(0, 'noSave')
                        void requestImmediateSave()
                    }
                }}>{language.remove}</Button>
                <Check bind:check={DBState.db.personas[DBState.db.selectedPersona].largePortrait} name={language.largePortrait}/>
                <Help key="personaLargePortrait" />
            </div>
            <button
                type="button"
                aria-label={DBState.db.username}
                class="shrink-0"
                class:drop-persona-image={personaImageDropTarget === DBState.db.selectedPersona}
                ondragenter={(event) => markPersonaImageDrop(event, DBState.db.selectedPersona)}
                ondragover={(event) => markPersonaImageDrop(event, DBState.db.selectedPersona)}
                ondragleave={(event) => clearPersonaImageDrop(event, DBState.db.selectedPersona)}
                ondrop={(event) => dropPersonaImage(event, DBState.db.selectedPersona)}
                onclick={() => {selectUserImg()}}
            >
                {#if DBState.db.userIcon === ''}
                    <div class="flex h-24 w-24 cursor-pointer items-center justify-center rounded-md bg-textcolor2 p-2 text-center text-xs font-semibold leading-tight text-darkbg shadow-lg hover:text-primary">
                        <span class="line-clamp-4 wrap-break-word">{DBState.db.username || 'User'}</span>
                    </div>
                {:else}
                    {#await getCharImage(DBState.db.userIcon, DBState.db.personas[DBState.db.selectedPersona].largePortrait ? 'lgcss' : 'css')}
                        <div class="h-24 w-24 cursor-pointer rounded-md bg-textcolor2 shadow-lg hover:text-primary"></div>
                    {:then im}
                        <div class="h-24 w-24 cursor-pointer rounded-md bg-textcolor2 shadow-lg hover:text-primary" style={im}></div>
                    {/await}
                {/if}
            </button>
        </div>
    </div>
    {/if}
</div>
</SettingPage>

<style>
    .drop-persona-image {
        border-radius: 0.375rem;
        outline: 3px solid var(--risu-theme-primary);
        outline-offset: 3px;
    }

    .persona-detail-panel {
        position: fixed;
        z-index: 50;
        min-width: 21.25rem;
        min-height: 11.875rem;
        max-width: calc(100vw - 1.5rem);
        max-height: calc(100vh - 1.5rem);
        flex-direction: column;
        overflow: hidden;
        resize: both;
        box-shadow: 0 -0.4rem 1.2rem color-mix(in srgb, var(--risu-theme-bgcolor) 82%, transparent);
    }

    .persona-panel-collapsed {
        height: 2.25rem !important;
        min-height: 2.25rem;
        resize: none;
    }

    .persona-panel-grip {
        cursor: move;
        touch-action: none;
        user-select: none;
    }

    @media (max-width: 640px) {
        .persona-detail-panel {
            position: sticky;
            left: auto !important;
            top: auto !important;
            bottom: 0;
            width: 100% !important;
            height: min(52vh, 24rem) !important;
            min-width: 0;
            max-width: 100%;
            resize: vertical;
        }

        .persona-panel-collapsed {
            height: 2.25rem !important;
            min-height: 2.25rem;
            resize: none;
        }

        .persona-panel-grip {
            cursor: default;
        }
    }

    .persona-source-badge {
        position: absolute;
        left: 0.2rem;
        right: 0.2rem;
        bottom: 0.2rem;
        overflow: hidden;
        border-radius: 9999px;
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 84%, transparent);
        padding: 0.1rem 0.3rem;
        color: var(--risu-theme-textcolor);
        font-size: 0.65rem;
        line-height: 1rem;
        text-overflow: ellipsis;
        white-space: nowrap;
        pointer-events: none;
    }
</style>
