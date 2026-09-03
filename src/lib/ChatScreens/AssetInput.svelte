<script lang="ts">
    import { FileMusicIcon, PlusIcon } from "@lucide/svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { appendAssetManifestItems, forageStorage, recoverAssetManifestConflict, saveAsset } from "src/ts/globalApi.svelte";
    import LazyAssetPreview from "src/lib/Others/LazyAssetPreview.svelte";
    import { selectMultipleFile } from "src/ts/util";
    interface Props {
        currentCharacter: character;
        onSelect: (additionalAsset:[string,string,string])=>void;
    }

    const { currentCharacter, onSelect }: Props = $props();
    let manifestItems:[string, string, string][] = $state([])
    let manifestOffset = $state(0)
    let manifestTotal = $state(0)
    let manifestCharacterId: string | null = $state(null)
    let manifestLoadSequence = 0
    const manifestPageSize = 100

    async function loadManifestPage(offset = 0) {
        const characterId = currentCharacter.chaId
        const manifest = currentCharacter.additionalAssetManifest
        if (!manifest) {
            manifestItems = []
            manifestOffset = 0
            manifestTotal = 0
            return
        }
        const manifestId = manifest.id
        const sequence = ++manifestLoadSequence
        const page = await forageStorage.getAssetManifestPage(manifest, {
            offset,
            limit: manifestPageSize,
        })
        if (
            sequence !== manifestLoadSequence
            || currentCharacter.chaId !== characterId
            || currentCharacter.additionalAssetManifest?.id !== manifestId
        ) return
        manifestItems = page.items as [string, string, string][]
        manifestOffset = page.offset
        manifestTotal = page.total
    }

    $effect(() => {
        const characterId = currentCharacter.chaId
        if (manifestCharacterId === characterId) return
        manifestCharacterId = characterId
        manifestLoadSequence++
        manifestItems = []
        manifestOffset = 0
        manifestTotal = 0
        if (currentCharacter.additionalAssetManifest) void loadManifestPage(0)
    })
</script>
{#if currentCharacter.type ==='character'}
    <button class="hover:text-primary bg-textcolor2 flex justify-center items-center w-16 h-16 m-1 rounded-md" onclick={async () => {
        if(currentCharacter.type === 'character'){
            const da = await selectMultipleFile(['png', 'webp', 'mp4', 'mp3', 'gif'])
            if(!da){
                return
            }
            const appended: [string, string, string][] = []
            for(const f of da){
                console.log(f)
                const img = f.data
                const name = f.name
                const extension = name.split('.').pop().toLowerCase()
                const imgp = await saveAsset(img,'',extension)
                if (currentCharacter.additionalAssetManifest) {
                    appended.push([name, imgp, extension])
                } else {
                    currentCharacter.additionalAssets ??= []
                    currentCharacter.additionalAssets.push([name, imgp, extension])
                }
            }
            if (currentCharacter.additionalAssetManifest && appended.length > 0) {
                try {
                    currentCharacter.additionalAssetManifest = await appendAssetManifestItems(
                        currentCharacter.additionalAssetManifest,
                        appended,
                    )
                    await loadManifestPage(Math.floor((currentCharacter.additionalAssetManifest.count - 1) / manifestPageSize) * manifestPageSize)
                } catch (error) {
                    if (!await recoverAssetManifestConflict(error, () => loadManifestPage(0))) throw error
                }
            }
        }
    }}>
        <PlusIcon />
    </button>
    {#if currentCharacter.additionalAssets || currentCharacter.additionalAssetManifest}
        {#each (currentCharacter.additionalAssetManifest ? manifestItems : currentCharacter.additionalAssets ?? []) as additionalAsset, i}
                {@const extension = (additionalAsset[2] ?? additionalAsset[1].split('.').pop() ?? '').toLowerCase()}
                <button onclick={()=>{
                    onSelect(additionalAsset)
                }}>
                        {#if ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(extension)}
                            <div class='w-16 h-16 m-1 rounded-md bg-slate-500 flex flex-col justify-center items-center'>
                                <FileMusicIcon/>
                                <div class='w-16 px-1 text-ellipsis whitespace-nowrap overflow-hidden'>{additionalAsset[0]}</div>
                            </div>
                        {:else}
                            <LazyAssetPreview
                                path={additionalAsset[1]}
                                {extension}
                                alt={additionalAsset[0]}
                                draggableOriginal={['png', 'webp', 'jpeg', 'jpg', 'gif', 'svg', 'avif', 'bmp'].includes(extension)}
                                dragFileName={additionalAsset[0]}
                                mediaClass="w-16 h-16 m-1 rounded-md object-cover"
                            />
                        {/if}
                </button>
        {/each}
        {#if currentCharacter.additionalAssetManifest && manifestTotal > manifestPageSize}
            <div class="flex items-center gap-2 w-full">
                <button disabled={manifestOffset === 0} onclick={() => loadManifestPage(Math.max(0, manifestOffset - manifestPageSize))}>←</button>
                <span>{manifestOffset + 1}–{Math.min(manifestOffset + manifestItems.length, manifestTotal)} / {manifestTotal}</span>
                <button disabled={manifestOffset + manifestPageSize >= manifestTotal} onclick={() => loadManifestPage(manifestOffset + manifestPageSize)}>→</button>
            </div>
        {/if}
    {/if}
{/if}
