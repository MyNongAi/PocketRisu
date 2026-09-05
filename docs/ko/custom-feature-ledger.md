# PocketRisu 개조 기능 장부

이 문서는 공식 PocketRisu 업데이트를 받을 때 개조 기능의 소유 파일, 도입 이유, 검증 상태와 상류 중복 여부를 빠르게 판단하기 위한 유지보수 장부입니다.

## 기준

- 상류 기준: 공식 PocketRisu v1.11.2
- 개조 브랜치: `feature/external-assets`
- 외부 프로젝트 전체 병합: 없음
- HaejeokRisu `b6651`의 GPL v3 코드·구조 중 사이드바 지연 로더와 제한형 이미지 캐시 원칙을 PocketRisu API에 맞춰 이식했습니다. 상세 내용은 `docs/ko/haejeok-adoption.md`에 기록합니다.

## 기능군 장부

| 기능군 | 상태 | 대표 커밋 | 주요 소유 영역 | 상류 반영 전략 |
|---|---|---|---|---|
| 외부 에셋 URI·공급자·LRU | 완료, 운영 이전 published | `75b91e62`, `e542b1ec` | `src/ts/storage`, `server/node`, 시스템 설정 | URI·백업 정책 RFC 후 분할 PR |
| 썸네일·원본 드래그·가시영역 로딩 | 완료 | `6e9ddd67`, `8725fe75`, `f3c17929` | 에셋 미리보기, 캐릭터/모듈 목록, 서버 썸네일 | 독립 PR 최우선 후보 |
| 채팅 hydration·LRU·복구 | 완료 | `b7bd2d13`, `87217e77` | 채팅 저장소, 로딩 UI, 서버 metadata | prefetch/LRU를 분리 제안 |
| 채팅별 동시 생성·다중 기기 저장 | 완료 | `44a2dce0`, `42c7c573`, `a00a2b5d` | 생성 상태, generation target, node 저장 API | 동시성 테스트와 함께 별도 PR |
| PC 분할 채팅 패널 | 완료 | `79e347b4` | `ChatScreen`, `SecondaryChatPanel`, `chatSplitPane` | UX 옵션으로 별도 PR |
| 비차단 다중 import | 완료 | `ed146f9f` | import queue와 상단 진행 UI | 작은 독립 PR 후보 |
| 최근 캐릭터·모듈 정렬 | 완료 | `58a9f630`, `5ac3f653` | 캐릭터/모듈 order metadata | metadata와 UI 분리 PR |
| 캐릭터·모듈 폴더와 drag/drop | 완료, 회귀 테스트 유지 | `97df8a8b`, `bee038ae`, `623ba11a`, `3593108f` | Sidebar, ModuleList, folder overlay | 원본 배열 비파괴 원칙 유지 |
| 출처별 병합 exporter | 완료 | `94f3490b`, `695759a6` | `extras/risu-source-collection-exporter`, 병합 UI | 포맷 문서와 함께 제안 |
| 시각형 페르소나 선택·이미지 drop | 완료 | `1047a47e`, `a98c779a` | PersonaSettings, persona storage | UI와 저장 검증 분리 PR |
| 이동·크기 조절 페르소나 정보창 | 완료 | `79e347b4` | `PersonaSettings.svelte` | 데스크톱 UX 옵션 |
| 상·하단 동작 버튼·사이드바 탭 | 완료 | `73da07e8`, `0b87d2f5`, `58595524` | Sidebar, Chat, Module UI | 순수 UI PR 후보 |
| 내부 백업·스냅샷 보존 | 완료 | `104b6c43`, `e542b1ec` | node storage, 시스템 설정 | 보존 주기/개수 정책 분리 |
| Haejeok식 패널 지연 로딩·이미지 LRU·에셋 이름 인덱스 | 완료, C 설치본 배포 | `28ba044e` | `Sidebar`, `characters`, `parser`, `assetNameLocalResolver` | 작고 독립적인 성능 PR로 분리 |

## 업데이트 충돌 판단 순서

1. 상류 업데이트를 먼저 merge하고 충돌 파일을 기능군별로 분류합니다.
2. 상류에 같은 기능이 생겼다면 장부의 개조 코드를 무조건 유지하지 않고 동작·테스트를 비교합니다.
3. 상류 구현이 충분하면 해당 개조 커밋을 제거하거나 adapter만 남깁니다.
4. 저장 형식·에셋 URI·동시성처럼 데이터 안전에 영향을 주는 기능은 UI 기능보다 먼저 회귀 테스트합니다.
5. 빌드와 실제 C 드라이브 서버 배포가 끝난 커밋만 이 장부에서 `완료`로 바꿉니다.

## 2026-09-05 채팅 저장 충돌 회귀 수정

- **확인한 원인:** 본문 POST의 성공 응답 뒤 catalog stub의 name/lastDate/folderId/modules를 병합하면서 전체 바이트 ETag가 바뀌었습니다. 다른 기기가 없어도 다음 본문 저장이 409가 되는 경로를 실제 서버 테스트로 재현했습니다.
- **본문과 목록의 버전 분리:** 본문 동시성에는 `x-chat-etag`의 정규화된 본문 버전을 사용합니다. 목록 필드는 기존 DB PATCH hash/ETag가 담당하며, HTTP `ETag`는 GET 응답 바이트에 대응합니다. 옛 클라이언트의 바이트 ETag도 실제 현재 데이터와 일치할 때만 허용합니다.
- **새 채팅 보호:** 본문이 목록 등록보다 먼저 도착하면 SQLite의 `chat-payload-pending/`에 임시 복구 기록을 남깁니다. 본문과 목록이 함께 database.bin에 저장된 뒤에만 기록을 제거하며, 서버 재시작 전에도 본문을 잃지 않습니다. 전체 에셋을 복제하는 기능이 아닙니다.
- **클라이언트 경쟁 방지:** 같은 채팅의 자동 저장·생성 복구 저장·생성 시작 확인은 순서대로 처리합니다. 다른 채팅은 독립적입니다. 늦은 heartbeat는 새 저장 버전을 되돌리지 않으며, 충돌 응답만으로 보지 못한 원격 버전을 채택하지 않습니다.
- **반복 팝업:** 화면 파일 로드 실패는 비차단 알림 한 개로 표시하고 자동 새로고침하지 않습니다. 저장 실패는 로컬 변경을 유지하며 간격을 늘려 재시도하고, 같은 안내를 연속 모달로 띄우지 않습니다. 실제 충돌을 무시하거나 덮어쓰지는 않습니다.
- **배포:** `emptyOutDir: false` 및 기존 `dist/assets` 보존으로 이미 열린 탭의 지연 로드 파일을 유지합니다. 과거에 이미 삭제된 빌드 파일이나 실제 네트워크 단절까지 복구하는 것은 아닙니다.
- **검증 범위:** 독립 서버의 저장→flush→저장, 생성→flush→재시작→목록 등록, 동일/상이한 채팅의 기기별 lease, 실제 stale write 거부, 중복 POST 재시도, placeholder 거부와 클라이언트 지연 응답 테스트. 실물 휴대폰 장시간 사용 검증은 별도입니다.

## 아직 운영 단계가 남은 항목

- 약 47GB 기존 에셋의 C → H 해시 검증·참조 전환 완료(494,605개 전부 검증, 실패 0, 554,352개 참조 전환). 복구용 휴지통의 영구 삭제는 사용자 검증 뒤에만 수행합니다.
- 웹리스·로컬리스·모바일 웹리스 컬렉션의 사용자 확인 병합
- Haejeok식 캐릭터 shadow index와 선택 시 본문 hydration(저장 병합 경계 선행 필요)
