import type { RegistryFieldSchema, RegistryUiField } from './types'
import type { RegistryLocale } from './registry/i18n'
import { VERTEX_CUSTOM_PATH_LOCATION } from './adapter/vertexEndpoint'

export const VERTEX_LOCATIONS = [
    { value: 'global', ko: '전 세계 자동 배정', en: 'Global, auto-routed' },
    { value: 'us-central1', ko: '미국 아이오와', en: 'Iowa, USA' },
    { value: 'us-east1', ko: '미국 사우스캐롤라이나', en: 'South Carolina, USA' },
    { value: 'us-east4', ko: '미국 버지니아 북부', en: 'Northern Virginia, USA' },
    { value: 'us-east5', ko: '미국 오하이오', en: 'Ohio, USA' },
    { value: 'us-south1', ko: '미국 텍사스 댈러스', en: 'Dallas, USA' },
    { value: 'us-west1', ko: '미국 오리건', en: 'Oregon, USA' },
    { value: 'us-west4', ko: '미국 라스베이거스', en: 'Las Vegas, USA' },
    { value: 'asia-northeast1', ko: '일본 도쿄', en: 'Tokyo, Japan' },
    { value: 'asia-northeast3', ko: '한국 서울', en: 'Seoul, Korea' },
    { value: 'asia-east1', ko: '대만', en: 'Taiwan' },
    { value: 'asia-southeast1', ko: '싱가포르', en: 'Singapore' },
    { value: 'europe-west1', ko: '벨기에', en: 'Belgium' },
    { value: 'europe-west4', ko: '네덜란드', en: 'Netherlands' },
] as const

export function vertexLocationLabel(value: string, locale: RegistryLocale): string {
    const location = VERTEX_LOCATIONS.find(location => location.value === value)
    return `${value} (${location?.[locale] ?? value})`
}

export function isVertexLocationField(schemaField: RegistryFieldSchema, uiField: RegistryUiField): boolean {
    return schemaField.mapsTo?.target === 'custom'
        && schemaField.mapsTo?.path === VERTEX_CUSTOM_PATH_LOCATION
        && uiField.widget === 'text'
}

export function isKnownVertexLocation(value: string | undefined): boolean {
    return VERTEX_LOCATIONS.some(location => location.value === value)
}

export function isVertexGlobalOnlyModel(modelId: string | undefined): boolean {
    if (!modelId) return false
    const id = modelId.replace(/^(?:google\/|publishers\/google\/models\/)/, '')
    return id.startsWith('gemini-4')
        || /^gemini-3-.*-preview$/.test(id)
        || /^gemini-3\.[5678]-flash/.test(id)
}
