/*
 * Preflight rules.
 *
 * Checks are declarative and keyed by template name. The template is read from
 * the document's page metadata (the `template` row in the Metadata block),
 * which is the same value EDS `decorateTemplateAndTheme()` puts on <body> as a
 * class at render time.
 *
 * Resolution order for a document:
 *   1. rules['*']              - checks that apply to every page
 *   2. rules[<template-name>]  - checks for that specific template
 * A page whose template has no entry only runs the '*' checks.
 *
 * Supported check types (see checks.js for the implementations):
 *   'block-present'  - a block must appear on the page
 *                      opts: { name, min, max, variants }
 *   'block-absent'   - a block must NOT appear on the page
 *                      opts: { name }
 *
 * Severities: 'error' | 'warning' | 'info'
 * Only 'error' results are treated as blocking in the summary.
 */

export const TEMPLATE_METADATA_KEY = 'template';

/** Template name used in results when a page declares no template. */
export const NO_TEMPLATE = '(none)';

const rules = {
  /* ---- Applies to every page, regardless of template ---- */
  '*': [],

  /* ---- Templates that must carry an embed block ---- */
  'video-page': [
    {
      type: 'block-present',
      name: 'embed',
      min: 1,
      severity: 'error',
      title: 'Embed block required',
      description: 'A "video-page" must contain at least one Embed block to host its video.',
      hint: 'Add an Embed block and give it the video URL (YouTube, Vimeo, or a fragment path).',
    },
  ],

  'campaign-page': [
    {
      type: 'block-present',
      name: 'embed',
      min: 1,
      max: 1,
      severity: 'error',
      title: 'Exactly one Embed block required',
      description: 'A "campaign-page" must contain exactly one Embed block.',
      hint: 'Add an Embed block, or remove the extra ones so only a single Embed remains.',
    },
  ],

  /* ---- Example of a template that forbids an embed ---- */
  'print-page': [
    {
      type: 'block-absent',
      name: 'embed',
      severity: 'warning',
      title: 'Embed block not supported',
      description: 'Embedded media does not render on a "print-page" and will be dropped.',
      hint: 'Remove the Embed block or switch the page to a template that supports media.',
    },
  ],
};

export default rules;
