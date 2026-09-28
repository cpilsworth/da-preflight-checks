/*
 * Tests for the preflight service.
 *
 * Run: npm test
 *
 * Covers the service layer (path/URL handling, report shape, batch behaviour,
 * error mapping) and the Worker's HTTP contract. The check engine itself is
 * vendored from the DA plugin and has its own tests there; what matters here is
 * that the service wraps it faithfully.
 *
 * No test touches the network: fetch is stubbed throughout.
 */

import '../src/dom.js';
import { assert, test } from './harness.mjs';

let mods;
async function load() {
  if (mods) return mods;
  mods = {
    svc: await import('../src/preflight.js'),
    worker: (await import('../src/worker.js')).default,
  };
  return mods;
}

/* --- fixtures -------------------------------------------------------- */
const META = (tpl) => (tpl
  ? `<div class="metadata"><div><div>template</div><div>${tpl}</div></div></div>`
  : '');
const EMBED = '<div class="embed full-bleed"><div><div>v</div></div></div>';
const page = (inner) => `<body><main><div>${inner}</div></main></body>`;

/** A fetch stub serving a map of path -> html (or a status number). */
function stubFetch(map) {
  return async (url) => {
    const m = String(url).match(/\/source\/[^/]+\/[^/]+(.*)\.html$/);
    const key = m ? m[1] : '';
    const entry = map[key];
    if (entry === undefined) return { ok: false, status: 404 };
    if (typeof entry === 'number') return { ok: false, status: entry };
    return { ok: true, status: 200, text: async () => entry };
  };
}

const req = (path, { method = 'GET', body, headers = {} } = {}) => new Request(
  `https://svc.example${path}`,
  {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  },
);

/* --- path + url handling --------------------------------------------- */
test('normalisePath canonicalises author input', async () => {
  const { svc } = await load();
  assert.equal(svc.normalisePath('/index'), '/index');
  assert.equal(svc.normalisePath('index'), '/index');
  assert.equal(svc.normalisePath('/drafts/x.html'), '/drafts/x');
  assert.equal(svc.normalisePath('/drafts/x.HTML'), '/drafts/x');
  assert.equal(svc.normalisePath('  /a/b  '), '/a/b');
  assert.equal(svc.normalisePath('/'), '/index', 'root means index');
  assert.equal(svc.normalisePath(''), '/index');
  assert.equal(svc.normalisePath(undefined), '/index');
});

test('sourceUrl targets the DA Source API', async () => {
  const { svc } = await load();
  assert.equal(
    svc.sourceUrl({ org: 'o', site: 's', path: '/drafts/x' }),
    'https://admin.da.live/source/o/s/drafts/x.html',
  );
  assert.equal(
    svc.sourceUrl({ org: 'o', site: 's', path: '/' }),
    'https://admin.da.live/source/o/s/index.html',
  );
});

/* --- checkHtml: the report contract --------------------------------- */
test('checkHtml passes a compliant page', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(EMBED + META('video-page')), '/v');
  assert.equal(r.status, 'pass');
  assert.equal(r.template, 'video-page');
  assert.equal(r.counts.blocking, 0);
  assert.equal(r.counts.checks, 1);
  assert.deepEqual(r.blocks, ['embed']);
  assert.equal(r.failures.length, 0);
});

test('checkHtml fails a page missing a required block', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(META('video-page')), '/v');
  assert.equal(r.status, 'fail');
  assert.equal(r.counts.blocking, 1);
  assert.equal(r.failures[0].severity, 'error');
  assert.ok(r.failures[0].hint, 'a failure carries remediation guidance');
  assert.match(r.failures[0].detail, /No "embed" block found/);
});

test('a warning does not make the page fail', async () => {
  const { svc } = await load();
  // print-page forbids an embed, at warning severity.
  const r = svc.checkHtml(page(EMBED + META('print-page')), '/p');
  assert.equal(r.counts.failed, 1);
  assert.equal(r.counts.blocking, 0);
  assert.equal(r.status, 'pass', 'only errors block');
});

test('a page with no template reports as unconfigured, not failed', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(EMBED), '/index');
  assert.equal(r.status, 'pass');
  assert.equal(r.templateConfigured, false);
  assert.equal(r.counts.checks, 0);
});

test('results and failures stay consistent', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(META('campaign-page')), '/c');
  assert.equal(r.counts.checks, r.results.length);
  assert.equal(r.counts.failed, r.failures.length);
  assert.equal(r.counts.passed, r.results.filter((x) => x.passed).length);
});

/* --- checkPage: fetch + error mapping ------------------------------- */
test('checkPage reads a page from DA', async () => {
  const { svc } = await load();
  const r = await svc.checkPage(
    { org: 'o', site: 's', path: '/v' },
    { fetch: stubFetch({ '/v': page(EMBED + META('video-page')) }) },
  );
  assert.equal(r.status, 'pass');
  assert.equal(r.path, '/v');
});

test('checkPage maps HTTP failures to actionable errors', async () => {
  const { svc } = await load();
  const cases = [[404, /not found/], [401, /unauthorised/], [403, /forbidden/]];
  for (const [code, re] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await svc.checkPage(
      { org: 'o', site: 's', path: '/x' },
      { fetch: stubFetch({ '/x': code }) },
    );
    assert.equal(r.status, 'error');
    assert.equal(r.httpStatus, code);
    assert.match(r.error, re);
  }
});

test('a network throw is returned as data, not raised', async () => {
  const { svc } = await load();
  const r = await svc.checkPage(
    { org: 'o', site: 's', path: '/x' },
    { fetch: async () => { throw new Error('socket hang up'); } },
  );
  assert.equal(r.status, 'error');
  assert.match(r.error, /socket hang up/);
});

test('a token is sent as a Bearer header only when supplied', async () => {
  const { svc } = await load();
  const seen = [];
  const spy = async (url, opts) => {
    seen.push(opts?.headers?.Authorization);
    return { ok: true, status: 200, text: async () => page(EMBED) };
  };
  await svc.checkPage({ org: 'o', site: 's', path: '/a', token: 'tok' }, { fetch: spy });
  await svc.checkPage({ org: 'o', site: 's', path: '/a' }, { fetch: spy });
  assert.equal(seen[0], 'Bearer tok');
  assert.equal(seen[1], undefined);
});

/* --- checkPages: batching ------------------------------------------- */
test('checkPages aggregates and preserves input order', async () => {
  const { svc } = await load();
  const r = await svc.checkPages(
    { org: 'o', site: 's', paths: ['/a', '/b', '/c'] },
    {
      fetch: stubFetch({
        '/a': page(EMBED + META('video-page')), // pass
        '/b': page(META('video-page')), // fail
        '/c': 404, // error
      }),
    },
  );
  assert.equal(r.status, 'fail');
  assert.equal(r.counts.pages, 3);
  assert.equal(r.counts.passed, 1);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.counts.errored, 1);
  assert.deepEqual(r.reports.map((x) => x.path), ['/a', '/b', '/c']);
});

test('checkPages passes only when every page passes', async () => {
  const { svc } = await load();
  const r = await svc.checkPages(
    { org: 'o', site: 's', paths: ['/a', '/b'] },
    { fetch: stubFetch({ '/a': page(EMBED), '/b': page(EMBED) }) },
  );
  assert.equal(r.status, 'pass');
  assert.equal(r.counts.failed, 0);
});

/* --- worker HTTP contract ------------------------------------------- */
test('GET / returns usage', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/'), {});
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.service, 'da-preflight-checks');
  assert.ok(Array.isArray(body.templatesConfigured));
});

test('GET /health is a liveness probe', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/health'), {});
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).status, 'pass');
});

test('an unknown route 404s with a status field', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/nope'), {});
  assert.equal(resp.status, 404);
  assert.equal((await resp.json()).status, 'error');
});

test('OPTIONS is answered for CORS preflight', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/preflight', { method: 'OPTIONS' }), {});
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), '*');
});

test('missing parameters are reported precisely', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/preflight', { method: 'POST', body: { org: 'o' } }), {});
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.equal(body.status, 'error');
  assert.match(body.error, /site/);
  assert.match(body.error, /path/);
});

test('malformed JSON is rejected, not crashed on', async () => {
  const { worker } = await load();
  const bad = new Request('https://svc.example/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const resp = await worker.fetch(bad, {});
  assert.equal(resp.status, 400);
  assert.match((await resp.json()).error, /valid JSON/);
});

test('an oversized batch is refused', async () => {
  const { worker } = await load();
  const paths = Array.from({ length: 5 }, (_, i) => `/p${i}`);
  const resp = await worker.fetch(
    req('/preflight', { method: 'POST', body: { org: 'o', site: 's', paths } }),
    { MAX_PAGES: '3' },
  );
  assert.equal(resp.status, 400);
  assert.match((await resp.json()).error, /too many paths/);
});

test('API_KEY, when set, gates the endpoint', async () => {
  const { worker } = await load();
  const env = { API_KEY: 'secret' };
  const body = { org: 'o', site: 's', path: '/a' };

  const denied = await worker.fetch(req('/preflight', { method: 'POST', body }), env);
  assert.equal(denied.status, 401);

  const wrong = await worker.fetch(
    req('/preflight', { method: 'POST', body, headers: { 'x-api-key': 'nope' } }),
    env,
  );
  assert.equal(wrong.status, 401);
});

test('env defaults fill in org and site', async () => {
  const { worker } = await load();
  // No org/site in the request; they come from env. Stub the network so the test
  // asserts parameter resolution, not DA availability.
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch({ '/index': page(EMBED) });
  let resp;
  try {
    resp = await worker.fetch(
      req('/preflight?path=/index'),
      { DEFAULT_ORG: 'o', DEFAULT_SITE: 's' },
    );
  } finally { globalThis.fetch = real; }
  const body = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(body.org, 'o');
  assert.equal(body.site, 's');
});

test('paths accepts a comma-separated list', async () => {
  const { worker } = await load();
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch({ '/a': page(EMBED), '/b': page(EMBED) });
  let resp;
  try {
    resp = await worker.fetch(req('/preflight?org=o&site=s&paths=/a,/b'), {});
  } finally { globalThis.fetch = real; }
  const body = await resp.json();
  assert.equal(body.counts.pages, 2);
});
