<script lang="ts">
    import { CopyIcon, Trash2Icon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import type { ModelPreset } from "src/ts/preset/types";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { v4 as uuidv4 } from "uuid";

    interface Props {
        preset: ModelPreset;
        onAfterDelete?: () => void;
    }

    let { preset = $bindable(), onAfterDelete = () => {} }: Props = $props();

    function duplicate() {
        const src = preset;
        const idx = DBState.db.modelPresets.findIndex(p => p.id === src.id);
        if (idx < 0) return;
        const copy = safeStructuredClone(src);
        copy.id = uuidv4();
        copy.name = `${src.name} Copy`;
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        DBState.db.modelPresets = [...DBState.db.modelPresets, copy];
        notifySuccess(language.presetDuplicated);
    }

    async function remove() {
        const ok = await alertConfirm(`${language.presetDeleteConfirm}\n${preset.name}`);
        if (!ok) return;
        const idx = DBState.db.modelPresets.findIndex(p => p.id === preset.id);
        if (idx < 0) return;
        const next = [...DBState.db.modelPresets];
        next.splice(idx, 1);
        DBState.db.modelPresets = next;
        notifySuccess(language.presetDeleted);
        onAfterDelete();
    }
</script>

<div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
        <span class="text-textcolor">{language.name}</span>
        <TextInput bind:value={preset.name} fullwidth />
    </div>

    <div class="flex flex-col gap-1 p-3 rounded-md border border-darkborderc bg-darkbg/40">
        <span class="text-xs text-textcolor2 uppercase tracking-wide">Profile</span>
        <div class="text-sm text-textcolor">{preset.profileSnapshot.profileId}</div>
        <div class="text-xs text-textcolor2">Provider: {preset.profileSnapshot.providerBaseId}</div>
        {#if preset.profileSnapshot.modelId}
            <div class="text-xs text-textcolor2">Default model: {preset.profileSnapshot.modelId}</div>
        {/if}
        {#if preset.profileSnapshot.capabilities && preset.profileSnapshot.capabilities.length > 0}
            <div class="flex flex-wrap gap-1 mt-1">
                {#each preset.profileSnapshot.capabilities as cap}
                    <span class="text-xs px-2 py-0.5 rounded border border-darkborderc text-textcolor2">{cap}</span>
                {/each}
            </div>
        {/if}
    </div>

    <div class="flex flex-col gap-2">
        <ShButton variant="default" size="default" className="w-full" onclick={duplicate}>
            <CopyIcon size={16}/>
            <span class="ml-1">{language.presetDuplicate}</span>
        </ShButton>
        <ShButton variant="destructive" size="default" className="w-full" onclick={remove}>
            <Trash2Icon size={16}/>
            <span class="ml-1">{language.presetDelete}</span>
        </ShButton>
    </div>
</div>
