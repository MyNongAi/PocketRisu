# PocketRisu Kei 구조 검토 장부

PocketRisu Kei의 코드를 통째로 합치지 않고, 우리 개조판에 필요한 설계 원칙만 작은 단위로 검토·이식하기 위한 장부입니다. 이 문서에서 `도입 후보`는 **아직 구현 완료를 뜻하지 않습니다**.

## 검토 기준

- 대상 저장소: [seto-sama/PocketRisu-Kei](https://github.com/seto-sama/PocketRisu-Kei)
- 검토 태그: `kei-v2.1.1`
- 검토 커밋: `631e71b0`
- Kei 기반 PocketRisu: v1.8.1 계열, 기준 커밋 `63832a13`
- 우리 기준: PocketRisu v1.12.0, `feature/external-assets`
- 검토일: 2026-09-06
- Pull requests 탭에는 열린 PR과 닫힌 PR이 없었으므로, 실제 구조는 태그와 커밋 이력으로 확인했습니다.

Kei는 기반 버전과 변경 면적이 우리 브랜치와 크게 다릅니다. 따라서 브랜치 merge나 대량 cherry-pick은 하지 않고, 아래 후보를 테스트 가능한 독립 기능으로 다시 구현합니다.

## 도입 후보

### 1. 순수 함수형 사이드바 드래그 엔진

- 상태: `완료` (`b341f8d6`)
- 참고 커밋: [`114dbfc7`](https://github.com/seto-sama/PocketRisu-Kei/commit/114dbfc7)
- 가져올 철학: DOM 인덱스와 화면 위치에 직접 의존하는 드래그 로직을, 안정된 ID를 입력받아 새 폴더·아이템 순서를 반환하는 순수 변환기로 분리합니다.
- 우리 목표: 폴더 안팎 이동, 검색 중 이동, 폴더 자체 이동에서 `null`이 뜨거나 항목이 사라지는 회귀를 단위 테스트로 막습니다.
- 보존 조건: 즐겨찾기, 최근순, 출처 폴더, 비파괴 모듈 폴더 메타데이터를 그대로 유지해야 합니다.
- 이식 결과: `src/lib/SideBars/sidebarDrag.ts`가 캐릭터·폴더의 안정 ID를 입력받아 새 순서를 만드는 순수 계층을 담당하고, 기존 HTML5·터치·가상 목록 UI는 그 결과만 한 번 저장합니다. 화면 인덱스가 바뀌거나 검색 결과가 줄어도 낡거나 모호한 시작점은 데이터 변경 없이 거부합니다.
- 검증: `src/lib/SideBars/sidebarDrag.test.ts`에서 루트↔폴더 이동, 같은 폴더 안 재정렬, 폴더 블록 이동, 캐릭터끼리 새 폴더 생성, 검색 중 낡은 시작점, 폴더 중첩 거부를 검사합니다.

### 2. 서버 소유 생성 작업과 메시지 단위 병합

- 상태: `장기 계획`
- 참고 커밋: [`4c5e9660`](https://github.com/seto-sama/PocketRisu-Kei/commit/4c5e9660), [`26198188`](https://github.com/seto-sama/PocketRisu-Kei/commit/26198188), [`d4b873ff`](https://github.com/seto-sama/PocketRisu-Kei/commit/d4b873ff)
- 가져올 철학: 생성 중인 결과를 브라우저 탭 하나의 수명에만 맡기지 않고 서버 작업으로 보존하며, 작업 시작 당시 본문 전체를 덮는 대신 안정된 메시지 ID를 기준으로 결과를 현재 채팅에 병합합니다.
- 우리 목표: 현재의 채팅별 lease, 본문 ETag, pending payload 복구 위에 `base/result/current` 3방향 병합과 재접속 가능한 작업 journal을 얹습니다.
- 충돌 원칙: 서로 다른 메시지나 서로 다른 채팅은 병합하되, 같은 메시지를 두 기기가 동시에 수정한 진짜 충돌은 조용히 덮어쓰지 않습니다.
- 도입 방식: 생성 실행기 전체를 바꾸지 않고 저장 materializer부터 기능 플래그 뒤에 작게 도입합니다.

### 3. 관계형 메타데이터 저장과 호환 projection

- 상태: `연구`
- 참고 커밋: [`6d0984d4`](https://github.com/seto-sama/PocketRisu-Kei/commit/6d0984d4), [`6e2608ac`](https://github.com/seto-sama/PocketRisu-Kei/commit/6e2608ac), [`f38f6882`](https://github.com/seto-sama/PocketRisu-Kei/commit/f38f6882)
- 가져올 철학: 캐릭터·모듈·페르소나·채팅·메시지의 목록과 본문을 독립 레코드로 읽어, 목록 한 번을 보기 위해 거대한 전체 DB를 디코딩하지 않습니다.
- 우리 목표: 기존 `database.bin`과 플러그인 API에는 호환 projection을 제공하면서, 대형 카탈로그의 읽기·검색·정렬 경로만 먼저 인덱스로 전환합니다.
- 선행 조건: 양방향 변환의 무손실 round-trip, 중단 가능한 마이그레이션 journal, 구버전 복귀 경로가 있어야 합니다.

### 4. 플러그인 저장소 메모리 예산과 OOM 방어

- 상태: `부분 검토`
- 참고 커밋: [`7b01acb4`](https://github.com/seto-sama/PocketRisu-Kei/commit/7b01acb4), [`70de0d07`](https://github.com/seto-sama/PocketRisu-Kei/commit/70de0d07)
- 가져올 철학: 플러그인 저장값과 임베딩 같은 대형 데이터를 시작 시 전부 복제하지 않고, 명시적인 바이트 예산·페이지 처리·해제 지점을 둡니다.
- 우리 현황: 서버측 플러그인 저장소, 스트리밍 preload, 제한형 LRU를 이미 갖고 있으므로 Kei 구현을 그대로 가져오지 않습니다. 시작 시 메모리 예산 초과 감지와 진단 수치만 독립 후보로 둡니다.

## 이미 우리 쪽에 있는 원칙

- 화면 주변만 유지하는 가변 높이 목록 로더
- 크기가 제한된 Object URL·이미지 캐시와 동시 요청 합치기
- 설정 검색
- 외부 원본과 작은 썸네일의 분리, 드래그 때 원본 전환
- 채팅별 생성 lease와 본문 버전 검사

같은 목적의 상류·외부 구현이 발견되면 먼저 동작과 회귀 테스트를 비교합니다. 이름이 비슷하다는 이유만으로 기존 구현 위에 두 번째 구현을 겹치지 않습니다.

## 명시적으로 가져오지 않을 것

- 에셋 원본까지 단일 SQLite에 다시 넣는 구조
- Kei 브랜치 전체 merge 또는 대량 cherry-pick
- 우리 사용 환경에 필요한 레거시 플러그인·로컬 모델 경로의 일괄 제거
- 기존 DB를 즉시 삭제하는 단방향 마이그레이션
- 같은 메시지의 실제 충돌을 무조건 마지막 저장으로 덮는 정책

## 도입 규칙

1. 외부 코드의 GPL v3 출처와 참고 커밋을 문서와 커밋 메시지에 남깁니다.
2. 기능 하나를 작은 커밋 하나 이상으로 분리하고, 기능 플래그나 이전 형식 호환으로 되돌릴 수 있게 만듭니다.
3. 도입 전에 실패를 재현하는 회귀 테스트를 먼저 둡니다.
4. 저장 형식 변경은 복제 데이터에서 round-trip과 강제 중단 복구를 검증합니다.
5. 구현이 완료될 때에만 `docs/ko/custom-feature-contract.json`에 소유 파일·핵심 표식·회귀 테스트를 등록합니다.
