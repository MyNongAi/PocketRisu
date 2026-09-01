# PocketRisu 개조 기능 장부

이 문서는 공식 PocketRisu 업데이트를 받을 때 개조 기능의 소유 파일, 도입 이유, 검증 상태와 상류 중복 여부를 빠르게 판단하기 위한 유지보수 장부입니다.

## 기준

- 상류 기준: 공식 PocketRisu v1.11.0
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
| Haejeok식 패널 지연 로딩·이미지 LRU·에셋 이름 인덱스 | 완료, C 설치본 배포 | `28ba044e` | `Sidebar`, `characters`, `parser` | 작고 독립적인 성능 PR로 분리 |

## 업데이트 충돌 판단 순서

1. 상류 업데이트를 먼저 merge하고 충돌 파일을 기능군별로 분류합니다.
2. 상류에 같은 기능이 생겼다면 장부의 개조 코드를 무조건 유지하지 않고 동작·테스트를 비교합니다.
3. 상류 구현이 충분하면 해당 개조 커밋을 제거하거나 adapter만 남깁니다.
4. 저장 형식·에셋 URI·동시성처럼 데이터 안전에 영향을 주는 기능은 UI 기능보다 먼저 회귀 테스트합니다.
5. 빌드와 실제 C 드라이브 서버 배포가 끝난 커밋만 이 장부에서 `완료`로 바꿉니다.

## 아직 운영 단계가 남은 항목

- 약 47GB 기존 에셋의 C → H 해시 검증·참조 전환 완료(494,605개 전부 검증, 실패 0, 554,352개 참조 전환). 복구용 휴지통의 영구 삭제는 사용자 검증 뒤에만 수행합니다.
- 웹리스·로컬리스·모바일 웹리스 컬렉션의 사용자 확인 병합
- Haejeok식 캐릭터 shadow index와 선택 시 본문 hydration(저장 병합 경계 선행 필요)
