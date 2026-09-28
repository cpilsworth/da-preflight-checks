/*
 * Shared constants for the check engine.
 *
 * Kept separate from any rule set: in this service rules are loaded per-repo at
 * request time, so the engine must not depend on a bundled rules module.
 */

/** Metadata row that declares a page's template. */
export const TEMPLATE_METADATA_KEY = 'template';

/** Template reported for a page that declares none. */
export const NO_TEMPLATE = '(none)';
