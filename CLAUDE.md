# 이 저장소에서 작업하는 에이전트를 위한 규칙

PocketRisu 위에 개인 수정을 얹은 포크입니다. 여러 세션(데스크톱, 노트북)이 같은 브랜치에 커밋하므로, 어느 세션이든 아래 규칙을 따릅니다.

## 말과 커밋

- 사용자에게 하는 말은 한국어로 씁니다.
- 커밋 메시지는 영어로 쓰고, BOM 없는 파일을 `git commit -F`로 넘깁니다.
- 작업 하나가 끝나면 바로 커밋하고 `feature/external-assets`로 푸시합니다.
- 푸시 전에는 항상 `git fetch` 후 origin 위로 fast-forward하거나 rebase합니다. 다른 세션도 같은 브랜치에 푸시합니다.
- 금지:
  - force-push
  - 히스토리 재작성
  - `git push --all` / `--tags`
- 푸시는 refspec을 명시해서 합니다: `git push origin HEAD:feature/external-assets`

## 공개 저장소

이 저장소는 공개입니다. 커밋 작성자는 noreply 주소만 씁니다. 아래 정보는 코드, 문서, 커밋 메시지 어디에도 넣지 않습니다.

- 실명, 개인 이메일
- 로컬 경로, 기기 이름
- Tailscale 네트워크 이름과 IP
- 클라우드 프로젝트 ID와 주소

`pnpm run check`와 `pnpm build`가 `scripts/check-public-tree-privacy.mjs`를 돌리지만, 푸시 전에 diff도 직접 훑어봅니다.

## 원본 따라가기

**PocketRisu (`upstream`, PocketRisu/PocketRisu)**

- 코드를 고치기 전에, 적어도 하루 한 번 `git fetch upstream`을 하고 `main`과 `develop`에 새 커밋이 있는지 봅니다.
- 새 커밋이 있으면 사용자에게 알리고, 우리 수정보다 먼저 병합합니다.
- 우리 쪽 변경은 작게 유지합니다. 새 모듈과 얇은 연결 코드로 만들고, 저장 형식은 바꾸지 않습니다.

**공식 RisuAI (kwaroran/Risuai)**

- PocketRisu를 따라갈 때 공식 `main`도 같이 훑어봅니다. remote는 추가하지 않습니다.

  ```
  git fetch https://github.com/kwaroran/Risuai.git main:refs/remotes/official/main
  git log --no-merges --cherry-pick --right-only --format='%h %ad %s' --date=short upstream/main...official/main
  ```

- 보안, 권한, 플러그인 샌드박스, sanitize 관련 수정이 우리와 PocketRisu 양쪽에 없으면 사용자에게 알리고 가져옵니다.
  - 코드는 공식과 똑같이 옮깁니다. 그래야 나중에 어느 쪽을 병합해도 줄이 맞습니다.
  - 커밋 메시지에 공식 PR 번호를 적습니다.
- 공식을 통째로 병합하지 않습니다. PocketRisu는 2026-03-16에 공식에서 갈라진 뒤 다시 병합한 적이 없어, 수백 커밋과 천 개가 넘는 파일이 다릅니다.

## 검사

- **커밋 전:** `pnpm run check`, 바꾼 부분과 관련된 테스트를 돌립니다. 화면 수정은 폰 너비(375px)에서 직접 재현하고 고친 뒤 다시 확인합니다.
- **푸시 직후, 전체 검사를 백그라운드로 돌립니다.** 실패하면 바로 고쳐서 다시 푸시합니다. 전체 검사는 아래와 같습니다.
  - `pnpm exec vitest run`
  - `pnpm exec vitest run --config vitest.config.server.ts`
  - `pnpm exec vitest run --config vitest.config.compat.ts`를 세 가지 모드로:
    - 기본
    - `POCKETRISU_TEST_FREEZE_CACHE=1`
    - 거기에 `POCKETRISU_FLAG_PERSIST_MODE=incremental`을 더한 것
  - `pnpm build`
- 사용자 데이터로 테스트하지 않습니다. 합성 데이터를 씁니다. 사용자 DB 내용은 출력하지 말고, 개수만 봅니다.

## 개인 기능 문서

- 개인 수정 기능은 다음 두 곳에 함께 기록합니다. `pnpm run check`가 마커를 검사합니다.
  - `docs/ko/custom-feature-contract.json`
  - `docs/ko/custom-feature-ledger.md`
- 기능을 추가하거나 바꾸면 두 파일을 같이 고칩니다.
