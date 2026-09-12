import { config } from '../config';
import { fetchJson } from '../lib/http';

export interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  username: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface OAuthProvider {
  id: string;
  label: string;
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  fetchProfile(accessToken: string): Promise<OAuthProfile>;
}

function splitName(full: string | null | undefined, fallback: string): [string, string] {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [fallback, fallback];
  if (parts.length === 1) return [parts[0], parts[0]];
  return [parts[0], parts.slice(1).join(' ')];
}

function sanitiseName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^\p{L}\p{M}\s'-]/gu, '').trim().slice(0, 50);
  return cleaned.length >= 1 ? cleaned : fallback;
}

interface FortyTwoUser {
  id: number;
  login: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  image?: { link?: string; versions?: { medium?: string } };
}

const fortyTwo: OAuthProvider = {
  id: '42',
  label: '42',
  clientId: config.OAUTH_42_CLIENT_ID,
  clientSecret: config.OAUTH_42_CLIENT_SECRET,
  authorizeUrl: 'https://api.intra.42.fr/oauth/authorize',
  tokenUrl: 'https://api.intra.42.fr/oauth/token',
  scope: 'public',
  async fetchProfile(accessToken) {
    const user = await fetchJson<FortyTwoUser>('https://api.intra.42.fr/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return {
      providerUserId: String(user.id),
      email: user.email ?? null,
      username: user.login,
      firstName: sanitiseName(user.first_name ?? user.login, user.login),
      lastName: sanitiseName(user.last_name ?? user.login, user.login),
      avatarUrl: user.image?.versions?.medium ?? user.image?.link ?? null,
    };
  },
};

interface GoogleUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

const google: OAuthProvider = {
  id: 'google',
  label: 'Google',
  clientId: config.OAUTH_GOOGLE_CLIENT_ID,
  clientSecret: config.OAUTH_GOOGLE_CLIENT_SECRET,
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  async fetchProfile(accessToken) {
    const user = await fetchJson<GoogleUser>('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const [first, last] = splitName(user.name, user.email?.split('@')[0] ?? 'user');
    return {
      providerUserId: user.sub,
      email: user.email ?? null,
      username: user.email?.split('@')[0] ?? `google${user.sub.slice(0, 8)}`,
      firstName: sanitiseName(user.given_name ?? first, 'User'),
      lastName: sanitiseName(user.family_name ?? last, 'User'),
      avatarUrl: user.picture ?? null,
    };
  },
};

interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
}

const github: OAuthProvider = {
  id: 'github',
  label: 'GitHub',
  clientId: config.OAUTH_GITHUB_CLIENT_ID,
  clientSecret: config.OAUTH_GITHUB_CLIENT_SECRET,
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scope: 'read:user user:email',
  async fetchProfile(accessToken) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    };
    const user = await fetchJson<GitHubUser>('https://api.github.com/user', { headers });

    // GitHub hides the address unless it is public; ask the dedicated endpoint.
    let email = user.email ?? null;
    if (!email) {
      const emails = await fetchJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
        'https://api.github.com/user/emails',
        { headers },
      ).catch(() => []);
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }

    const [first, last] = splitName(user.name, user.login);
    return {
      providerUserId: String(user.id),
      email,
      username: user.login,
      firstName: sanitiseName(first, user.login),
      lastName: sanitiseName(last, user.login),
      avatarUrl: user.avatar_url ?? null,
    };
  },
};

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  email?: string | null;
  verified?: boolean;
  avatar?: string | null;
}

const discord: OAuthProvider = {
  id: 'discord',
  label: 'Discord',
  clientId: config.OAUTH_DISCORD_CLIENT_ID,
  clientSecret: config.OAUTH_DISCORD_CLIENT_SECRET,
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  scope: 'identify email',
  async fetchProfile(accessToken) {
    const user = await fetchJson<DiscordUser>('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const [first, last] = splitName(user.global_name, user.username);
    return {
      providerUserId: user.id,
      email: user.verified ? (user.email ?? null) : null,
      username: user.username,
      firstName: sanitiseName(first, user.username),
      lastName: sanitiseName(last, user.username),
      avatarUrl: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`
        : null,
    };
  },
};

const ALL: OAuthProvider[] = [fortyTwo, google, github, discord];

export function getProvider(id: string): OAuthProvider | null {
  const provider = ALL.find((p) => p.id === id);
  if (!provider || !provider.clientId || !provider.clientSecret) return null;
  return provider;
}

export function availableProviders(): Array<{ id: string; label: string }> {
  return ALL.filter((p) => p.clientId && p.clientSecret).map(({ id, label }) => ({ id, label }));
}

export function redirectUri(providerId: string): string {
  return `${config.PUBLIC_URL}/api/auth/oauth/${providerId}/callback`;
}

export function buildAuthorizeUrl(provider: OAuthProvider, state: string): string {
  const params = new URLSearchParams({
    client_id: provider.clientId as string,
    redirect_uri: redirectUri(provider.id),
    response_type: 'code',
    scope: provider.scope,
    state,
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(provider: OAuthProvider, code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: provider.clientId as string,
    client_secret: provider.clientSecret as string,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(provider.id),
  });

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'Hypertube/1.0',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`${provider.id} token exchange failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string; error?: string };
  if (!payload.access_token) {
    throw new Error(`${provider.id} did not return an access token`);
  }
  return payload.access_token;
}
