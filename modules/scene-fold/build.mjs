// Builds the distributable 📁 장면 접기 module (.risum) from scene-fold.lua.
// usage: node modules/scene-fold/build.mjs
// A .risum is: byte 111, byte 0, the main JSON's length (uint32 LE), the
// main JSON rpack-encoded, then assets (none here) and a closing 0 byte
// (src/ts/process/modules.ts exportModule / readModule).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'
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
    '=설정=divider',
    'scenefold.mode=장면 찾기=select=보조 모델이 판단,메인 모델이 표시',
    'scenefold.grace=끝난 뒤 접기까지=select=답 2개,바로,답 1개,답 3개,답 4개,답 6개',
    'scenefold.summary=요약 쓰는 모델=select=보조 모델,메인 모델',
    'scenefold.buttons=메시지 아래 장면 버튼=select=보이기,숨기기',
    '=비권장=divider',
    'scenefold.cut=✂️ 원문 잘라내기 (비권장)=select=끔,켬',
    '=켜면 접은 장면을 채팅에서 지우고 요약 메시지 하나로 바꿔, 장기 기억(하이파)이 요약만 보게 합니다. 원문은 채팅 상태에 보관하고 요약 메시지의 되돌리기로 돌려놓을 수 있지만, 그 사이의 리롤·삭제는 평소처럼 되돌릴 수 없습니다=caption',
    '==groupEnd',
].join('\n')

export const DESCRIPTION = '끝난 배틀·NSFW·사용자 정의 장면을 모델에게 보내는 요청에서 접고 짧은 요약으로 바꿉니다. 채팅 원문은 그대로 둡니다. 보조 모델 판단과 요약에 저수준 접근이 필요합니다.'

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
            regex: [],
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
