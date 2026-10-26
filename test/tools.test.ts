import { APICallError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createWity } from "../src/index";

const EMAIL = "From: dana@example.com\nSeal test failed.\n\nFrom: marcus@example.com\nRerun tomorrow.";

const splitReply = {
  items: [
    { start: 0, end: 40, text: EMAIL.slice(0, 40) },
    { start: 42, end: EMAIL.length, text: EMAIL.slice(42) },
  ],
  how: "model",
  timing_ms: { total: 84 },
  usage: { input_tokens: 412, output_tokens: 0 },
};

const extractReply = {
  fields: { sender: ["dana@example.com", "marcus@example.com"], constructor: [] },
  entities: [
    { field: "sender", text: "dana@example.com", start: 6, end: 22, confidence: 0.98 },
    { field: "sender", text: "marcus@example.com", start: 48, end: 66, confidence: 0.97 },
  ],
  timing_ms: 503,
  usage: { input_tokens: 301, output_tokens: 0 },
};

/** A Wity provider whose fetch answers with `body` and `status`, and records each request. */
function wityWith(body: unknown, status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { wity: createWity({ apiKey: "wity_test_key", baseURL: "https://wity.test", fetch }), calls };
}

const callOptions = { toolCallId: "call_1", messages: [], context: {} };

describe("wity.tools.split", () => {
  it("returns the items as text", async () => {
    const { wity, calls } = wityWith(splitReply);
    const items = await wity.tools.split().execute?.({ text: EMAIL, split: "one item per email" }, callOptions);
    expect(items).toEqual([EMAIL.slice(0, 40), EMAIL.slice(42)]);
    expect(calls[0]?.url).toBe("https://wity.test/v1/split");
    expect(calls[0]?.body).toEqual({ text: EMAIL, split: "one item per email" });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer wity_test_key");
    expect(calls[0]?.headers.get("user-agent")).toContain("wity-ai-provider/");
  });

  it("leaves the default split to Wity", async () => {
    const { wity, calls } = wityWith(splitReply);
    await wity.tools.split().execute?.({ text: EMAIL }, callOptions);
    expect(calls[0]?.body).toEqual({ text: EMAIL });
  });

  it("raises Wity's error message", async () => {
    const { wity } = wityWith({ error: "text must be 1 to 60000 characters" }, 400);
    const call = wity.tools.split().execute?.({ text: "" }, callOptions);
    await expect(call).rejects.toThrow(APICallError);
    await expect(call).rejects.toThrow("text must be 1 to 60000 characters");
  });
});

describe("wity.tools.extract", () => {
  it("returns each field's values, even fields named like object keys", async () => {
    const { wity, calls } = wityWith(extractReply);
    const fields = { sender: "Who each email is from", constructor: "Who built it" };
    const values = await wity.tools.extract().execute?.({ text: EMAIL, fields }, callOptions);
    expect(values).toEqual({ sender: ["dana@example.com", "marcus@example.com"], constructor: [] });
    expect(calls[0]?.url).toBe("https://wity.test/v1/extract");
    expect(calls[0]?.body).toEqual({ text: EMAIL, fields });
  });
});

describe("in an agent", () => {
  it("runs when the model calls it, and the model sees the result", async () => {
    const { wity, calls } = wityWith(extractReply);
    const prompts: unknown[] = [];
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        step += 1;
        const usage = {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        };
        if (step === 1) {
          const input = JSON.stringify({ text: EMAIL, fields: { sender: "Who each email is from" } });
          return {
            content: [{ type: "tool-call", toolCallId: "call_1", toolName: "wityExtract", input }],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "dana and marcus" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const result = await generateText({
      model,
      prompt: `Who wrote these emails?\n\n${EMAIL}`,
      tools: { wityExtract: wity.tools.extract() },
      stopWhen: () => step >= 2,
    });

    expect(result.text).toBe("dana and marcus");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(prompts[1])).toContain("marcus@example.com");
  });
});
