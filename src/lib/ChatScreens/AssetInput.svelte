<script lang="ts">
    import { FileMusicIcon, PlusIcon } from "@lucide/svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { saveAsset } from "src/ts/globalApi.svelte";
    import LazyAssetPreview from "src/lib/Others/LazyAssetPreview.svelte";
    import { selectMultipleFile } from "src/ts/util";
    interface Props {
        currentCharacter: character;
        onSelect: (additionalAsset:[string,string,string])=>void;
    }

    const { currentCharacter, onSelect }: Props = $props();
</script>
{#if currentCharacter.type ==='character'}
    <button class="hover:text-primary bg-textcolor2 flex justify-center items-center w-16 h-16 m-1 rounded-md" onclick={async () => {
        if(currentCharacter.type === 'character'){
            const da = await selectMultipleFile(['png', 'webp', 'mp4', 'mp3', 'gif'])
            currentCharacter.additionalAssets = currentCharacter.additionalAssets ?? []
            if(!da){
                return
            }
            for(const f of da){
                console.log(f)
                const img = f.data
                const name = f.name
                const extension = name.split('.').pop().toLowerCase()
                const imgp = await saveAsset(img,'',extension)
                currentCharacter.additionalAssets.push([name, imgp, extension])
            }
        }
    }}>
        <PlusIcon />
    </button>
    {#if currentCharacter.additionalAssets}
        {#each currentCharacter.additionalAssets as additionalAsset, i}
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
                                mediaClass="w-16 h-16 m-1 rounded-md object-cover"
                            />
                        {/if}
                </button>
        {/each}
    {/if}
{/if}
