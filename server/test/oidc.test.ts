/**
 * OIDC single sign-on against a stub provider.
 *
 * Covers the whole round trip (start → callback → one-time hand-off → session)
 * and the account-mapping rules that matter for security: an unmapped identity
 * is refused unless auto-create is on, and a local account is never claimed just
 * because its username matches.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config/index.ts';
import { openDatabase, type Db } from '../src/db/index.ts';
import { UserService } from '../src/services/users.ts';
import { BusinessSettings } from '../src/services/business-settings.ts';
import { OidcService, parseUserMap } from '../src/services/oidc.ts';
import type { AppContext } from '../src/http/context.ts';

let root = '';
let provider: Server;
let issuer = '';
let db: Db;
let ctx: AppContext;
/** Claims the stub puts in the next ID token; `nonce` is filled from the authorize request. */
let nextClaims: Record<string, unknown> = {};
let lastNonce = '';
let lastTokenRequest: { auth: string; body: URLSearchParams } | null = null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-oidc-test-'));
  await mkdir(join(root, 'books'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  process.env.BOOKS_DIR = join(root, 'books');
  process.env.DATA_DIR = join(root, 'data');
  process.env.SCAN_INTERVAL = '0';
  process.env.WATCH_INTERVAL = '0';
  process.env.READER_TOKEN_SECRET = 'test-secret-that-is-long-enough';

  provider = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (url.pathname === '/o/reader/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`,
          userinfo_endpoint: `${issuer}userinfo`, token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }));
        return;
      }
      if (url.pathname === '/o/reader/token') {
        lastTokenRequest = { auth: String(req.headers.authorization ?? ''), body: new URLSearchParams(raw) };
        const payload = { iss: issuer, aud: 'reader-client', exp: Math.floor(Date.now() / 1000) + 300, nonce: lastNonce, ...nextClaims };
        const idToken = ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id_token: idToken, access_token: 'at' }));
        return;
      }
      if (url.pathname === '/o/reader/userinfo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sub: nextClaims['sub'], groups: ['readers'] }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', () => resolve()));
  const address = provider.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/o/reader/`;

  const config = loadConfig();
  config.publicUrl = 'https://book.example.com';
  db = openDatabase(config);
  const settings = new BusinessSettings(db, config);
  ctx = { config, db, settings, users: new UserService(db, config) } as unknown as AppContext;
  await ctx.users.create({ username: 'admin', password: 'password123' });
  await ctx.users.create({ username: 'alice', password: 'password123' });
  configure({});
});

after(async () => {
  db?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function configure(patch: Record<string, unknown>): void {
  const settings = ctx.settings!;
  settings.save('oidc', { enabled: true, issuer, clientId: 'reader-client', clientSecret: 's3cret', userMap: 'akadmin=admin', autoCreate: false, ...patch }, settings.view('oidc').revision);
}

/** Runs start → callback and returns the hand-off code (or the thrown error). */
async function signIn(service: OidcService, claims: Record<string, unknown>): Promise<string> {
  const authorize = new URL(await service.start());
  lastNonce = authorize.searchParams.get('nonce') ?? '';
  nextClaims = claims;
  return service.callback({ code: 'auth-code', state: authorize.searchParams.get('state') ?? '' });
}

test('authorize URL carries PKCE, state, nonce and the public callback', async () => {
  const service = new OidcService(ctx);
  const url = new URL(await service.start());
  assert.equal(url.origin + url.pathname, `${issuer}authorize`);
  assert.equal(url.searchParams.get('client_id'), 'reader-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://book.example.com/api/v1/auth/oidc/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state') && url.searchParams.get('nonce'));
  assert.deepEqual(service.publicInfo(), { enabled: true, label: '使用统一认证登录', passwordLogin: true });
});

test('mapped identity signs in as the local account, once per hand-off code', async () => {
  const service = new OidcService(ctx);
  const code = await signIn(service, { sub: 'sub-akadmin', preferred_username: 'akadmin' });
  assert.equal(lastTokenRequest?.auth, 'Basic ' + Buffer.from('reader-client:s3cret').toString('base64'));
  assert.ok(lastTokenRequest?.body.get('code_verifier'));
  const session = service.exchange(code, 'test');
  assert.equal(session.user.username, 'admin');
  assert.ok(session.accessToken && session.refreshToken);
  assert.throws(() => service.exchange(code, 'test'), /失效/);
  // The link is by sub from now on, even if the username claim changes.
  const again = await signIn(service, { sub: 'sub-akadmin', preferred_username: 'renamed' });
  assert.equal(service.exchange(again, 'test').user.username, 'admin');
});

test('unmapped identity is refused, and a matching local username is not claimed', async () => {
  const service = new OidcService(ctx);
  await assert.rejects(signIn(service, { sub: 'sub-x', preferred_username: 'stranger' }), /尚未对应本地账号/);
  configure({ autoCreate: true });
  await assert.rejects(signIn(service, { sub: 'sub-alice', preferred_username: 'alice' }), /本地已有账号/);
  const code = await signIn(service, { sub: 'sub-bob', preferred_username: 'bob', name: 'Bob' });
  const session = service.exchange(code, 'test');
  assert.equal(session.user.username, 'bob');
  assert.equal(session.user.role, 'member');
  configure({ autoCreate: false });
});

test('admin group promotes, and bad nonce / state are rejected', async () => {
  configure({ adminGroup: 'readers', autoCreate: true });
  const service = new OidcService(ctx);
  const code = await signIn(service, { sub: 'sub-carol', preferred_username: 'carol' });
  assert.equal(service.exchange(code, 'test').user.role, 'admin');
  await assert.rejects(service.callback({ code: 'x', state: 'unknown' }), /过期/);
  const authorize = new URL(await service.start());
  lastNonce = 'wrong';
  nextClaims = { sub: 'sub-carol', preferred_username: 'carol' };
  await assert.rejects(service.callback({ code: 'x', state: authorize.searchParams.get('state')! }), /nonce/);
  configure({ adminGroup: '', autoCreate: false });
});

test('user map parsing', () => {
  assert.deepEqual([...parseUserMap('AkAdmin = admin\n# no\n=x\nbob=\nfoo=bar')], [['akadmin', 'admin'], ['foo', 'bar']]);
});
