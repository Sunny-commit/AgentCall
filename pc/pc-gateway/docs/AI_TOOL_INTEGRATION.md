# Connect AgentCall to an AI tool

AgentCall already provides a local, USB-only gateway and stdio MCP server for local agents. This adapter adds a small authenticated HTTP API for AI tools that support REST/OpenAPI actions, including Custom GPT Actions.

## What it does

- `POST /v1/calls` places a consented call, asks 1–12 questions, and returns a `callId`.
- `GET /v1/calls/{callId}` returns structured answers and the transcript.
- `POST /v1/calls/{callId}/cancel` hangs up an active call.

The adapter orchestrates the existing AgentCall MCP tools. It does not add SIP, VoIP, a cloud phone number, or a second telephony stack. The phone still needs the supported AgentCall Android and USB gateway setup.

## Run locally

From `pc/pc-gateway`:

```bash
export AGENTCALL_API_KEY="replace-with-a-long-random-value"
export AGENTCALL_RPC_SOCKET="/run/user/$UID/agentcall/gateway.sock"
npm run start:api
```

For local development only, the API key can be omitted when the server stays on loopback:

```bash
AGENTCALL_API_ALLOW_INSECURE_LOCAL=true npm run start:api
```

The default listener is `127.0.0.1:8765`. Keep it on loopback unless it is behind an HTTPS reverse proxy or a private authenticated tunnel. Never put an API key in a repository, OpenAPI document, screenshot, or chat message.

## OpenAPI / Custom GPT setup

1. Import `openapi/agentcall-openapi.json` into the AI tool's action setup.
2. Replace the server URL with the HTTPS URL that securely reaches this API.
3. Configure bearer authentication with `AGENTCALL_API_KEY`.
4. Instruct the AI tool to confirm the destination, explain that the call is recorded, ask for consent and approval, start the call, poll until completion, and report each question with its answer.
5. Test with a number you control.

ChatGPT Custom GPT Actions require a reachable HTTPS endpoint. A private VPN or authenticated tunnel is preferable to an open internet listener.

## Example

```bash
curl -X POST https://YOUR-AGENTCALL-HOST.example/v1/calls \
  -H "Authorization: Bearer $AGENTCALL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+14155552671",
    "questions": ["Are you available for a short interview?", "What time should we follow up?"],
    "context": "This is a scheduling call for the product team.",
    "recordingConsent": true,
    "approved": true
  }'
```

Poll the returned call ID. When `status` is `completed`, each answer is in `questions[].answer`. An optional HTTPS `callbackUrl` receives a `call.completed` payload after the call ends.

## Safety and privacy

- Destinations must be strict E.164 numbers.
- Calls require explicit `recordingConsent: true` and `approved: true`.
- Existing dial policy, recording checks, rate limits, emergency-number blocks, and device qualification remain authoritative.
- Session answers are held in memory and disappear when the API process stops.
- Do not use this for emergency services, spam, harassment, impersonation, or calls without the required consent and legal permissions.
