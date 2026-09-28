/*
 * Preflight service core.
 *
 * Runtime-agnostic on purpose: this module touches no Worker and no Node API, so
 * the same code runs in Cloudflare Workers, in Node for the tests, and anywhere
 * else with fetch + DOMParser. The runtime adapters live in worker.js.
 */

// Side-effect import: guarantees DOMParser exists before the engine parses.
// Kept here rather than only in worker.js so importing this module is safe in any
// order and from any entry point (tests, a CLI, another service).
import './dom.js';
import rules, { NO_TEMPLATE } from './engine/rules.js';
import runChecks, { parseDoc, getTemplate, getBlocks } from './engine/checks.js';

export const DA_ADMIN = 'https://admin.da.live';

/** Site-relative path -> canonical form: leading slash, no .html. */
export function normalisePath(path) {
  const clean = String(path ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.html$/i, '');
  return `/${clean || 'index'}`;
}

/** DA Source API URL for a page. */
export function sourceUrl({ org, site, path }) {
  return `${DA_ADMIN}/source/${org}/${site}${normalisePath(path)}.html`;
}

/** The rules that apply to a template: global first, then template-specific. */
export function rulesFor(template) {
  return [...(rules['*'] || []), ...(rules[template] || [])];
}

/** Templates that currently carry at least one rule. Useful for discovery. */
export function configuredTemplates() {
  return Object.keys(rules).filter((key) => key !== '*' && rules[key]?.length);
}

/**
 * Run the checks against a single document's HTML.
 * Pure: no I/O, so it is trivially testable.
 */
export function checkHtml(html, path = '/') {
  const doc = parseDoc(html);
  const template = getTemplate(doc);
  const results = runChecks(doc, rulesFor(template));

  const failures = results.filter((r) => !r.passed);
  const blocking = failures.filter((r) => r.severity === 'error');

  return {
    path: normalisePath(path),
    template,
    templateConfigured: template !== NO_TEMPLATE && !!rules[template]?.length,
    blocks: [...new Set(getBlocks(doc).map((b) => b.name))].sort(),
    status: blocking.length ? 'fail' : 'pass',
    counts: {
      checks: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      blocking: blocking.length,
    },
    results: results.map((r) => ({
      severity: r.severity,
      passed: r.passed,
      title: r.title,
      detail: r.detail,
      ...(r.hint && !r.passed ? { hint: r.hint } : {}),
    })),
    failures: failures.map((r) => ({
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      ...(r.hint ? { hint: r.hint } : {}),
    })),
  };
}

/**
 * Fetch one page from DA and check it.
 *
 * `token` is optional: DA source is readable without auth on public sites, and
 * required on protected ones. Fetch failures are returned as data, never thrown,
 * so a bad path in a batch does not sink the whole request.
 */
export async function checkPage({ org, site, path, token }, deps = {}) {
  // Wrap rather than alias the global: some runtimes reject `fetch` when it is
  // detached from its receiver, which surfaces as a hung promise rather than a
  // clear TypeError. Calling through globalThis keeps the binding intact.
  const doFetch = deps.fetch || ((url, opts) => globalThis.fetch(url, opts));
  const url = sourceUrl({ org, site, path });
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  let resp;
  try {
    resp = await doFetch(url, { headers });
  } catch (e) {
    return {
      path: normalisePath(path), status: 'error', error: `fetch failed: ${e.message}`,
    };
  }

  if (!resp.ok) {
    const reason = {
      401: 'unauthorised - supply a token with DA read access',
      403: 'forbidden - the token cannot read this page',
      404: 'page not found - check the path, and that it has been saved',
    }[resp.status] || `HTTP ${resp.status}`;
    return {
      path: normalisePath(path), status: 'error', httpStatus: resp.status, error: reason,
    };
  }

  return checkHtml(await resp.text(), path);
}

/** Check several pages, bounded concurrency so DA is not hammered. */
export async function checkPages({ org, site, paths, token }, deps = {}) {
  // Fixed-size batches rather than a worker pool: DA sees at most `limit`
  // concurrent reads, results stay in the caller's order for free, and there is
  // no shared mutable queue to reason about.
  const limit = Math.max(1, Math.min(deps.concurrency ?? 4, 10));
  const reports = [];

  for (let i = 0; i < paths.length; i += limit) {
    const batch = paths.slice(i, i + limit);
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.all(
      batch.map((path) => checkPage({ org, site, path, token }, deps)),
    );
    reports.push(...settled);
  }

  const failed = reports.filter((r) => r.status === 'fail');
  const errored = reports.filter((r) => r.status === 'error');

  return {
    org,
    site,
    status: (failed.length || errored.length) ? 'fail' : 'pass',
    counts: {
      pages: reports.length,
      passed: reports.filter((r) => r.status === 'pass').length,
      failed: failed.length,
      errored: errored.length,
    },
    reports,
  };
}
