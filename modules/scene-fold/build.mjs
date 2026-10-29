// Builds the distributable 📁 장면 접기 module (.risum) from scene-fold.lua.
// usage: node modules/scene-fold/build.mjs
// A .risum is: byte 111, byte 0, the main JSON's length (uint32 LE), the
// main JSON rpack-encoded, then assets (none here) and a closing 0 byte
// (src/ts/process/modules.ts exportModule / readModule).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.3.0'
export const MODULE_ID = '5c3e1f0a-7d2b-4e9c-9a41-2f6b8d0e5a17'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

export const TOGGLES = [
    '=📁 장면 접기=group',
    '=접을 장면은 종류마다 따로 켜고 끕니다=caption',
    'scenefold.battle=⚔️ 배틀 (전투·던전·게이트·탐험·대련·미니게임·도박)=select=켬,끔',
    'scenefold.nsfw=🔞 NSFW=select=끔,켬',
    'scenefold.custom=✏️ 사용자 정의=select=끔,켬',
    'scenefold.customName=└ 사용자 정의 이름=text',
    'scenefold.customRule=└ 언제 시작하고 끝나는지, 접은 뒤 무엇을 남길지=textarea',
    'scenefold.loop=🔁 회차 (죽으면 시간이 되돌아가는 회귀물)=select=끔,켬',
    'scenefold.loopHero=└ 회귀하는 인물 (예: 스바루)=text',
    '=켜면 주인공이 죽을 때마다 그 회차(지난 사망 다음부터 이번 사망까지)를 접고, 무슨 일이 있었고 무엇을 알아냈고 어떻게 죽었는지를 "그 인물만 기억함"으로 남깁니다. 회차 안의 배틀은 따로 접힙니다=caption',
    '=설정=divider',
    'scenefold.mode=장면 찾기=select=보조 모델이 판단,메인 모델이 표시',
    'scenefold.grace=끝난 뒤 접기까지=select=답 2개,바로,답 1개,답 3개,답 4개,답 6개',
    'scenefold.summary=요약 쓰는 모델=select=보조 모델,메인 모델',
    'scenefold.buttons=메시지 아래 장면 버튼=select=보이기,숨기기',
    'scenefold.cut=접은 장면 처리=select=요청에서 빼기 (장기 기억 전),원문 잘라내기 (비권장·렉 감소),요청에서만 접기 (장기 기억은 원문)',
    '=요청에서 빼기: 접은 장면을 장기 기억(하이파)이 읽기 전에 빼서, 하이파도 모델도 요약만 봅니다. 원문 잘라내기: 채팅에서 지우고 요약 메시지 하나로 바꿔 글이 줄고 렉이 줄지만, 되돌리기 전까지 원문이 채팅에 없습니다. 요청에서만 접기: 예전 방식이며 하이파는 원문을 요약합니다=caption',
    '==groupEnd',
].join('\n')

export const DESCRIPTION = '끝난 배틀·NSFW·사용자 정의 장면과 회귀물의 지난 회차를 모델에게 보내는 요청에서 접고 짧은 요약으로 바꿉니다. 장기 기억(하이파)도 요약만 봅니다. 채팅 원문은 그대로 둡니다. 보조 모델 판단과 요약에 저수준 접근이 필요합니다.'

// The request regex works only while 접은 장면 처리 is not 요청에서만 접기 (2):
// in that choice its lookahead can never match.
const ACTIVE = '(?={{#when::{{getglobalvar::toggle_scenefold.cut}}::is::2}}(?!){{/when}})'

/**
 * Request-editing regexes (type editprocess): Risu runs them on each message
 * when it builds the request, before long-term memory reads the chat. The Lua
 * marks every message wholly inside a folded scene; these take the scene out:
 * a message with a member mark goes empty (the Lua drops it from the request),
 * the first message becomes the summary the Lua keeps in sf_text_<id>. A
 * message in a folded run and in a battle inside it goes, the run covering it.
 */
export const REQUEST_REGEX = [
    {
        comment: '📁 장면 접기 · 접은 장면의 나머지 메시지 빼기',
        in: String.raw`^${ACTIVE}[\s\S]*<!--sf:m:\w+-->[\s\S]*$`,
        out: '',
        type: 'editprocess',
        flag: 'g<cbs>',
        ableFlag: true,
    },
    {
        comment: '📁 장면 접기 · 접은 장면 첫 메시지를 요약으로',
        in: String.raw`^${ACTIVE}[\s\S]*<!--sf:f:\w+:(\w+)-->[\s\S]*$`,
        out: '{{getvar::sf_text_$1}}',
        type: 'editprocess',
        flag: 'g<cbs>',
        ableFlag: true,
    },
]

/** The module's main JSON (what a .risum carries before its assets). */
export function buildModuleJson(code) {
    return {
        module: {
            name: `📁 장면 접기 v${VERSION}`,
            description: DESCRIPTION,
            id: MODULE_ID,
            namespace: 'scene-fold',
            lowLevelAccess: true,
            lorebook: [],
            regex: REQUEST_REGEX,
            trigger: [{
                comment: '장면 접기',
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

export function rpackMaps(mapBytes) {
    return { encode: mapBytes.subarray(0, 256), decode: mapBytes.subarray(256, 512) }
}

export function encodeRisum(json, encodeMap) {
    const main = Buffer.from(JSON.stringify(json, null, 2), 'utf-8')
    const packed = Buffer.from(main.map((byte) => encodeMap[byte]))
    const head = Buffer.alloc(6)
    head.writeUInt8(111, 0)
    head.writeUInt8(0, 1)
    head.writeUInt32LE(packed.length, 2)
    return Buffer.concat([head, packed, Buffer.from([0])])
}

export function decodeRisum(buffer, decodeMap) {
    if (buffer[0] !== 111 || buffer[1] !== 0) throw new Error('not a .risum')
    const length = buffer.readUInt32LE(2)
    const main = Buffer.from(buffer.subarray(6, 6 + length).map((byte) => decodeMap[byte]))
    if (buffer[6 + length] !== 0) throw new Error('unexpected data after the module')
    return JSON.parse(main.toString('utf-8'))
}

export function readSource() {
    return readFileSync(join(here, 'scene-fold.lua'), 'utf-8')
}

export function readMaps() {
    return rpackMaps(readFileSync(join(root, 'src/ts/rpack/rpack_map.bin')))
}

function main() {
    const json = buildModuleJson(readSource())
    const maps = readMaps()
    const out = join(here, 'dist', `scene-fold-${VERSION}.risum`)
    mkdirSync(dirname(out), { recursive: true })
    const buffer = encodeRisum(json, maps.encode)
    // Read it back before calling it done.
    const back = decodeRisum(buffer, maps.decode)
    if (JSON.stringify(back) !== JSON.stringify(json)) throw new Error('round trip mismatch')
    writeFileSync(out, buffer)
    console.log(`wrote ${out} (${buffer.length} bytes)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
