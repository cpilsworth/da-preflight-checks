/*
 * Document inspection + check implementations.
 *
 * DA stores a document as an HTML body fragment. Blocks are authored either as
 * a table whose first cell holds the block name, or - once normalised - as a
 * div carrying the block name as a class. Both shapes are handled here so the
 * checks work against saved source regardless of how it was authored.
 */

import { TEMPLATE_METADATA_KEY, NO_TEMPLATE } from './constants.js';

/** Normalise a block/variant name the way EDS does (lowercase, dash-joined). */
export function toClassName(name) {
  return typeof name === 'string'
    ? name
      .toLowerCase()
      .replace(/[^0-9a-z]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    : '';
}

/**
 * Split an authored block label into its name and variants.
 * e.g. "Embed (autoplay, dark)" -> { name: 'embed', variants: ['autoplay','dark'] }
 */
function parseBlockLabel(label) {
  const text = (label || '').trim();
  const match = text.match(/^([^(]+)(?:\(([^)]*)\))?$/);
  if (!match) return { name: toClassName(text), variants: [] };
  const name = toClassName(match[1]);
  const variants = (match[2] || '')
    .split(',')
    .map((v) => toClassName(v))
    .filter(Boolean);
  return { name, variants };
}

/** Parse a DA HTML string into a document we can query. */
export function parseDoc(html) {
  return new DOMParser().parseFromString(html || '', 'text/html');
}

/**
 * Read the page metadata rows out of the document's Metadata block.
 * Returns a lowercase-keyed map, e.g. { template: 'video-page', title: '...' }.
 */
export function getMetadata(doc) {
  const meta = {};
  const tables = [...doc.querySelectorAll('table')];
  const metaTable = tables.find((t) => {
    const first = t.querySelector('tr th, tr td');
    return first && toClassName(first.textContent) === 'metadata';
  });

  const rows = metaTable
    ? [...metaTable.querySelectorAll('tr')].slice(1)
    : [...doc.querySelectorAll('.metadata > div')];

  rows.forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const key = cells[0].textContent.trim().toLowerCase();
    const value = cells[1].textContent.trim();
    if (key) meta[key] = value;
  });

  return meta;
}

/** The template this document declares, or NO_TEMPLATE. */
export function getTemplate(doc) {
  const meta = getMetadata(doc);
  const raw = meta[TEMPLATE_METADATA_KEY];
  return raw ? toClassName(raw) : NO_TEMPLATE;
}

/**
 * Every block on the page, as { name, variants }.
 * Covers both authored tables and normalised block divs.
 */
export function getBlocks(doc) {
  const blocks = [];

  // Metadata blocks carry page/section configuration, not content, and must
  // never be reported as blocks or matched by a rule.
  const NOT_CONTENT = new Set(['metadata', 'section-metadata']);

  // Authored form: a table whose first cell is the block name.
  doc.querySelectorAll('table').forEach((table) => {
    const first = table.querySelector('tr th, tr td');
    if (!first) return;
    const { name, variants } = parseBlockLabel(first.textContent);
    if (!name || NOT_CONTENT.has(name)) return;
    blocks.push({ name, variants, el: table });
  });

  // Normalised form: <div class="embed">. Section wrappers carry no class.
  doc.querySelectorAll('div[class]').forEach((div) => {
    const [name, ...variants] = [...div.classList];
    if (!name || NOT_CONTENT.has(name)) return;
    if (blocks.some((b) => b.el === div)) return;
    blocks.push({ name, variants, el: div });
  });

  return blocks;
}

/* ------------------------------------------------------------------ *
 * Check implementations
 * Each returns { severity, title, description, hint, passed, detail }
 * ------------------------------------------------------------------ */

function countMatches(blocks, rule) {
  const wanted = toClassName(rule.name);
  return blocks.filter((b) => {
    if (b.name !== wanted) return false;
    if (!rule.variants?.length) return true;
    return rule.variants.every((v) => b.variants.includes(toClassName(v)));
  }).length;
}

const checks = {
  'block-present': (blocks, rule) => {
    const count = countMatches(blocks, rule);
    const min = rule.min ?? 1;
    const { max } = rule;

    let passed = count >= min;
    let detail;

    if (count === 0) {
      detail = `No "${rule.name}" block found on the page.`;
    } else if (count < min) {
      detail = `Found ${count} "${rule.name}" block(s); at least ${min} required.`;
    } else if (typeof max === 'number' && count > max) {
      passed = false;
      detail = `Found ${count} "${rule.name}" block(s); at most ${max} allowed.`;
    } else {
      detail = `Found ${count} "${rule.name}" block(s).`;
    }

    return { passed, detail, count };
  },

  'block-absent': (blocks, rule) => {
    const count = countMatches(blocks, rule);
    return {
      passed: count === 0,
      detail: count === 0
        ? `No "${rule.name}" block present, as expected.`
        : `Found ${count} "${rule.name}" block(s); this template does not support them.`,
      count,
    };
  },
};

/**
 * Run a set of rules against a parsed document.
 * Unknown rule types surface as an 'info' result rather than throwing.
 */
export function runChecks(doc, rules) {
  const blocks = getBlocks(doc);

  return rules.map((rule) => {
    const impl = checks[rule.type];
    if (!impl) {
      return {
        ...rule,
        severity: 'info',
        passed: true,
        detail: `Unknown check type "${rule.type}" - skipped.`,
      };
    }
    const result = impl(blocks, rule);
    return {
      severity: rule.severity || 'error',
      title: rule.title || rule.type,
      description: rule.description || '',
      hint: rule.hint || '',
      ...result,
    };
  });
}

const DA_ADMIN = 'https://admin.da.live';

/**
 * Build the DA Source API URL for the document under edit.
 *
 * The Prepare menu posts a context of { view, org, site, repo, ref, path } where
 * `path` is site-relative and normally carries no extension (e.g. `/drafts/foo`).
 * `site` and `repo` are the same value; `repo` is accepted for parity with the
 * Library SDK context. Folder-ish and already-suffixed paths are tolerated.
 */
export function sourceUrl({ org, site, repo, path }) {
  const owner = org;
  const project = site || repo;
  const clean = `${path || ''}`
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.html$/, '');
  const doc = clean || 'index';
  return `${DA_ADMIN}/source/${owner}/${project}/${doc}.html`;
}

export default runChecks;
