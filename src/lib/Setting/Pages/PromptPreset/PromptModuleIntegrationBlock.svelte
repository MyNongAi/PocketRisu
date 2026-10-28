<script lang="ts">
    // The preset's module integration (고급 설정 › 모듈 통합) with what each
    // name turns on, the user's request, 2026-10-28 (moduleIntegration.ts).
    import { XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import { addIntegration, integrationCandidates, removeIntegration, resolveIntegration } from "src/ts/process/moduleIntegration";

    let links = $derived(resolveIntegration(DBState.db.moduleIntergration, DBState.db.modules ?? []))
    let choices = $derived(integrationCandidates(DBState.db.moduleIntergration, DBState.db.modules ?? []))
    let pick = $state('')

    const more = (count: number) => count > 0 ? ` ${language.moduleIntegrationMore(count)}` : ''
</script>

<div class="flex flex-col gap-2 min-w-0" data-module-integration>
    <TextAreaInput fullwidth autocomplete="off" bind:value={DBState.db.moduleIntergration} placeholder="namespace1, namespace2" />
    {#if links.length > 0}
        <div class="flex flex-wrap gap-1">
            {#each links as link (link.value)}
                <span class="inline-flex items-center gap-1 min-w-0 max-w-full rounded-md border px-2 py-0.5 text-xs"
                    class:border-darkborderc={link.modules.length > 0}
                    class:border-red-500={link.modules.length === 0}
                    class:text-red-400={link.modules.length === 0}
                    title={link.modules.map((module) => module.name).join('\n') || link.value}
                    data-integration-link={link.value}
                    data-integration-missing={link.modules.length === 0 ? '' : undefined}>
                    <span class="truncate">
                        {link.modules.length === 0
                            ? `${link.value} · ${language.moduleIntegrationMissing}`
                            : `${link.modules[0].name}${more(link.modules.length - 1)}`}
                    </span>
                    <button class="shrink-0 text-textcolor2 hover:text-textcolor" title={language.moduleIntegrationRemove} aria-label={language.moduleIntegrationRemove}
                        onclick={() => DBState.db.moduleIntergration = removeIntegration(DBState.db.moduleIntergration, link.value)}>
                        <XIcon size={12} />
                    </button>
                </span>
            {/each}
        </div>
    {/if}
    {#if choices.length > 0}
        <SelectInput className="w-full" size="sm" bind:value={pick} onchange={() => {
            if (pick) DBState.db.moduleIntergration = addIntegration(DBState.db.moduleIntergration, pick)
            pick = ''
        }}>
            <OptionInput value="">{language.moduleIntegrationAdd}</OptionInput>
            {#each choices as choice (choice.namespace)}
                <OptionInput value={choice.namespace}>{choice.names[0]}{more(choice.names.length - 1)} ({choice.namespace})</OptionInput>
            {/each}
        </SelectInput>
    {/if}
</div>
