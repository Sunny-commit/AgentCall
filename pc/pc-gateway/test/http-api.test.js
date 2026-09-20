import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCallHttpApi } from '../src/http-api.js';

function result(value, isError = false) {
  return { jsonrpc: '2.0', id: 'test', result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError } };
}
class FakeRpcClient { async startEvents() {} stopEvents() {} }
class FakeHandler {
  constructor() { this.calls = []; this.turn = 0; }
  async handle(message) {
    const { name, arguments: args } = message.params;
    this.calls.push({ name, args });
    if (name === 'capabilities') return result({ tools: ['dial', 'wait_for_turn', 'speak', 'hangup'] });
    if (name === 'dial') return result({ accepted: true, callId: 'gateway-call-1', afterSequence: 0 });
    if (name === 'wait_for_turn') {
      this.turn += 1;
      return result({ status: 'turn', callId: 'gateway-call-1', sequence: this.turn, speaker: 'remote', text: this.turn === 1 ? 'Yes, I am available.' : 'Tomorrow at 10 AM.', complete: true });
    }
    if (name === 'speak' || name === 'hangup') return result({ accepted: true, callId: 'gateway-call-1' });
    return result({ accepted: false, reason: 'unsupported test tool' }, true);
  }
}
async function waitForCompletion(baseUrl, callId, headers) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/calls/${callId}`, { headers });
    const call = await response.json();
    if (['completed', 'failed'].includes(call.status)) return call;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('test call did not complete');
}

test('authenticated question call returns structured answers and hangs up', async (t) => {
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  const apiKey = 'test-api-key-not-a-secret';
  const handler = new FakeHandler();
  const api = new AgentCallHttpApi({ env: { AGENTCALL_API_HOST: '127.0.0.1', AGENTCALL_API_PORT: String(port), AGENTCALL_API_KEY: apiKey }, rpcClient: new FakeRpcClient(), handler, waitMs: 250 });
  await api.start();
  t.after(() => api.stop());
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${baseUrl}/v1/capabilities`)).status, 401);
  const started = await fetch(`${baseUrl}/v1/calls`, { method: 'POST', headers, body: JSON.stringify({ to: '+12025550123', questions: ['Are you available?', 'What time should we follow up?'], recordingConsent: true, approved: true }) });
  assert.equal(started.status, 202);
  const completed = await waitForCompletion(baseUrl, (await started.json()).callId, headers);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.questions.map(({ answer }) => answer), ['Yes, I am available.', 'Tomorrow at 10 AM.']);
  assert.equal(handler.calls.at(-1).name, 'hangup');
  assert.equal(completed.toLast4, '0123');
  assert.equal(JSON.stringify(completed).includes('+12025550123'), false);
});

test('call creation requires recording consent', async (t) => {
  const port = 19_000 + Math.floor(Math.random() * 1_000);
  const api = new AgentCallHttpApi({ env: { AGENTCALL_API_HOST: '127.0.0.1', AGENTCALL_API_PORT: String(port), AGENTCALL_API_KEY: 'test-api-key-not-a-secret' }, rpcClient: new FakeRpcClient(), handler: new FakeHandler() });
  await api.start();
  t.after(() => api.stop());
  const response = await fetch(`http://127.0.0.1:${port}/v1/calls`, { method: 'POST', headers: { authorization: 'Bearer test-api-key-not-a-secret', 'content-type': 'application/json' }, body: JSON.stringify({ to: '+12025550123', questions: ['Are you available?'] }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /recordingConsent/u);
});
