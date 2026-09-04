<script lang="ts">
    import { AccessibilityIcon, ActivityIcon, PackageIcon, BotIcon, CodeIcon, CogIcon, ContactIcon, FlaskConicalIcon, GripVerticalIcon, ImageIcon, LanguagesIcon, MonitorIcon, MonitorSmartphoneIcon, Sailboat, ScrollTextIcon, SearchIcon, CircleXIcon, KeyboardIcon, TruckIcon, FileBoxIcon, Volume2Icon, HeartIcon, BrainIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { supportDialogOpen, supportEnabled } from "src/ts/support";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import NotificationSoundSettings from "./Pages/NotificationSoundSettings.svelte";
    import MigrationSettings from "./Pages/MigrationSettings.svelte";
    import BotSettings from "./Pages/BotSettings.svelte";
    import ModelPresetSettings from "./Pages/Model/ModelPresetSettings.svelte";
    import PromptPresetSettings from "./Pages/PromptPresetSettings.svelte";
    import OtherBotSettings from "./Pages/OtherBotSettings.svelte";
    import PluginSettings from "./Pages/PluginSettings.svelte";
    import FilesSettings from "./Pages/FilesSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import SystemSettings from "./Pages/SystemSettings.svelte";
    import { additionalSettingsMenu, MobileGUI, SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import GlobalLoreBookSettings from "./Pages/GlobalLoreBookSettings.svelte";
    import Lorepreset from "./lorepreset.svelte";
    import GlobalRegex from "./Pages/GlobalRegex.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import MemorySettings from "./Pages/MemorySettings.svelte";
    import PromptSettings from "./Pages/PromptSettings.svelte";
    import ModuleSettings from "./Pages/Module/ModuleSettings.svelte";
  import { isLite } from "src/ts/lite";
    import HotkeySettings from "./Pages/HotkeySettings.svelte";
    import InlayImageGallery from "./Pages/InlayImageGallery.svelte";
    import RemoteAccessSettings from "./Pages/RemoteAccessSettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import DevPanel from "src/lib/_dev/DevPanel.svelte";
    import SettingsSearch from "./SettingsSearch.svelte";
    import { MediaQuery } from "svelte/reactivity";
    import Sortable from 'sortablejs/modular/sortable.core.esm.js';
    import {
        mergeVisibleSettingsMenuOrder,
        moveVisibleSettingsMenuItem,
        readSettingsMenuOrder,
        writeSettingsMenuOrder,
    } from "src/ts/setting/menuOrder";

    // Dev panel is opt-in via localStorage['risu-dev-panel']='1' in devtools.
    // Read once on mount — flag changes require reload. Gates both the menu
    // button below and the route render branch (SettingsMenuIndex === 99).
    const devPanelEnabled = typeof localStorage !== 'undefined'
        && localStorage.getItem('risu-dev-panel') === '1';

    let openLoreList = $state(false)
    let searchOpen = $state(false)

    // Reactive breakpoints: the raw window.innerWidth reads these replace were
    // evaluated outside Svelte's reactivity, so the layout never responded to
    // window resizes. Three distinct thresholds — do not merge them.
    const wide900 = new MediaQuery('(min-width: 900px)')
    const wide700 = new MediaQuery('(min-width: 700px)')
    const wide768 = new MediaQuery('(min-width: 768px)')

    type SettingsMenuItem = {
        id: string
        index: number
        label: () => string
        icon: typeof BotIcon
        fullOnly?: boolean
        devOnly?: boolean
        activeIndices?: number[]
    }

    const settingsMenuItems: SettingsMenuItem[] = [
        { id: 'bot', index: 1, label: () => language.chatBot, icon: BotIcon, fullOnly: true, activeIndices: [1, 13] },
        { id: 'model-preset', index: 16, label: () => language.modelPresetMenu, icon: FileBoxIcon, fullOnly: true },
        { id: 'prompt-preset', index: 17, label: () => language.promptPresetMenu, icon: ScrollTextIcon, fullOnly: true },
        { id: 'persona', index: 12, label: () => language.persona, icon: ContactIcon, fullOnly: true },
        { id: 'memory', index: 24, label: () => language.longTermMemory, icon: BrainIcon, fullOnly: true },
        { id: 'other-bots', index: 2, label: () => language.otherBots, icon: Sailboat, fullOnly: true },
        { id: 'display', index: 3, label: () => language.display, icon: MonitorIcon, fullOnly: true },
        { id: 'sound', index: 7, label: () => language.soundAndNotification, icon: Volume2Icon, fullOnly: true },
        { id: 'language', index: 10, label: () => language.language, icon: LanguagesIcon },
        { id: 'accessibility', index: 11, label: () => language.accessibility, icon: AccessibilityIcon, fullOnly: true },
        { id: 'modules', index: 14, label: () => language.modules, icon: PackageIcon, fullOnly: true },
        { id: 'plugins', index: 4, label: () => language.plugin, icon: CodeIcon, fullOnly: true },
        { id: 'migration', index: 0, label: () => language.migration, icon: TruckIcon },
        { id: 'hotkeys', index: 15, label: () => language.hotkey, icon: KeyboardIcon },
        { id: 'inlay-gallery', index: 23, label: () => language.playground.inlayImageGallery, icon: ImageIcon, fullOnly: true },
        { id: 'remote-access', index: 21, label: () => language.remoteAccess, icon: MonitorSmartphoneIcon, fullOnly: true },
        { id: 'advanced', index: 6, label: () => language.advancedSettings, icon: ActivityIcon, fullOnly: true },
        { id: 'system', index: 22, label: () => language.system, icon: CogIcon, fullOnly: true },
        { id: 'dev-panel', index: 99, label: () => 'Dev Panel', icon: FlaskConicalIcon, fullOnly: true, devOnly: true },
    ]
    const settingsMenuById = new Map(settingsMenuItems.map((item) => [item.id, item]))
    const settingsMenuStorage = typeof localStorage !== 'undefined' ? localStorage : null
    let settingsMenuOrder = $state(readSettingsMenuOrder(settingsMenuItems.map((item) => item.id), settingsMenuStorage))
    let settingsMenuDragging = $state(false)
    let settingsMenuAnnouncement = $state('')
    const visibleSettingsMenuItems = $derived.by(() => {
        const result: SettingsMenuItem[] = []
        for (const id of settingsMenuOrder) {
            const item = settingsMenuById.get(id)
            if (!item) continue
            if (item.fullOnly && $isLite) continue
            if (item.devOnly && !devPanelEnabled) continue
            result.push(item)
        }
        return result
    })

    function sortableSettingsMenu(node: HTMLElement) {
        const sortable = Sortable.create(node, {
            animation: 150,
            draggable: '[data-settings-menu-id]',
            delay: 320,
            delayOnTouchOnly: true,
            touchStartThreshold: 5,
            fallbackTolerance: 5,
            ghostClass: 'settings-menu-ghost',
            chosenClass: 'settings-menu-chosen',
            onStart: () => { settingsMenuDragging = true },
            onEnd: () => {
                const visibleOrder = Array.from(node.querySelectorAll<HTMLElement>('[data-settings-menu-id]'))
                    .map((element) => element.dataset.settingsMenuId)
                    .filter((id): id is string => Boolean(id))
                settingsMenuOrder = mergeVisibleSettingsMenuOrder(settingsMenuOrder, visibleOrder)
                writeSettingsMenuOrder(settingsMenuOrder, settingsMenuStorage)
                setTimeout(() => { settingsMenuDragging = false }, 0)
            },
        })
        return { destroy: () => sortable.destroy() }
    }

    function openSettingsMenu(index: number) {
        if (!settingsMenuDragging) $SettingsMenuIndex = index
    }

    function reorderSettingsMenuWithKeyboard(event: KeyboardEvent, item: SettingsMenuItem) {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        const visibleOrder = visibleSettingsMenuItems.map((visibleItem) => visibleItem.id)
        const currentIndex = visibleOrder.indexOf(item.id)
        const offset = event.key === 'ArrowUp' ? -1 : 1
        const targetIndex = currentIndex + offset
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= visibleOrder.length) return
        event.preventDefault()
        event.stopPropagation()
        settingsMenuOrder = moveVisibleSettingsMenuItem(settingsMenuOrder, visibleOrder, item.id, offset)
        writeSettingsMenuOrder(settingsMenuOrder, settingsMenuStorage)
        settingsMenuAnnouncement = `${item.label()}: ${targetIndex + 1} / ${visibleOrder.length}`
    }

    $effect(() => {
        if(wide900.current && $SettingsMenuIndex === -1 && !$MobileGUI){
            $SettingsMenuIndex = 1
        }
    })
    $effect(() => {
        // The hotkey page only renders at >=768px; route back to the menu when
        // the viewport drops below that so the panel doesn't go blank.
        if(!wide768.current && !$MobileGUI && $SettingsMenuIndex === 15){
            $SettingsMenuIndex = -1
        }
    })

</script>
<div class="h-full w-full flex justify-center rs-setting-cont" class:bg-bgcolor={$MobileGUI} class:setting-bg={!$MobileGUI}>
    <div class="h-full max-w-4xl w-full flex relative rs-setting-cont-2">
        {#if (wide700.current && !$MobileGUI) || $SettingsMenuIndex === -1}
            <div class="flex h-full flex-col p-4 pt-8 gap-2 overflow-y-auto relative rs-setting-cont-3 shrink-0"
                class:w-full={!wide700.current || $MobileGUI}
                class:w-60={wide700.current && !$MobileGUI}
                class:bg-darkbg={!$MobileGUI} class:bg-bgcolor={$MobileGUI}
            >
                <!-- Fake-input trigger: the actual search lives in a dialog
                     (SettingsSearch) so the result list never reflows the
                     sidebar. -->
                <button
                    class="flex items-center gap-2 border border-darkborderc hover:border-borderc rounded-md px-2 py-1.5 text-textcolor2 transition-colors"
                    onclick={() => { searchOpen = true }}
                >
                    <SearchIcon size={16} class="shrink-0" />
                    <span class="text-sm">{language.searchSettingsPlaceholder}</span>
                </button>
                <div class="flex flex-col gap-2" use:sortableSettingsMenu>
                    {#each visibleSettingsMenuItems as item (item.id)}
                        {@const MenuIcon = item.icon}
                        {@const isActive = item.activeIndices
                            ? item.activeIndices.includes($SettingsMenuIndex)
                            : $SettingsMenuIndex === item.index}
                        <button
                            type="button"
                            data-settings-menu-id={item.id}
                            class="settings-menu-item flex gap-2 items-center hover:text-textcolor"
                            class:text-textcolor={isActive}
                            class:text-textcolor2={!isActive}
                            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                            onclick={() => openSettingsMenu(item.index)}
                            onkeydown={(event) => reorderSettingsMenuWithKeyboard(event, item)}
                        >
                            <MenuIcon />
                            <span>{item.label()}</span>
                            <span class="grow"></span>
                            <GripVerticalIcon size={16} class="settings-menu-grip shrink-0 opacity-35" aria-hidden="true" />
                        </button>
                    {/each}
                </div>
                <span class="sr-only" aria-live="polite" aria-atomic="true">{settingsMenuAnnouncement}</span>
                {#if !$isLite}
                    {#if $supportEnabled}
                        <button class="flex gap-2 items-center hover:text-textcolor text-textcolor2"
                            onclick={() => supportDialogOpen.set(true)}>
                            <HeartIcon />
                            <span>{language.support}</span>
                        </button>
                    {/if}
                    {#if additionalSettingsMenu.length > 0}
                        <div class="border-t border-selected mt-2 pt-2">
                            <span class="text-textcolor2 text-xs ml-1">{language.plugin}</span>
                        </div>
                    {/if}
                    {#each additionalSettingsMenu as menu}
                        <button class="flex gap-2 items-center hover:text-textcolor text-textcolor2"
                            onclick={() => menu.callback()}>
                            <PluginDefinedIcon ico={menu} className="w-5 h-5 shrink-0" />
                            <span>{menu.name}</span>
                        </button>
                    {/each}
                {/if}
                {#if !wide700.current && !$MobileGUI}
                    <button class="absolute top-2 right-2 hover:text-primary text-textcolor" onclick={() => {
                        settingsOpen.set(false)
                    }}> <CircleXIcon size={DBState.db.settingsCloseButtonSize} /> </button>
                {/if}
            </div>
        {/if}
        {#if (wide700.current && !$MobileGUI) || $SettingsMenuIndex !== -1}
            {#key $SettingsMenuIndex}
                <div class="grow py-6 px-4 bg-bgcolor flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-4 min-w-0 [scrollbar-gutter:stable]">
                    <div class="w-full max-w-2xl mx-auto flex flex-col">
                        {#if $SettingsMenuIndex === 0}
                            <MigrationSettings />
                        {:else if $SettingsMenuIndex === 1}
                            <BotSettings />
                        {:else if $SettingsMenuIndex === 2}
                            <OtherBotSettings />
                        {:else if $SettingsMenuIndex === 3}
                            <DisplaySettings />
                        {:else if $SettingsMenuIndex === 7}
                            <NotificationSoundSettings />
                        {:else if $SettingsMenuIndex === 4}
                            <PluginSettings />
                        {:else if $SettingsMenuIndex === 5}
                            <FilesSettings />
                        {:else if $SettingsMenuIndex === 6}
                            <AdvancedSettings />
                        {:else if $SettingsMenuIndex === 8}
                            <GlobalLoreBookSettings bind:openLoreList />
                        {:else if $SettingsMenuIndex === 9}
                            <GlobalRegex/>
                        {:else if $SettingsMenuIndex === 10}
                            <LanguageSettings/>
                        {:else if $SettingsMenuIndex === 11}
                            <AccessibilitySettings/>
                        {:else if $SettingsMenuIndex === 12}
                            <PersonaSettings/>
                        {:else if $SettingsMenuIndex === 24}
                            <MemorySettings/>
                        {:else if $SettingsMenuIndex === 14}
                            <ModuleSettings/>
                        {:else if $SettingsMenuIndex === 13}
                            <PromptSettings onGoBack={() => {
                                $SettingsMenuIndex = 1
                            }}/>
                        {:else if $SettingsMenuIndex === 15 && wide768.current}
                            <HotkeySettings/>
                        {:else if $SettingsMenuIndex === 16}
                            <ModelPresetSettings/>
                        {:else if $SettingsMenuIndex === 17}
                            <PromptPresetSettings/>
                        {:else if $SettingsMenuIndex === 23}
                            <InlayImageGallery/>
                        {:else if $SettingsMenuIndex === 21}
                            <RemoteAccessSettings/>
                        {:else if $SettingsMenuIndex === 22}
                            <SystemSettings/>
                        {:else if $SettingsMenuIndex === 99 && devPanelEnabled}
                            <DevPanel/>
                        {/if}
                    </div>
            </div>
            {/key}
            {#if !$MobileGUI}
                <button class="absolute top-2 right-2 hover:text-primary text-textcolor" onclick={() => {
                    if(window.innerWidth >= 700){
                        settingsOpen.set(false)
                    }
                    else{
                        $SettingsMenuIndex = -1
                    }
                }}>
                    <CircleXIcon size={DBState.db.settingsCloseButtonSize} />
                </button>
            {/if}
        {/if}
    </div>
</div>
{#if openLoreList}
    <Lorepreset close={() => {openLoreList = false}} />
{/if}
<SettingsSearch bind:open={searchOpen} />
<style>
    .setting-bg{
        background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-bgcolor) 50%);

    }
    /* The desktop sidebar is fixed-width, so a long menu name (plugins can
       register any label) has to wrap inside it instead of widening the
       column and squeezing the settings pane. */
    .rs-setting-cont-3 button{
        text-align: left;
    }
    .rs-setting-cont-3 span{
        overflow-wrap: anywhere;
    }
    .rs-setting-cont-3 :global(svg),
    .rs-setting-cont-3 :global(img){
        flex-shrink: 0;
    }
    .settings-menu-item {
        min-height: 2rem;
        cursor: grab;
        touch-action: pan-y;
        user-select: none;
    }
    :global(.settings-menu-chosen) {
        border-radius: 0.375rem;
        background: var(--risu-theme-darkborderc);
        cursor: grabbing;
    }
    :global(.settings-menu-ghost) {
        opacity: 0.35;
    }
</style>
