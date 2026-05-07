<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { alertConfirm } from "src/ts/alert";
    import {
        LoadLocalBackup,
        SaveLocalBackupForUpstream,
        SavePartialLocalBackup,
        ImportFromSaveZip,
        CleanupMigratedFiles,
    } from "src/ts/drive/backuplocal";
    import { exportAsDataset } from "src/ts/storage/exportAsDataset";
    import { openSettings, SettingsRoute, SystemTab } from "src/ts/routing";
    import { InfoIcon } from "@lucide/svelte";

    function gotoBackupTab() {
        openSettings(SettingsRoute.System, SystemTab.Backups);
    }
</script>

<SettingPage title={language.migration}>
    <p class="text-textcolor2 text-sm leading-relaxed mb-4">{language.migrationDesc}</p>

    <div class="bg-blue-900/30 border border-blue-700/40 rounded-md px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap text-blue-300">
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <InfoIcon class="size-4 shrink-0 text-blue-400" />
            <span class="leading-relaxed text-sm">{language.migrationInfoBackupMoved}</span>
        </div>
        <ShButton variant="outline" size="sm" onclick={gotoBackupTab}>
            {language.migrationGotoBackupTab}
        </ShButton>
    </div>

    <!-- Migration: upstream RisuAI ↔ NodeOnly ─────────────────────────── -->
    <Button
        onclick={async () => {
            if (await alertConfirm(language.saveBackupForUpstreamConfirm)) {
                SaveLocalBackupForUpstream();
            }
        }} className="mt-2">
        {language.saveBackupForUpstream}
    </Button>

    <Button
        onclick={async () => {
            if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
                LoadLocalBackup();
            }
        }} className="mt-2">
        {language.migrationLoadUpstreamBackup}
    </Button>

    <h3 class="mb-1 text-lg font-bold mt-6">{language.importSaveFolderHeader}</h3>

    <p class="text-sm text-textcolor2 mb-2">{language.importSaveZipDesc}</p>
    <Button onclick={ImportFromSaveZip} className="mt-1">
        {language.importSaveZip}
    </Button>

    <p class="text-sm text-textcolor2 mt-3 mb-2">{language.cleanupMigratedDesc}</p>
    <Button onclick={CleanupMigratedFiles} className="mt-1">
        {language.cleanupMigratedFiles}
    </Button>

    <!-- Legacy backup options — collapsed by default ─────────────────── -->
    <div class="mt-6">
        <ShAccordion name={language.migrationLegacyAccordion} variant="card">
            <div class="flex flex-col gap-2">
                <Button
                    onclick={async () => {
                        if (await alertConfirm(language.backupConfirm)) {
                            SavePartialLocalBackup();
                        }
                    }} className="w-full">
                    {language.savePartialLocalBackup}
                </Button>

                <Button onclick={exportAsDataset} className="w-full">
                    {language.exportAsDataset}
                </Button>
            </div>
        </ShAccordion>
    </div>
</SettingPage>
