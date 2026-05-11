# cccp — Claude Code channels peer

Claude Code channels peer.

각 세션이 자체 MCP **channel** 서버(`cccp-inbox`)를 띄우고, 다른 인스턴스는 `~/.cccp/registry/`로 자동 발견됩니다. 메시지는 `<channel source="cccp-inbox" sender="..." kind="..." task_id="...">` 태그로 받는 쪽 Claude의 컨텍스트에 직접 주입됩니다.

> **요구사항**: Claude Code v2.1.80+ (permission relay는 2.1.81+), Bun 1.x, macOS/Linux.
> **연구 프리뷰**: 현재 자작 채널은 allowlist에 없으므로 `--dangerously-load-development-channels` 플래그로 실행해야 합니다.

---

## 설치

### 1. 의존성

```bash
cd server
bun install
cd ..
```

### 2. 플러그인 등록

#### 방법 A — 로컬 마켓플레이스로 추가 (권장)

`~/.claude.json` 또는 프로젝트 `.mcp.json` 옆에 다음을 추가:

```json
{
  "mcpServers": {
    "cccp-inbox": {
      "command": "bun",
      "args": ["/Users/ljh0801/Desktop/codespace/cccp/server/inbox.ts"]
    }
  }
}
```

이 방식은 MCP 서버만 등록하고, 슬래시 커맨드/스킬/훅은 사용하지 않습니다.

#### 방법 B — 플러그인으로 정식 설치

Claude Code의 플러그인 시스템에 마켓플레이스로 등록:

```bash
# /plugin marketplace add /Users/ljh0801/Desktop/codespace/cccp
# /plugin install cccp@<your-marketplace>
```

> 자작 채널은 allowlist에 없으므로 실행 시 항상 `--dangerously-load-development-channels server:cccp-inbox` 또는 `plugin:cccp@<marketplace>`가 필요합니다.

---

## 실행 (두 인스턴스 시나리오)

### 터미널 1 — "alice"

```bash
CCCP_NAME=alice claude --dangerously-load-development-channels server:cccp-inbox
```

세션이 뜨면 `~/.cccp/registry/alice.json`이 생기고 inbox HTTP 서버가 임의 포트에서 listen 시작.

### 터미널 2 — "bob"

```bash
CCCP_NAME=bob claude --dangerously-load-development-channels server:cccp-inbox
```

이제 두 인스턴스가 서로 발견됩니다.

### 첫 대화

**alice 세션에서:**

```
/cccp-peers
```

→ alice가 list_peers를 호출하고 `bob`을 표시.

```
/cccp-delegate bob 이 디렉토리에서 가장 최근에 수정된 파일 3개를 찾아서 파일명과 수정시각을 알려줘
```

→ alice가 bob에게 task 메시지 송신. bob의 컨텍스트에 다음 태그가 도착:

```
<channel source="cccp-inbox" sender="alice" kind="task" task_id="alice-...">
이 디렉토리에서 가장 최근에 수정된 파일 3개를 ...
</channel>
```

bob의 Claude가 자동으로 cccp-protocol 스킬을 적용해서 작업 수행 후 `respond_to_peer({ task_id, content })`를 호출. 결과가 alice의 컨텍스트에 `<channel ... kind="reply" task_id="...">`로 도착하고 alice의 Claude가 사용자에게 결론을 정리해서 보고합니다.

---

## 환경 변수

| 변수 | 설명 |
|------|------|
| `CCCP_NAME` | 이 인스턴스의 이름. 미설정 시 `<hostname>-<pid>`. |
| `CCCP_PORT` | inbox HTTP 포트. 미설정 시 OS가 자동 할당. |
| `CCCP_SUPERVISOR` | 이 인스턴스의 권한 승인 릴레이 대상 peer 이름. 설정 시 Claude Code의 모든 tool-approval 다이얼로그가 해당 peer에게도 forward됨. |
| `CCCP_NOTIFY_ON_STOP` | Stop 훅에서 알릴 peer 이름. 세션 종료 시 해당 peer에게 `kind=note` 메시지 발송. |

---

## 권한 릴레이 (supervisor 패턴)

bob이 위험한 도구 호출을 할 때마다 alice가 승인하게 하려면:

```bash
# alice (supervisor)
CCCP_NAME=alice claude --dangerously-load-development-channels server:cccp-inbox

# bob (supervised)
CCCP_NAME=bob CCCP_SUPERVISOR=alice claude --dangerously-load-development-channels server:cccp-inbox
```

bob이 예: `Bash` 도구를 호출하면 →
- bob의 로컬 다이얼로그가 열리고
- 동시에 alice에게 `<channel kind="perm-request" request_id="abcde" tool_name="Bash" ...>` 가 도착
- alice가 `respond_permission({ peer: "bob", request_id: "abcde", behavior: "allow" })` 호출
- bob의 다이얼로그가 자동으로 닫히고 도구 실행 진행

먼저 응답하는 쪽이 이김 (로컬 vs 원격).

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

| 경로 | 페이로드 |
|------|---------|
| `POST /msg` | `{ from, content, kind, task_id? }` |
| `POST /permission/request` | `{ from, request_id, tool_name, description, input_preview }` |
| `POST /permission/verdict` | `{ from, request_id, behavior }` |
| `GET /info` | 자기 메타데이터 |
| `GET /peers` | 발견된 peer 목록 |

모든 `POST`는 `from` 필드가 **현재 살아있는 등록된 peer**여야 통과 (sender allowlist).

---

## 디버깅

```bash
# 살아있는 인스턴스 직접 확인
ls ~/.cccp/registry/
cat ~/.cccp/registry/alice.json

# 수동으로 메시지 push (loopback만 가능)
curl -X POST http://127.0.0.1:<port>/msg \
  -H 'Content-Type: application/json' \
  -d '{"from":"alice","kind":"note","content":"manual test"}'

# Claude Code 세션 안에서
/mcp                  # cccp-inbox 상태 확인
```

서버 로그는 stderr로 가서 Claude Code의 `~/.claude/debug/<session-id>.txt`에 남습니다.

---

## 한계

- **같은 머신 한정**: 디스커버리는 `~/.cccp/registry/` 파일 시스템 기반이고 HTTP는 127.0.0.1로만 listen. 멀티 머신은 향후 작업.
- **Sender 신뢰 모델**: 같은 사용자 홈의 다른 프로세스는 모두 신뢰. 멀티유저 환경에서는 추가 인증 필요.
- **컨텍스트 비공유**: 각 인스턴스의 transcript/메모리는 독립. 메시지 본문이 정보 전달의 유일한 수단.
- **연구 프리뷰**: `--dangerously-load-development-channels` 필수. 정식 마켓플레이스 등재는 별도 절차 필요.

---

## 라이선스

MIT.
