<script lang="ts">
    import ChatBody from './ChatBody.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import type { Chat, Message, character as CharacterData } from 'src/ts/storage/database.svelte'
    import type { simpleCharacterArgument } from 'src/ts/parser/parser.svelte'
    import type { RisuModule } from 'src/ts/process/modules'
    import { risuChatParser } from 'src/ts/process/scripts'

    let {
        message,
        character,
        chat,
        modules,
        simpleCharacter,
        index,
        resolveAssets = true,
    }: {
        message: Message
        character: CharacterData
        chat: Chat
        modules: readonly RisuModule[]
        simpleCharacter: simpleCharacterArgument
        index: number
        resolveAssets?: boolean
    } = $props()

    let translated = $state(false)
    let translating = $state(false)
    let retranslate = $state(false)
    let bodyRoot: HTMLElement | null = $state(null)
    let display = $derived(risuChatParser(message.data ?? '', {
        chara: character,
        chat,
        modules,
        chatID: index,
        rmVar: true,
        visualize: true,
        cbsConditions: {
            firstmsg: false,
            chatRole: message.role,
        },
    }))
    let roleName = $derived(message.role === 'user' ? DBState.db.username : character.name)
</script>

<article class:secondary-user={message.role === 'user'} class="secondary-message rounded-lg border border-darkborderc bg-bgcolor/90 px-3 py-2 text-textcolor">
    <div class="mb-1 text-xs font-semibold text-textcolor2">{roleName}</div>
    <div class="secondary-message-body prose max-w-none" bind:this={bodyRoot}>
        <ChatBody
            character={simpleCharacter}
            idx={index}
            msgDisplay={display}
            role={message.role}
            bind:translated
            bind:translating
            bind:retranslate
            {bodyRoot}
            modelShortName=""
            {resolveAssets}
        />
    </div>
</article>

<style>
    .secondary-message {
        width: min(94%, 52rem);
        align-self: flex-start;
    }

    .secondary-user {
        align-self: flex-end;
        background: color-mix(in srgb, var(--risu-theme-primary) 12%, var(--risu-theme-bgcolor));
    }

    .secondary-message-body :global(img),
    .secondary-message-body :global(video) {
        max-width: 100%;
        height: auto;
    }
</style>
