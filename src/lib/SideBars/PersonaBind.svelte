<script lang="ts">
    import { DBState, selectedCharID } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { getCurrentChat } from "src/ts/storage/database.svelte";
    import { notifySuccess } from "src/ts/alert";
    import { ContactIcon, UserRoundIcon } from "@lucide/svelte";
    import { getCharImage } from "src/ts/characters";
    import { openPersonaList, personaSelectCallback } from "src/ts/stores.svelte";
    import { v4 } from "uuid";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import { markPersonaApplied } from "src/ts/persona";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";

    let currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage])

    let boundPersona = $derived.by(() => {
        const id = currentChat?.bindedPersona
        if (!id) return null
        return DBState.db.personas.find(p => p.id === id) ?? null
    })
    let displayPersona = $derived(boundPersona ?? DBState.db.personas[DBState.db.selectedPersona])
    let isPersonaBound = $derived(!!boundPersona)

    function bindPersona(personaIndex: number) {
        const chat = getCurrentChat()
        if (!chat) return
        const persona = DBState.db.personas[personaIndex]
        if (!persona.id) persona.id = v4()
        chat.bindedPersona = persona.id
        markPersonaApplied(personaIndex)
        void requestImmediateSave()
        notifySuccess(language.personaBindedSuccess)
    }

    // One-tap buttons right of the binding: the blank persona (no
    // description) and the favorited personas.
    let favorites = $derived(DBState.db.personas
        .map((persona, index) => ({ persona, index }))
        .filter(({ persona }) => persona.favorite && !persona.nodeOnlyBlank))
    let boundId = $derived(currentChat?.bindedPersona || '')

    // Created on first use, then reused.
    function bindBlankPersona() {
        let index = DBState.db.personas.findIndex((persona) => persona.nodeOnlyBlank)
        if (index < 0) {
            const now = Date.now()
            DBState.db.personas = [...DBState.db.personas, {
                id: v4(),
                name: 'User',
                icon: '',
                personaPrompt: '',
                note: language.personaBlank,
                createdAt: now,
                lastAppliedAt: now,
                nodeOnlyBlank: true,
            }]
            index = DBState.db.personas.length - 1
        }
        bindPersona(index)
    }

    function unbindPersona() {
        const chat = getCurrentChat()
        if (!chat) return
        chat.bindedPersona = ''
        notifySuccess(language.personaUnbindedSuccess)
    }

    // One tap opens the picker. Its top row ("default") unbinds; any persona
    // binds — same flow as the memory preset binding.
    function handlePersonaBindClick() {
        personaSelectCallback.set((index) => {
            if (index < 0) unbindPersona()
            else bindPersona(index)
        })
        openPersonaList.set(true)
    }
</script>

<div class="text-[11px] text-textcolor2 mt-4 px-1">{language.personaBindingLabel}</div>
<div class="flex gap-1 mt-1 items-stretch">
    <ShButton
        className={`flex-1 min-w-0 justify-start ${isPersonaBound
            ? 'border-selected text-textcolor'
            : 'text-textcolor2 opacity-75 hover:opacity-100'}`}
        onclick={handlePersonaBindClick}
    >
        <ContactIcon size={16} class="shrink-0" />
        <span class="truncate">{isPersonaBound ? (displayPersona?.name ?? 'User') : `${language.memoryPresetInherit} (${displayPersona?.name ?? 'User'})`}</span>
        {#if displayPersona?.note}
            <span class="truncate text-xs opacity-60">({displayPersona.note})</span>
        {/if}
    </ShButton>
    <div class="flex max-w-[55%] shrink-0 items-center gap-1 overflow-x-auto">
        <button
            type="button"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-textcolor2 hover:text-textcolor {boundPersona?.nodeOnlyBlank ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc'}"
            title={language.personaBlankBind}
            aria-label={language.personaBlankBind}
            onclick={bindBlankPersona}
        ><UserRoundIcon size={16} /></button>
        {#each favorites as { persona, index } (persona.id ?? index)}
            <button
                type="button"
                class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-selected/45 text-xs font-semibold {persona.id && persona.id === boundId ? 'border-primary ring-2 ring-primary/40' : 'border-darkborderc'}"
                title={persona.name || 'User'}
                aria-label={`${language.personaBindingLabel}: ${persona.name || 'User'}`}
                onclick={() => bindPersona(index)}
            >
                {#if persona.icon}
                    {#await getCharImage(persona.icon, 'css') then im}
                        <div class="h-full w-full bg-cover bg-center" style={im}></div>
                    {/await}
                {:else}
                    {(persona.name || 'U').slice(0, 1)}
                {/if}
            </button>
        {/each}
    </div>
</div>
