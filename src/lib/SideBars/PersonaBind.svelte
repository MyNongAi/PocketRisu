<script lang="ts">
    import { getPaneView } from "src/ts/chatPanes.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { getCurrentChat } from "src/ts/storage/database.svelte";
    import { notifySuccess } from "src/ts/alert";
    import { ChevronDownIcon, ContactIcon } from "@lucide/svelte";
    import { openPersonaList, personaSelectCallback } from "src/ts/stores.svelte";
    import { v4 } from "uuid";
    import ShButton from "../UI/GUI/ShButton.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import { markPersonaApplied } from "src/ts/persona";
    import { editPersonaText } from "src/ts/personaTextEdit";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { boundPersona } from "src/ts/nameOnlyPersona";
    // The pane this is drawn in (chatPanes.svelte.ts): its chat, not only the selected one.
    const view = getPaneView()

    let currentChat = $derived(view.chat)

    // A name-only binding (nameOnlyPersona.ts) shows as its name.
    let bound = $derived(boundPersona(DBState.db, currentChat?.bindedPersona) ?? null)
    let displayPersona = $derived(bound ?? DBState.db.personas[DBState.db.selectedPersona])
    let isPersonaBound = $derived(!!bound)
    const descriptionId = `sidebar-persona-description-${v4()}`
    let descriptionExpanded = $state(false)
    let description = $state('')

    // Show the text a request sends (getPersonaPrompt in util.ts): the bound
    // persona's own, else the root personaPrompt of the global persona, which
    // its card only catches up with when the persona is saved.
    $effect(() => {
        description = bound ? (bound.personaPrompt ?? '') : (DBState.db.personaPrompt ?? '')
    })

    function editDescription(value: string) {
        const chat = currentChat
        if (!chat || !displayPersona) return
        const boundId = chat.bindedPersona
        const index = bound
            ? DBState.db.personas.findIndex((persona) => persona.id === boundId)
            : DBState.db.selectedPersona
        editPersonaText({
            db: DBState.db,
            index,
            nameOnlyId: boundId,
            followsDefault: !bound,
            onBind: (created) => {
                // The editor belongs to this pane, which can show a different chat.
                chat.bindedPersona = DBState.db.personas[created].id
                markPersonaApplied(created)
                void requestImmediateSave()
                notifySuccess(language.personaBindedSuccess)
            },
        }, { personaPrompt: value })
    }

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
    <ShButton
        size="icon"
        className="shrink-0"
        onclick={() => { descriptionExpanded = !descriptionExpanded }}
        title={language.personaDescriptionToggle}
        aria-label={language.personaDescriptionToggle}
        aria-expanded={descriptionExpanded}
    >
        <ChevronDownIcon size={16} class={`transition-transform${descriptionExpanded ? ' rotate-180' : ''}`} />
    </ShButton>
</div>
{#if descriptionExpanded && currentChat && displayPersona}
    <div class="flex flex-col gap-1 mt-1 pl-2 border-l border-selected min-w-0">
        <label for={descriptionId} class="text-[11px] text-textcolor2 px-1">{language.personaDescriptionLabel}</label>
        <TextAreaInput
            id={descriptionId}
            className="w-full min-w-0"
            fullwidth
            height="32"
            autocomplete="off"
            optimaizedInput={false}
            bind:value={description}
            onInput={() => editDescription(description)}
            placeholder={`Put the description of this persona here.\nExample: [<user> is a 20 year old girl.]`}
        />
    </div>
{/if}
