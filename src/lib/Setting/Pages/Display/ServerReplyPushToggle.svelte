<script lang="ts">
    // Server reply push (SERVER-REPLY-PUSH). Per-device state: the switch
    // mirrors whether this browser holds a push subscription, not a DB flag.
    import { onMount } from 'svelte';
    import { language } from 'src/lang';
    import { notifyError } from 'src/ts/alert';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SoundRow from '../Sound/SoundRow.svelte';
    import {
        disableServerReplyPush,
        enableServerReplyPush,
        isServerReplyPushEnabled,
        serverReplyPushFailureMessage,
    } from 'src/ts/serverReplyPush';

    let enabled = $state(false);
    let busy = $state(false);

    onMount(() => {
        void isServerReplyPushEnabled().then((value) => {
            if (!busy) enabled = value;
        });
    });

    async function onToggle(check: boolean) {
        if (busy) return;
        busy = true;
        enabled = check;
        try {
            if (check) {
                // Called straight from the tap: the permission prompt needs it.
                const result = await enableServerReplyPush();
                if (!result.ok) {
                    enabled = false;
                    notifyError(serverReplyPushFailureMessage(result.reason));
                }
            } else {
                await disableServerReplyPush();
            }
        } finally {
            enabled = await isServerReplyPushEnabled();
            busy = false;
        }
    }
</script>

<SoundRow label={language.serverReplyPush} description={language.descServerReplyPush}>
    <ShSwitch checked={enabled} onCheckedChange={onToggle} disabled={busy} />
</SoundRow>
