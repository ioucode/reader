import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../http/context.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import type { BusinessValues } from './business-settings.ts';
import type { UserRow } from './users.ts';

/**
 * OpenID Connect sign-in (authorization code + PKCE, confidential client).
 *
 * ## Shape of the flow
 *
 *  1. The login page sends the browser to `GET /api/v1/auth/oidc/start`; the
 *     server remembers `state` → (nonce, PKCE verifier) and redirects to the
 *     provider's authorization endpoint.
 *  2. The provider redirects back to `GET /api/v1/auth/oidc/callback`. The server
 *     exchanges the code over its own TLS connection, checks the ID token claims,
 *     maps the identity to a local account and stores a short-lived one-time
 *     hand-off code.
 *  3. The browser lands on `<publicUrl>/#/?oidc_code=…`; the web client trades
 *     that code for an ordinary reader session (`POST /api/v1/auth/oidc/exchange`).
 *
 * The session itself is the same access/refresh pair a password login returns,
 * so nothing else in the app (sync, assets, Android) needs to know OIDC exists.
 * Reader tokens never appear in a URL: only the one-time code does, and it is
 * useless after one exchange or two minutes.
 *
 * ## Why the ID token signature is not checked
 *
 * The token comes straight from the token endpoint over a TLS connection the
 * server opened itself, which OIDC Core §3.1.3.7 (6) accepts in place of signature
 * validation. Issuer, audience, expiry and nonce are still checked.
 *
 * ## Account mapping
 *
 * An identity is keyed by (issuer, sub) in `oidc_identities`. The first sign-in
 * finds its account through the administrator's explicit `userMap`
 * (`oidc-name=local-name`) or, when allowed, creates a member account. A local
 * account is never claimed just because its username happens to match: that
 * would let whoever controls the provider's usernames take over any account.
 *
 * State lives in memory: the deployment runs one replica, and a restart only
 * costs an in-flight sign-in a retry.
 */

const STATE_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 2 * 60_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const MAX_PENDING = 500;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

type OidcSettings = BusinessValues['oidc'];

export class OidcService {
  private readonly pending = new Map<string, { nonce: string; verifier: string; createdAt: number }>();
  private readonly handoffs = new Map<string, { userId: string; createdAt: number }>();
  private discovery: { key: string; doc: Discovery; at: number } | null = null;

  constructor(private readonly ctx: AppContext, private readonly fetcher: typeof fetch = fetch) {}

  private settings(): OidcSettings {
    return this.ctx.settings!.read('oidc');
  }

  redirectUri(): string {
    const base = this.ctx.config.publicUrl.replace(/\/+$/, '');
    return base ? `${base}/api/v1/auth/oidc/callback` : '';
  }

  /** What the login page needs; never includes the client secret. */
  publicInfo(): { enabled: boolean; label: string; passwordLogin: boolean } {
    const s = this.settings();
    const enabled = s.enabled && !!s.issuer && !!s.clientId && !!this.redirectUri();
    return { enabled, label: s.buttonLabel || '使用统一认证登录', passwordLogin: !enabled || s.passwordLogin };
  }

  /** Fetches (and caches) the provider metadata; also the admin "测试连接". */
  async discover(s: OidcSettings = this.settings(), force = false): Promise<Discovery> {
    const issuer = s.issuer.trim();
    if (!issuer) throw badRequest('请填写 Issuer 地址');
    const key = issuer;
    if (!force && this.discovery && this.discovery.key === key && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.doc;
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    let doc: Discovery;
    try {
      const response = await this.fetcher(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(String(response.status));
      doc = (await response.json()) as Discovery;
    } catch {
      throw new AppError(502, 'OIDC_DISCOVERY', '无法读取 OIDC 发现文档，请检查 Issuer 地址');
    }
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) throw new AppError(502, 'OIDC_DISCOVERY', 'OIDC 发现文档缺少必要字段');
    if (trimSlash(doc.issuer) !== trimSlash(issuer)) throw new AppError(502, 'OIDC_DISCOVERY', 'OIDC 发现文档的 issuer 与配置不一致');
    this.discovery = { key, doc, at: Date.now() };
    return doc;
  }

  /** Step 1: the provider URL to send the browser to. */
  async start(): Promise<string> {
    const s = this.settings();
    if (!this.publicInfo().enabled) throw badRequest('OIDC 登录未启用', 'OIDC_DISABLED');
    const doc = await this.discover(s);
    this.sweep();
    if (this.pending.size >= MAX_PENDING) throw new AppError(429, 'OIDC_BUSY', '登录请求过多，请稍后再试');
    const state = token(), nonce = token(), verifier = token(48);
    this.pending.set(state, { nonce, verifier, createdAt: Date.now() });
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', s.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', s.scopes.trim() || 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Step 2: provider callback → one-time hand-off code. */
  async callback(query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<string> {
    if (query.error) throw badRequest(`认证服务拒绝了登录：${query.error_description || query.error}`, 'OIDC_DENIED');
    const pending = query.state ? this.pending.get(query.state) : undefined;
    if (query.state) this.pending.delete(query.state);
    if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) throw badRequest('登录请求已过期，请重新登录', 'OIDC_STATE');
    if (!query.code) throw badRequest('认证服务未返回授权码', 'OIDC_CODE');
    const s = this.settings();
    const doc = await this.discover(s);
    const tokens = await this.exchangeCode(s, doc, query.code, pending.verifier);
    const claims = this.checkIdToken(s, doc, tokens.id_token, pending.nonce);
    if (doc.userinfo_endpoint && tokens.access_token) {
      const info = await this.userinfo(doc.userinfo_endpoint, tokens.access_token);
      if (info && info['sub'] === claims['sub']) for (const [key, value] of Object.entries(info)) if (claims[key] === undefined) claims[key] = value;
    }
    const user = await this.resolveUser(s, doc.issuer, claims);
    this.sweep();
    const code = token();
    this.handoffs.set(code, { userId: user.id, createdAt: Date.now() });
    return code;
  }

  /** Step 3: one-time code → reader session. */
  exchange(code: unknown, device: string) {
    if (typeof code !== 'string' || !code) throw badRequest('缺少登录凭证', 'OIDC_HANDOFF');
    const entry = this.handoffs.get(code);
    this.handoffs.delete(code);
    if (!entry || Date.now() - entry.createdAt > HANDOFF_TTL_MS) throw new AppError(401, 'OIDC_HANDOFF', '登录凭证已失效，请重新登录');
    const row = this.ctx.users.byId(entry.userId);
    if (!row || row.disabled === 1) throw new AppError(403, 'ACCOUNT_DISABLED', '账号已停用');
    return this.ctx.users.issueSession(row, device);
  }

  private async exchangeCode(s: OidcSettings, doc: Discovery, code: string, verifier: string): Promise<{ id_token?: string; access_token?: string }> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(), code_verifier: verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (s.clientSecret && methods.includes('client_secret_basic')) {
      headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString('base64');
    } else {
      body.set('client_id', s.clientId);
      if (s.clientSecret) body.set('client_secret', s.clientSecret);
    }
    let response: Response;
    try {
      response = await this.fetcher(doc.token_endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new AppError(502, 'OIDC_TOKEN', '无法连接认证服务换取令牌');
    }
    if (!response.ok) throw new AppError(502, 'OIDC_TOKEN', `认证服务换取令牌失败（HTTP ${response.status}）`);
    return (await response.json()) as { id_token?: string; access_token?: string };
  }

  private checkIdToken(s: OidcSettings, doc: Discovery, idToken: string | undefined, nonce: string): Record<string, unknown> {
    if (!idToken) throw new AppError(502, 'OIDC_TOKEN', '认证服务未返回 ID Token');
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new AppError(502, 'OIDC_TOKEN', 'ID Token 格式无效');
    }
    const audience = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
    const now = Date.now() / 1000;
    if (claims['iss'] !== doc.issuer) throw new AppError(401, 'OIDC_CLAIMS', 'ID Token 的签发者不匹配');
    if (!audience.includes(s.clientId)) throw new AppError(401, 'OIDC_CLAIMS', 'ID Token 的受众不匹配');
    if (audience.length > 1 && claims['azp'] !== undefined && claims['azp'] !== s.clientId) throw new AppError(401, 'OIDC_CLAIMS', 'ID Token 的授权方不匹配');
    if (typeof claims['exp'] !== 'number' || claims['exp'] < now - 60) throw new AppError(401, 'OIDC_CLAIMS', 'ID Token 已过期');
    if (claims['nonce'] !== nonce) throw new AppError(401, 'OIDC_CLAIMS', 'ID Token 的 nonce 不匹配');
    if (typeof claims['sub'] !== 'string' || !claims['sub']) throw new AppError(401, 'OIDC_CLAIMS', 'ID Token 缺少 sub');
    return claims;
  }

  private async userinfo(endpoint: string, accessToken: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.fetcher(endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async resolveUser(s: OidcSettings, issuer: string, claims: Record<string, unknown>): Promise<UserRow> {
    const db = this.ctx.db, subject = String(claims['sub']);
    const claimed = claims[s.usernameClaim.trim() || 'preferred_username'];
    const oidcName = typeof claimed === 'string' ? claimed.trim() : '';
    let row: UserRow | undefined;
    const link = db.get<{ user_id: string }>('SELECT user_id FROM oidc_identities WHERE issuer = ? AND subject = ?', issuer, subject);
    if (link) {
      row = this.ctx.users.byId(link.user_id);
      if (!row) db.run('DELETE FROM oidc_identities WHERE issuer = ? AND subject = ?', issuer, subject);
    }
    if (!row) {
      if (!oidcName) throw new AppError(403, 'OIDC_NO_USERNAME', `认证服务未提供用户名声明 ${s.usernameClaim}`);
      const target = parseUserMap(s.userMap).get(oidcName.toLowerCase());
      if (target) {
        row = db.get<UserRow>('SELECT * FROM users WHERE username = ? COLLATE NOCASE', target);
        if (!row) throw new AppError(403, 'OIDC_NOT_LINKED', `对应的本地账号 ${target} 不存在`);
      } else if (s.autoCreate) {
        const username = oidcName.slice(0, 100);
        if (username.length < 3) throw new AppError(403, 'OIDC_NOT_LINKED', '用户名过短，无法自动创建账号');
        if (db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', username)) {
          throw new AppError(403, 'OIDC_NOT_LINKED', `本地已有账号 ${username}，请管理员在「账号对应关系」中关联后再登录`);
        }
        const displayName = typeof claims['name'] === 'string' ? claims['name'].slice(0, 100) : '';
        const created = await this.ctx.users.create({ username, password: randomBytes(32).toString('hex'), displayName, role: 'member' });
        row = this.ctx.users.byId(created.id)!;
      } else {
        throw new AppError(403, 'OIDC_NOT_LINKED', `统一认证账号 ${oidcName} 尚未对应本地账号，请联系管理员`);
      }
      const owner = db.get<{ issuer: string }>('SELECT issuer FROM oidc_identities WHERE user_id = ? AND issuer = ?', row.id, issuer);
      if (owner) throw new AppError(403, 'OIDC_NOT_LINKED', '该本地账号已关联其他统一认证身份');
      db.run('INSERT INTO oidc_identities (issuer, subject, user_id, created_at) VALUES (?,?,?,?)', issuer, subject, row.id, Date.now());
    }
    if (row.disabled === 1) throw new AppError(403, 'ACCOUNT_DISABLED', '账号已停用');
    const groups = Array.isArray(claims['groups']) ? claims['groups'].map(String) : [];
    if (s.adminGroup.trim() && groups.includes(s.adminGroup.trim()) && row.role !== 'admin') {
      this.ctx.users.setRole(row.id, 'admin');
      row = this.ctx.users.byId(row.id)!;
    }
    return row;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.pending) if (now - value.createdAt > STATE_TTL_MS) this.pending.delete(key);
    for (const [key, value] of this.handoffs) if (now - value.createdAt > HANDOFF_TTL_MS) this.handoffs.delete(key);
  }
}

/** `oidc-name=local-name` per line; keys are case-insensitive. */
export function parseUserMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const from = line.slice(0, index).trim().toLowerCase(), to = line.slice(index + 1).trim();
    if (from && to) map.set(from, to);
  }
  return map;
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
