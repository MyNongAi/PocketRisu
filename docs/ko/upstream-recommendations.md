# PocketRisu 상류 반영 제안서

## 비교 기준

- 기준 상류: PocketRisu `v1.10.0`, commit `98e968339d1b3f91b9dac85bb3f2ebb5f90f9d14`
- 개조 브랜치: 상류 v1.10.0을 포함하고 그 위에 기능별 커밋을 쌓는 구조
- 이 문서의 수치는 2026-08-23 실제 대형 사용자 DB에서 측정

이 문서에서 **원본 RisuAI**는 `risuai.xyz` 계열 클라이언트를, **공식 PocketRisu**는 `PocketRisu/PocketRisu` 상류 저장소를, **개조판**은 이 로컬 브랜치를 뜻합니다. 공식 PocketRisu의 단일 SQLite 저장 구조와 원본 RisuAI 웹의 브라우저 IndexedDB 저장 구조를 같은 의미로 부르지 않습니다.

## 개조판에만 있는 기능

### 1. 외부 에셋 코어

- `external://provider/sha256` 경로와 filesystem/HTTP 공급자
- 캐릭터, 모듈, persona embedded module, GPT-SoVITS 참조 수집·치환
- 업로드 → 재다운로드 해시/크기 검증 → 복구용 휴지통 → 원자적 참조 전환
- 내부·휴지통 fallback, 재시도, 제한형 메모리 LRU, manifest-only 기본 백업
- 서버 중단 후 재개 가능한 SQLite 작업 journal
- 검사와 복사를 worker/background batch로 수행하여 채팅 저장을 장시간 막지 않음
- 파일시스템 공급자와 휴지통이 같은 볼륨이면 hard link로 복구 사본의 데이터 중복 방지
- Android SAF는 현재 명시적 미지원이며 Termux 접근 가능 경로나 HTTP 저장소를 사용

### 2. 이미지·대형 목록 최적화

- 서버가 요청 시 320px WebP 썸네일을 만들며 파생 캐시는 256MB로 제한
- 추가 에셋 미리보기는 썸네일을 사용하고, 드래그앤드롭/전체 보기 때만 원본 요청
- IntersectionObserver 기반 가시영역 요청
- 추가 에셋, 감정 이미지, 에셋 뷰어, 모바일/전체 캐릭터 목록은 화면 주변 행만 mount하는 가상 목록·그리드 사용
- 좌측 캐릭터 목록도 원본 대신 지연 생성 썸네일 사용

### 3. 채팅 메모리와 체감 속도

- 서버의 metadata-only chat placeholder를 선택 직전 prefetch
- 180ms 안에 끝나는 전환에는 로딩 문구를 표시하지 않음
- 최근 캐릭터의 현재 채팅을 idle 시간에 미리 준비
- 서버에 저장된 비활성 hydrated chat만 12개 LRU 범위 밖에서 다시 placeholder로 접음
- 수정 중, 생성 중, 현재 채팅은 eviction하지 않음
- 채팅 에셋 출력 창 설정과 범위 이탈 DOM/media/Object URL 정리

### 4. 가져오기와 목록 UX

- 여러 캐릭터 파일을 동시에 처리하며 화면을 막지 않는 상단 진행 표시
- 최근 열람·최근 import 캐릭터를 목록 상단으로 승격
- 활성 모듈을 최근 활성화 순으로 영구 정렬
- 채팅 동작 버튼을 메시지 상·하단에 함께 표시
- 모듈 동작 버튼을 상·하단 및 좌측 패널 흐름에 함께 표시
- 웹/로컬/모바일 출처 라벨을 붙여 캐릭터·모듈을 별도 내보내는 migration exporter

## 실제 대형 DB 측정

테스트 DB의 논리 `database.bin`은 약 305MB였고, 캐릭터·모듈 에셋 참조는 약 54.7만 건, 고유 내부 에셋은 약 48.8만 개, 이전 대상은 약 46.9GB였습니다. 깨진 내부 참조 131개도 존재했습니다.

| 항목 | 기존 상세 참조 스캔 | 새 worker 요약 스캔 |
|---|---:|---:|
| 경과 시간 | 약 610.9초 | 약 36.0초 |
| 결과 | 누락 131개 때문에 전체 이전 중단 | 누락을 보고하고 정상 488,228개를 queue에 등록 가능 |
| 서버 응답성 | 메인 흐름에서 큰 객체·JSON pointer 생성 | 별도 worker, 작은 진행 상태만 UI에 전달 |

데이터가 검사 사이에 소폭 증가했으므로 완전히 동일한 snapshot 비교는 아니지만, 참조 규모 차이는 0.1% 미만이며 약 17배의 계획 단계 단축이 관측됐습니다.

측정 뒤에도 사용자가 에셋을 계속 추가하고 있으므로 위 개수와 용량은 기준 스냅샷일 뿐입니다. 실제 이전은 저장된 과거 목록을 재사용하지 않고, 시작 직전에 현재 DB를 다시 계획해 새 에셋까지 포함합니다.

## 상류에 권하는 PR 순서

하나의 거대한 PR로 제출하지 않는 편이 review와 회귀 추적에 유리합니다.

1. **썸네일 + 원본 drag + 가상 목록**
   - 사용자 체감과 메모리 효과가 가장 분명하고 저장 형식 변경이 없음
   - `thumbnail-cache`, `LazyAssetPreview`, `VirtualList/Grid`, 에셋 편집/뷰어 적용을 한 묶음으로 제안
2. **비차단 다중 캐릭터 import**
   - core DB 형식과 독립적이고 기능 경계가 작음
3. **채팅 prefetch + 지연 loading indicator + 안전한 hydrated LRU**
   - 기존 lazy chat architecture를 보완하는 별도 PR
4. **최근 캐릭터/모듈 정렬**
   - 정렬 metadata와 UI를 작은 PR로 분리
5. **상·하단 동작 버튼**
   - 순수 UX 옵션으로 별도 제안
6. **외부 에셋 저장소는 먼저 RFC**
   - URI, backup portability, provider credential, migration journal, fallback/purge 정책을 합의한 뒤 여러 PR로 나눔

최근 출력 N개에서만 매크로 에셋을 해석하는 기능은 고급 설정/플러그인과 역할이 겹칠 수 있으므로 상류 기본 동작으로 바로 제안하기보다 별도 논의 대상으로 두는 편이 낫습니다.

## 5379 dev 구조와의 관계

이 개조판은 5379 dev의 전체 SQL 재설계를 가져오지 않았습니다. 현재 PocketRisu의 SQLite KV + serialized `database.bin` 구조를 유지하면서 큰 바이너리, 채팅 payload, 화면 렌더링의 병목을 외부화·지연화한 방식입니다.

정규화 SQL에서 참고할 가치가 큰 부분은 다음과 같습니다.

- 캐릭터 목록용 작은 metadata row를 DB blob decode 없이 읽는 구조
- chat/message 단위 pagination과 필요한 column만 조회하는 구조
- asset manifest를 하나의 대형 JSON 대신 row 단위로 조회·갱신하는 구조

반대로 fork 전체를 그대로 병합하면 PocketRisu의 서버 저장, backup, mobile/Termux, 상류 update와 충돌 면적이 너무 큽니다. schema adapter와 benchmark를 먼저 만들고 character index → module index → settings 순으로 점진 이전하는 편이 안전합니다.

## 현재 검증 상태

- server Vitest: 10 files, 149 tests 통과
- chat LRU/virtual window logic: 24 tests 통과
- web Vitest: 78 files, 1,080 tests 통과, 3 tests 의도적 skip
- migration exporter Node tests: 8 tests 통과
- Svelte 전체 검사: 5,796 files, 오류 0개
- Vite production build: 7,812 modules, 성공
- 별도 임시 서버의 실제 HTTP 흐름: planning → staged → published → verified 통과
- 내부 참조 3개가 외부 URI로 바뀌고 내부 원본이 제거되며 manifest fallback이 유지되는 것 확인

대형 실데이터의 전체 46.9GB 복사·최종 전환·장시간 재시작 복구 검증은 별도 운영 단계로 기록해야 합니다.
