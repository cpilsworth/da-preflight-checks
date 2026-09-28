/*
 * Minimal test harness.
 *
 * A tiny self-contained runner, deliberately not node:test. The suite needs to
 * run in sandboxed and bundled runtimes that do not expose node:test (or support
 * `node --test`), and being able to run the tests anywhere matters more here than
 * reusing the built-in runner's reporting.
 *
 * Tests are queued on import and flushed on the next tick, so the test file
 * needs no top-level await (which would break CommonJS transpilation).
 */

/* Deep-equal that covers the shapes these tests use: primitives, arrays,
 * and plain objects. Kept local so the harness has no dependencies. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

const fmt = (v) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

export const assert = {
  equal(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(msg || `expected ${fmt(expected)}, got ${fmt(actual)}`);
    }
  },
  deepEqual(actual, expected, msg) {
    if (!deepEqual(actual, expected)) {
      throw new Error(msg || `expected ${fmt(expected)}, got ${fmt(actual)}`);
    }
  },
  match(actual, re, msg) {
    if (!re.test(String(actual))) {
      throw new Error(msg || `expected ${fmt(actual)} to match ${re}`);
    }
  },
  ok(value, msg) {
    if (!value) throw new Error(msg || `expected truthy, got ${fmt(value)}`);
  },
};

const queue = [];
let scheduled = false;
let running = false;

export async function run() {
  if (running || !queue.length) return;
  running = true;

  const cases = queue.splice(0, queue.length);
  let passed = 0;
  const failures = [];

  for (const { name, fn } of cases) {
    try {
      // Sequential: these tests stub globals (fetch), so they must not overlap.
      // eslint-disable-next-line no-await-in-loop
      await fn();
      passed += 1;
      process.stdout.write(`  ok    ${name}\n`);
    } catch (e) {
      failures.push({ name, message: e.message });
      process.stdout.write(`  FAIL  ${name}\n          ${e.message}\n`);
    }
  }

  process.stdout.write(`\n${passed}/${cases.length} passed`
    + `${failures.length ? `, ${failures.length} failed` : ''}\n`);

  if (failures.length) process.exitCode = 1;
  running = false;
}

export function test(name, fn) {
  queue.push({ name, fn });
  if (!scheduled) {
    scheduled = true;
    // Flush after the module graph settles so every test is registered first.
    Promise.resolve().then(() => { scheduled = false; run(); });
  }
}
