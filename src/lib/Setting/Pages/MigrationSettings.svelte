<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
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
    import { selectAndImportSourceCollections } from "src/ts/sourceCollectionImport";

    function gotoBackupTab() {
        openSettings(SettingsRoute.System, SystemTab.Backups);
    }
</script>

<SettingPage title={language.migration}>
    <p class="text-textcolor2 text-sm leading-relaxed mb-4">{language.migrationDesc}</p>

    <ShAlert variant="info" className="mb-4">
        {#snippet icon()}<InfoIcon />{/snippet}
        {#snippet title()}{language.migrationInfoBackupMoved}{/snippet}
        {#snippet action()}
            <ShButton variant="outline" size="sm" onclick={gotoBackupTab}>
                {language.migrationGotoBackupTab}
            </ShButton>
        {/snippet}
    </ShAlert>

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

    <div class="mt-6 rounded-md border border-darkborderc p-4">
        <h3 class="font-semibold text-textcolor">출처별 컬렉션 병합</h3>
        <p class="mt-2 text-sm leading-relaxed text-textcolor2">
            로컬리스·PC 웹리스·모바일 웹리스의 내보내기 플러그인이 만든 봇·모듈·페르소나 part 파일을
            기존 데이터에 덮어쓰지 않고 합칩니다. 같은 이름도 보존하며 출처 폴더와 배지로 구분합니다.
        </p>
        <p class="mt-2 text-xs leading-relaxed text-textcolor2">
            한 번에 여러 출처와 종류를 골라도 되지만, 각 묶음의 part는 마지막 번호까지 빠짐없이 선택해야 합니다.
            32MB를 넘는 part와 16MB를 넘는 단일 에셋은 모바일 메모리 보호를 위해 거부됩니다.
        </p>
        <Button onclick={selectAndImportSourceCollections} className="mt-3 w-full">
            컬렉션 part 파일 선택·병합
        </Button>
        <a
            href="/plugins/pocketrisu-source-collection-exporter.js"
            download="pocketrisu-source-collection-exporter.js"
            class="mt-2 flex w-full items-center justify-center rounded-md border border-darkborderc px-4 py-2 text-sm font-semibold text-textcolor hover:border-primary hover:text-primary"
        >
            로컬·웹리스용 내보내기 플러그인 받기
        </a>
    </div>

    <!-- Save folder import (collapsed by default) ────────────────────── -->
    <div class="mt-6">
        <ShAccordion name={language.migrationSaveFolderAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.migrationSaveFolderDesc}</p>

            <p class="text-textcolor2 text-sm leading-relaxed mb-2">{language.importSaveZipDesc}</p>
            <div class="flex flex-col gap-2">
                <Button onclick={ImportFromSaveZip} className="w-full">
                    {language.importSaveZip}
                </Button>
            </div>

            <p class="text-textcolor2 text-sm leading-relaxed mt-4 mb-2">{language.cleanupMigratedDesc}</p>
            <div class="flex flex-col gap-2">
                <Button onclick={CleanupMigratedFiles} className="w-full">
                    {language.cleanupMigratedFiles}
                </Button>
            </div>
        </ShAccordion>
    </div>

    <!-- Legacy backup options (collapsed by default) ──────────────────── -->
    <div class="mt-3">
        <ShAccordion name={language.migrationLegacyAccordion} variant="card">
            <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.migrationLegacyDesc}</p>
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
