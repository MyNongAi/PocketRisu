// Builds the distributable 🃏 카드 전투 module (.risum) from card-battle.lua.
// usage: node modules/card-battle/build.mjs
// The .risum container is the scene-fold module's (encodeRisum there).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeRisum, encodeRisum, readMaps } from '../scene-fold/build.mjs'

export const VERSION = '0.3.0'
export const MODULE_ID = '5dc65ab5-ed92-484d-b4c9-84940df8f952'

const here = dirname(fileURLToPath(import.meta.url))

export const TOGGLES = [
    '=🃏 카드 전투=group',
    'cardbattle.cards=레벨업 카드 만드는 모델=select=보조 모델,메인 모델,기본 카드만',
    '=보조 모델: 레벨이 오르는 순간 보조 모델이 이 봇에 맞는 카드 3장을 씁니다(저수준 접근 필요). 메인 모델: 다음 답 끝에 메인 모델이 이야기를 보고 카드 3장을 같이 씁니다(화면에는 안 보임). 기본 카드만: AI 없이 모듈에 든 카드에서 고릅니다=caption',
    'cardbattle.popup=전투 시작 확인창=select=띄우기,바로 전투 화면',
    'cardbattle.hp=전투 사이 체력=select=전투마다 회복,이어짐',
    'cardbattle.log=이야기로 보낼 전투 기록=select=턴마다 요약,결과만',
    '==groupEnd',
].join('\n')

export const DESCRIPTION = '어느 봇에나 붙이는 덱빌딩 카드 전투. 싸움이 시작되면 메인 모델이 표시를 남기고, 전투는 채팅 위 창에서 카드로 합니다. 끝나면 전투 기록이 이야기로 넘어가고, 레벨이 오르면 AI가 이 봇에 맞는 새 카드 3장을 씁니다. 보조 모델로 카드를 쓰려면 저수준 접근이 필요합니다.'

/**
 * A request-editing regex (type editprocess): Risu runs it on each message
 * when it builds the request, before long-term memory reads the chat, so the
 * hidden marks (the fight and the run, a few KB on a message) reach neither
 * the model nor a summary. The Lua takes them out of the request as well.
 */
export const REQUEST_REGEX = [
    {
        comment: '🃏 카드 전투 · 숨은 표시 빼기',
        in: String.raw`\n?<!--cb:[^>]*-->`,
        out: '',
        type: 'editprocess',
        flag: 'g',
        ableFlag: true,
    },
]

/** The module's main JSON (what a .risum carries before its assets). */
export function buildModuleJson(code) {
    return {
        module: {
            name: `🃏 카드 전투 v${VERSION}`,
            description: DESCRIPTION,
            id: MODULE_ID,
            namespace: 'card-battle',
            lowLevelAccess: true,
            lorebook: [],
            regex: REQUEST_REGEX,
            trigger: [{
                comment: '카드 전투',
                type: 'start',
                conditions: [],
                effect: [{ type: 'triggerlua', code }],
            }],
            customModuleToggle: TOGGLES,
            backgroundEmbedding: '',
            assets: [],
        },
        type: 'risuModule',
    }
}

export function readSource() {
    return readFileSync(join(here, 'card-battle.lua'), 'utf-8')
}

function main() {
    const json = buildModuleJson(readSource())
    const maps = readMaps()
    const out = join(here, 'dist', `card-battle-${VERSION}.risum`)
    mkdirSync(dirname(out), { recursive: true })
    const buffer = encodeRisum(json, maps.encode)
    // Read it back before calling it done.
    const back = decodeRisum(buffer, maps.decode)
    if (JSON.stringify(back) !== JSON.stringify(json)) throw new Error('round trip mismatch')
    writeFileSync(out, buffer)
    console.log(`wrote ${out} (${buffer.length} bytes)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
