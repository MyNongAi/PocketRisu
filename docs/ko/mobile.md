# 모바일 접속 가이드

> 🚧 **이 문서는 준비 중입니다.**
>
> Quick Tunnel과 Tailscale 설정에 대한 상세 안내가 여기에 정리될 예정입니다.

당분간은:

- **Quick Tunnel** — PocketRisu에서 설정 > 원격 접속 > "원격 접속 열기"를 누르면 임시 URL과 QR 코드가 생성됩니다. 별도 설정 불필요. 서버 재시작 시 URL이 바뀝니다.
- **Tailscale** — PC와 폰에 같은 계정으로 Tailscale을 설치한 뒤, PC에서 `tailscale serve --bg http://localhost:6001` 실행. 재시작해도 URL이 유지됩니다.

가이드가 완성되기 전까지 [기존 README](../../README.legacy.md)에서 전체 절차를 참고하세요.

---

← [README로 돌아가기](../../README.ko.md)
