import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const contractPath = path.join(root, 'docs', 'ko', 'custom-feature-contract.json')
const ledgerPath = path.join(root, 'docs', 'ko', 'custom-feature-ledger.md')

function insideRoot(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null
    const resolved = path.resolve(root, relativePath)
    const relative = path.relative(root, resolved)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null
}

async function exists(relativePath) {
    const resolved = insideRoot(relativePath)
    if (!resolved) return false
    try {
        await stat(resolved)
        return true
    }
    catch {
        return false
    }
}

const contract = JSON.parse(await readFile(contractPath, 'utf8'))
const ledger = await readFile(ledgerPath, 'utf8')
const failures = []
const ids = new Set()

if (contract.schemaVersion !== 1) failures.push(`지원하지 않는 장부 스키마: ${contract.schemaVersion}`)
if (!Array.isArray(contract.features) || contract.features.length === 0) {
    failures.push('기능 계약에 등록된 기능이 없사와요')
}

for (const feature of contract.features ?? []) {
    const label = `${feature.id ?? '<id 없음>'} ${feature.title ?? ''}`.trim()
    if (!feature.id || ids.has(feature.id)) failures.push(`${label}: ID가 없거나 중복이랍니다`)
    ids.add(feature.id)
    if (!ledger.includes(`\`${feature.id}\``)) failures.push(`${label}: 사람이 읽는 장부 표에 ID가 없답니다`)

    for (const file of feature.ownerFiles ?? []) {
        if (!await exists(file)) failures.push(`${label}: 소유 파일 누락 — ${file}`)
    }
    for (const test of feature.regressionTests ?? []) {
        if (!await exists(test)) failures.push(`${label}: 회귀 테스트 누락 — ${test}`)
    }
    for (const marker of feature.requiredMarkers ?? []) {
        const resolved = insideRoot(marker.file)
        if (!resolved || !await exists(marker.file)) {
            failures.push(`${label}: 표식 파일 누락 — ${marker.file}`)
            continue
        }
        const source = await readFile(resolved, 'utf8')
        if (!source.includes(marker.contains)) {
            failures.push(`${label}: 핵심 표식 소실 — ${marker.file} :: ${marker.contains}`)
        }
    }
}

if (failures.length > 0) {
    console.error(`\n개조 기능 검문 실패 ${failures.length}건\n`)
    for (const failure of failures) console.error(`- ${failure}`)
    console.error('\n상류 구현으로 대체했다면 계약과 장부를 함께 갱신하고, 아니라면 기능을 복구하시와요.\n')
    process.exitCode = 1
}
else {
    const counts = Object.groupBy(contract.features, (feature) => feature.criticality ?? 'unspecified')
    const summary = Object.entries(counts).map(([key, values]) => `${key} ${values.length}`).join(', ')
    console.log(`개조 기능 ${contract.features.length}개 검문 통과 (${summary})`)
    console.log(`기준: ${contract.upstreamBaseline} / ${contract.branch} / ${contract.updatedAt}`)
}
