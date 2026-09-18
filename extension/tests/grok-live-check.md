# Grok export investigation — 2026-09-18

## Verified evidence and limits

- The reported error is emitted by `parseDom`, after the API attempt. It implies that a Grok content script answered the popup; it does not identify which API request failed.
- The manifest still matches `https://grok.com/*` and `https://www.grok.com/*`, loading converter → Grok adapter → Grok content script in the isolated world. The Grok entry was not changed.
- Browser automation could not connect to the user's browser. No authenticated short/long conversation smoke was possible. Cookies were neither read nor exported. Requests continue to use same-origin URLs with `credentials: "include"`; actual cookie transmission in the user's Chrome is unverified.
- The public `https://grok.com/` HTML returned HTTP 200. Its current official bundles were fetched directly from `cdn.grok.com`, not inferred from old fixtures:
  - [Message components](https://cdn.grok.com/_next/static/chunks/0ebzxd4cfxkye.js): message bubbles are normal `div` elements with `role="article"` and `data-testid="user-message"` or `"assistant-message"`. System-origin bubbles additionally have `data-origin`; surrounding rows have `data-scroll-anchor-root` and an ID. The old adapter only recognized `data-message-author-role`.
  - [API definitions](https://cdn.grok.com/_next/static/chunks/40iv50z-flmca.js): metadata is `GET /rest/app-chat/conversations_v2/{id}`, nodes are `GET /rest/app-chat/conversations/{id}/response-node` returning `responseNodes`, bodies are `POST /rest/app-chat/conversations/{id}/load-responses` with `{responseIds}` returning `responses`.
  - [Current application callers](https://cdn.grok.com/_next/static/chunks/0sl8ao_svsuhg.js) still call the node and load APIs. Routing includes `/chat/:chatId`, already supported by this adapter.
  - `GET /rest/app-chat/conversations/{id}/responses` also exists in the current API definitions. `POST` on the same path creates a response, so it must not be used as an export probe. There is no evidence that replacing the existing transcript flow with this endpoint is needed.
- Unauthenticated probes using a synthetic all-zero conversation UUID returned HTTP **401**, `application/json`, top-level fields `code`, `message`, `details` for each of the four read paths above (including POST load-responses). This does **not** establish authenticated endpoint availability or explain the user's API failure.
- There is no saved yesterday/live comparison. The current DOM incompatibility is verified, but its deployment date and the user's API failure trigger remain unknown. Do not describe the API as removed or claim a confirmed same-day migration.

## Minimal changes

- Add the two verified test-ID selectors; retain the old role selectors. Ignore hidden/system-origin bubbles and duplicate/nested messages. Never concatenate API and DOM transcripts.
- A metadata HTTP/JSON failure no longer prevents trying the node/body APIs. Existing completeness and ID validation remain in place.
- Preserve safe request diagnostics through both successful fallback and total failure: conversation ID, request method/path, status, content type, top-level keys, selector counts, iframe count and fallback reason. Do not log body values, cookies, tokens or exception text from JSON/network parsing.
- Key in-flight captures by URL, and prevent an old promise's completion from clearing the new conversation's pending request. Check the URL before requests and before returning/exporting.
- Only Grok receives the new popup formatting. ChatGPT converter/content/injection code is unchanged by this fix.

## Validation

- `tests/grok.html`, executed with jsdom 26: PASS. Covers original API/DOM fixture, new DOM markup, metadata failure with successful API transcript, 401/403 fallback, diagnostic privacy/content type, missing body fallback, a 120-message API transcript preferred over a two-message DOM, and navigation rejection.
- `node extension/tests/grok-regression.cjs` from repository root: PASS. ChatGPT fixture Markdown matches the previous converter, filenames are unchanged, manifest/script matching passes, and concurrent SPA captures plus failure diagnostics pass.
- `node tests/test_platform_adapters.js` from repository root: PASS.
- `python3 -m unittest discover -s tests -v` from repository root: 12 tests PASS. Existing uncommitted model/adapter work was present and was not included in this commit.
- Initial existing-suite runs from `extension/` failed to resolve repository-relative imports; running from the documented repository root resolved that invocation issue.

## Required Chrome confirmation

Reload the unpacked extension in Chrome's extensions page, then refresh the Grok conversation tab. Export one short conversation and one existing long conversation; verify the long conversation uses `Completeness: API` and contains its first and last turns. Switch conversations without reloading and check the ID/title and exported content.

If only `DOM_PARTIAL` or an error remains, send the popup diagnostic text (not a Network response body or Cookie headers). It now identifies the failing request/status/schema. DOM fallback includes only currently loaded messages and is not proof of complete long-conversation export.
