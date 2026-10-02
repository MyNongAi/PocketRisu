/// <reference types="svelte" />
/// <reference types="vite/client" />


declare const __APP_VERSION__: string
/** This build's id (vite.config.ts); empty outside production builds. */
declare const __POCKETRISU_BUILD_ID__: string
declare var Buffer: BufferConstructor
declare var safeStructuredClone: <T>(data: T) => T
declare var userScriptFetch: (url: string,arg:RequestInit) => Promise<Response>