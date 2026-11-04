/**
 * OpenAI-compatible HTTP TTS.
 *
 * The protocol differs from the query one in every visible way — POST with a
 * JSON body, `response_format` names instead of MIME types, no voice list
 * endpoint — so it gets its own stub upstream and its own assertions.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TtsService } from '../src/services/tts.ts';
import { settingsDefaults } from '../src/services/business-settings.ts';
import type { AppConfig } from '../src/config/index.ts';

let root = '';
let upstream: Server;
let base = '';
let last: { method: string; path: string; auth: string; body: Record<string, unknown> } | null = null;
let answerType = 'audio/mpeg';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-tts-openai-'));
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      last = { method: req.method ?? '', path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: raw ? JSON.parse(raw) : {} };
      if (req.url === '/v1/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ voice_id: 'v1', name: '晓晓', lang: 'zh' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': answerType });
      res.end(Buffer.from('AUDIO:' + String(last.body.input ?? '')));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const address = upstream.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function service(patch: Partial<ReturnType<typeof settingsDefaults<'tts'>>>): TtsService {
  const config = { dataDir: root } as AppConfig;
  return new TtsService(config, { ...settingsDefaults('tts'), enabled: true, protocol: 'openai', url: base, token: 'sk-test', cacheMaxBytes: 0, ...patch });
}

test('posts an OpenAI speech request to <base>/audio/speech', async () => {
  answerType = 'audio/mpeg';
  const audio = await service({ model: 'gpt-4o-mini-tts' }).synthesize({ text: '你好', voice: 'nova', speed: 1.5, format: 'audio/ogg' });
  assert.equal(last?.method, 'POST');
  assert.equal(last?.path, '/v1/audio/speech');
  assert.equal(last?.auth, 'Bearer sk-test');
  assert.deepEqual(last?.body, { model: 'gpt-4o-mini-tts', input: '你好', voice: 'nova', response_format: 'opus', speed: 1.5 });
  assert.equal(Buffer.from(audio.bytes).toString(), 'AUDIO:你好');
});

test('accepts a full endpoint URL and fills model, voice and format defaults', async () => {
  answerType = 'application/octet-stream';
  const audio = await service({ url: base + '/audio/speech' }).synthesize({ text: '测试' });
  assert.equal(last?.path, '/v1/audio/speech');
  assert.deepEqual(last?.body, { model: 'tts-1', input: '测试', voice: 'alloy', response_format: 'mp3', speed: 1 });
  assert.equal(audio.contentType, 'audio/mpeg');
});

test('voice list: endpoint, then configured list, then OpenAI built-ins', async () => {
  assert.deepEqual(await service({ voicesUrl: base + '/voices' }).voices(), [{ id: 'v1', name: '晓晓', lang: 'zh' }]);
  assert.deepEqual(await service({ voiceList: 'a|甲\n\nb\na|重复' }).voices(), [{ id: 'a', name: '甲', lang: '' }, { id: 'b', name: 'b', lang: '' }]);
  const builtIn = await service({}).voices();
  assert.ok(builtIn.some((voice) => voice.id === 'alloy'));
});

test('query protocol is unchanged and still uses the configured list as a fallback', async () => {
  const query = new TtsService({ dataDir: root } as AppConfig, { ...settingsDefaults('tts'), enabled: true, url: base.replace('/v1', '/missing'), voiceList: 'x|某音色', cacheMaxBytes: 0 });
  assert.deepEqual(await query.voices(), [{ id: 'x', name: '某音色', lang: '' }]);
});
