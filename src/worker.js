/*
 * Cloudflare Worker HTTP adapter for the preflight engine.
 *
 * Routes
 *   GET  /                    service metadata + usage
 *   GET  /health              liveness
 *   POST /preflight           check one or many pages
 *   GET  /preflight?org=&site=&path=   same, convenient for a browser or curl
 *
 * Designed for Workfront Fusion: every response carries a top-level
 * `status: "pass" | "fail" | "error"` so a Fusion router can branch on one
 * field without inspecting nested arrays.
 *
 * Auth
 *   - DA source is public on some sites and protected on others. Pass `token`
 *     in the body (or an Authorization header) when it is protected.
 *   - Set the API_KEY secret to require callers to authenticate to THIS service
 *     (`x-api-key` header). Without it the endpoint is open, which is fine for a
 *     read-only checker on public content but not much else.
 */

// Side-effect import: installs DOMParser before the engine parses anything.
import './dom.js';
import { checkPages, configuredTemplates, normalisePath } from './preflight.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-api-key, authorization',
  'access-control-max-age': '86400',
};

const json = (body, status = 200) => new Response(
  `${JSON.stringify(body, null, 2)}\n`,
  { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS } },
);

function unauthorised(env, request) {
  if (!env?.API_KEY) return null;
  const supplied = request.headers.get('x-api-key');
  if (supplied && supplied === env.API_KEY) return null;
  return json({ status: 'error', error: 'missing or invalid x-api-key' }, 401);
}

/** Collect request params from either a JSON body or the query string. */
async function readParams(request) {
  const url = new URL(request.url);
  const q = url.searchParams;

  let body = {};
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      try {
        body = await request.json();
      } catch {
        throw new Error('body is not valid JSON');
      }
    } else if (type.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(await request.text()));
    }
  }

  // Accept `path` (one) or `paths` (many, array or comma-separated).
  const rawPaths = body.paths ?? q.get('paths') ?? body.path ?? q.get('path');
  let paths = [];
  if (Array.isArray(rawPaths)) paths = rawPaths;
  else if (typeof rawPaths === 'string' && rawPaths.trim()) paths = rawPaths.split(',');

  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

  return {
    org: body.org ?? q.get('org') ?? undefined,
    site: body.site ?? q.get('site') ?? undefined,
    paths: paths.map((p) => String(p).trim()).filter(Boolean),
    token: body.token ?? q.get('token') ?? bearer ?? undefined,
  };
}

function usage(request) {
  const { origin } = new URL(request.url);
  return {
    service: 'da-preflight-checks',
    description: 'Template-aware preflight checks for AEM Edge Delivery pages authored in DA.',
    templatesConfigured: configuredTemplates(),
    endpoints: {
      'GET /health': 'liveness probe',
      'POST /preflight': 'body: { org, site, path | paths[], token? }',
      'GET /preflight': '?org=&site=&path= (or &paths=a,b)',
    },
    responseContract: {
      status: 'pass | fail | error  <- route on this',
      counts: '{ pages, passed, failed, errored }',
      'reports[]': '{ path, template, status, counts, results[], failures[] }',
    },
    example: `curl -X POST ${origin}/preflight -H 'content-type: application/json' `
      + '-d \'{"org":"cpilsworth","site":"one-azn-demo","path":"/index"}\'',
  };
}

async function handlePreflight(request, env) {
  const denied = unauthorised(env, request);
  if (denied) return denied;

  let params;
  try {
    params = await readParams(request);
  } catch (e) {
    return json({ status: 'error', error: e.message }, 400);
  }

  const org = params.org || env?.DEFAULT_ORG;
  const site = params.site || env?.DEFAULT_SITE;
  const token = params.token || env?.DA_TOKEN;

  const missing = [];
  if (!org) missing.push('org');
  if (!site) missing.push('site');
  if (!params.paths.length) missing.push('path (or paths)');
  if (missing.length) {
    return json({
      status: 'error',
      error: `missing required parameter(s): ${missing.join(', ')}`,
      hint: 'POST { "org": "...", "site": "...", "path": "/index" }',
    }, 400);
  }

  // Bound the batch: a Worker has a CPU budget, and an unbounded list from an
  // automation is a denial-of-service on both this service and DA.
  const MAX_PAGES = Number(env?.MAX_PAGES ?? 50);
  if (params.paths.length > MAX_PAGES) {
    return json({
      status: 'error',
      error: `too many paths: ${params.paths.length} (max ${MAX_PAGES})`,
    }, 400);
  }

  const result = await checkPages({
    org, site, token, paths: params.paths.map(normalisePath),
  });

  // 200 for both pass and fail: a non-compliant page is a successful answer, and
  // a 4xx would make Fusion's HTTP module treat it as a transport error and retry.
  return json(result);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (pathname === '/health') {
      return json({ status: 'pass', service: 'da-preflight-checks' });
    }

    if (pathname === '/' || pathname === '') {
      return json(usage(request));
    }

    if (pathname === '/preflight') {
      if (request.method !== 'POST' && request.method !== 'GET') {
        return json({ status: 'error', error: 'use GET or POST' }, 405);
      }
      try {
        return await handlePreflight(request, env);
      } catch (e) {
        // Never leak a stack trace to a caller.
        return json({ status: 'error', error: `unhandled: ${e.message}` }, 500);
      }
    }

    return json({ status: 'error', error: `no route for ${pathname}` }, 404);
  },
};
