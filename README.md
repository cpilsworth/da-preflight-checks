# da-preflight-checks

An HTTP API for template-aware preflight checks on AEM Edge Delivery pages
authored in [Document Authoring](https://da.live). It answers one question for
any page: **does this page satisfy the rules for its template?**

The org and site are part of the URL, and the rules come from the repo being
checked — so one deployment serves every project, and each project owns its own
rules without a redeploy here.

```bash
curl https://<your-worker>/cpilsworth/one-azn-demo/drafts/launch
```

```json
{
  "org": "cpilsworth",
  "site": "one-azn-demo",
  "status": "fail",
  "counts": { "pages": 1, "passed": 0, "failed": 1, "errored": 0 },
  "rulesFound": true,
  "rulesSource": "https://main--one-azn-demo--cpilsworth.aem.live/tools/preflight/preflight-rules.json",
  "templatesConfigured": ["campaign-page", "print-page", "video-page"],
  "reports": [
    {
      "path": "/drafts/launch",
      "template": "video-page",
      "status": "fail",
      "counts": { "checks": 1, "passed": 0, "failed": 1, "blocking": 1 },
      "failures": [
        {
          "severity": "error",
          "title": "Embed block required",
          "detail": "No \"embed\" block found on the page.",
          "hint": "Add an Embed block and give it the video URL."
        }
      ]
    }
  ]
}
```

Built for automation — Workfront Fusion, CI, or anything that can make an HTTP
request. Every response carries a top-level `status` of `pass`, `fail`, or
`error`, so a Fusion router can branch on a single field.

## Endpoints

| Route | Purpose |
| ----- | ------- |
| `GET /{org}/{site}/{path}` | Check one page |
| `POST /{org}/{site}` | Check many — body `{ "paths": ["/a", "/b"] }` |
| `GET /{org}/{site}/_rules` | Show the rules this service resolved for a repo |
| `GET /health` | Liveness probe |
| `GET /` | Service metadata and usage |

Page paths are accepted with or without `.html`; `/{org}/{site}` with no path
means `index`. Nested paths work as written: `/o/s/drafts/q4/launch`.

| Option | Where | Purpose |
| ------ | ----- | ------- |
| `ref` | `?ref=` or body | Branch to read rules from (default `main`) |
| `token` | `Authorization: Bearer`, `?token=`, or body | DA token, if the site's source is not public |
| `paths` | body or `?paths=a,b` | Extra pages to check in one call |

## How it works

1. Loads the repo's rules from
   `https://{ref}--{site}--{org}.aem.live/tools/preflight/preflight-rules.json`,
   falling back to the `.aem.page` preview host.
2. Reads each page's authoring source from the DA Source API
   (`admin.da.live/source/{org}/{site}/{path}.html`).
3. Resolves the page's **template** from the `template` row of its Metadata block
   — the same value EDS turns into a `<body>` class.
4. Runs the rules configured for that template and returns a report.

A page whose template has no rules is reported `pass` with
`templateConfigured: false`, so "nothing to check" is never confused with
"checked and clean". A repo with no rules file at all reports
`rulesFound: false` rather than failing — not publishing rules is a valid state.

## Publishing rules for a repo

Commit `tools/preflight/preflight-rules.json` to the site's repo. It is keyed by
template name, and each entry is a list of checks:

```json
{
  "video-page": [
    {
      "type": "block-present",
      "name": "embed",
      "min": 1,
      "severity": "error",
      "title": "Embed block required",
      "description": "A video page must contain at least one Embed block.",
      "hint": "Add an Embed block and give it the video URL."
    }
  ]
}
```

Checks for a page are the `"*"` entries plus its template's entries.

| `type` | Options | Passes when |
| ------ | ------- | ----------- |
| `block-present` | `name`, `min` (1), `max`, `variants` | count within `min`..`max` |
| `block-absent` | `name`, `variants` | the block does not appear |

| Field | Notes |
| ----- | ----- |
| `severity` | `error` (blocks), `warning`, `info`. Defaults to `error` |
| `title` | Shown to the author; derived from the type if omitted |
| `hint` | How to fix it — written for an author, safe to paste into a ticket |

Rules are fetched as **JSON and never imported as JavaScript**: importing remote
code into the Worker would be arbitrary code execution on behalf of whoever
controls that repo. Every entry is validated, and an invalid one is dropped with
a warning in `rulesWarnings` rather than silently disabling the rest.

Use `GET /{org}/{site}/_rules` to see exactly what the service resolved, which
URL it came from, and any warnings. A rules file that is published but broken
shows up there instead of quietly doing nothing.

Both authored shapes are recognised — a table whose first cell is the block name
(`| Embed |`) and a normalised `div` (`<div class="embed">`) — so checks work
whichever way the source is stored.

## Use from Workfront Fusion

1. **HTTP > Make a request**
   - URL `https://<your-worker>/cpilsworth/one-azn-demo/{{page}}`
   - Method `GET`, tick *Parse response*
   - Or `POST` to `https://<your-worker>/cpilsworth/one-azn-demo` with
     `{"paths": ["{{page}}"]}` to check several at once
2. **Router** with two routes filtering on `{{status}}`:
   - `fail` → raise a Workfront issue, post to Slack, block an approval
   - `pass` → carry on
3. Useful fields downstream: `{{reports[].template}}`,
   `{{reports[].failures[].title}}`, `{{reports[].failures[].hint}}`.

### Response contract

| `status` | Meaning |
| -------- | ------- |
| `pass` | Every page satisfied its template's rules |
| `fail` | At least one page has a blocking (`error`) failure, or could not be read |
| `error` | The request itself was bad — unknown route, missing paths, malformed JSON |

Only `error`-severity results block. A `warning` appears in `results` and
`counts.failed` but leaves `status` as `pass`.

The HTTP status is **200 for both `pass` and `fail`**, deliberately: a
non-compliant page is a successful answer, and returning 4xx would make Fusion
treat it as a transport error and retry.

## Develop

```sh
npm install
npm test          # 42 tests, no network
npm run dev       # wrangler dev, on http://localhost:8787
```

```sh
curl 'http://localhost:8787/cpilsworth/one-azn-demo/index'
curl 'http://localhost:8787/cpilsworth/one-azn-demo/_rules'
```

## Deploy

```sh
npx wrangler login
npm run deploy
```

Optional configuration:

```sh
# Require callers to send a matching x-api-key header
npx wrangler secret put API_KEY

# Fallback DA token, for sites whose source is not publicly readable
npx wrangler secret put DA_TOKEN
```

`MAX_PAGES` (default 50) caps a single batch — set it in `wrangler.toml`.

## Security

- **Read-only.** The service only ever issues `GET` requests, to the DA Source
  API and to the repo's rules file. It cannot modify content.
- **No remote code execution.** Rules are inert JSON, validated before use.
- **Open by default.** With no `API_KEY` set the endpoint is unauthenticated,
  which is reasonable for checking public content and not much else.
- **Source visibility is DA's decision, not this service's.** Some DA sites serve
  source publicly; others require a token. A token is passed through when given
  and never stored.
- Batches are capped (`MAX_PAGES`) so an automation cannot turn the endpoint into
  an amplifier against DA.

## Layout

| Path | Role |
| ---- | ---- |
| `src/worker.js` | HTTP adapter: routing, validation, CORS, auth |
| `src/preflight.js` | Service core — fetch, check, aggregate. Runtime-agnostic |
| `src/rules-loader.js` | Per-repo rule fetching and validation |
| `src/dom.js` | Installs `DOMParser` (Workers and Node lack one) |
| `src/engine/checks.js` | Document parsing and check implementations |
| `src/engine/constants.js` | Template metadata key, no-template sentinel |
| `examples/preflight-rules.json` | A rules file to copy into a site repo |
| `test/` | Tests and a dependency-free runner |

> `src/engine/` is shared with the DA Prepare-menu plugin in
> [`one-azn-demo`](https://github.com/cpilsworth/one-azn-demo)
> (`tools/preflight/`). Keeping the files identical means the interactive plugin
> and this API can never disagree about whether a page passes. Port changes both
> ways.

## Licence

Apache-2.0
