# Changelog

All notable changes to `wity-ai-provider`. Versions follow [semver](https://semver.org). Before 1.0, a minor version can add features.

## 0.2.0 (2026-10-26)

### Added

- **Split and extract tools.** `wity.tools.split()` and `wity.tools.extract()` give an agent on any other model Wity's split and extract. The model decides when to call them; Wity reads the document.
  - `split` cuts a document into whole items, like emails in a thread. It returns the items in order, each exactly as written.
  - `extract` pulls named fields out of a document. It returns each field's values as written, or `[]` when there are none.
  - The tools use the provider's key, address, headers and fetch. A failed call isn't retried: the AI SDK shows the error to the model as the tool's result.
- **Update notice.** On Node at a terminal, the provider tells you on stderr when a newer `wity-ai-provider` is on npm, at most once a day. The check runs in the background and never keeps your program running. It stays quiet in CI, when output is piped, and on servers. `WITY_NO_UPDATE_CHECK=1` turns it off.
- The `WityTools` type.

## 0.1.0 (2026-10-12)

First release.

- `wity.decisionModel("wity-1")`: Wity as a decision model for the AI SDK's `experimental_decide`.
- Yes/no, choice and score questions, with a probability for every option.
- State as text, JSON or one image.
- `reasoning` and `maxLatencyMs` through `providerOptions.wity`.
- `createWity` for your own key, address, headers or fetch.
