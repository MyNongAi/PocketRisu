import { alertMd } from "./alert"

export interface UpdateInfo {
    currentVersion: string
    latestVersion: string
    hasUpdate: boolean
    severity: 'none' | 'optional' | 'required' | 'outdated'
    releaseUrl: string
    releaseName: string
    publishedAt: string
    disabled?: boolean
}

let cachedUpdateInfo: UpdateInfo | null = null

export async function checkRisuUpdate(): Promise<UpdateInfo | null> {
    try {
        const res = await fetch('/api/update-check')
        if (!res.ok) return null
        const data: UpdateInfo = await res.json()
        cachedUpdateInfo = data

        if (data.hasUpdate) {
            showUpdatePopupOnce(data)
        }

        return data
    } catch {
        return null
    }
}

export function getUpdateInfo(): UpdateInfo | null {
    return cachedUpdateInfo
}

const DISMISSED_KEY = 'risuNodeOnly_dismissedUpdateVersion'

function showUpdatePopupOnce(info: UpdateInfo) {
    const dismissed = localStorage.getItem(DISMISSED_KEY)
    if (dismissed === info.latestVersion) return

    localStorage.setItem(DISMISSED_KEY, info.latestVersion)

    const severityLabel = info.severity === 'required'
        ? '**⚠ Required Update**'
        : info.severity === 'outdated'
        ? '**⚠ Your version is too old**'
        : '**Update Available**'

    const msg = [
        `## ${severityLabel}`,
        '',
        `A new version **v${info.latestVersion}** is available (current: v${info.currentVersion}).`,
        '',
        info.releaseName ? `**${info.releaseName}**` : '',
        '',
        `[View release notes](${info.releaseUrl})`,
    ].filter(Boolean).join('\n')

    alertMd(msg)
}
