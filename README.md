# da-preflight-checks

An HTTP API for template-aware preflight checks on AEM Edge Delivery pages
authored in [Document Authoring](https://da.live). It answers one question for
any page: **does this page satisfy the rules for its template?**

Built for automation — Workfront Fusion, CI, or anything that can make an HTTP
request. Every response carries a top-level `status` of `pass`, `fail`, or
`error`, so a Fusion router can branch on a single field.

```bash
curl -X POST https://<your-worker>/preflight \
  -H 'content-type: application/json' \
  -d '{"org":"cpilsworth","site":"one-azn-demo","path":"/index"}'
```

```json
{
  "org": "cpilsworth",
  "site": "one-azn-demo",
  "status": "fail",
  "counts": { "pages": 1, "passed": 0, "failed": 1, "errored": 0 },
  "reports": [
    {
      "path": "/launch",
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

## How it works

1. Reads the page's authoring source from the DA Source API
   (`admin.da.live/source/{org}/{site}/{path}.html`).
2. Resolves the page's **template** from the `template` row of its Metadata
   block — the same value EDS turns into a `<body>` class.
3. Runs the rules configured for that template, and returns a report.

A page whose template has no rules is reported `pass` with
`templateConfigured: false`, so "nothing to check" is never confused with
"checked and clean".

## Endpoints

| Route | Purpose |
| ----- | ------- |
| `GET /` | Service metadata, configured templates, usage |
| `GET /health` | Liveness probe |
| `POST /preflight` | Check one or many pages |
| `GET /preflight` | Same, via query string — handy for curl and browsers |

### Parameters

| Name | Required | Notes |
| ---- | -------- | ----- |
| `org` | yes | DA org the pages are **authored** in |
| `site` | yes | DA site |
| `path` / `paths` | yes | One path, an array, or a comma-separated list |
| `token` | only if the site is protected | IMS token for the DA Source API |

`org` and `site` can be defaulted per-deployment via the `DEFAULT_ORG` and
`DEFAULT_SITE` vars, and `token` via the `DA_TOKEN` secret, which lets callers
send nothing but a path.

Paths are accepted with or without a leading slash and with or without `.html`.
`/` means `/index`.

### Response contract

`status` is the field to route on:

| Value | Meaning |
| ----- | ------- |
| `pass` | Every page satisfied its template's rules |
| `fail` | At least one page has a blocking (`error`) failure, or could not be read |
| `error` | The request itself was bad — missing parameters, malformed JSON |

Only `error`-severity results block. A `warning` appears in `results` and
`counts.failed` but leaves `status` as `pass`.

The HTTP status is **200 for both `pass` and `fail`**, deliberately: a
non-compliant page is a successful answer, and returning 4xx would make Fusion
treat it as a transport error and retry.

## Use from Workfront Fusion

1. **HTTP > Make a request**
   - URL `https://<your-worker>/preflight`
   - Method `POST`, body type `Raw`, content type `application/json`
   - Body: `{"org":"cpilsworth","site":"one-azn-demo","path":"{{page}}"}`
   - Tick *Parse response*
2. **Router** with two routes, filtering on `{{status}}`:
   - `fail` → raise a Workfront issue, post to Slack, block an approval
   - `pass` → carry on
3. Useful fields downstream: `{{reports[].template}}`,
   `{{reports[].failures[].title}}`, `{{reports[].failures[].hint}}`.

The `hint` on each failure is written for an author, so it can be dropped
straight into a ticket or message.

## Configuring the checks

Rules live in [`src/engine/rules.js`](src/engine/rules.js), keyed by template
name:

```js
const rules = {
  '*': [],                          // every page
  'video-page': [
    {
      type: 'block-present',        // block must appear
      name: 'embed',
      min: 1,
      severity: 'error',            // 'error' | 'warning' | 'info'
      title: 'Embed block required',
      description: 'A "video-page" must contain at least one Embed block.',
      hint: 'Add an Embed block and give it the video URL.',
    },
  ],
};
```

Checks for a page are the `'*'` entries plus its template's entries.

| `type` | Options | Passes when |
| ------ | ------- | ----------- |
| `block-present` | `name`, `min` (1), `max`, `variants` | count within `min`..`max` |
| `block-absent` | `name`, `variants` | the block does not appear |

Both authored shapes are recognised — a table whose first cell is the block name
(`| Embed |`) and a normalised `div` (`<div class="embed">`) — so checks work
whichever way the source is stored.

> `src/engine/` is shared with the DA Prepare-menu plugin in
> [`one-azn-demo`](https://github.com/cpilsworth/one-azn-demo)
> (`tools/preflight/`). Keeping the files identical means the interactive plugin
> and this API can never disagree about whether a page passes. Port changes both
> ways.

## Develop

```sh
npm install
npm test          # 23 tests, no network
npm run dev       # wrangler dev, on http://localhost:8787
```

```sh
curl 'http://localhost:8787/preflight?org=cpilsworth&site=one-azn-demo&path=/index'
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

# Only needed when the DA site's source is not publicly readable
npx wrangler secret put DA_TOKEN
```

Edit `wrangler.toml` to set `DEFAULT_ORG` / `DEFAULT_SITE` / `MAX_PAGES`
(default 50) per environment.

## Security

- **Read-only.** The service only ever issues `GET` requests to the DA Source
  API. It cannot modify content.
- **Open by default.** With no `API_KEY` set the endpoint is unauthenticated,
  which is reasonable for checking public content and not much else. Set
  `API_KEY` before exposing it anywhere sensitive.
- **Source visibility is DA's decision, not this service's.** Some DA sites
  serve source publicly; others require a token. This service passes a token
  through when given one and never stores it.
- Batches are capped (`MAX_PAGES`) so an automation cannot turn the endpoint
  into an amplifier against DA.

## Layout

| Path | Role |
| ---- | ---- |
| `src/worker.js` | HTTP adapter: routing, validation, CORS, auth |
| `src/preflight.js` | Service core — fetch, check, aggregate. Runtime-agnostic |
| `src/dom.js` | Installs `DOMParser` (Workers and Node lack one) |
| `src/engine/checks.js` | Document parsing and check implementations |
| `src/engine/rules.js` | **The rules — edit this** |
| `test/` | Tests and a dependency-free runner |

## Licence

Apache-2.0
