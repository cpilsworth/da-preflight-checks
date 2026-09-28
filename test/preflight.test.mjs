/*
 * Tests for the preflight service.
 *
 * Run: npm test
 *
 * Covers the service layer (path/URL handling, report shape, batch behaviour,
 * error mapping), the per-repo rules loader and its validation, and the Worker's
 * HTTP contract. The check engine itself is vendored from the DA plugin and has
 * its own tests there; what matters here is that the service wraps it faithfully.
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
    loader: await import('../src/rules-loader.js'),
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

/** The rule set most tests run against. */
const RULES = {
  'video-page': [{
    type: 'block-present',
    name: 'embed',
    min: 1,
    severity: 'error',
    title: 'Embed block required',
    hint: 'Add an Embed block.',
  }],
  'print-page': [{
    type: 'block-absent',
    name: 'embed',
    severity: 'warning',
    title: 'Embed not supported',
  }],
};

/**
 * Stub fetch serving DA source paths and, optionally, a repo rules file.
 * `sources` maps '/path' -> html or an HTTP status number.
 */
function stubFetch(sources, rules = RULES) {
  return async (url) => {
    const s = String(url);

    if (s.includes('preflight-rules.json')) {
      if (rules === 404) return { ok: false, status: 404 };
      if (typeof rules === 'string') return { ok: true, status: 200, text: async () => rules };
      return { ok: true, status: 200, text: async () => JSON.stringify(rules) };
    }

    const m = s.match(/\/source\/[^/]+\/[^/]+(.*)\.html$/);
    const entry = sources[m ? m[1] : ''];
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

/** Run the worker with the network stubbed. */
async function callWorker(path, { env = {}, ...init } = {}, stub) {
  const { worker } = await load();
  const real = globalThis.fetch;
  if (stub) globalThis.fetch = stub;
  try {
    const resp = await worker.fetch(req(path, init), env);
    return { status: resp.status, body: await resp.json(), headers: resp.headers };
  } finally {
    globalThis.fetch = real;
  }
}

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
});

/* --- route parsing --------------------------------------------------- */
test('parseRoute splits org, site and page path', async () => {
  const { parseRoute: pr } = await import('../src/worker.js');
  assert.deepEqual(
    { ...pr('/org/site/a/b') },
    { org: 'org', site: 'site', path: '/a/b', wantsRules: false },
  );
  assert.deepEqual(
    { ...pr('/org/site') },
    { org: 'org', site: 'site', path: '', wantsRules: false },
  );
  assert.deepEqual(
    { ...pr('/org/site/_rules') },
    { org: 'org', site: 'site', path: '', wantsRules: true },
  );
  assert.equal(pr('/onlyone'), null, 'a single segment is not a route');
});

/* --- rules loader: validation --------------------------------------- */
test('rulesUrls prefers live, then preview', async () => {
  const { loader } = await load();
  const urls = loader.rulesUrls({ org: 'o', site: 's' });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/main--s--o\.aem\.live\/tools\/preflight\/preflight-rules\.json$/);
  assert.match(urls[1], /aem\.page/);
  assert.match(loader.rulesUrls({ org: 'o', site: 's', ref: 'dev' })[0], /dev--s--o/);
});

test('validateRules keeps good rules and defaults severity', async () => {
  const { loader } = await load();
  const { rules, warnings } = loader.validateRules({
    'video-page': [{ type: 'block-present', name: 'Embed' }],
  });
  assert.equal(warnings.length, 0);
  assert.equal(rules['video-page'][0].severity, 'error', 'severity defaults to error');
  assert.equal(rules['video-page'][0].title, 'block-present: Embed', 'title is derived');
});

test('validateRules drops malformed entries with a warning', async () => {
  const { loader } = await load();
  const { rules, warnings } = loader.validateRules({
    good: [{ type: 'block-present', name: 'embed' }],
    badType: [{ type: 'no-such', name: 'embed' }],
    noName: [{ type: 'block-present' }],
    notArray: { nope: true },
  });
  assert.deepEqual(Object.keys(rules), ['good'], 'only valid templates survive');
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => /unknown type/.test(w)));
  assert.ok(warnings.some((w) => /missing block "name"/.test(w)));
  assert.ok(warnings.some((w) => /expected an array/.test(w)));
});

test('validateRules warns on an unknown severity but keeps the rule', async () => {
  const { loader } = await load();
  const { rules, warnings } = loader.validateRules({
    t: [{ type: 'block-present', name: 'embed', severity: 'critical' }],
  });
  assert.equal(rules.t[0].severity, 'error');
  assert.ok(warnings.some((w) => /unknown severity/.test(w)));
});

test('validateRules rejects a non-object document', async () => {
  const { loader } = await load();
  assert.ok(loader.validateRules([]).warnings.length);
  assert.ok(loader.validateRules(null).warnings.length);
  assert.ok(loader.validateRules('nope').warnings.length);
});

test('validateRules accepts a { templates: {...} } wrapper', async () => {
  const { loader } = await load();
  const { rules } = loader.validateRules({
    templates: { t: [{ type: 'block-present', name: 'embed' }] },
  });
  assert.deepEqual(Object.keys(rules), ['t']);
});

/* --- rules loader: fetching ----------------------------------------- */
test('loadRules reads a repo rules file', async () => {
  const { loader } = await load();
  const r = await loader.loadRules({ org: 'o', site: 's' }, { fetch: stubFetch({}) });
  assert.equal(r.found, true);
  assert.match(r.source, /aem\.live/);
  assert.deepEqual(Object.keys(r.rules).sort(), ['print-page', 'video-page']);
});

test('loadRules falls back to preview when live has no file', async () => {
  const { loader } = await load();
  let call = 0;
  const fetchStub = async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 404 };
    return { ok: true, status: 200, text: async () => JSON.stringify(RULES) };
  };
  const r = await loader.loadRules({ org: 'o', site: 's' }, { fetch: fetchStub });
  assert.equal(r.found, true);
  assert.match(r.source, /aem\.page/);
});

test('a missing rules file is unconfigured, not an error', async () => {
  const { loader } = await load();
  const r = await loader.loadRules({ org: 'o', site: 's' }, { fetch: async () => ({ ok: false, status: 404 }) });
  assert.equal(r.found, false);
  assert.deepEqual(r.rules, {});
  assert.ok(r.warnings[0].includes('no rules file found'));
});

test('malformed JSON in a rules file is flagged loudly', async () => {
  const { loader } = await load();
  const r = await loader.loadRules({ org: 'o', site: 's' }, { fetch: stubFetch({}, '{not json') });
  assert.equal(r.found, true);
  assert.deepEqual(r.rules, {});
  assert.ok(r.warnings[0].includes('not valid JSON'));
});

/* --- checkHtml: the report contract --------------------------------- */
test('checkHtml passes a compliant page', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(EMBED + META('video-page')), { path: '/v', rules: RULES });
  assert.equal(r.status, 'pass');
  assert.equal(r.template, 'video-page');
  assert.equal(r.templateConfigured, true);
  assert.equal(r.counts.checks, 1);
  assert.deepEqual(r.blocks, ['embed']);
});

test('checkHtml fails a page missing a required block', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(META('video-page')), { path: '/v', rules: RULES });
  assert.equal(r.status, 'fail');
  assert.equal(r.counts.blocking, 1);
  assert.equal(r.failures[0].severity, 'error');
  assert.ok(r.failures[0].hint, 'a failure carries remediation guidance');
});

test('a warning does not make the page fail', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(EMBED + META('print-page')), { path: '/p', rules: RULES });
  assert.equal(r.counts.failed, 1);
  assert.equal(r.counts.blocking, 0);
  assert.equal(r.status, 'pass', 'only errors block');
});

test('no rules means no checks, reported as unconfigured', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(EMBED + META('video-page')), { path: '/v', rules: {} });
  assert.equal(r.status, 'pass');
  assert.equal(r.templateConfigured, false);
  assert.equal(r.counts.checks, 0);
});

test('checkHtml tolerates being called with no rules at all', async () => {
  const { svc } = await load();
  const r = svc.checkHtml(page(EMBED), {});
  assert.equal(r.status, 'pass');
  assert.equal(r.counts.checks, 0);
});

test('global "*" rules apply to every template', async () => {
  const { svc } = await load();
  const rules = {
    '*': [{
      type: 'block-present', name: 'embed', severity: 'error', title: 'Embed everywhere',
    }],
  };
  const withEmbed = svc.checkHtml(page(EMBED + META('anything')), { rules });
  const without = svc.checkHtml(page(META('anything')), { rules });
  assert.equal(withEmbed.status, 'pass');
  assert.equal(without.status, 'fail');
});

test('rulesFor concatenates global and template rules', async () => {
  const { svc } = await load();
  const rules = { '*': [{ a: 1 }], t: [{ b: 2 }] };
  assert.equal(svc.rulesFor(rules, 't').length, 2);
  assert.equal(svc.rulesFor(rules, 'other').length, 1);
  assert.equal(svc.rulesFor(undefined, 't').length, 0);
});

test('configuredTemplates lists only templates with rules', async () => {
  const { svc } = await load();
  assert.deepEqual(
    svc.configuredTemplates({ '*': [{ x: 1 }], b: [{ x: 1 }], a: [] }),
    ['b'],
  );
});

/* --- checkPage: fetch + error mapping ------------------------------- */
test('checkPage maps HTTP failures to actionable errors', async () => {
  const { svc } = await load();
  const cases = [[404, /not found/], [401, /unauthorised/], [403, /forbidden/]];
  for (const [code, re] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await svc.checkPage(
      { org: 'o', site: 's', path: '/x', rules: RULES },
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
    { org: 'o', site: 's', paths: ['/a', '/b', '/c'], rules: RULES },
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

/* --- worker HTTP contract ------------------------------------------- */
test('GET / returns usage naming the path-based routes', async () => {
  const { body } = await callWorker('/');
  assert.equal(body.service, 'da-preflight-checks');
  assert.ok(body.endpoints['GET /{org}/{site}/{path}']);
  assert.match(body.rules.publishAt, /preflight-rules\.json/);
});

test('GET /health is a liveness probe', async () => {
  const { status, body } = await callWorker('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'pass');
});

test('GET /{org}/{site}/{path} checks that page', async () => {
  const { status, body } = await callWorker(
    '/cpilsworth/one-azn-demo/drafts/launch',
    {},
    stubFetch({ '/drafts/launch': page(META('video-page')) }),
  );
  assert.equal(status, 200, 'a failing page is still a successful request');
  assert.equal(body.status, 'fail');
  assert.equal(body.org, 'cpilsworth');
  assert.equal(body.site, 'one-azn-demo');
  assert.equal(body.reports[0].path, '/drafts/launch');
  assert.equal(body.rulesFound, true);
});

test('a nested page path is preserved', async () => {
  const { body } = await callWorker(
    '/o/s/a/b/c',
    {},
    stubFetch({ '/a/b/c': page(EMBED + META('video-page')) }),
  );
  assert.equal(body.reports[0].path, '/a/b/c');
  assert.equal(body.status, 'pass');
});

test('POST /{org}/{site} checks a list of pages', async () => {
  const { body } = await callWorker(
    '/o/s',
    { method: 'POST', body: { paths: ['/a', '/b'] } },
    stubFetch({ '/a': page(EMBED + META('video-page')), '/b': page(META('video-page')) }),
  );
  assert.equal(body.counts.pages, 2);
  assert.equal(body.counts.passed, 1);
  assert.equal(body.counts.failed, 1);
  assert.equal(body.status, 'fail');
});

test('GET /{org}/{site}/_rules exposes the resolved rules', async () => {
  const { status, body } = await callWorker('/o/s/_rules', {}, stubFetch({}));
  assert.equal(status, 200);
  assert.equal(body.rulesFound, true);
  assert.deepEqual(body.templatesConfigured, ['print-page', 'video-page']);
  assert.equal(body.checkCount, 2);
  assert.ok(Array.isArray(body.searched));
});

test('_rules reports a missing file without failing', async () => {
  const { body } = await callWorker(
    '/o/s/_rules',
    {},
    async () => ({ ok: false, status: 404 }),
  );
  assert.equal(body.rulesFound, false);
  assert.deepEqual(body.templatesConfigured, []);
  assert.ok(body.warnings.length);
});

test('a page check surfaces rules warnings', async () => {
  const { body } = await callWorker(
    '/o/s/index',
    {},
    stubFetch({ '/index': page(EMBED) }, { t: [{ type: 'bogus', name: 'x' }] }),
  );
  assert.ok(body.rulesWarnings, 'a broken rule must not be silent');
  assert.match(body.rulesWarnings[0], /unknown type/);
});

test('POST /{org}/{site} with no paths is a 400', async () => {
  const { status, body } = await callWorker('/o/s', { method: 'POST', body: {} });
  assert.equal(status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.error, /no page specified/);
});

test('a single-segment path is not a route', async () => {
  const { status, body } = await callWorker('/justorg');
  assert.equal(status, 404);
  assert.match(body.hint, /\{org\}/);
});

test('reserved routes are never treated as an org', async () => {
  const { status } = await callWorker('/favicon.ico');
  assert.equal(status, 404);
});

test('malformed JSON is rejected, not crashed on', async () => {
  const { worker } = await load();
  const bad = new Request('https://svc.example/o/s', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const resp = await worker.fetch(bad, {});
  assert.equal(resp.status, 400);
  assert.match((await resp.json()).error, /valid JSON/);
});

test('an oversized batch is refused', async () => {
  const paths = Array.from({ length: 5 }, (_, i) => `/p${i}`);
  const { status, body } = await callWorker(
    '/o/s',
    { method: 'POST', body: { paths }, env: { MAX_PAGES: '3' } },
  );
  assert.equal(status, 400);
  assert.match(body.error, /too many paths/);
});

test('API_KEY, when set, gates the endpoint', async () => {
  const env = { API_KEY: 'secret' };
  const denied = await callWorker('/o/s/index', { env });
  assert.equal(denied.status, 401);

  const wrong = await callWorker('/o/s/index', { env, headers: { 'x-api-key': 'nope' } });
  assert.equal(wrong.status, 401);

  const ok = await callWorker(
    '/o/s/index',
    { env, headers: { 'x-api-key': 'secret' } },
    stubFetch({ '/index': page(EMBED) }),
  );
  assert.equal(ok.status, 200);
});

test('OPTIONS is answered for CORS preflight', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/o/s', { method: 'OPTIONS' }), {});
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), '*');
});

test('an unsupported method is refused', async () => {
  const { worker } = await load();
  const resp = await worker.fetch(req('/o/s/index', { method: 'DELETE' }), {});
  assert.equal(resp.status, 405);
});

test('?ref= selects a branch for the rules lookup', async () => {
  const seen = [];
  const spy = async (url) => {
    seen.push(String(url));
    if (String(url).includes('preflight-rules.json')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(RULES) };
    }
    return { ok: true, status: 200, text: async () => page(EMBED) };
  };
  await callWorker('/o/s/index?ref=feature', {}, spy);
  assert.ok(seen.some((u) => u.includes('feature--s--o')), 'ref reaches the rules URL');
});
