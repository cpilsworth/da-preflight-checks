/*
 * Cloudflare Worker HTTP adapter for the preflight engine.
 *
 * Routes
 *   GET  /                                 service metadata + usage
 *   GET  /health                           liveness
 *   GET  /{org}/{site}/{path...}           check one page
 *   POST /{org}/{site}                     check many: body { paths: [...] }
 *   POST /{org}/{site}/{path...}           check one page
 *   GET  /{org}/{site}/_rules              show the rules this service resolved
 *
 * The org and site live in the path so a URL identifies a page the same way DA
 * and Edge Delivery do, and so one deployment serves every repo. Rules come from
 * the repo being checked (see rules-loader.js), not from this service.
 *
 * Designed for Workfront Fusion: every response carries a top-level
 * `status: "pass" | "fail" | "error"` so a Fusion router can branch on one field
 * without inspecting nested arrays.
 *
 * Auth
 *   - DA source is public on some sites and protected on others. Pass a DA token
 *     as `Authorization: Bearer ...`, or `token` in the body, when it is needed.
 *   - Set the API_KEY secret to require callers to authenticate to THIS service
 *     (`x-api-key` header). Without it the endpoint is open, which is fine for a
 *     read-only checker on public content but not much else.
 */

// Side-effect import: installs DOMParser before the engine parses anything.
import './dom.js';
import { checkPages, configuredTemplates, normalisePath } from './preflight.js';
import { loadRules, rulesUrls } from './rules-loader.js';

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

/* Reserved first segments, so they can never be mistaken for an org. */
const RESERVED = new Set(['', 'health', 'favicon.ico', 'robots.txt']);

function unauthorised(env, request) {
  if (!env?.API_KEY) return null;
  const supplied = request.headers.get('x-api-key');
  if (supplied && supplied === env.API_KEY) return null;
  return json({ status: 'error', error: 'missing or invalid x-api-key' }, 401);
}

/**
 * Split /{org}/{site}/{path...} into its parts.
 * A trailing `_rules` marks the rules-inspection route.
 */
export function parseRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [org, site, ...rest] = segments;
  const wantsRules = rest.length === 1 && rest[0] === '_rules';
  return {
    org,
    site,
    path: wantsRules || !rest.length ? '' : `/${rest.join('/')}`,
    wantsRules,
  };
}

/** Request params from the body, the query string, and headers. */
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

  const rawPaths = body.paths ?? q.get('paths');
  let paths = [];
  if (Array.isArray(rawPaths)) paths = rawPaths;
  else if (typeof rawPaths === 'string' && rawPaths.trim()) paths = rawPaths.split(',');

  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

  return {
    paths: paths.map((p) => String(p).trim()).filter(Boolean),
    token: body.token || q.get('token') || bearer || undefined,
    ref: body.ref || q.get('ref') || undefined,
  };
}

function usage(request) {
  const { origin } = new URL(request.url);
  return {
    service: 'da-preflight-checks',
    description: 'Template-aware preflight checks for AEM Edge Delivery pages authored in DA.',
    endpoints: {
      'GET /{org}/{site}/{path}': 'check one page',
      'POST /{org}/{site}': 'check many - body { "paths": ["/a", "/b"] }',
      'GET /{org}/{site}/_rules': 'show the rules resolved for that repo',
      'GET /health': 'liveness probe',
    },
    rules: {
      ownedBy: 'the repo being checked, not this service',
      publishAt: 'tools/preflight/preflight-rules.json',
      resolvedFrom: rulesUrls({ org: '{org}', site: '{site}' }),
      format: {
        'video-page': [{
          type: 'block-present | block-absent',
          name: 'embed',
          min: 1,
          max: 1,
          variants: ['optional'],
          severity: 'error | warning | info',
          title: 'shown to the author',
          hint: 'how to fix it',
        }],
      },
    },
    responseContract: {
      status: 'pass | fail | error  <- route on this',
      counts: '{ pages, passed, failed, errored }',
      'reports[]': '{ path, template, status, counts, results[], failures[] }',
    },
    examples: [
      `curl ${origin}/cpilsworth/one-azn-demo/index`,
      `curl -X POST ${origin}/cpilsworth/one-azn-demo -H 'content-type: application/json' `
        + '-d \'{"paths":["/index","/drafts/launch"]}\'',
    ],
  };
}

/** GET /{org}/{site}/_rules - lets a project debug its own rules file. */
async function handleRules(route, params) {
  const { org, site } = route;
  const loaded = await loadRules({ org, site, ref: params.ref });
  return json({
    status: loaded.warnings.length && !loaded.found ? 'error' : 'pass',
    org,
    site,
    rulesFound: loaded.found,
    rulesSource: loaded.source,
    searched: rulesUrls({ org, site, ref: params.ref || 'main' }),
    templatesConfigured: configuredTemplates(loaded.rules),
    checkCount: Object.values(loaded.rules).reduce((n, r) => n + r.length, 0),
    warnings: loaded.warnings,
    rules: loaded.rules,
  });
}

async function handlePreflight(request, env, route) {
  const denied = unauthorised(env, request);
  if (denied) return denied;

  let params;
  try {
    params = await readParams(request);
  } catch (e) {
    return json({ status: 'error', error: e.message }, 400);
  }

  const { org, site } = route;
  if (route.wantsRules) return handleRules(route, params);

  // A path in the URL, or a list in the body. Not both.
  let paths = params.paths.length ? params.paths : [];
  if (route.path) paths = [route.path, ...paths];
  if (!paths.length) {
    return json({
      status: 'error',
      error: 'no page specified',
      hint: `GET /${org}/${site}/index, or POST /${org}/${site} with { "paths": [...] }`,
    }, 400);
  }

  const MAX_PAGES = Number(env?.MAX_PAGES ?? 50);
  if (paths.length > MAX_PAGES) {
    return json({
      status: 'error',
      error: `too many paths: ${paths.length} (max ${MAX_PAGES})`,
    }, 400);
  }

  const token = params.token || env?.DA_TOKEN;
  const loaded = await loadRules({ org, site, ref: params.ref });

  const result = await checkPages({
    org, site, token, rules: loaded.rules, paths: paths.map(normalisePath),
  });

  // 200 for both pass and fail: a non-compliant page is a successful answer, and
  // a 4xx would make Fusion's HTTP module treat it as a transport error and retry.
  return json({
    ...result,
    rulesFound: loaded.found,
    rulesSource: loaded.source,
    templatesConfigured: configuredTemplates(loaded.rules),
    ...(loaded.warnings.length ? { rulesWarnings: loaded.warnings } : {}),
  });
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

    const first = pathname.split('/').filter(Boolean)[0] ?? '';
    if (RESERVED.has(first)) {
      return json({ status: 'error', error: `no route for ${pathname}` }, 404);
    }

    const route = parseRoute(pathname);
    if (!route) {
      return json({
        status: 'error',
        error: `no route for ${pathname}`,
        hint: 'expected /{org}/{site}/{path}',
      }, 404);
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ status: 'error', error: 'use GET or POST' }, 405);
    }

    try {
      return await handlePreflight(request, env, route);
    } catch (e) {
      // Never leak a stack trace to a caller.
      return json({ status: 'error', error: `unhandled: ${e.message}` }, 500);
    }
  },
};
