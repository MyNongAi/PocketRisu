import "./ts/polyfill";
import "core-js/actual"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { initScrollbarAutoHide } from "./ts/gui/scrollbarAutoHide";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";
import { toast } from "svelte-sonner";

let preloadFailureNotified = false;
window.addEventListener('vite:preloadError', (event) => {
    if (preloadFailureNotified) return;
    preloadFailureNotified = true;
    console.error("Chunk load error detected:", event);
    // Do not force a reload or repeatedly block typing while a chat is unsaved.
    // Keep the original load rejection visible to its caller.
    toast.error("Some screen files could not be loaded.", {
        id: 'screen-files-unavailable',
        description: "Check the connection. Save or copy any unsaved chat before refreshing the page.",
        duration: Infinity,
        closeButton: true,
    });
});

preLoadCheck()
let app = mount(App, {
    target: document.getElementById("app"),
});
loadData()
initHotkey()
initScrollbarAutoHide()
document.getElementById('preloading').remove()

export default app;
