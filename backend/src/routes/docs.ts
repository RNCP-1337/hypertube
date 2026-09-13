import type { FastifyInstance } from 'fastify';

interface RouteDoc {
  method: string;
  path: string;
  auth: 'none' | 'bearer' | 'bearer (owner)' | 'bearer (write scope)';
  summary: string;
  body?: string;
  returns: string;
}

const ROUTES: RouteDoc[] = [
  {
    method: 'GET',
    path: '/api/health',
    auth: 'none',
    summary: 'Service health and enabled integrations',
    returns: '{ status, database, sources, oauthProviders, languages }',
  },

  {
    method: 'POST',
    path: '/api/oauth/token',
    auth: 'none',
    summary: 'Issue an API access token (client_credentials, password, authorization_code, refresh_token)',
    body: 'grant_type, client_id, client_secret [, username, password | code, redirect_uri | refresh_token, scope]',
    returns: '{ access_token, token_type, expires_in, scope }',
  },
  {
    method: 'GET',
    path: '/api/oauth/authorize',
    auth: 'bearer',
    summary: 'Authorization-code consent step; redirects with ?code=',
    returns: '302 to redirect_uri',
  },

  {
    method: 'POST',
    path: '/api/auth/register',
    auth: 'none',
    summary: 'Create an account',
    body: 'username, email, firstName, lastName, password [, language]',
    returns: '201 { user, accessToken, expiresIn }',
  },
  {
    method: 'POST',
    path: '/api/auth/login',
    auth: 'none',
    summary: 'Sign in with a username or e-mail address',
    body: 'username, password',
    returns: '{ user, accessToken, expiresIn }',
  },
  {
    method: 'POST',
    path: '/api/auth/refresh',
    auth: 'none',
    summary: 'Rotate the refresh cookie and issue a new access token',
    returns: '{ user, accessToken, expiresIn }',
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'none',
    summary: 'Revoke the current session',
    returns: '204',
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password',
    auth: 'none',
    summary: 'Send a password-reset e-mail',
    body: 'email',
    returns: '{ message }',
  },
  {
    method: 'POST',
    path: '/api/auth/reset-password',
    auth: 'none',
    summary: 'Consume a reset token and set a new password',
    body: 'token, password',
    returns: '{ message }',
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    auth: 'bearer',
    summary: 'Current session and linked OmniAuth providers',
    returns: '{ user, providers }',
  },
  {
    method: 'GET',
    path: '/api/auth/providers',
    auth: 'none',
    summary: 'OmniAuth strategies configured on this instance',
    returns: '{ providers: [{ id, label }] }',
  },
  {
    method: 'GET',
    path: '/api/auth/oauth/:provider',
    auth: 'none',
    summary: 'Start an OmniAuth flow (42, google, github, discord)',
    returns: '302 to the provider',
  },

  {
    method: 'GET',
    path: '/api/users',
    auth: 'bearer',
    summary: 'List users with their id and username',
    returns: '{ users: [{ id, username, profilePictureUrl }] }',
  },
  {
    method: 'GET',
    path: '/api/users/:id',
    auth: 'bearer',
    summary: 'A profile; the e-mail is only returned to its owner',
    returns: '{ user }',
  },
  {
    method: 'PATCH',
    path: '/api/users/:id',
    auth: 'bearer (owner)',
    summary: 'Update your own profile; 403 for anyone else',
    body: 'username, email, password, firstName, lastName, language, profilePictureUrl',
    returns: '{ user }',
  },
  {
    method: 'POST',
    path: '/api/users/:id/avatar',
    auth: 'bearer (owner)',
    summary: 'Upload a profile picture (multipart, max 5 MB, re-encoded server side)',
    returns: '{ profilePictureUrl }',
  },

  {
    method: 'GET',
    path: '/api/movies',
    auth: 'none',
    summary: 'Front page / library: search, sort, filter, paginate',
    body: 'query: search, page, perPage, sort, order, genre, yearMin, yearMax, ratingMin',
    returns: '{ movies, page, perPage, hasMore, sources }',
  },
  {
    method: 'GET',
    path: '/api/movies/genres',
    auth: 'none',
    summary: 'Genre values available to the filter',
    returns: '{ genres }',
  },
  {
    method: 'GET',
    path: '/api/movies/:id',
    auth: 'bearer',
    summary: 'Everything collected about a movie',
    returns: '{ movie }',
  },
  {
    method: 'POST',
    path: '/api/movies',
    auth: 'bearer (write scope)',
    summary: 'Register a movie manually (bonus)',
    body: 'title, year?, summary?, coverUrl?, genres?, quality?, magnetUri or torrentUrl',
    returns: '{ movie }',
  },
  {
    method: 'DELETE',
    path: '/api/movies/:id',
    auth: 'bearer (write scope)',
    summary: 'Remove a movie, its torrents and any downloaded files (bonus)',
    returns: '204 No Content',
  },
  {
    method: 'POST',
    path: '/api/movies/:id/play',
    auth: 'bearer',
    summary: 'Start the torrent in the background',
    body: 'torrentId (optional, to pick a resolution)',
    returns: '{ infoHash, status, streamUrl }',
  },
  {
    method: 'GET',
    path: '/api/movies/:id/status',
    auth: 'bearer',
    summary: 'Download progress, peers and readiness',
    returns: '{ started, status, progress, downloadedBytes, totalBytes, peers }',
  },
  {
    method: 'GET',
    path: '/api/movies/:id/stream',
    auth: 'bearer',
    summary: 'The video, with byte ranges; non-native containers are transcoded on the fly',
    body: 'query: resolution? (2160/1440/1080/720/480/360/240, bonus - forces a re-encode)',
    returns: '206 video/mp4',
  },
  {
    method: 'GET',
    path: '/api/movies/:id/subtitles/:language',
    auth: 'bearer',
    summary: 'A WebVTT subtitle track',
    returns: 'text/vtt',
  },
  {
    method: 'POST',
    path: '/api/movies/:id/progress',
    auth: 'bearer',
    summary: 'Record playback position; marks the movie as watched',
    body: 'positionSec, completed',
    returns: '204',
  },

  {
    method: 'GET',
    path: '/api/comments',
    auth: 'bearer',
    summary: 'Latest comments with author, date, content and id',
    returns: '{ comments, hasMore }',
  },
  {
    method: 'GET',
    path: '/api/comments/:id',
    auth: 'bearer',
    summary: 'One comment',
    returns: '{ comment }',
  },
  {
    method: 'POST',
    path: '/api/comments',
    auth: 'bearer (write scope)',
    summary: 'Post a comment',
    body: 'content, movieId',
    returns: '201 { comment }',
  },
  {
    method: 'PATCH',
    path: '/api/comments/:id',
    auth: 'bearer (write scope)',
    summary: 'Edit your own comment',
    body: 'content',
    returns: '{ comment }',
  },
  {
    method: 'DELETE',
    path: '/api/comments/:id',
    auth: 'bearer (write scope)',
    summary: 'Delete your own comment',
    returns: '204',
  },
  {
    method: 'GET',
    path: '/api/movies/:movieId/comments',
    auth: 'bearer',
    summary: 'Comments of one movie',
    returns: '{ comments, hasMore }',
  },
  {
    method: 'POST',
    path: '/api/movies/:movieId/comments',
    auth: 'bearer (write scope)',
    summary: 'Post a comment on a movie',
    body: 'content',
    returns: '201 { comment }',
  },
];

const STATUS_CODES = [
  ['200 / 201 / 204', 'success, with or without a body'],
  ['206', 'partial content - a byte range of the video'],
  ['302', 'OAuth redirect'],
  ['400', 'malformed request'],
  ['401', 'missing or invalid access token'],
  ['403', 'authenticated, but not allowed (another user\'s profile or comment)'],
  ['404', 'unknown route or resource'],
  ['409', 'username or e-mail already taken'],
  ['422', 'validation failed - the response lists the offending fields'],
  ['429', 'rate limit exceeded'],
  ['503', 'still buffering - retry after the indicated delay'],
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(): string {
  const rows = ROUTES.map(
    (r) => `<tr>
      <td><code class="m m-${r.method.toLowerCase()}">${r.method}</code></td>
      <td><code>${escapeHtml(r.path)}</code></td>
      <td>${escapeHtml(r.auth)}</td>
      <td>${escapeHtml(r.summary)}${r.body ? `<br><small>body: ${escapeHtml(r.body)}</small>` : ''}</td>
      <td><code>${escapeHtml(r.returns)}</code></td>
    </tr>`,
  ).join('');

  const codes = STATUS_CODES.map(
    ([code, meaning]) => `<tr><td><code>${escapeHtml(code)}</code></td><td>${escapeHtml(meaning)}</td></tr>`,
  ).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hypertube API</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px 20px; background:#0d1117; color:#e6edf3;
         font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:1100px; margin:0 auto; }
  h1 { margin:0 0 4px; font-size:26px; }
  h2 { margin:36px 0 12px; font-size:18px; color:#f0f6fc; }
  p { color:#8b949e; margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid #21262d; vertical-align:top; }
  th { color:#8b949e; font-weight:600; font-size:13px; text-transform:uppercase; letter-spacing:.04em; }
  code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; background:#161b22;
         border:1px solid #30363d; border-radius:5px; padding:1px 6px; }
  small { color:#8b949e; }
  .m { font-weight:700; border:0; background:transparent; padding:0; }
  .m-get{color:#3fb950}.m-post{color:#58a6ff}.m-patch{color:#d29922}.m-delete{color:#f85149}
  pre { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:14px; overflow-x:auto; }
</style>
</head><body><main>
<h1>Hypertube REST API</h1>
<p>OAuth2 bearer authentication. Obtain a token with <code>POST /api/oauth/token</code>, then send
<code>Authorization: Bearer &lt;token&gt;</code>. Any route not listed here returns <code>404</code>.</p>

<h2>Getting a token</h2>
<pre>curl -X POST http://localhost:8080/api/oauth/token \\
  -H 'Content-Type: application/json' \\
  -d '{"grant_type":"client_credentials","client_id":"...","client_secret":"..."}'</pre>

<h2>Endpoints</h2>
<table>
  <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th><th>Returns</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<h2>Status codes</h2>
<table><tbody>${codes}</tbody></table>
</main></body></html>`;
}

export async function docsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      reply.header('Content-Type', 'text/html; charset=utf-8').send(renderHtml());
      return;
    }
    reply.send({
      name: 'Hypertube API',
      version: '1.0.0',
      authentication: 'OAuth2 bearer token from POST /api/oauth/token',
      grants: ['client_credentials', 'password', 'authorization_code', 'refresh_token'],
      scopes: ['read', 'write'],
      routes: ROUTES,
      statusCodes: Object.fromEntries(STATUS_CODES),
    });
  });
}
