#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { GatewayRpcClient } from './gateway-rpc.js';
import { McpHandler } from './mcp-server.js';
import { rpcSocketFromEnv } from './runtime-config.js';

const E164 = /^\+[1-9]\d{5,14}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_BODY = 64 * 1024;
const WAIT_MS = 30_000;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const loopback = (host) => ['127.0.0.1', '::1', 'localhost'].includes(host);

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('body must be a JSON object'), { statusCode: 400 });
  }
}
function validate(value) {
  const destination = value.to ?? value.destination ?? value.number;
  if (!E164.test(destination ?? '')) throw Object.assign(new Error('to must use strict E.164 format'), { statusCode: 400 });
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 12
      || value.questions.some((question) => !text(question, 500))) {
    throw Object.assign(new Error('questions must contain 1-12 bounded strings'), { statusCode: 400 });
  }
  if (value.recordingConsent !== true) throw Object.assign(new Error('recordingConsent must be true'), { statusCode: 400 });
  if (value.approved !== true) throw Object.assign(new Error('approved must be true'), { statusCode: 400 });
  if (value.context !== undefined && !text(value.context, 2_000)) throw Object.assign(new Error('context is invalid'), { statusCode: 400 });
  let callbackUrl = null;
  if (value.callbackUrl !== undefined) {
    try {
      const url = new URL(value.callbackUrl);
      if (url.protocol !== 'https:' || url.toString().length > 2_048) throw new Error();
      callbackUrl = url.toString();
    } catch {
      throw Object.assign(new Error('callbackUrl must be a valid HTTPS URL'), { statusCode: 400 });
    }
  }
  return { destination, questions: value.questions.map((question) => question.trim()), context: value.context?.trim() ?? '', callbackUrl };
}
function publicCall(call) {
  return {
    callId: call.id, status: call.status, createdAt: call.createdAt, startedAt: call.startedAt,
    completedAt: call.completedAt, toLast4: call.destination.slice(-4), outcome: call.outcome, error: call.error,
    questions: call.questions.map((question, index) => ({ index, question, answer: call.answers[index]?.answer ?? null, answeredAt: call.answers[index]?.answeredAt ?? null })),
    transcript: call.transcript.slice(-100),
  };
}
function opening(call) {
  return `Hello, this is an automated assistant. I have a few brief questions.${call.context ? ` Context: ${call.context}` : ''} First question: ${call.questions[0]}`;
}
function nextQuestion(question, last) {
  return last ? `Thank you. This is the final question: ${question}` : `Thank you. Next question: ${question}`;
}

export class AgentCallHttpApi {
  constructor({ env = process.env, rpcClient = new GatewayRpcClient({ socketPath: rpcSocketFromEnv(env) }), handler, now = () => new Date(), fetchImpl = fetch, waitMs = WAIT_MS } = {}) {
    this.env = env;
    this.rpc = rpcClient;
    this.handler = handler ?? new McpHandler(rpcClient);
    this.now = now;
    this.fetch = fetchImpl;
    this.waitMs = waitMs;
    this.calls = new Map();
    this.server = null;
  }
  async start() {
    const host = this.env.AGENTCALL_API_HOST ?? '127.0.0.1';
    const port = Number(this.env.AGENTCALL_API_PORT ?? 8765);
    const apiKey = String(this.env.AGENTCALL_API_KEY ?? '');
    const insecure = this.env.AGENTCALL_API_ALLOW_INSECURE_LOCAL === 'true';
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('AGENTCALL_API_PORT is invalid');
    if (!apiKey && !(insecure && loopback(host))) throw new Error('AGENTCALL_API_KEY is required');
    await this.rpc.startEvents();
    this.server = http.createServer((req, res) => void this.route(req, res, { host, apiKey, insecure }));
    await new Promise((accept, reject) => { this.server.once('error', reject); this.server.listen(port, host, accept); });
    return { host, port };
  }
  async route(req, res, auth) {
    try {
      const url = new URL(req.url ?? '/', 'http' + '://' + (req.headers.host || 'localhost'));
      if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, service: 'agentcall-api' });
      if (!(auth.insecure && !auth.apiKey && loopback(auth.host)) && req.headers.authorization !== `Bearer ${auth.apiKey}`) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/v1/capabilities' && req.method === 'GET') return send(res, 200, await this.tool('capabilities', {}));
      if (url.pathname === '/v1/calls' && req.method === 'POST') {
        const input = validate(await body(req));
        const call = { id: randomUUID(), ...input, status: 'queued', createdAt: this.now().toISOString(), startedAt: null, completedAt: null, answers: [], transcript: [], outcome: null, error: null, gatewayCallId: null, cursor: 0 };
        this.calls.set(call.id, call);
        send(res, 202, publicCall(call));
        void this.run(call);
        return;
      }
      const get = url.pathname.match(/^\/v1\/calls\/([^/]+)$/u);
      if (get && req.method === 'GET') return this.calls.has(get[1]) ? send(res, 200, publicCall(this.calls.get(get[1]))) : send(res, 404, { error: 'call not found' });
      const cancel = url.pathname.match(/^\/v1\/calls\/([^/]+)\/cancel$/u);
      if (cancel && req.method === 'POST') {
        const call = this.calls.get(cancel[1]);
        if (!call) return send(res, 404, { error: 'call not found' });
        await this.cancel(call);
        return send(res, 200, publicCall(call));
      }
      send(res, 404, { error: 'not found' });
    } catch (problem) {
      const status = Number.isInteger(problem?.statusCode) ? problem.statusCode : 500;
      send(res, status, { error: status >= 500 ? 'internal server error' : problem.message });
    }
  }
  async tool(name, args) {
    const response = await this.handler.handle({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } });
    if (response?.error) throw new Error(response.error.message ?? 'AgentCall tool failed');
    const result = response?.result;
    if (!result?.content?.[0]?.text) throw new Error('invalid AgentCall response');
    const value = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(value.reason ?? 'AgentCall tool failed');
    return value;
  }
  async run(call) {
    call.status = 'dialing';
    call.startedAt = this.now().toISOString();
    try {
      const dial = await this.tool('dial', {
        destination: call.destination, openingText: opening(call),
        preparedReplies: ['Thank you. Please continue.', 'Thank you, I have recorded that.', 'Thank you. Let me ask the next question.', 'Thank you, that is all I needed today.'],
        approved: true, consent: { recorded: true, policy: 'AI question call approved with recording consent.' }, idempotencyKey: `api-${call.id}-dial`,
      });
      if (dial.accepted !== true || typeof dial.callId !== 'string') throw new Error(dial.reason ?? 'call was not accepted');
      call.gatewayCallId = dial.callId;
      call.cursor = Number.isSafeInteger(dial.afterSequence) ? dial.afterSequence : 0;
      call.status = 'asking';
      for (let index = 0; index < call.questions.length && !TERMINAL.has(call.status); index += 1) {
        let turn;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          turn = await this.tool('wait_for_turn', { callId: call.gatewayCallId, afterSequence: call.cursor, timeoutMs: this.waitMs, autoAcknowledge: false, autoPreparedReply: false });
          if (turn.status !== 'timeout') break;
        }
        if (!turn || turn.status === 'timeout') throw new Error('the person did not answer in time');
        if (turn.status === 'ended') { call.status = 'completed'; call.outcome = 'callee_ended_before_all_questions'; break; }
        call.cursor = turn.sequence;
        call.answers[index] = { answer: turn.text, answeredAt: this.now().toISOString() };
        call.transcript.push({ speaker: 'remote', text: turn.text, sequence: turn.sequence });
        if (index + 1 < call.questions.length) {
          const prompt = nextQuestion(call.questions[index + 1], index + 1 === call.questions.length - 1);
          const spoken = await this.tool('speak', { callId: call.gatewayCallId, text: prompt, respondingToSequence: call.cursor, idempotencyKey: `api-${call.id}-question-${index + 1}` });
          if (spoken.accepted !== true) throw new Error(spoken.reason ?? 'could not ask next question');
          call.transcript.push({ speaker: 'agent', text: prompt });
        } else {
          const closing = 'Thank you for your time. That was my final question. Goodbye.';
          const spoken = await this.tool('speak', { callId: call.gatewayCallId, text: closing, respondingToSequence: call.cursor, idempotencyKey: `api-${call.id}-closing` });
          if (spoken.accepted !== true) throw new Error(spoken.reason ?? 'could not close call');
          call.transcript.push({ speaker: 'agent', text: closing });
          call.status = 'completed'; call.outcome = 'all_questions_answered';
        }
      }
    } catch (problem) {
      if (call.status !== 'cancelled') { call.status = 'failed'; call.outcome = 'call_failed'; call.error = problem instanceof Error ? problem.message : 'call failed'; }
    } finally {
      if (call.gatewayCallId && call.status !== 'cancelled') await this.tool('hangup', { callId: call.gatewayCallId, idempotencyKey: `api-${call.id}-hangup` }).catch(() => {});
      call.completedAt = this.now().toISOString();
      await this.notify(call);
    }
  }
  async cancel(call) {
    if (TERMINAL.has(call.status)) return;
    call.status = 'cancelled'; call.outcome = 'cancelled_by_api'; call.completedAt = this.now().toISOString();
    if (call.gatewayCallId) await this.tool('hangup', { callId: call.gatewayCallId, idempotencyKey: `api-${call.id}-cancel` }).catch(() => {});
    await this.notify(call);
  }
  async notify(call) {
    if (!call.callbackUrl) return;
    await this.fetch(call.callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'call.completed', call: publicCall(call) }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
  async stop() {
    for (const call of this.calls.values()) if (!TERMINAL.has(call.status)) await this.cancel(call);
    this.rpc.stopEvents();
    if (this.server) await new Promise((accept) => this.server.close(accept));
    this.server = null;
  }
}
export function isHttpApiEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
  return Boolean(argv[1] && resolve(argv[1]) === fileURLToPath(moduleUrl));
}
if (isHttpApiEntrypoint()) {
  const api = new AgentCallHttpApi();
  try {
    const { host, port } = await api.start();
    process.stdout.write('AgentCall API listening on ' + 'http' + '://' + host + ':' + port + '\n');
    const stop = () => void api.stop().finally(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (problem) {
    process.stderr.write(`${problem instanceof Error ? problem.message : 'AgentCall API failed'}\n`); process.exitCode = 1;
  }
}
