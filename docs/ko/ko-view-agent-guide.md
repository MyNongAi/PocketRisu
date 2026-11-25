# 한국어 보기 글 넣기 (에이전트용 안내)

PocketRisu 개조판의 "한국어 보기"(`KO-VIEW`)는 봇·모듈의 영어 원문은 그대로 두고, 사람이 읽을 한국어 번역을 옆에 따로 붙여 두는 기능입니다. 이 문서는 봇이나 모듈을 만들고 고치는 에이전트(Codex, Claude Code, Antigravity 등)가 그 한국어를 어떻게 넣는지 정리합니다.

## 원칙

- **모델이 읽는 것은 영어 원문뿐입니다.** 한국어는 화면에서 `가`/`A` 토글로 사용자만 봅니다. 프롬프트, 요청, 토큰 계산 어디에도 들어가지 않습니다.
- **영어와 한국어는 같이 씁니다.** 영어 원문을 새로 쓰거나 고칠 때는 같은 호출에서 그 한국어도 함께 넣습니다. 영어만 바꾸면 화면에 "원문 바뀜"이 표시되고, 한국어는 예전 번역으로 남습니다.
- **번역 규칙**
  - `{{...}}` 매크로, `<...>` 태그, 정규식·Lua가 찾는 표식, 고유 이름, 줄바꿈과 목록 같은 서식은 그대로 둡니다.
  - 의미를 빼거나 더하지 않습니다. 사람이 읽기 위한 충실한 번역입니다.
- **한국어를 지우려면** 빈 문자열(`""`)을 넣습니다.
- **다른 리스에서는** 이 한국어 칸을 모르기 때문에 무시하고 영어만 씁니다. 그래서 봇과 모듈은 다른 리스에서도 그대로 동작합니다.

## MCP 도구로 넣기 (권장)

PocketRisu의 MCP 서버(`risuaccess`)가 열려 있으면 아래 도구를 씁니다. 읽기 도구는 한국어와 함께 `stale`(영어가 그 뒤에 바뀌었는지) 값을 돌려줍니다.

### 모듈 로어북 항목

모듈에서 한국어 보기가 되는 것은 **로어북 항목의 본문**입니다. 모듈 정보, 정규식, Lua에는 한국어 칸이 없습니다.

- 읽기: `risu-get-module-lorebook` → `content`(영어), `koContent: { text, stale }`
- 쓰기: `risu-set-module-lorebook`

```json
{
  "id": "모듈 ID 또는 이름",
  "name": "로어북 항목 이름",
  "content": "English source the model reads.",
  "koContent": "모델이 읽는 영어 원문의 한국어 번역.",
  "keys": ["keyword"],
  "alwaysActive": false
}
```

### 봇 로어북 항목

모듈과 같은 방식입니다.

- 읽기: `risu-get-character-lorebook`
- 쓰기: `risu-set-character-lorebook`. `content`와 `koContent`를 같은 호출에 넣습니다.

### 봇 필드

`risu-set-character-info`의 `ko` 묶음에 필드별 한국어를 넣습니다. 영어는 `data`에, 한국어는 같은 이름으로 `ko`에 넣습니다.

```json
{
  "id": "봇 ID 또는 이름",
  "data": { "description": "English description.", "greeting": "English first message." },
  "ko": { "description": "한국어 설명.", "greeting": "한국어 첫 메시지." }
}
```

`ko`에 쓸 수 있는 이름은 아래와 같습니다.

| `ko` 이름 | 화면의 필드 |
|---|---|
| `description` 또는 `desc` | 봇 설명 |
| `greeting` 또는 `firstMessage` | 첫 메시지 |
| `exampleMessage` | 예시 대화 |
| `systemPrompt` | 시스템 프롬프트 |
| `replaceGlobalNote` | 글로벌 노트 대체 |
| `additionalText` | 추가 텍스트 |
| `personality` | 성격 |
| `scenario` | 시나리오 |

`risu-get-character-info`는 각 필드의 한국어와 `stale`을 함께 돌려줍니다.

## 파일을 직접 만들 때 (MCP 없이)

MCP 없이 봇 카드나 모듈 파일을 직접 만들면, 한국어는 아래 위치에 넣습니다. 모양은 `{ "text": 한국어, "src": 영어 원문의 지문 }`입니다.

- **모듈(.risum)**
  - 로어북 항목마다 `nodeOnlyKo: { "content": { "text": "…", "src": "…" } }`를 둡니다.
- **봇 카드(.charx / .png, Character Card V3)**
  - 봇 필드: `data.extensions.pocketrisu.ko`에 넣습니다. 열쇠는 위 표의 저장 이름(`desc`, `firstMessage` 등)입니다.
    - 예: `{ "desc": { "text": "…", "src": "…" } }`
  - 로어북 항목: `extensions.pocketrisu_ko.content`에 넣습니다.
- **`src` 계산법**
  - `src`는 그 영어 원문의 32비트 FNV-1a 해시를 8자리 16진수로 적은 값입니다.
    - 시작값 `0x811c9dc5`
    - 글자마다(UTF-16 코드 단위) XOR한 뒤 `0x01000193`을 곱합니다(32비트).
    - `src/ts/koView.ts`의 `fingerprint`와 같습니다.
  - 값이 원문과 맞지 않으면 앱이 "원문 바뀜"으로 표시할 뿐, 한국어는 그대로 보입니다.
  - 계산하기 번거로우면 MCP 도구로 넣는 쪽이 안전합니다.

## 확인

앱에서 해당 필드나 로어북 항목의 찾기·복사 줄에 있는 `가`/`A` 토글을 눌러 한국어가 보이는지 확인합니다. "원문 바뀜"이 뜨면, 영어를 고친 뒤 한국어를 다시 넣지 않은 것입니다.
