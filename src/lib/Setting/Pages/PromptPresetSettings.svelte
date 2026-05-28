<script lang="ts">
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import PresetHeader from "src/lib/UI/GUI/PresetHeader.svelte";
    import { language } from "src/lang";
    import { DBState, openPresetList } from "src/ts/stores.svelte";
</script>

<SettingPage title={language.promptPresetMenu}>
    <PresetHeader
        label={language.promptPresetMenu}
        activeName={DBState.db.botPresets?.[DBState.db.botPresetsId]?.name ?? '—'}
        onManage={() => openPresetList.set(true)}
    />
    <p class="text-textcolor2">준비 중입니다.</p>
</SettingPage>
