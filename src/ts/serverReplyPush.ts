import { language } from 'src/lang'
import { authHeader } from './process/request/jobFetch'

// Server reply push (SERVER-REPLY-PUSH), browser half. The server
// (server/node/push-notifications.cjs) sends a Web Push when a server-side
// model job finishes while no page is watching it; public/sw.js shows it.
//
// A push subscription belongs to this browser, not to the synced database,
// so there is no DB flag: the settings toggle shows whether this browser holds
// a subscription right now, and each device turns it on separately.

export type ServerReplyPushUnavailable = 'unsupported' | 'insecure' | 'ios-home-screen'
export type ServerReplyPushFailure = ServerReplyPushUnavailable | 'denied' | 'server' | 'subscribe'
export type ServerReplyPushResult = { ok: true, reason?: undefined } | { ok: false, reason: ServerReplyPushFailure }

// navigator.serviceWorker.ready never settles when registration failed.
const SERVICE_WORKER_READY_TIMEOUT_MS = 15_000

function isIosDevice(): boolean {
    const ua = navigator.userAgent || ''
    // iPadOS reports a desktop Mac user agent; touch points tell it apart.
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

function isStandaloneDisplay(): boolean {
    try {
        if (globalThis.matchMedia?.('(display-mode: standalone)').matches) return true
    } catch { /* matchMedia unavailable */ }
    return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** Why Web Push cannot work in this browser, or null when it can. */
export function serverReplyPushUnavailableReason(): ServerReplyPushUnavailable | null {
    if (typeof navigator === 'undefined') return 'unsupported'
    // Service workers and PushManager exist only in secure contexts, so plain
    // http:// over the LAN must say "use HTTPS", not "unsupported".
    if (globalThis.isSecureContext === false) return 'insecure'
    if ('serviceWorker' in navigator && typeof globalThis.PushManager !== 'undefined' && typeof globalThis.Notification !== 'undefined') {
        return null
    }
    // iOS exposes Web Push only to web apps added to the home screen.
    if (isIosDevice() && !isStandaloneDisplay()) return 'ios-home-screen'
    return 'unsupported'
}

export function serverReplyPushFailureMessage(reason: ServerReplyPushFailure): string {
    switch (reason) {
        case 'insecure': return language.serverReplyPushInsecure
        case 'ios-home-screen': return language.serverReplyPushIosHomeScreen
        case 'denied': return language.permissionDenied
        case 'server': return language.serverReplyPushServerError
        case 'subscribe': return language.serverReplyPushSubscribeError
        default: return language.serverReplyPushUnsupported
    }
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const bytes = new Uint8Array(new ArrayBuffer(raw.length))
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
}

function hasServerKey(subscription: PushSubscription, publicKey: string): boolean {
    const current = subscription.options?.applicationServerKey
    // A browser that does not expose the key cannot be checked; keep its
    // subscription rather than replacing it on every boot.
    if (!current) return true
    const a = new Uint8Array(current)
    const b = base64UrlToBytes(publicKey)
    return a.length === b.length && a.every((value, index) => value === b[index])
}

async function currentSubscription(): Promise<PushSubscription | null> {
    const registration = await navigator.serviceWorker.getRegistration()
    return (await registration?.pushManager.getSubscription()) ?? null
}

/** Toggle state: this browser holds a subscription and may show notifications. */
export async function isServerReplyPushEnabled(): Promise<boolean> {
    if (serverReplyPushUnavailableReason() || Notification.permission !== 'granted') return false
    try {
        return (await currentSubscription()) !== null
    } catch {
        return false
    }
}

async function fetchVapidPublicKey(): Promise<string | null> {
    try {
        const res = await fetch('/api/push/vapid-public-key', { headers: await authHeader() })
        if (!res.ok) return null
        const { publicKey } = await res.json()
        return typeof publicKey === 'string' && publicKey ? publicKey : null
    } catch {
        return null
    }
}

// The notification text comes from here (src/lang) so it follows the UI
// language; the server only adds the character/chat names.
async function registerOnServer(subscription: PushSubscription): Promise<boolean> {
    try {
        const res = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...await authHeader() },
            body: JSON.stringify({
                subscription: subscription.toJSON(),
                text: { done: language.serverReplyPushDone, failed: language.serverReplyPushFailed },
            }),
        })
        return res.ok
    } catch {
        return false
    }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
    // bootstrap registers /sw.js on every boot; registering again is a no-op
    // that also covers a boot where that registration failed.
    await navigator.serviceWorker.register('/sw.js')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('service worker not ready')), SERVICE_WORKER_READY_TIMEOUT_MS)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

async function subscribeWithKey(registration: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
    const existing = await registration.pushManager.getSubscription()
    if (existing && hasServerKey(existing, publicKey)) return existing
    // A subscription made with another server key cannot receive this
    // server's pushes (the push service checks the VAPID key): replace it.
    if (existing) await existing.unsubscribe().catch(() => false)
    return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
    })
}

/** Turn the toggle on: permission → subscription → server record. */
export async function enableServerReplyPush(): Promise<ServerReplyPushResult> {
    const unavailable = serverReplyPushUnavailableReason()
    if (unavailable) return { ok: false, reason: unavailable }
    // Ask before anything else is awaited: Safari only shows the prompt while
    // the toggle's tap still counts as the user gesture.
    let permission: NotificationPermission
    try {
        permission = await Notification.requestPermission()
    } catch {
        permission = Notification.permission
    }
    if (permission !== 'granted') return { ok: false, reason: 'denied' }

    const publicKey = await fetchVapidPublicKey()
    if (!publicKey) return { ok: false, reason: 'server' }
    let subscription: PushSubscription
    try {
        subscription = await subscribeWithKey(await readyRegistration(), publicKey)
    } catch (err) {
        console.warn('[ServerReplyPush] subscribe failed', err)
        return { ok: false, reason: 'subscribe' }
    }
    if (!await registerOnServer(subscription)) {
        // Keep the toggle truthful: no browser subscription the server lacks.
        await subscription.unsubscribe().catch(() => false)
        return { ok: false, reason: 'server' }
    }
    return { ok: true }
}

/** Turn the toggle off: drop the server record, then the browser subscription. */
export async function disableServerReplyPush(): Promise<void> {
    if (serverReplyPushUnavailableReason()) return
    try {
        const subscription = await currentSubscription()
        if (!subscription) return
        try {
            await fetch('/api/push/unsubscribe', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...await authHeader() },
                body: JSON.stringify({ endpoint: subscription.endpoint }),
            })
        } catch {
            // The server also forgets an endpoint once its push service
            // answers 404/410, which follows from the unsubscribe below.
        }
        await subscription.unsubscribe()
    } catch (err) {
        console.warn('[ServerReplyPush] unsubscribe failed', err)
    }
}

/** Boot refresh: re-send this browser's subscription, if any, so the server's
 *  copy follows endpoint rotation, a lost server file, a new server key and
 *  the current UI language. Never prompts. */
export async function syncServerReplyPush(): Promise<void> {
    if (serverReplyPushUnavailableReason() || Notification.permission !== 'granted') return
    try {
        const registration = await navigator.serviceWorker.getRegistration()
        if (!registration || !await registration.pushManager.getSubscription()) return
        const publicKey = await fetchVapidPublicKey()
        if (!publicKey) return
        await registerOnServer(await subscribeWithKey(registration, publicKey))
    } catch (err) {
        console.warn('[ServerReplyPush] sync failed', err)
    }
}
