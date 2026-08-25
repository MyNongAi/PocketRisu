# PocketRisu 이주 내보내기 플러그인 (구형 실험본·사용 중단)

> 이 폴더의 `.prisumigrate` 도구는 현재 병합 UI와 호환되지 않는 구형
> 실험본입니다. 새 작업에 사용하지 마십시오. 특히 아래의 256MB 형식과
> “가져오기 미구현” 설명은 현재 상태가 아닙니다.

현재 사용하는 도구와 형식은 다음 문서를 기준으로 합니다.

- 플러그인: `public/plugins/pocketrisu-source-collection-exporter.js`
- 설치 안내: `extras/risu-source-collection-exporter/README.ko.md`
- PocketRisu 병합 안내: `docs/ko/source-collection-merge.md`
- 형식: `.risu-characters`, `.risu-modules`, `.risu-personas`
- 기본 조각 목표: 12MB, part 상한: 32MB

이 구형 코드는 과거 형식 참고와 회귀 추적을 위해서만 남겨 둡니다.

## 아래 내용은 구형 형식 기록입니다

RisuAI에 있는 봇과 모듈을 PocketRisu 병합용 파일로 각각 내보내는 API v3 플러그인입니다.

## 현재 기능

- 봇 전체 백업과 모듈 전체 백업을 별도 실행
- `로컬리스`, `모바일웹리스`, `웹리스`, 사용자 지정 출처 기록
- 봇 백업에서 채팅, 채팅 폴더, 콜드 스토리지 제외
- 캐릭터 이미지, 감정 이미지, 추가 에셋, VITS/GPT-SoVITS/CC 에셋 수집
- 모듈 에셋, 아이콘, 문자열 안의 내부 에셋 참조 수집
- SHA-256, 원래 에셋 키, 바이트 크기 기록
- 기본 256MB 단위 분할 다운로드
- 캐릭터별 OpenAI 호환 TTS API 키는 기본 제외
- 원본 Risu 데이터는 읽기만 하며 수정하지 않음

## 설치

1. RisuAI의 플러그인 설정을 엽니다.
2. `플러그인 가져오기`를 선택합니다.
3. `pocketrisu-migration-exporter.js`를 선택합니다.
4. 설정 목록에서 `PocketRisu 이주 내보내기`를 엽니다.
5. 현재 데이터의 출처를 선택한 뒤 봇 또는 모듈 백업을 실행합니다.

브라우저가 여러 파일 다운로드 권한을 물으면 허용해야 합니다. `.prisumigrate` 파일은 일반 Risu 전체 백업이 아니며 PocketRisu의 병합 가져오기 기능에서 사용합니다.

## 파일 형식

각 파일은 다음 순서의 바이너리 컨테이너입니다.

1. ASCII magic `PRISUMG1` 8바이트
2. little-endian JSON 헤더 길이 4바이트
3. UTF-8 JSON 헤더
4. 헤더의 `assets` 배열 순서대로 이어 붙인 원본 에셋 바이트

헤더에는 형식 버전, 출처, 내보내기 ID, 분할 번호, 봇 또는 모듈 데이터, 에셋 SHA-256과 크기, 누락 에셋 목록이 포함됩니다.

## 제한

- 현재 버전은 내보내기 전용입니다. PocketRisu 병합 가져오기는 별도로 구현해야 합니다.
- 플러그인 API가 캐릭터 목록을 한 번에 전달하므로 캐릭터와 채팅이 매우 많은 Risu에서는 내보내기 시작 시 잠시 멈출 수 있습니다.
- 하나의 봇 또는 모듈이 분할 크기보다 큰 에셋을 소유하면 그 항목의 파일은 설정한 분할 크기보다 커질 수 있습니다.
- 다운로드가 끝날 때까지 해당 Risu 탭이나 앱을 닫지 마십시오.

