# ccp — Codex channels peer

> **언어**: [English](./README.md) · **한국어** (이 파일)

여러 로컬 Codex 세션이 서로를 발견하고, 메시지를 보내고, 작업을 위임하고, 답장을
가져오고, 필요하면 권한 승인 요청을 supervisor peer에게 릴레이할 수 있게 해주는
Codex 플러그인입니다.

각 세션은 로컬 MCP 서버(`ccp-inbox`)를 실행합니다. peer들은
`~/.ccp/registry/`를 통해 서로를 발견합니다. 수신 메시지는 받는 세션의 inbox에
쌓이고, Codex가 `fetch_messages`를 호출할 때 가져옵니다.

## 요구사항

- macOS 또는 Linux: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`
- MCP, plugin, skill, hook을 지원하는 Codex
- prebuilt `ccp-inbox` 바이너리 또는 PATH의 Bun 1.x

## 설치

### Codex 플러그인으로 설치

이 저장소는 Codex 플러그인 루트입니다.

```bash
codex plugin marketplace add /ccp의/절대경로
```

그 다음 `~/.codex/config.toml`에서 플러그인을 활성화합니다.

```toml
[plugins."ccp@ccp-local"]
enabled = true
```

활성화 후에는 plugin MCP 서버를 다시 읽도록 Codex CLI 세션을 재시작하세요.

Codex 플러그인 파일:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks.json`
- `skills/ccp-protocol/SKILL.md`

### MCP 서버만 연결

`~/.codex/config.toml` 또는 신뢰된 프로젝트의 `.codex/config.toml`에 추가합니다.

```toml
[mcp_servers.ccp-inbox]
command = "/ccp의/절대경로/server/start.sh"
enabled = true
```

또는 CLI로 추가할 수 있습니다.

```bash
codex mcp add ccp-inbox -- /ccp의/절대경로/server/start.sh
```

Codex CLI v0.130에서는 plugin `commands/`가 최상위 slash command로 노출되지
않습니다. `/ccp-*` 대신 "CCP peer 목록 보여줘", "CCP 메시지 가져와줘" 같은
자연어 요청을 사용합니다.

## 런타임 바이너리

`server/start.sh`는 다음 순서로 서버 바이너리를 찾습니다.

1. `$CCP_BIN`
2. `server/dist/ccp-inbox-<os>-<arch>`
3. `server/dist/ccp-inbox`
4. PATH에 `bun`이 있으면 `server/inbox.ts`를 1회 컴파일
5. 모두 실패하면 릴리스 다운로드 명령 출력

로컬 빌드:

```bash
cd server
bun install
bun run build
```

전체 릴리스 타깃 빌드:

```bash
cd server
bun run build:all
```

## 두 peer 실행

터미널 1:

```bash
codex -C /ccp의/절대경로 \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="alice"'
```

터미널 2:

```bash
codex -C /ccp의/절대경로 \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="bob"'
```

각 세션이 시작되면 `~/.ccp/registry/alice.json` 같은 registry 레코드가 생깁니다.

참고: shell에서 `CCP_NAME=alice codex`처럼 실행해도 Codex MCP 서버에 환경변수가
전달되지 않을 수 있습니다. CLI 테스트에서는
`-c mcp_servers.ccp-inbox.env.CCP_NAME=...` override를 사용하세요.

## 사용 흐름

peer 목록:

```text
ccp-inbox list_peers를 사용해서 CCP peer 목록 보여줘.
```

작업 위임:

```text
ccp-inbox send_to_peer로 bob에게 task를 보내줘: 가장 최근에 수정된 파일 3개의 파일명과 수정시각을 알려줘.
```

보낸 쪽은 `task_id`를 받습니다. 받는 쪽은 메시지를 직접 가져와야 합니다.

```text
CCP 메시지 가져와줘.
```

Codex는 `fetch_messages`를 호출하고, `kind="task"` 메시지를 실행한 뒤
`respond_to_peer({ task_id, content })`로 답합니다. 원래 보낸 쪽은 다시
`fetch_messages`를 호출해 `kind="reply"` 결과를 확인합니다.

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `CCP_NAME` | 이 인스턴스 이름. 기본값은 `<hostname>-<pid>`. |
| `CCP_PORT` | inbox HTTP 포트. 기본값은 OS가 할당하는 임의 포트. |
| `CCP_SUPERVISOR` | Codex `PermissionRequest` hook을 릴레이할 peer 이름. |
| `CCP_NOTIFY_ON_STOP` | 세션 종료 시 알릴 peer 이름. |
| `CCP_PERMISSION_TIMEOUT_SEC` | supervisor verdict를 기다리는 시간. 기본값 `120`. |
| `CCP_HOME` | registry 루트. 기본값 `~/.ccp`. 주로 테스트용. |

## 권한 릴레이

supervisor 실행:

```bash
codex -C /ccp의/절대경로 \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="alice"'
```

supervised 세션 실행:

```bash
codex -C /ccp의/절대경로 \
  -c 'mcp_servers.ccp-inbox.env.CCP_NAME="bob"' \
  -c 'mcp_servers.ccp-inbox.env.CCP_SUPERVISOR="alice"'
```

`bob`에서 Codex 권한 요청이 발생하면 `hooks/permission-request.sh`가 `alice`에게
`perm-request` 메시지를 보냅니다. Alice는 메시지를 가져와 판단한 뒤 다음처럼
응답합니다.

```json
respond_permission({ "peer": "bob", "request_id": "...", "behavior": "allow" })
```

verdict는 Bob의 hook이 읽을 수 있는 위치에 기록됩니다.

## MCP 도구

- `fetch_messages({ clear? })`
- `send_to_peer({ to, content, kind?, task_id? })`
- `respond_to_peer({ task_id, content })`
- `list_peers()`
- `whoami()`
- `register({ name })`
- `respond_permission({ peer, request_id, behavior })`

메시지 종류:

- `task`: peer가 실제 작업을 수행하고 `respond_to_peer`로 답해야 함
- `reply`: 위임된 작업의 답장
- `note`: 수동 정보
- `perm-request`: supervised peer의 권한 요청
- `permission-verdict`: 권한 verdict 가시성 메시지

## HTTP 엔드포인트

| 경로 | 페이로드 |
| --- | --- |
| `POST /msg` | `{ from, content, kind, task_id? }` |
| `POST /permission/request` | `{ from, request_id, tool_name, description, input_preview }` |
| `POST /permission/verdict` | `{ from, request_id, behavior }` |
| `GET /info` | 이 인스턴스의 메타데이터 |
| `GET /peers` | 발견된 peer 목록 |

모든 `POST`는 `from`이 현재 살아있는 등록 peer여야 합니다. 자기 자신으로부터의
loopback은 허용합니다.

## 테스트

```bash
cd server
bun test
```

테스트는 peer discovery, sender gating, queued inbox delivery, register rename,
permission relay 경로를 검증합니다.

## 한계

- 같은 머신 한정입니다. discovery는 파일시스템 기반이고 HTTP는 `127.0.0.1`에
  바인딩됩니다.
- Codex는 임의 MCP 서버 notification을 새 모델 턴으로 받지 않습니다. peer 메시지는
  `fetch_messages`로 가져와야 합니다.
- 권한 릴레이는 Codex hook 지원과 대기 중인 hook 프로세스에 의존합니다.
