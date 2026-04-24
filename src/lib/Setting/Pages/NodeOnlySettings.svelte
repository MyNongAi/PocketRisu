<script lang="ts">
    import { nodeOnlySettingsItems } from "src/ts/setting/nodeOnlySettingsData";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import { language } from "src/lang";
    import DevPanel from "src/lib/_dev/DevPanel.svelte";

    // Dev panel is opt-in via localStorage['risu-dev-panel']='1' in devtools.
    // Read once on mount — flag changes require reload.
    const devPanelEnabled = typeof localStorage !== 'undefined'
        && localStorage.getItem('risu-dev-panel') === '1';
</script>

<SettingPage title={language.nodeOnlySettings}>
<SettingRenderer items={nodeOnlySettingsItems} />
{#if devPanelEnabled}
    <DevPanel />
{/if}
</SettingPage>
