import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { language } from 'src/lang'
import {
    base64UrlToBytes,
    disableServerReplyPush,
    enableServerReplyPush,
    isServerReplyPushEnabled,
    serverReplyPushFailureMessage,
    serverReplyPushUnavailableReason,
    syncServerReplyPush,
} from './serverReplyPush'

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))

const SERVER_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString('base64url')
const OTHER_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 200 - i))).toString('base64url')

// --- browser doubles ----------------------------------------------------------

function fakeSubscription(endpoint: string, key: string | null) {
    return {
        endpoint,
        options: { applicationServerKey: key ? base64UrlToBytes(key).buffer : null },
        toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } }),
        unsubscribe: vi.fn(async () => true),
    }
}

function installBrowser(opts: { permission?: NotificationPermission, grant?: NotificationPermission, existing?: ReturnType<typeof fakeSubscription> | null } = {}) {
    let current = opts.existing ?? null
    const pushManager = {
        getSubscription: vi.fn(async () => current),
        subscribe: vi.fn(async (options: { userVisibleOnly?: boolean, applicationServerKey: Uint8Array }) => {
            current = fakeSubscription('https://push.example.test/new', Buffer.from(options.applicationServerKey).toString('base64url'))
            return current
        }),
    }
    const registration = { pushManager }
    const serviceWorker = {
        register: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
        getRegistration: vi.fn(async () => registration),
    }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
    const notification = {
        permission: opts.permission ?? 'default',
        requestPermission: vi.fn(async () => {
            notification.permission = opts.grant ?? 'granted'
            return notification.permission
        }),
    }
    vi.stubGlobal('Notification', notification)
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('isSecureContext', true)
    return { pushManager, serviceWorker, notification, current: () => current }
}

function installServer(behavior: { keyStatus?: number, subscribeStatus?: number } = {}) {
    const calls: { url: string, init?: RequestInit }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        if (url === '/api/push/vapid-public-key') {
            return new Response(JSON.stringify({ publicKey: SERVER_KEY }), { status: behavior.keyStatus ?? 200 })
        }
        if (url === '/api/push/subscribe' || url === '/api/push/unsubscribe') {
            return new Response('{"success":true}', { status: behavior.subscribeStatus ?? 200 })
        }
        throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return { calls }
}

const posted = (calls: { url: string, init?: RequestInit }[], url: string) =>
    calls.filter((c) => c.url === url && c.init?.method === 'POST').map((c) => JSON.parse(c.init!.body as string))

afterEach(() => {
    vi.unstubAllGlobals()
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('serverReplyPushUnavailableReason', () => {
    const originalUa = navigator.userAgent
    beforeEach(() => {
        delete (navigator as { serviceWorker?: unknown }).serviceWorker
    })
    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUa })
    })

    test('plain http asks for HTTPS first', () => {
        installBrowser()
        vi.stubGlobal('isSecureContext', false)
        expect(serverReplyPushUnavailableReason()).toBe('insecure')
    })

    test('supported when service worker, PushManager and Notification exist', () => {
        installBrowser()
        expect(serverReplyPushUnavailableReason()).toBeNull()
    })

    test('iPhone Safari outside the home-screen app points at "add to home screen"', () => {
        vi.stubGlobal('isSecureContext', true)
        vi.stubGlobal('PushManager', undefined)
        Object.defineProperty(navigator, 'userAgent', {
            configurable: true,
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        })
        expect(serverReplyPushUnavailableReason()).toBe('ios-home-screen')
    })

    test('other browsers without the APIs are unsupported', () => {
        vi.stubGlobal('isSecureContext', true)
        vi.stubGlobal('PushManager', undefined)
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' })
        expect(serverReplyPushUnavailableReason()).toBe('unsupported')
    })

    test('every failure maps to a localized message', () => {
        expect(serverReplyPushFailureMessage('insecure')).toBe(language.serverReplyPushInsecure)
        expect(serverReplyPushFailureMessage('ios-home-screen')).toBe(language.serverReplyPushIosHomeScreen)
        expect(serverReplyPushFailureMessage('denied')).toBe(language.permissionDenied)
        expect(serverReplyPushFailureMessage('server')).toBe(language.serverReplyPushServerError)
        expect(serverReplyPushFailureMessage('subscribe')).toBe(language.serverReplyPushSubscribeError)
        expect(serverReplyPushFailureMessage('unsupported')).toBe(language.serverReplyPushUnsupported)
    })
})

describe('enableServerReplyPush', () => {
    test('asks permission, subscribes with the server key and registers it with localized text', async () => {
        const browser = installBrowser()
        const { calls } = installServer()
        await expect(enableServerReplyPush()).resolves.toEqual({ ok: true })

        expect(browser.notification.requestPermission).toHaveBeenCalledTimes(1)
        expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1)
        const options = browser.pushManager.subscribe.mock.calls[0][0]
        expect(options.userVisibleOnly).toBe(true)
        expect(Buffer.from(options.applicationServerKey).toString('base64url')).toBe(SERVER_KEY)

        const [body] = posted(calls, '/api/push/subscribe')
        expect(body).toEqual({
            subscription: { endpoint: 'https://push.example.test/new', keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } },
            text: { done: language.serverReplyPushDone, failed: language.serverReplyPushFailed },
        })
        const keyCall = calls.find((c) => c.url === '/api/push/vapid-public-key')!
        expect((keyCall.init?.headers as Record<string, string>)['risu-auth']).toBe('test-auth')
        await expect(isServerReplyPushEnabled()).resolves.toBe(true)
    })

    test('a denied permission stops before any request', async () => {
        installBrowser({ grant: 'denied' })
        const { calls } = installServer()
        await expect(enableServerReplyPush()).resolves.toEqual({ ok: false, reason: 'denied' })
        expect(calls).toHaveLength(0)
    })

    test('an unsupported browser never prompts', async () => {
        const browser = installBrowser()
        vi.stubGlobal('isSecureContext', false)
        await expect(enableServerReplyPush()).resolves.toEqual({ ok: false, reason: 'insecure' })
        expect(browser.notification.requestPermission).not.toHaveBeenCalled()
    })

    test('a server that refuses the subscription leaves no browser subscription behind', async () => {
        const browser = installBrowser()
        installServer({ subscribeStatus: 500 })
        await expect(enableServerReplyPush()).resolves.toEqual({ ok: false, reason: 'server' })
        expect(browser.current()!.unsubscribe).toHaveBeenCalledTimes(1)
    })

    test('no VAPID key from the server reports a server failure', async () => {
        const browser = installBrowser()
        installServer({ keyStatus: 503 })
        await expect(enableServerReplyPush()).resolves.toEqual({ ok: false, reason: 'server' })
        expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
    })

    test('a subscription made with another server key is replaced', async () => {
        const stale = fakeSubscription('https://push.example.test/old', OTHER_KEY)
        const browser = installBrowser({ existing: stale })
        installServer()
        await expect(enableServerReplyPush()).resolves.toEqual({ ok: true })
        expect(stale.unsubscribe).toHaveBeenCalledTimes(1)
        expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1)
    })
})

describe('disable and boot sync', () => {
    test('disable removes the server record, then the browser subscription', async () => {
        const existing = fakeSubscription('https://push.example.test/mine', SERVER_KEY)
        installBrowser({ permission: 'granted', existing })
        const { calls } = installServer()
        await disableServerReplyPush()
        expect(posted(calls, '/api/push/unsubscribe')).toEqual([{ endpoint: 'https://push.example.test/mine' }])
        expect(existing.unsubscribe).toHaveBeenCalledTimes(1)
    })

    test('sync without a subscription sends nothing', async () => {
        installBrowser({ permission: 'granted' })
        const { calls } = installServer()
        await syncServerReplyPush()
        expect(calls).toHaveLength(0)
    })

    test('sync never prompts when permission is not granted', async () => {
        const browser = installBrowser({ permission: 'default', existing: fakeSubscription('https://push.example.test/mine', SERVER_KEY) })
        const { calls } = installServer()
        await syncServerReplyPush()
        expect(browser.notification.requestPermission).not.toHaveBeenCalled()
        expect(calls).toHaveLength(0)
    })

    test('sync re-sends the existing subscription unchanged', async () => {
        const existing = fakeSubscription('https://push.example.test/mine', SERVER_KEY)
        const browser = installBrowser({ permission: 'granted', existing })
        const { calls } = installServer()
        await syncServerReplyPush()
        expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
        expect(posted(calls, '/api/push/subscribe').map((b) => b.subscription.endpoint)).toEqual(['https://push.example.test/mine'])
    })
})
