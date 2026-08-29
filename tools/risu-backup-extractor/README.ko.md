# Risu 공식 백업 부분 추출기

Risu의 공식 전체 백업 `Binary.bin`을 수정하지 않고 다음 자료를 각각 분리합니다.

- 채팅을 제외한 캐릭터
- 모듈
- 페르소나
- 각 묶음이 참조하는 `assets/<hash>.png` 목록
- 캐릭터·모듈 폴더 배치 자료

첫 단계는 메타데이터와 에셋 참조 색인만 만듭니다. 수십 GB의 에셋 원본은
백업 안에 그대로 두므로 같은 데이터를 다시 복제하지 않습니다. 생성 결과는 아직
PocketRisu 컬렉션 가져오기 화면에 직접 넣는 파일이 아니라, 대용량 이주와 중복
검사를 위한 안전한 중간 산출물입니다.

## 실행

PocketRisu 저장소에서 다음처럼 실행합니다.

```powershell
node --max-old-space-size=4096 tools/risu-backup-extractor/extract-risu-backup.mjs `
  --input "H:\Download\새 폴더 (8)\Binary.bin" `
  --output "H:\Risuai-Pork\backups\risu-partial-extract\pc-web-20260813" `
  --source-label "PC웹리스"
```

출력 폴더가 이미 존재하면 덮어쓰지 않고 중단합니다. 작업 중 실패하면 원본은
건드리지 않으며 `.partial-<프로세스번호>` 폴더를 남겨 진단할 수 있게 합니다.

## 출력 구조

```text
pc-web-20260813/
├─ summary.json
├─ characters/
│  ├─ manifest.json
│  ├─ layout.json
│  └─ items/*.json
├─ modules/
│  ├─ manifest.json
│  ├─ layout.json
│  └─ items/*.json
└─ personas/
   ├─ manifest.json
   └─ items/*.json
```

`summary.json`에는 원본 크기, DB 위치와 해시, 종류별 항목·에셋 참조 수가
기록됩니다. 동일한 모바일 백업을 나중에 처리하면 DB 해시와 출처 이름으로 서로
구분할 수 있습니다.
