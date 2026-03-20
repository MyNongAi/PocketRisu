<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import Hub from "./Realm/RealmMain.svelte";
    import { OpenRealmStore, RealmInitialOpenChar } from "src/ts/stores.svelte";
    import { ArrowLeft } from "@lucide/svelte";
    import { getVersionString, openURL } from "src/ts/globalApi.svelte";
    import { language } from "src/lang";
    import { getRisuHub, hubAdditionalHTML } from "src/ts/characterCards";
    import RisuHubIcon from "./Realm/RealmHubIcon.svelte";
    import Title from "./Title.svelte";
    import { getUpdateInfo, type UpdateInfo } from "src/ts/update";

    let updateInfo: UpdateInfo | null = $state(null);

    $effect(() => {
        // Poll cached update info on mount and when re-entering the menu
        updateInfo = getUpdateInfo();
    });
</script>
<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if !$OpenRealmStore}
      <Title />
      <h3 class="text-textcolor2 mt-1">RisuAI NodeOnly v{getVersionString()}</h3>
      {#if updateInfo?.hasUpdate}
        <button
          class="text-xs mt-1 px-2 py-0.5 rounded transition-colors {updateInfo.severity === 'optional' ? 'text-textcolor2 hover:text-green-400' : 'text-draculared font-semibold hover:text-red-300'}"
          onclick={() => openURL(updateInfo.releaseUrl)}
        >
          {#if updateInfo.severity === 'outdated'}
            ⚠ v{updateInfo.latestVersion} — your version is too old
          {:else if updateInfo.severity === 'required'}
            ⚠ v{updateInfo.latestVersion} required update available
          {:else}
            ↳ v{updateInfo.latestVersion} update available
          {/if}
        </button>
      {/if}
    {/if}
    <div class="w-full flex p-4 flex-col text-textcolor max-w-4xl">
      {#if !$OpenRealmStore}
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <h1 class="text-2xl font-bold">Recently Uploaded<button class="text-base font-medium float-right p-1 bg-darkbg rounded-md hover:ring-3" onclick={() => {
        $OpenRealmStore = true
      }}>Get More</button></h1>
          {#if !DBState.db.hideRealm}
            {#await getRisuHub({
                  search: '',
                  page: 0,
                  nsfw: false,
                  sort: 'recommended'
              }) then charas}
            {#if charas.length > 0}
              {@html hubAdditionalHTML}
              <div class="w-full flex gap-4 p-2 flex-wrap justify-center">
                  {#each charas as chara}
                      <RisuHubIcon onClick={() => {
                        $OpenRealmStore = true
                        if(DBState.db.realmDirectOpen){
                            $RealmInitialOpenChar = chara
                        }
                      }} chara={chara} />
                  {/each}
              </div>
            {:else}
              <div class="text-textcolor2">Failed to load {language.hub}...</div>
            {/if}
          {/await}
        {:else}
          <div class="text-textcolor2">{language.hideRealm}</div>
        {/if}
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <h1 class="text-2xl font-bold mb-4">
        Related Links
      </h1>
        <div class="w-full flex gap-4 p-2 flex-wrap justify-center">
        <button class="bg-darkbg rounded-lg p-4 flex flex-col hover:bg-selected transition-colors relative lg:w-96 w-full items-start text-start" onclick={() => {
          openURL("https://discord.gg/Exy3NrqkGm")
        }}>
          <h2 class="text-xl">Discord</h2>
          <span class="text-textcolor2">
            Join our Discord server to chat with other users and the developer.
          </span>
        </button>
        <button class="bg-darkbg rounded-lg p-4 flex flex-col hover:bg-selected transition-colors relative lg:w-96 w-full items-start text-start" onclick={() => {
          openURL("https://risuai.net")
        }}>
          <h2 class="text-xl">
            Website
          </h2>
          <span class="text-textcolor2">
            See the official website for the project.
          </span>
        </button>
        <button class="bg-darkbg rounded-lg p-4 flex flex-col hover:bg-selected transition-colors relative lg:w-96 w-full items-start text-start" onclick={() => {
          openURL("https://github.com/kwaroran/RisuAI")
        }}>
          <h2 class="text-xl">Github</h2>
          <span class="text-textcolor2">
            View the source code and contribute to the project.
          </span>
        </button>
        <button class="bg-darkbg rounded-lg p-4 flex flex-col hover:bg-selected transition-colors relative lg:w-96 w-full items-start text-start" onclick={() => {
          openURL("mailto:support@risuai.net")
        }}>
          <h2 class="text-xl">Email</h2>
          <span class="text-textcolor2">
            Contact the developer directly.
          </span>
        </button>
      </div>

      {:else}
        <div class="flex items-center mt-4">
          <button class="mr-2 text-textcolor2 hover:text-green-500" onclick={() => ($OpenRealmStore = false)}>
            <ArrowLeft/>
          </button>
        </div>
        <Hub />
      {/if}
  </div>
</div>