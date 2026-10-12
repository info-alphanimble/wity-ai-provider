import { readFileSync } from "node:fs";
import { APICallError, InvalidArgumentError, LoadAPIKeyError, NoSuchModelError } from "@ai-sdk/provider";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@ai-sdk/provider-utils";
import { type Experimental_DecisionQuestion, experimental_decide } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWity, VERSION } from "../src/index";
import { WityDecisionModel } from "../src/wity-decision-model";

type Fixture = { status: number; body: Record<string, unknown> };

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(`test/fixtures/${name}.json`, "utf8"));
}

/** A fetch that answers with the given fixtures in order, and records each request. */
function fakeFetch(...responses: (Fixture | Response)[]) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next?.body), {
      status: next?.status,
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
    });
  });
  return { fetch, calls };
}

function model(...responses: (Fixture | Response)[]) {
  const fake = fakeFetch(...responses);
  const provider = createWity({ apiKey: "wity_test_key", baseURL: "https://wity.test", fetch: fake.fetch });
  return { model: provider.decisionModel("wity-1"), calls: fake.calls, fetch: fake.fetch };
}

// The questions that the multi-auto fixture answers.
const questions = {
  team: {
    type: "choice",
    instructions: "Which team should handle this ticket?",
    criteria: { billing: "Payments, charges and refunds", technical: "Bugs, errors and outages", other: "Anything else" },
  },
  urgent: {
    type: "boolean",
    instructions: "Does the customer ask for something to happen soon?",
    criteria: { true: "They ask for fast action", false: "No time pressure" },
  },
  severity: {
    type: "score",
    instructions: "How much is this hurting the customer?",
    criteria: ["Not at all", "A little", "A lot"],
  },
} as const satisfies Record<string, Experimental_DecisionQuestion>;

const state = "I was charged twice for my subscription this month. Please refund one of them today.";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request", () => {
  it("sends one request in Wity's shape", async () => {
    const { model: m, calls } = model(fixture("multi-auto"));
    await m.doDecide({ state: [{ type: "text", text: state }], questions });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://wity.test/v1/systemone");
    expect(calls[0]?.body).toEqual({
      model: "wity-1",
      state,
      questions: {
        team: questions.team,
        urgent: { ...questions.urgent, type: "noul" },
        severity: questions.severity,
      },
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer wity_test_key");
    expect(calls[0]?.headers.get("user-agent")).toContain(`wity-ai-provider/${VERSION}`);
  });

  it("turns JSON state, JSON text and missing descriptions into strings", async () => {
    const { model: m, calls } = model(fixture("multi-auto"));
    await m.doDecide({
      state: [
        { type: "text", text: "Ticket:" },
        { type: "json", value: { message: "charged twice", plan: "pro" } },
      ],
      questions: {
        team: { type: "choice", instructions: { ask: "Which team?" }, criteria: { billing: null, other: ["misc"] } },
        severity: { type: "score", instructions: "How bad?", criteria: [null, "Bad", null] },
        urgent: { type: "boolean", instructions: "Urgent?", criteria: { true: "Today" } },
        refund: { type: "boolean", instructions: "Refund?", criteria: { true: null, false: null } },
      },
    });

    expect(calls[0]?.body.state).toBe('Ticket:\n{"message":"charged twice","plan":"pro"}');
    expect(calls[0]?.body.questions).toEqual({
      team: { type: "choice", instructions: '{"ask":"Which team?"}', criteria: { billing: "billing", other: '["misc"]' } },
      severity: { type: "score", instructions: "How bad?", criteria: ["Level 0", "Bad", "Level 2"] },
      urgent: { type: "noul", instructions: "Urgent?", criteria: { true: "Today", false: "No" } },
      refund: { type: "noul", instructions: "Refund?" },
    });
  });

  it("sends one image as a data URL", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { model: m, calls } = model(fixture("noul"));
    await m.doDecide({
      state: [
        { type: "text", text: "Is it damaged?" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: png } },
      ],
      questions: { urgent: questions.urgent },
    });
    expect(calls[0]?.body.image).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(calls[0]?.body.state).toBe("Is it damaged?");
  });

  it("refuses a second image and files that aren't images", async () => {
    const { model: m, calls } = model(fixture("noul"));
    const image = { type: "file", mediaType: "image/png", data: { type: "data", data: "iVBORw0KGgo=" } } as const;
    await expect(m.doDecide({ state: [image, image], questions: { urgent: questions.urgent } })).rejects.toThrow(
      /More than one image/,
    );
    await expect(
      m.doDecide({
        state: [{ type: "file", mediaType: "application/pdf", data: { type: "data", data: "JVBERi0=" } }],
        questions: { urgent: questions.urgent },
      }),
    ).rejects.toThrow(/other than an image/);
    expect(calls).toHaveLength(0);
  });

  it("checks Wity's option and level limits before calling", async () => {
    const { model: m, calls } = model(fixture("choice"));
    const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `Option ${i}`]));
    const choice = (n: number) => ({ q: { type: "choice", instructions: "Pick", criteria: options(n) } }) as const;

    await expect(m.doDecide({ state: [], questions: choice(1) })).rejects.toThrow(InvalidArgumentError);
    await expect(m.doDecide({ state: [], questions: choice(129) })).rejects.toThrow(/2 to 128 options/);
    const levels = Array.from({ length: 11 }, (_, i) => `L${i}`);
    await expect(
      m.doDecide({ state: [], questions: { q: { type: "score", instructions: "Rate", criteria: levels } } }),
    ).rejects.toThrow(/at most 10 levels/);
    expect(calls).toHaveLength(0);

    await m.doDecide({ state: [], questions: choice(128) });
    expect(calls).toHaveLength(1);
  });

  it("refuses __proto__ as an option name or question ID before calling", async () => {
    const { model: m, calls } = model(fixture("choice"));
    const criteria = JSON.parse('{"__proto__": "Payments", "technical": "Bugs"}');
    await expect(
      m.doDecide({ state: [], questions: { team: { type: "choice", instructions: "Pick", criteria } } }),
    ).rejects.toThrow(/"__proto__" can't be used as an option name/);
    await expect(
      m.doDecide({ state: [], questions: JSON.parse('{"__proto__": {"type": "boolean", "instructions": "Urgent?"}}') }),
    ).rejects.toThrow(/"__proto__" can't be used as a question ID/);
    expect(calls).toHaveLength(0);
  });

  it("says which ai version is needed when the state isn't a list of parts", async () => {
    const { model: m, calls } = model(fixture("choice"));
    // ai before 7.0.133 passes the state as it was given.
    const old = { state, questions } as unknown as Parameters<typeof m.doDecide>[0];
    await expect(m.doDecide(old)).rejects.toThrow(/needs ai 7\.0\.133 or newer/);
    expect(calls).toHaveLength(0);
  });

  it("sends reasoning and maxLatencyMs, and warns about unknown options", async () => {
    const { model: m, calls } = model(fixture("multi-auto"));
    const result = await m.doDecide({
      state: [{ type: "text", text: state }],
      questions,
      providerOptions: { wity: { reasoning: "off", maxLatencyMs: 5000, temperature: 0 } },
    });
    expect(calls[0]?.body).toMatchObject({ reasoning: "off", max_latency_ms: 5000 });
    expect(calls[0]?.body).not.toHaveProperty("temperature");
    expect(result.warnings).toEqual([{ type: "unsupported", feature: "providerOptions.wity.temperature" }]);
  });

  it("refuses bad option values before calling", async () => {
    const { model: m, calls } = model(fixture("multi-auto"));
    for (const wity of [{ reasoning: "sometimes" }, { maxLatencyMs: 100 }, { maxLatencyMs: 500.5 }]) {
      await expect(
        m.doDecide({ state: [{ type: "text", text: state }], questions, providerOptions: { wity } }),
      ).rejects.toThrow(InvalidArgumentError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("answers", () => {
  it("maps Wity's answers, metadata and usage", async () => {
    const body = fixture("multi-auto").body as { answers: Record<string, Record<string, unknown>> };
    const { model: m } = model(fixture("multi-auto"));
    const result = await m.doDecide({ state: [{ type: "text", text: state }], questions });

    expect(result.answers).toEqual({
      team: { type: "choice", choice: "billing", probabilities: body.answers.team?.probabilities },
      urgent: { type: "boolean", probability: body.answers.urgent?.noul },
      severity: { type: "score", score: body.answers.severity?.score, probabilities: body.answers.severity?.probabilities },
    });
    expect(result.usage).toEqual({ inputTokens: 287, outputTokens: 0 });
    expect(result.rounding).toBeUndefined();
    expect(result.providerMetadata?.wity?.confidence).toEqual({
      team: body.answers.team?.confidence,
      severity: body.answers.severity?.confidence,
    });
    expect(Object.keys(result.providerMetadata?.wity?.reasoning ?? {})).toEqual(["team", "urgent", "severity"]);
    expect(result.providerMetadata?.wity?.directProbabilities).toEqual({});
    expect(result.response?.modelId).toBe("wity-1");
    expect(result.response?.headers?.["x-request-id"]).toBe("req-1");
    expect(result.response?.body).toEqual(fixture("multi-auto").body);
  });

  it("reads answers for a question ID and option named constructor", async () => {
    // zod before 4.2 refused such objects in z.record; users can be on zod 3.25 or 4.1.
    const constructorAnswer = {
      status: 200,
      body: {
        model: "wity-1",
        answers: { constructor: { type: "choice", choice: "constructor", probabilities: { constructor: 0.8, toString: 0.2 } } },
      },
    };
    const { model: m } = model(constructorAnswer);
    const result = await m.doDecide({
      state: [{ type: "text", text: state }],
      questions: { constructor: { type: "choice", instructions: "Pick", criteria: { constructor: "A", toString: "B" } } as const },
    });
    expect(result.answers.constructor).toEqual({ type: "choice", choice: "constructor", probabilities: { constructor: 0.8, toString: 0.2 } });
  });

  it("keeps the answer from before thinking", async () => {
    const thought = fixture("reasoning-always").body as { answers: { team: Record<string, unknown> } };
    const { model: m } = model(fixture("reasoning-always"));
    const result = await m.doDecide({ state: [{ type: "text", text: state }], questions: { team: questions.team } });
    expect(result.providerMetadata?.wity?.directProbabilities).toEqual({ team: thought.answers.team.direct_probabilities });
    expect(result.providerMetadata?.wity?.reasoning).toEqual({ team: thought.answers.team.reasoning });

    const noul = fixture("noul-always").body as { answers: { urgent: { direct_noul: number } } };
    const { model: m2 } = model(fixture("noul-always"));
    const result2 = await m2.doDecide({ state: [{ type: "text", text: state }], questions: { urgent: questions.urgent } });
    expect(result2.providerMetadata?.wity?.directProbabilities).toEqual({ urgent: noul.answers.urgent.direct_noul });
  });
});

describe("through experimental_decide", () => {
  // Every saved real answer must pass the AI SDK's own checks on probabilities and scores.
  it.each([
    "choice",
    "noul",
    "score",
    "multi-auto",
    "reasoning-always",
    "noul-always",
    "score-always",
  ])("%s passes the AI SDK's answer checks", async (name) => {
    const body = fixture(name).body as { answers: Record<string, { type: string }> };
    const asked = Object.fromEntries(
      Object.keys(body.answers).map((id) => [id, questions[id as keyof typeof questions]]),
    ) as Record<string, Experimental_DecisionQuestion>;
    const { model: m } = model(fixture(name));

    const result = await experimental_decide({ model: m, state, questions: asked });
    expect(Object.keys(result.answers).sort()).toEqual(Object.keys(body.answers).sort());
  });

  it("types the answers from the questions", async () => {
    const { model: m } = model(fixture("multi-auto"));
    const result = await experimental_decide({ model: m, state: { message: state }, questions });
    const team: "billing" | "technical" | "other" = result.answers.team.choice;
    expect(team).toBe("billing");
    expect(result.answers.urgent.probability).toBeGreaterThan(0.5);
    expect(result.usage.inputTokens).toBe(287);
  });

  it("keeps its name in the user agent next to the AI SDK's", async () => {
    const { model: m, calls } = model(fixture("multi-auto"));
    await experimental_decide({ model: m, state, questions });
    const agent = calls[0]?.headers.get("user-agent") ?? "";
    expect(agent).toMatch(/^ai\/\S+ wity-ai-provider\//);
    expect(agent.split(`wity-ai-provider/${VERSION}`)).toHaveLength(2);
  });

  it("retries a 429 and then answers", async () => {
    const { model: m, calls } = model({ status: 429, body: { detail: "Too many requests" } }, fixture("multi-auto"));
    const result = await experimental_decide({ model: m, state, questions });
    expect(calls).toHaveLength(2);
    expect(result.answers.team.choice).toBe("billing");
  });
});

describe("errors", () => {
  async function failure(response: Fixture | Response) {
    const { model: m } = model(response);
    return Promise.resolve(m.doDecide({ state: [{ type: "text", text: state }], questions })).catch((error: unknown) => error);
  }

  it("turns Wity's error bodies into APICallError with Wity's message", async () => {
    const badKey = await failure(fixture("error-bad-key"));
    expect(APICallError.isInstance(badKey)).toBe(true);
    expect((badKey as APICallError).message).toBe("invalid API key");
    expect((badKey as APICallError).statusCode).toBe(401);
    expect((badKey as APICallError).isRetryable).toBe(false);

    const badRequest = (await failure(fixture("error-object-instructions"))) as APICallError;
    expect(badRequest.message).toBe("questions.team.instructions must be a nonempty string of at most 4000 characters");
    expect(badRequest.isRetryable).toBe(false);
  });

  it("marks 402 as final and 429/502/503 as retryable", async () => {
    const noBalance = (await failure({ status: 402, body: { detail: "Insufficient balance" } })) as APICallError;
    expect(noBalance.isRetryable).toBe(false);
    for (const status of [429, 502, 503]) {
      const error = (await failure({ status, body: { error: "busy" } })) as APICallError;
      expect(error.isRetryable).toBe(true);
    }
  });

  it("handles an error page that isn't JSON", async () => {
    const error = (await failure(new Response("<html>Bad Gateway</html>", { status: 502 }))) as APICallError;
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error.statusCode).toBe(502);
    expect(error.isRetryable).toBe(true);
  });

  it("refuses an answer that isn't Wity's shape", async () => {
    const error = await failure({ status: 200, body: { answers: { team: { type: "choice" } } } });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/Invalid JSON response|Type validation failed/);
  });
});

describe("provider", () => {
  it("reads WITY_API_KEY and WITY_BASE_URL when the call is made", async () => {
    const fake = fakeFetch(fixture("multi-auto"));
    const m = createWity({ fetch: fake.fetch }).decisionModel("wity-1");
    vi.stubEnv("WITY_API_KEY", "wity_env_key");
    await m.doDecide({ state: [{ type: "text", text: state }], questions });
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer wity_env_key");
    expect(fake.calls[0]?.url).toBe("https://api.wity.alphanimble.com/v1/systemone");

    vi.stubEnv("WITY_BASE_URL", "https://other.wity.test/");
    await createWity({ fetch: fake.fetch })
      .decisionModel("wity-1")
      .doDecide({ state: [{ type: "text", text: state }], questions });
    expect(fake.calls[1]?.url).toBe("https://other.wity.test/v1/systemone");
  });

  it("drops a trailing /v1 from the address", async () => {
    const fake = fakeFetch(fixture("multi-auto"));
    for (const baseURL of ["https://wity.test/v1", "https://wity.test/v1/"]) {
      await createWity({ apiKey: "k", baseURL, fetch: fake.fetch })
        .decisionModel("wity-1")
        .doDecide({ state: [{ type: "text", text: state }], questions });
    }
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://wity.test/v1/systemone",
      "https://wity.test/v1/systemone",
    ]);
  });

  it("trims spaces and newlines around the key", async () => {
    const fake = fakeFetch(fixture("multi-auto"));
    await createWity({ apiKey: " \twity_k\n", fetch: fake.fetch })
      .decisionModel("wity-1")
      .doDecide({ state: [{ type: "text", text: state }], questions });
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer wity_k");
  });

  it("says clearly when there's no key", async () => {
    vi.stubEnv("WITY_API_KEY", undefined);
    const fake = fakeFetch(fixture("multi-auto"));
    const m = createWity({ fetch: fake.fetch }).decisionModel("wity-1");
    await expect(m.doDecide({ state: [{ type: "text", text: state }], questions })).rejects.toThrow(LoadAPIKeyError);
    expect(fake.calls).toHaveLength(0);
  });

  it("merges provider and call headers, call headers last", async () => {
    const fake = fakeFetch(fixture("multi-auto"));
    const m = createWity({ apiKey: "k", headers: { a: "provider", b: "provider" }, fetch: fake.fetch }).decisionModel(
      "wity-1",
    );
    await m.doDecide({ state: [{ type: "text", text: state }], questions, headers: { b: "call" } });
    expect(fake.calls[0]?.headers.get("a")).toBe("provider");
    expect(fake.calls[0]?.headers.get("b")).toBe("call");
  });

  it("passes the abort signal to fetch", async () => {
    const { model: m, fetch } = model(fixture("multi-auto"));
    const controller = new AbortController();
    await m.doDecide({ state: [{ type: "text", text: state }], questions, abortSignal: controller.signal });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("has only decision models", () => {
    const provider = createWity({ apiKey: "k" });
    expect(provider.decisionModel("wity-1").provider).toBe("wity.decision");
    expect(provider.decisionModel("wity-1").modelId).toBe("wity-1");
    expect(() => provider.languageModel("wity-1")).toThrow(NoSuchModelError);
    expect(() => provider.embeddingModel("wity-1")).toThrow(NoSuchModelError);
    expect(() => provider.imageModel("wity-1")).toThrow(NoSuchModelError);
  });

  it("survives workflow serialization", async () => {
    const fake = fakeFetch(fixture("multi-auto"));
    const original = createWity({ apiKey: "wity_k", fetch: fake.fetch }).decisionModel("wity-1") as WityDecisionModel;
    const serialized = WityDecisionModel[WORKFLOW_SERIALIZE](original);
    const copy = WityDecisionModel[WORKFLOW_DESERIALIZE](
      serialized as unknown as Parameters<(typeof WityDecisionModel)[typeof WORKFLOW_DESERIALIZE]>[0],
    );
    expect(copy.modelId).toBe("wity-1");
    expect(copy.provider).toBe("wity.decision");
    // The custom fetch can't cross a workflow step, so the copy would use the global fetch.
    expect(serialized.config).not.toHaveProperty("fetch");
    expect(serialized.config.headers).toMatchObject({ Authorization: "Bearer wity_k" });

    // The copy names itself once in the user agent, like the original.
    const copyFake = fakeFetch(fixture("multi-auto"));
    const copyWithFetch = new WityDecisionModel("wity-1", { ...copy["config"], fetch: copyFake.fetch });
    await copyWithFetch.doDecide({ state: [{ type: "text", text: state }], questions });
    expect(copyFake.calls[0]?.headers.get("user-agent")?.split(`wity-ai-provider/${VERSION}`)).toHaveLength(2);
  });
});
