# Wity provider for the AI SDK

[Wity](https://wity.alphanimble.com) answers fixed-option questions about text in one pass, with a probability for every option. This package makes Wity a decision model for the [Vercel AI SDK](https://ai-sdk.dev)'s `experimental_decide`. It also gives agents Wity's split and extract as tools.

## Install

```sh
npm install wity-ai-provider ai
```

Needs `ai` 7.0.133 or newer and Node 22 or newer. Get an API key at [wity.alphanimble.com/console/keys](https://wity.alphanimble.com/console/keys) and set it as `WITY_API_KEY`.

## Use

```ts
import { experimental_decide } from "ai";
import { wity } from "wity-ai-provider";

const result = await experimental_decide({
  model: wity.decisionModel("wity-1"),
  state: "I was charged twice for my subscription this month. Please refund one of them today.",
  questions: {
    team: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: {
        billing: "Payments, charges and refunds",
        technical: "Bugs, errors and outages",
        other: "Anything else",
      },
    },
    urgent: {
      type: "boolean",
      instructions: "Does the customer ask for something to happen soon?",
    },
    severity: {
      type: "score",
      instructions: "How much is this hurting the customer?",
      criteria: ["Not at all", "A little", "A lot"],
    },
  },
});

result.answers.team.choice;        // "billing"
result.answers.team.probabilities; // { billing: 0.9999, technical: 0.00004, other: 0.00003 }
result.answers.urgent.probability; // 0.9999, the probability of true
result.answers.severity.score;     // 1.98, between 0 and 2
```

All questions are answered in one request against the same state. Choice and score answers include the probability of every option or level.

Wity's probabilities aren't calibrated. Pick thresholds from your own labelled examples.

## Split and extract tools

`wity.tools` has two tools for an agent that runs on any other model. The model decides when to call them; Wity reads the document.

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, isStepCount } from "ai";
import { wity } from "wity-ai-provider";

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: `Who wrote each email in this thread, and what do they ask for?\n\n${thread}`,
  tools: {
    witySplit: wity.tools.split(),
    wityExtract: wity.tools.extract(),
  },
  stopWhen: isStepCount(5),
});
```

- `split()` cuts a document into whole items, like emails in a thread or clauses in a contract. The model says what one item is in plain words, like `"one item per email"`. Without that, Wity cuts one item per paragraph. The tool returns the items in order, each exactly as written.
- `extract()` pulls named fields out of a document. The model names the fields, like `{ party: "Who signs the contract" }`. The tool returns each field's values as written, or `[]` when there are none.

The tools use the provider's key, address, headers and fetch. A document can be up to 60,000 characters. A failed call isn't retried: the AI SDK shows the error to the model as the tool's result.

## Settings

```ts
import { createWity } from "wity-ai-provider";

const wity = createWity({
  apiKey: "wity_...",  // default: WITY_API_KEY
  baseURL: "https://api.wity.alphanimble.com",  // default: WITY_BASE_URL, then this; a trailing /v1 is dropped
  headers: { "x-team": "support" },  // sent with every request
  fetch: myFetch,  // your own fetch
});
```

## Thinking and time limits

By default Wity answers directly, without thinking. Set `reasoning: "auto"` to let it think when a question needs it, such as a close call or a forecast, or `"always"` to make it think every time. Set it per call with `providerOptions.wity`:

```ts
await experimental_decide({
  model: wity.decisionModel("wity-1"),
  state,
  questions,
  providerOptions: {
    wity: {
      reasoning: "auto",    // "off" (Wity's default), "auto" or "always"
      maxLatencyMs: 5000,   // time limit, 200 to 120000 ms
    },
  },
});
```

Each answer's thinking details are in `result.providerMetadata.wity`, keyed by question ID:

- `confidence`: Wity's confidence for choice and score answers. It's a separate number, not the chosen option's probability.
- `reasoning`: whether Wity thought, why, and how many tokens it used. Empty when `reasoning` is `"off"`.
- `directProbabilities`: the answer before Wity thought. Only for questions where it thought.

## State

`state` can be a string, a JSON object, or a list of parts. Text and JSON parts are sent to Wity as one text. You can add one image:

```ts
state: [
  { type: "text", text: "Is the product damaged?" },
  { type: "file", mediaType: "image/png", data: imageBytes },
],
```

Wity reads PNG, JPEG, WebP, GIF and BMP. A second image, or a file that isn't an image, throws `UnsupportedFunctionalityError`.

## Limits

- Choice: 2 to 128 options. Score: 2 to 10 levels. Outside these, the call throws `InvalidArgumentError` before anything is sent.
- Options and levels without a description (`null`) are described by their name, or as `Level 0`, `Level 1` and so on.
- `__proto__` can't be an option name or a question ID. The AI SDK refuses answers that contain it, so the call throws `InvalidArgumentError` before anything is sent.
- Wity checks the rest itself, such as text lengths and state size, and answers with a 400.

## Errors and retries

Failed requests throw the AI SDK's `APICallError`, with Wity's message. The AI SDK retries 429 and 5xx errors twice by default (`maxRetries`). A wrong key (401) or an empty balance (402) is not retried. Failed calls aren't billed.

There's no time limit by default. To stop waiting after 60 seconds, pass an abort signal:

```ts
await experimental_decide({ model: wity.decisionModel("wity-1"), state, questions, abortSignal: AbortSignal.timeout(60_000) });
```

`maxLatencyMs` limits Wity's own work on the request; the abort signal also covers the network.

## Update notice

When code that uses `wity-ai-provider` runs at a terminal, it tells you on stderr when a newer version is out, at most once a day. It asks npm at most once a day, in the background, so nothing waits for it. It stays quiet in CI, when output is piped, and on servers. Set `WITY_NO_UPDATE_CHECK=1` to turn it off. The same variable turns it off in every Wity package.

## Licence

Apache-2.0
