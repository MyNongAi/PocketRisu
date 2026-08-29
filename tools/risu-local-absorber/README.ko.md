# PC 로컬리스 무손실 흡수 도구

PC 로컬 Risu의 봇·모듈·페르소나를 현재 PocketRisu에 **항목 중복을 제거하지
않고** 모두 덧붙이는 오프라인 이주 도구입니다.

- 채팅은 제외합니다.
- 모든 봇·모듈·페르소나는 새 ID를 받습니다.
- 이름과 내용이 같아도 건너뛰지 않습니다.
- 원래 캐릭터 폴더에는 `[로컬리스]` 접두사를 붙입니다.
- 폴더 밖 캐릭터와 모듈은 `[출처] 로컬리스` 폴더에 넣습니다.
- 에셋은 활성 외부 저장소에 SHA-256 주소로 저장합니다.
- 동일 바이트는 물리적으로 한 번만 저장하지만 모든 엔티티 참조는 유지합니다.
- 실행 직전에 현재 PocketRisu DB의 공유 청크 스냅샷과 외부 manifest 백업을 만듭니다.
- 같은 원본 DB 해시는 실수로 두 번 흡수할 수 없습니다.

PocketRisu 서버와 로컬 Risu를 닫은 뒤 먼저 dry-run을 실행합니다.

```powershell
node --max-old-space-size=4096 tools/risu-local-absorber/absorb-local-risu.mjs `
  --source-root "C:\Users\chae0_9ksma4k\AppData\Roaming\co.aiclient.risu" `
  --target-root "C:\Users\chae0_9ksma4k\PocketRisu" `
  --source-label "로컬리스"
```

검증 결과가 맞을 때만 `--execute`를 붙입니다. 실행 중 원본 로컬리스 파일은
수정하거나 삭제하지 않습니다. 완료 장부는 PocketRisu의
`backups/migration-journals`에 남습니다.
