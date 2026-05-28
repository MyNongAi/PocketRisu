<script lang="ts">
    import { ArrowLeftIcon, CopyIcon, PlusIcon, TrashIcon } from "@lucide/svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { language } from "src/lang";
    import { DBState, openModelProfileBrowser } from "src/ts/stores.svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { v4 as uuidv4 } from "uuid";

    let editingId = $state<string | null>(null);
    let submenu = $state(0);

    const editingPreset = $derived(
        editingId
            ? DBState.db.modelPresets.find(p => p.id === editingId) ?? null
            : null
    );

    // If the preset being edited disappears (deleted elsewhere), fall back to list.
    $effect(() => {
        if (editingId && !editingPreset) {
            editingId = null;
        }
    });

    function duplicate(index: number) {
        const src = DBState.db.modelPresets[index];
        if (!src) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        DBState.db.modelPresets = [...DBState.db.modelPresets, copy];
        notifySuccess(language.presetDuplicated);
    }

    async function remove(index: number) {
        const preset = DBState.db.modelPresets[index];
        if (!preset) return;
        const ok = await alertConfirm(`${language.removeConfirm}${preset.name}`);
        if (!ok) return;
        const next = [...DBState.db.modelPresets];
        next.splice(index, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
    }

    function createNew() {
        openModelProfileBrowser.set(true);
    }
</script>

<SettingPage title={language.modelPresetMenu}>
    {#if !editingId}
        <ShButton variant="default" size="default" className="w-full mb-4" onclick={createNew}>
            <PlusIcon size={16}/>
            <span class="ml-1">{language.modelPresetCreate}</span>
        </ShButton>

        {#if DBState.db.modelPresets.length === 0}
            <div class="text-textcolor2 text-sm text-center py-8">
                {language.modelPresetEmpty}
            </div>
        {:else}
            <div class="flex flex-col gap-1">
                {#each DBState.db.modelPresets as preset, i (preset.id)}
                    <button
                        class="flex items-center text-textcolor border border-darkborderc rounded-md p-3 cursor-pointer hover:bg-selected/30 transition-colors text-left"
                        onclick={() => { editingId = preset.id; submenu = 0; }}
                    >
                        <div class="flex flex-col min-w-0 grow">
                            <span class="text-sm text-textcolor truncate">{preset.name}</span>
                            {#if preset.profileSnapshot?.profileId}
                                <span class="text-xs text-textcolor2 truncate">{preset.profileSnapshot.profileId}</span>
                            {/if}
                        </div>
                        <div class="flex gap-2 shrink-0 ml-2">
                            <div class="text-textcolor2 hover:text-primary cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                                e.stopPropagation()
                                duplicate(i)
                            }} onkeydown={(e) => {
                                if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                    e.currentTarget.click()
                                }
                            }} aria-label="duplicate">
                                <CopyIcon size={18}/>
                            </div>
                            <div class="text-textcolor2 hover:text-red-400 cursor-pointer" role="button" tabindex="0" onclick={(e) => {
                                e.stopPropagation()
                                remove(i)
                            }} onkeydown={(e) => {
                                if (e.key === 'Enter' && e.currentTarget instanceof HTMLElement) {
                                    e.currentTarget.click()
                                }
                            }} aria-label="delete">
                                <TrashIcon size={18}/>
                            </div>
                        </div>
                    </button>
                {/each}
            </div>
        {/if}
    {:else}
        <ShButton variant="ghost" size="sm" className="mb-4 self-start" onclick={() => { editingId = null }}>
            <ArrowLeftIcon size={16}/>
            <span class="ml-1">{language.backToList}</span>
        </ShButton>

        <SettingTabs
            tabs={[
                { label: language.basicInfo, value: 0 },
                { label: language.basicSettings, value: 1 },
                { label: language.advancedSettings, value: 2 },
            ]}
            bind:selected={submenu}
        />

        {#if submenu === 0}
            <p class="text-textcolor2 mt-4">기본 정보 영역 — Phase 후속에서 채워짐 (이름, 프로필 표시, 복제/내보내기/불러오기/삭제)</p>
        {:else if submenu === 1}
            <p class="text-textcolor2 mt-4">기본 설정 영역 — Phase 3 (registry schema renderer)에서 구현</p>
        {:else if submenu === 2}
            <p class="text-textcolor2 mt-4">고급 설정 영역 — Phase 3/6에서 구현 (customBody / customHeaders)</p>
        {/if}
    {/if}
</SettingPage>
