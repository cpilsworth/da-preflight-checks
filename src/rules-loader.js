/*
 * Per-repo rule loading.
 *
 * Rules are owned by the site being checked, not by this service: each project
 * publishes its own `preflight-rules.json` and the service fetches it. That keeps
 * one deployment able to serve many sites, and lets a project change its rules
 * without a redeploy here.
 *
 * Rules are fetched as JSON, never imported as JavaScript. A remote `import()`
 * would be arbitrary code execution inside the Worker on behalf of whoever
 * controls that repo; JSON is inert, and everything in it is validated below
 * before the engine sees it.
 *
 * Resolution order for org/site (first hit wins):
 *   1. {ref}--{site}--{org}.aem.live/tools/preflight/preflight-rules.json
 *   2. the same path on .aem.page   (preview, so a branch can be tried first)
 * A site with no rules file is reported as unconfigured rather than failed - not
 * publishing rules is a valid state, not an error.
 */

const RULES_PATH = 'tools/preflight/preflight-rules.json';
const VALID_SEVERITIES = new Set(['error', 'warning', 'info']);
const VALID_TYPES = new Set(['block-present', 'block-absent']);

/** Candidate URLs for a repo's rules, in priority order. */
export function rulesUrls({ org, site, ref = 'main' }) {
  return [
    `https://${ref}--${site}--${org}.aem.live/${RULES_PATH}`,
    `https://${ref}--${site}--${org}.aem.page/${RULES_PATH}`,
  ];
}

/**
 * Validate and normalise a fetched rules document.
 *
 * Returns { rules, warnings }. Invalid entries are dropped with a warning rather
 * than rejecting the whole file: one malformed rule should not silently disable
 * every other check a project relies on. Warnings are surfaced in the response so
 * a broken rule is visible instead of quietly ignored.
 */
export function validateRules(doc) {
  const warnings = [];
  const rules = {};

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { rules, warnings: ['rules file must be a JSON object keyed by template name'] };
  }

  // Allow either a bare map or { templates: { ... } } for forward compatibility.
  const source = doc.templates && typeof doc.templates === 'object' ? doc.templates : doc;

  Object.entries(source).forEach(([template, entries]) => {
    if (template.startsWith('$') || template === 'templates') return;
    if (!Array.isArray(entries)) {
      warnings.push(`"${template}": expected an array of checks, got ${typeof entries}`);
      return;
    }

    const kept = [];
    entries.forEach((entry, i) => {
      const where = `"${template}"[${i}]`;
      if (!entry || typeof entry !== 'object') {
        warnings.push(`${where}: not an object`);
        return;
      }
      if (!VALID_TYPES.has(entry.type)) {
        warnings.push(`${where}: unknown type "${entry.type}" (expected ${[...VALID_TYPES].join(' | ')})`);
        return;
      }
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        warnings.push(`${where}: missing block "name"`);
        return;
      }
      if (entry.severity && !VALID_SEVERITIES.has(entry.severity)) {
        warnings.push(`${where}: unknown severity "${entry.severity}", defaulting to error`);
      }

      kept.push({
        type: entry.type,
        name: String(entry.name).trim(),
        ...(Number.isFinite(entry.min) ? { min: entry.min } : {}),
        ...(Number.isFinite(entry.max) ? { max: entry.max } : {}),
        ...(Array.isArray(entry.variants) ? { variants: entry.variants.map(String) } : {}),
        severity: VALID_SEVERITIES.has(entry.severity) ? entry.severity : 'error',
        title: typeof entry.title === 'string' && entry.title.trim()
          ? entry.title.trim()
          : `${entry.type}: ${entry.name}`,
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        ...(typeof entry.hint === 'string' ? { hint: entry.hint } : {}),
      });
    });

    if (kept.length) rules[template] = kept;
  });

  return { rules, warnings };
}

/**
 * Fetch a repo's rules.
 *
 * Returns { rules, source, warnings, found }. Never throws: a missing or broken
 * rules file degrades to "no rules" with an explanation, because the caller is an
 * automation that needs a usable answer rather than a stack trace.
 */
export async function loadRules({ org, site, ref = 'main' }, deps = {}) {
  const doFetch = deps.fetch || ((url, opts) => globalThis.fetch(url, opts));
  const urls = deps.rulesUrls || rulesUrls({ org, site, ref });
  const attempts = [];

  for (const url of urls) {
    let resp;
    try {
      // Sequential on purpose: the second URL is only a fallback for the first.
      // eslint-disable-next-line no-await-in-loop
      resp = await doFetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      attempts.push(`${url}: ${e.message}`);
      continue;
    }

    if (!resp.ok) {
      attempts.push(`${url}: HTTP ${resp.status}`);
      continue;
    }

    let parsed;
    try {
      // eslint-disable-next-line no-await-in-loop
      parsed = JSON.parse(await resp.text());
    } catch (e) {
      // A reachable but malformed file is worth flagging loudly - it means someone
      // published rules that silently are not running.
      return {
        found: true,
        rules: {},
        source: url,
        warnings: [`rules file is not valid JSON: ${e.message}`],
      };
    }

    const { rules, warnings } = validateRules(parsed);
    return { found: true, rules, source: url, warnings };
  }

  return {
    found: false,
    rules: {},
    source: null,
    warnings: [`no rules file found (tried: ${attempts.join('; ')})`],
  };
}
