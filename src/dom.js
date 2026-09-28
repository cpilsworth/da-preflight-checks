/*
 * DOMParser bootstrap.
 *
 * The check engine parses DA's stored HTML with DOMParser. Browsers have one;
 * Cloudflare Workers and Node do not. linkedom supplies a spec-shaped
 * implementation for both, via its dedicated worker entry point where available.
 *
 * Importing this module for its side effect installs DOMParser globally before
 * the engine runs. It is a no-op when the runtime already provides one, so the
 * same engine files stay usable in the browser plugin untouched.
 *
 * Why linkedom rather than Workers' native HTMLRewriter: HTMLRewriter is a
 * streaming transformer with no queryable tree, and the checks need
 * querySelectorAll with descendant/child selectors. Rewriting them around a
 * streaming API would fork the engine, and a single shared engine is the whole
 * point of this project.
 */

import { DOMParser } from 'linkedom/worker';

if (!globalThis.DOMParser) {
  globalThis.DOMParser = DOMParser;
}

export default globalThis.DOMParser;
