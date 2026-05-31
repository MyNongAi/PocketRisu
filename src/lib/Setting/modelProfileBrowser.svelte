<script lang="ts">
    import { SearchIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import { notifySuccess } from "src/ts/alert";
    import {
        getBundledRegistryId,
        loadBundledRegistry,
        resolveSnapshot,
    } from "src/ts/preset/registry";
    import { localizeDisplayName, localizeDescription } from "src/ts/preset/registry/i18n";
    import type { BaseProviderDefinition, ModelPreset, ModelProfile, RegistryProfileStatus, ResolvedModelProfileSnapshot } from "src/ts/preset/types";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { v4 as uuidv4 } from "uuid";

    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    const registry = loadBundledRegistry();
    const registryId = getBundledRegistryId();

    // Flatten all profiles across all registries (currently just `bundled`).
    type Entry = {
        profile: ModelProfile;
        baseProvider: BaseProviderDefinition | undefined;
    };

    const profileStatusOrder: RegistryProfileStatus[] = ['current', 'outdated', 'deprecated'];

    function getProfileStatusLabel(status: RegistryProfileStatus): string {
        if (status === 'current') return language.profileStatusCurrent;
        if (status === 'outdated') return language.profileStatusOutdated;
        return language.profileStatusDeprecated;
    }

    const entries: Entry[] = (() => {
        const out: Entry[] = [];
        for (const reg of Object.values(registry.registries)) {
            for (const profile of Object.values(reg.profiles ?? {})) {
                const baseProvider = reg.baseProviders?.[profile.providerBaseId];
                out.push({ profile, baseProvider });
            }
        }
        return out.sort((a, b) =>
            (a.baseProvider?.displayName ?? '').localeCompare(b.baseProvider?.displayName ?? '')
            || a.profile.displayName.localeCompare(b.profile.displayName),
        );
    })();

    let query = $state('');

    const filtered = $derived.by(() => {
        const q = query.trim().toLowerCase();
        if (!q) return entries;
        return entries.filter(({ profile, baseProvider }) => {
            return profile.displayName.toLowerCase().includes(q)
                || localizeDisplayName(profile).toLowerCase().includes(q)
                || profile.id.toLowerCase().includes(q)
                || profile.modelId.toLowerCase().includes(q)
                || (profile.description ?? '').toLowerCase().includes(q)
                || localizeDescription(profile).toLowerCase().includes(q)
                || (baseProvider?.displayName ?? '').toLowerCase().includes(q)
                || (baseProvider?.id ?? '').toLowerCase().includes(q);
        });
    });

    const groupedFiltered = $derived.by(() => {
        const buckets = new Map<RegistryProfileStatus, Entry[]>();
        for (const status of profileStatusOrder) buckets.set(status, []);
        for (const entry of filtered) {
            buckets.get(entry.profile.profileStatus)?.push(entry);
        }
        return profileStatusOrder
            .map((status) => ({ status, entries: buckets.get(status) ?? [] }))
            .filter((group) => group.entries.length > 0);
    });

    function seedDefaults(snapshot: ResolvedModelProfileSnapshot): Record<string, unknown> {
        const seeded: Record<string, unknown> = {};
        for (const field of snapshot.schema) {
            if (field.default !== undefined) seeded[field.key] = field.default;
        }
        return seeded;
    }

    function createPresetFrom(profile: ModelProfile) {
        const snapshot = resolveSnapshot(registry, profile.id);
        const preset: ModelPreset = {
            id: uuidv4(),
            name: profile.displayName,
            profileSnapshot: snapshot,
            sourceProfile: {
                registryId,
                profileId: snapshot.profileId,
                profileVersion: snapshot.profileVersion,
                providerBaseVersion: snapshot.providerBaseVersion,
                fetchedAt: Date.now(),
            },
            userValues: seedDefaults(snapshot),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        DBState.db.modelPresets = [...DBState.db.modelPresets, preset];
        notifySuccess(language.modelPresetCreated);
        close();
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-124 max-h-full overflow-hidden">
        <div class="flex items-center text-textcolor mb-4 shrink-0">
            <h2 class="mt-0 mb-0">{language.selectProfile}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>

        <div class="flex items-center gap-2 mb-4 shrink-0">
            <SearchIcon size={16} class="text-textcolor2 shrink-0" />
            <TextInput bind:value={query} placeholder={language.searchProfiles} fullwidth />
        </div>

        <div class="flex flex-col gap-1 overflow-y-auto">
            {#if filtered.length === 0}
                <div class="text-textcolor2 text-sm text-center py-8">
                    {language.noProfileMatch}
                </div>
            {:else}
                {#each groupedFiltered as group (group.status)}
                    <section class="flex flex-col gap-1 mt-2 first:mt-0">
                        <h3 class="text-xs font-semibold uppercase text-textcolor2 px-1">
                            {getProfileStatusLabel(group.status)}
                        </h3>
                        {#each group.entries as { profile, baseProvider } (profile.id)}
                            {@const localizedDesc = localizeDescription(profile)}
                            <button
                                class="flex items-start text-textcolor border border-darkborderc rounded-md p-3 cursor-pointer hover:bg-selected/30 transition-colors text-left"
                                onclick={() => createPresetFrom(profile)}
                            >
                                <div class="flex flex-col min-w-0 grow">
                                    <div class="flex items-center gap-2">
                                        <span class="text-sm text-textcolor truncate">{localizeDisplayName(profile)}</span>
                                        {#if baseProvider}
                                            <span class="text-xs text-textcolor2 shrink-0">[{baseProvider.displayName}]</span>
                                        {/if}
                                    </div>
                                    <span class="text-xs text-textcolor2 truncate">{profile.id}</span>
                                    {#if localizedDesc}
                                        <span class="text-xs text-textcolor2 mt-1 truncate">{localizedDesc}</span>
                                    {/if}
                                    {#if profile.statusReason}
                                        <span class="text-xs text-textcolor2 mt-1 truncate">{profile.statusReason}</span>
                                    {/if}
                                </div>
                            </button>
                        {/each}
                    </section>
                {/each}
            {/if}
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
