<script lang="ts">
    // A bot's, module's or module folder's info dialog (src/ts/gui/itemInfo.ts):
    // the title color as swatches like a bot folder's settings dialog, the
    // missing-asset mark with a switch to turn it off, and the red chain of a
    // pairing whose other side is gone, with a button to clear it. Every edit
    // finds the item again by id, so a stale render never edits another one.
    import { DBState } from "src/ts/stores.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShInput from "src/lib/UI/GUI/ShInput.svelte";
    import { itemInfoTarget, setMissingMarkHidden, withoutMissingModules } from "src/ts/gui/itemInfo";
    import { isRealmAssetRecoveryAvailable, normalizeTitleColor, shownMissingAssetCount, TITLE_COLOR_OPTIONS } from "src/ts/gui/titleColors";
    import { characterModuleLink, moduleLinks } from "src/ts/gui/pairedModules";

    const target = $derived($itemInfoTarget);
    const character = $derived(target?.kind === 'character'
        ? DBState.db.characters.find((item) => item?.chaId === target.id)
        : undefined);
    const module = $derived(target?.kind === 'module'
        ? (DBState.db.modules ?? []).find((item) => item?.id === target.id)
        : undefined);
    const folder = $derived(target?.kind === 'moduleFolder'
        ? (DBState.db.moduleFolders ?? []).find((item) => item?.id === target.id)
        : undefined);
    const name = $derived(character?.name ?? module?.name ?? folder?.name ?? '');
    const color = $derived(normalizeTitleColor(character?.titleColor ?? module?.titleColor ?? folder?.titleColor) ?? '');
    const kindLabel = $derived(target?.kind === 'character' ? '봇' : target?.kind === 'module' ? '모듈' : '모듈 폴더');

    const info = $derived(character?.sourceInfo ?? module?.sourceInfo);
    const missing = $derived(Math.max(0, Number(info?.missingAssetCount) || 0));
    const referenced = $derived(Math.max(0, Number(info?.assetReferenceCount) || 0));
    const markHidden = $derived(missing > 0 && shownMissingAssetCount(info) === 0);
    const recoverable = $derived(isRealmAssetRecoveryAvailable(character ?? module));

    const existingModuleIds = $derived(new Set((DBState.db.modules ?? []).map((item) => item?.id).filter(Boolean)));
    const botChain = $derived(character ? characterModuleLink(character, existingModuleIds) : null);
    const goneModules = $derived(character ? (character.modules ?? []).length - withoutMissingModules(character.modules, existingModuleIds).length : 0);
    const moduleChain = $derived(module
        ? moduleLinks([module], DBState.db.characters, DBState.db.nodeOnlyArchivedCharacters ?? []).get(module.id)
        : undefined);

    let custom = $state('');
    $effect(() => { custom = color; });

    function close() {
        itemInfoTarget.set(null);
    }

    function setColor(value: string) {
        if (!target) return;
        const next = normalizeTitleColor(value);
        if (target.kind === 'character') {
            const current = DBState.db.characters.find((item) => item?.chaId === target.id);
            if (!current) return;
            if (next) current.titleColor = next;
            else delete current.titleColor;
        } else if (target.kind === 'module') {
            const current = (DBState.db.modules ?? []).find((item) => item?.id === target.id);
            if (current) current.titleColor = next;
        } else {
            DBState.db.moduleFolders = (DBState.db.moduleFolders ?? []).map((item) => item.id === target.id ? { ...item, titleColor: next } : item);
        }
    }

    function applyCustom() {
        if (normalizeTitleColor(custom)) setColor(custom);
    }

    function setMarkHidden(hidden: boolean) {
        if (!target) return;
        const owner = target.kind === 'character'
            ? DBState.db.characters.find((item) => item?.chaId === target.id)
            : (DBState.db.modules ?? []).find((item) => item?.id === target.id);
        setMissingMarkHidden(owner, hidden);
    }

    function clearBrokenChain() {
        if (!target) return;
        if (target.kind === 'character') {
            const current = DBState.db.characters.find((item) => item?.chaId === target.id);
            if (current) current.modules = withoutMissingModules(current.modules, existingModuleIds);
        } else if (target.kind === 'module') {
            const current = (DBState.db.modules ?? []).find((item) => item?.id === target.id);
            if (current) delete current.nodeOnlyPairedCharacterIds;
        }
    }
</script>

{#if target && (character || module || folder)}
    <ShDialog open={true} onOpenChange={(open) => { if (!open) close() }} size="default">
        {#snippet title()}<span style:color={color || undefined}>{name || 'Unnamed'}</span>{/snippet}
        <div class="flex flex-col gap-5" data-item-info={target.kind}>
            <p class="-mt-2 text-xs text-textcolor2">{kindLabel} 정보</p>

            <section class="flex flex-col gap-2">
                <span class="text-sm text-textcolor2">제목 색</span>
                <div class="flex flex-wrap gap-2">
                    {#each TITLE_COLOR_OPTIONS as option (option.value)}
                        <button
                            type="button"
                            class="flex h-8 min-w-8 items-center justify-center rounded-md border-2 px-1 text-[10px] transition-colors {color === option.value ? 'border-primary' : 'border-darkborderc hover:border-textcolor2'} {option.value ? '' : 'bg-darkbg text-textcolor2'}"
                            style:background-color={option.value || undefined}
                            title={option.label}
                            aria-label={option.label}
                            aria-pressed={color === option.value}
                            data-title-color={option.value}
                            onclick={() => setColor(option.value)}
                        >{option.value ? '' : '기본'}</button>
                    {/each}
                </div>
                <div class="flex items-center gap-2">
                    <ShInput
                        className="w-32 font-mono"
                        value={custom}
                        placeholder="#RRGGBB"
                        oninput={(e) => { custom = e.currentTarget.value }}
                        onkeydown={(e) => { if (e.key === 'Enter') applyCustom() }}
                    />
                    <ShButton size="sm" variant="outline" disabled={!normalizeTitleColor(custom)} onclick={applyCustom}>직접 입력</ShButton>
                </div>
            </section>

            {#if character || module}
                <section class="flex flex-col gap-2" data-item-info-assets>
                    <span class="text-sm text-textcolor2">에셋</span>
                    {#if missing > 0}
                        <p class="text-sm">
                            {#if recoverable}<span class="font-black text-emerald-400">!</span>{:else}<span>❗</span>{/if}
                            깨진 에셋 {missing.toLocaleString()}개{#if referenced > 0} · 전체 {referenced.toLocaleString()}개 중{/if}
                        </p>
                        <p class="text-xs text-textcolor2">
                            {recoverable ? 'Realm에서 원본을 찾아 복구할 수 있습니다.' : '복구할 원본이 확인되지 않았습니다.'}
                        </p>
                        <label class="flex items-center justify-between gap-3">
                            <span class="text-sm text-textcolor">누락 표시 끄기</span>
                            <ShSwitch checked={markHidden} onCheckedChange={setMarkHidden} />
                        </label>
                        <p class="text-xs text-textcolor2">❗·빨간 제목·개수 표시만 숨깁니다. 데이터는 그대로이고, 누락이 더 늘면 다시 보입니다.</p>
                    {:else}
                        <p class="text-sm text-textcolor2">깨진 에셋 없음</p>
                    {/if}
                </section>
            {/if}

            {#if character && botChain}
                <section class="flex flex-col gap-2" data-item-info-chain={botChain}>
                    <span class="text-sm text-textcolor2">전용 모듈 연결</span>
                    {#if botChain === 'linked'}
                        <p class="text-sm"><span class="text-emerald-400">연결됨</span> · 전용 모듈 {(character.modules ?? []).length}개</p>
                    {:else}
                        <p class="text-sm"><span class="text-red-400">끊김</span> · 지워진 전용 모듈 {goneModules}개</p>
                        <ShButton size="sm" variant="outline" className="self-start" onclick={clearBrokenChain}>끊긴 연결 지우기</ShButton>
                        <p class="text-xs text-textcolor2">이미 지워진 모듈만 이 봇의 목록에서 뺍니다.</p>
                    {/if}
                </section>
            {/if}

            {#if module && moduleChain}
                <section class="flex flex-col gap-2" data-item-info-chain={moduleChain.state}>
                    <span class="text-sm text-textcolor2">봇 연결</span>
                    {#if moduleChain.state === 'linked'}
                        <p class="text-sm break-words"><span class="text-emerald-400">연결됨</span> · {moduleChain.names.join(', ')}</p>
                    {:else}
                        <p class="text-sm break-words"><span class="text-red-400">끊김</span> · 짝이던 봇이 지워졌습니다 ({moduleChain.names.join(', ')})</p>
                        <ShButton size="sm" variant="outline" className="self-start" onclick={clearBrokenChain}>끊긴 연결 지우기</ShButton>
                        <p class="text-xs text-textcolor2">이 모듈이 기억하는 지워진 짝 봇만 잊습니다.</p>
                    {/if}
                </section>
            {/if}
        </div>
    </ShDialog>
{/if}
