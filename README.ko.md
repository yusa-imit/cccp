# cccp — Claude Code channels peer

> **언어**: [English](./README.md) · **한국어** (이 파일)

여러 Claude Code 인스턴스가 서로 대화하게 해주는 Claude Code 플러그인. peer에게
작업을 위임하고, 회신을 받고, 원하면 도구 승인 프롬프트까지 다른 세션으로
릴레이할 수 있습니다. 각 세션이 자체 MCP **channel** 서버(`cccp-inbox`)를 띄우고,
다른 인스턴스는 `~/.cccp/registry/`로 자동 발견됩니다. 메시지는 받는 쪽 Claude의
컨텍스트에 `<channel source="cccp-inbox" sender="..." kind="..." task_id="...">`
태그로 직접 주입됩니다.

> **요구사항**: Claude Code v2.1.80+ (permission relay는 v2.1.81+), Bun 1.x,
> macOS 또는 Linux.
>
> **연구 프리뷰**: 자작 채널은 승인된 allowlist에 없으므로
> `--dangerously-load-development-channels` 플래그로 실행해야 합니다.
>
> **인터랙티브 모드 전용**: 채널 알림으로 새 모델 턴이 발동되려면 인터랙티브
> `claude` 세션이어야 합니다. `-p`/헤드리스 모드는 알림은 받지만 새 턴이 시작되지
> 않습니다 — [한계](#한계) 참고.

---

## 설치

### 사전 조건

- **macOS 또는 Linux**: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` 중 하나
- **둘 중 하나**: GitHub 릴리스의 prebuilt 바이너리 **또는** [Bun](https://bun.sh) 1.x이 PATH에 (래퍼가 첫 실행 시 컴파일)
- Claude Code v2.1.80+

### 방법 A — Claude Code 플러그인으로 설치 (권장)

```bash
# Claude Code 안에서
/plugin marketplace add yusa-imit/cccp
/plugin install cccp@cccp
```

MCP 서버가 처음 뜰 때 `server/start.sh`가 다음 순서로 런타임 바이너리를 찾습니다:

1. 환경 변수 `$CCCP_BIN` (있으면 그걸로)
2. `server/dist/cccp-inbox-<os>-<arch>` (다운로드된 릴리스 아티팩트)
3. `server/dist/cccp-inbox` (로컬 빌드)
4. `bun`이 PATH에 있으면 즉석에서 컴파일 (1회, ~5초)
5. 모두 실패하면 릴리스 다운로드 `curl` 명령을 알려주고 종료

bun 컴파일 단계를 건너뛰려면 prebuilt 바이너리를 그 자리에 놓아두세요:

```bash
PLATFORM=darwin-arm64    # darwin-x64 | linux-x64 | linux-arm64
PLUGIN_DIR="$HOME/.claude/plugins/cache/cccp/cccp"     # 버전이 다르면 조정
mkdir -p "$PLUGIN_DIR"/*/server/dist
curl -L -o "$PLUGIN_DIR"/*/server/dist/cccp-inbox-${PLATFORM} \
  https://github.com/yusa-imit/cccp/releases/latest/download/cccp-inbox-${PLATFORM}
chmod +x "$PLUGIN_DIR"/*/server/dist/cccp-inbox-${PLATFORM}
```

### 방법 B — 로컬 클론

```bash
git clone https://github.com/yusa-imit/cccp.git
# Claude Code 안에서 (어느 프로젝트에서든)
/plugin marketplace add /cccp의/절대경로
/plugin install cccp@cccp
```

### 방법 C — bare MCP 서버만 (슬래시 커맨드/스킬/훅 없이)

```bash
git clone https://github.com/yusa-imit/cccp.git
```

`~/.claude.json` 또는 프로젝트 `.mcp.json`에 추가:

```json
{
  "mcpServers": {
    "cccp-inbox": {
      "command": "/cccp의/절대경로/server/start.sh"
    }
  }
}
```

### 채널 활성화 상태로 실행

설치 이후 채널 메시지를 받으려면 매 `claude` 실행 시 dev-channel 플래그가 필요:

```bash
# 플러그인 설치 (방법 A/B)
claude --dangerously-load-development-channels plugin:cccp@cccp

# bare MCP 서버 (방법 C)
claude --dangerously-load-development-channels server:cccp-inbox
```

연구 프리뷰 중에는 이 플래그가 필수입니다.

### 바이너리 직접 빌드

```bash
cd server
bun install
bun run build              # 현재 플랫폼 → dist/cccp-inbox
bun run build:all          # 4개 플랫폼 전체
```

`.github/workflows/release.yml`이 `v*` 태그가 push될 때마다 4개 바이너리를 빌드해
GitHub Release에 첨부합니다.

---

## 실행 (두 인스턴스 시나리오)

### 터미널 1 — alice

```bash
CCCP_NAME=alice claude --dangerously-load-development-channels plugin:cccp@cccp
```

세션이 뜨면 `~/.cccp/registry/alice.json`이 생기고 inbox HTTP 서버가 OS가 할당한
임의 포트에서 listen 시작.

### 터미널 2 — bob

```bash
CCCP_NAME=bob claude --dangerously-load-development-channels plugin:cccp@cccp
```

이제 두 인스턴스가 서로 발견됩니다.

### 첫 대화

alice 세션에서:

```
/cccp-peers
```

→ alice가 `list_peers`를 호출하고 `bob`을 표시합니다.

```
/cccp-delegate bob 이 디렉토리에서 가장 최근에 수정된 파일 3개를 찾아서 파일명과 수정시각을 알려줘
```

→ alice가 bob에게 `task` 메시지를 보냅니다. bob의 컨텍스트에 다음 태그가 도착:

```
<channel source="cccp-inbox" sender="alice" kind="task" task_id="alice-...">
이 디렉토리에서 가장 최근에 수정된 파일 3개를 ...
</channel>
```

bob의 Claude가 `cccp-protocol` 스킬을 자동으로 적용해 작업을 수행한 뒤
`respond_to_peer({ task_id, content })`를 호출합니다. 결과가 alice의 컨텍스트에
`<channel ... kind="reply" task_id="...">`로 도착하고 alice의 Claude가 사용자에게
결론을 정리해서 보고합니다.

---

## 환경 변수

| 변수                  | 설명                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CCCP_NAME`           | 이 인스턴스의 이름. 미설정 시 `<hostname>-<pid>`.                                                                                   |
| `CCCP_PORT`           | inbox HTTP 포트. 미설정 시 OS가 자동 할당.                                                                                          |
| `CCCP_SUPERVISOR`     | 권한 승인을 릴레이할 peer 이름. 설정 시 Claude Code의 모든 tool-approval 다이얼로그가 그 peer에게도 forward됩니다.                  |
| `CCCP_NOTIFY_ON_STOP` | Stop 훅에서 세션 종료를 알릴 peer 이름 (해당 peer에게 `kind=note` 메시지 발송).                                                     |
| `CCCP_HOME`           | registry 루트 디렉토리 오버라이드. 기본값 `~/.cccp`. 주로 테스트용.                                                                 |

---

## 권한 릴레이 (supervisor 패턴)

bob이 위험한 도구를 호출할 때마다 alice가 승인하게 하려면:

```bash
# alice (supervisor)
CCCP_NAME=alice \
  claude --dangerously-load-development-channels plugin:cccp@cccp

# bob (supervised)
CCCP_NAME=bob CCCP_SUPERVISOR=alice \
  claude --dangerously-load-development-channels plugin:cccp@cccp
```

bob의 Claude가 예를 들어 `Bash` 도구를 호출하면:

1. bob의 로컬 다이얼로그가 열림
2. 동시에 alice에게 `<channel kind="perm-request" request_id="..." tool_name="Bash" ...>`가 도착
3. alice가 `respond_permission({ peer: "bob", request_id: "...", behavior: "allow" })` 호출
4. bob의 다이얼로그가 자동으로 닫히고 도구 실행

먼저 응답한 쪽이 이깁니다 (로컬 vs 원격).

---

## 프로토콜 요약

### Channel 태그 (수신측 컨텍스트)

```
<channel source="cccp-inbox" sender="<peer>" kind="task|reply|note|perm-request" task_id="..."[, ...]>
본문
</channel>
```

### MCP 도구 (각 인스턴스가 자기 inbox에 대해 호출)

- `send_to_peer({ to, content, kind?, task_id? })`
- `respond_to_peer({ task_id, content })`
- `list_peers()`
- `respond_permission({ peer, request_id, behavior })`

### HTTP 엔드포인트 (inbox 간 통신)

| 경로                       | 페이로드                                                                          |
| -------------------------- | --------------------------------------------------------------------------------- |
| `POST /msg`                | `{ from, content, kind, task_id? }`                                               |
| `POST /permission/request` | `{ from, request_id, tool_name, description, input_preview }`                     |
| `POST /permission/verdict` | `{ from, request_id, behavior }`                                                  |
| `GET /info`                | 자기 메타데이터                                                                   |
| `GET /peers`               | 발견된 peer 목록                                                                  |

모든 `POST`는 `from` 필드가 **현재 살아있는 등록된 peer**여야 통과합니다 (sender
allowlist). 자기 자신으로부터의 loopback은 허용.

---

## 테스트

```bash
cd server
bun test
```

23개 테스트: 13 단위(registry) + 10 통합(실제 inbox 프로세스를 띄워서 HTTP
라우팅, sender gating, 채널 알림 발행, 들어오는/나가는 권한 릴레이 풀루프
검증).

---

## 디버깅

```bash
# 살아있는 인스턴스 직접 확인
ls ~/.cccp/registry/
cat ~/.cccp/registry/alice.json

# 메시지 수동 push (등록된 peer 또는 loopback만 가능)
curl -X POST http://127.0.0.1:<port>/msg \
  -H 'Content-Type: application/json' \
  -d '{"from":"alice","kind":"note","content":"manual test"}'

# Claude Code 세션 안에서
/mcp                  # cccp-inbox 상태 확인
```

inbox 서버 stderr는 Claude Code의 `~/.claude/debug/<session-id>.txt`에 캡처됩니다.

### 플러그인 캐시 stale 함정

`/plugin install cccp@cccp` 시점에 `~/.claude/plugins/cache/cccp/cccp/<version>/`로
스냅샷이 떠집니다. 작업본을 편집해도 캐시는 **자동 갱신되지 않습니다**. 재설치하거나
`--plugin-dir`로 작업본을 직접 가리켜야 합니다:

```bash
claude --plugin-dir /cccp의/절대경로 \
       --dangerously-load-development-channels plugin:cccp@inline
```

---

## 한계

- **인터랙티브 모드 전용.** 채널 알림이 모델의 새 턴으로 라우팅되는 건 인터랙티브
  `claude` 세션에서만 됩니다. `-p`(`--print`) 또는 SDK 스트리밍 모드는 inbox가
  POST는 받지만 첫 모델 턴 후 세션이 끝나서 인바운드 채널 이벤트가 새 응답을 만들지
  못합니다. 실제로 확인했고 커밋 히스토리에서 검증 과정을 볼 수 있습니다.
- **같은 머신 한정.** 디스커버리가 파일시스템(`~/.cccp/registry/`) 기반이고 HTTP도
  `127.0.0.1`로만 listen. 멀티 머신은 향후 작업.
- **Sender 신뢰 모델.** 같은 사용자로 실행되는 모든 프로세스가 peer로 등록하고
  메시지를 보낼 수 있습니다. 멀티유저 환경에서는 추가 인증 필요.
- **컨텍스트 비공유.** 각 인스턴스의 transcript/메모리는 독립. 메시지 본문이 정보
  전달의 유일한 수단입니다.
- **연구 프리뷰 게이트.** 공식 Anthropic allowlist 등재 전까지는
  `--dangerously-load-development-channels`가 필수입니다.

---

## 라이선스

MIT.
