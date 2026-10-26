import { deflateSync } from "node:zlib";
import { APICallError } from "@ai-sdk/provider";
import { experimental_decide } from "ai";
import { describe, expect, it } from "vitest";
import { createWity, wity } from "../src/index";

// Real calls to Wity. Run with `npm run test:live` (needs WITY_API_KEY). About 6 billed calls, under a cent.
const live = describe.skipIf(!process.env.WITY_LIVE);

/** A small solid-colour PNG, built here so the test needs no image file. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3] ?? 0)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", pixels),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

live("live Wity", () => {
  it("answers all three question types", async () => {
    const result = await experimental_decide({
      model: wity.decisionModel("wity-1"),
      state: "I was charged twice for my subscription this month. Please refund one of them today.",
      questions: {
        team: {
          type: "choice",
          instructions: "Which team should handle this ticket?",
          criteria: { billing: "Payments, charges and refunds", technical: "Bugs and outages", other: null },
        },
        urgent: { type: "boolean", instructions: "Does the customer ask for something to happen soon?" },
        severity: { type: "score", instructions: "How much is this hurting the customer?", criteria: ["Not at all", "A little", "A lot"] },
      },
    });
    expect(result.answers.team.choice).toBe("billing");
    expect(result.answers.urgent.probability).toBeGreaterThan(0.5);
    expect(result.answers.severity.score).toBeGreaterThanOrEqual(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.response.modelId).toBe("wity-1");
  }, 60_000);

  it("thinks when asked and keeps the answer from before", async () => {
    const result = await experimental_decide({
      model: wity.decisionModel("wity-1"),
      state: { message: "Can you look at my invoice when you get a chance?", plan: "pro" },
      questions: {
        urgent: {
          type: "boolean",
          instructions: "Does the customer ask for something to happen soon?",
          criteria: { true: "They want it fast" },
        },
      },
      providerOptions: { wity: { reasoning: "always" } },
    });
    const wityMeta = result.providerMetadata?.wity as { reasoning: Record<string, { thought: boolean }>; directProbabilities: Record<string, number> };
    expect(wityMeta.reasoning.urgent?.thought).toBe(true);
    expect(typeof wityMeta.directProbabilities.urgent).toBe("number");
  }, 120_000);

  it("reads one image", async () => {
    const result = await experimental_decide({
      model: wity.decisionModel("wity-1"),
      state: [
        { type: "text", text: "A product photo." },
        { type: "file", mediaType: "image/png", data: solidPng(64, 64, [220, 20, 20]) },
      ],
      questions: {
        colour: {
          type: "choice",
          instructions: "What colour is the image?",
          criteria: { red: "Red", green: "Green", blue: "Blue" },
        },
      },
      providerOptions: { wity: { reasoning: "off" } },
    });
    expect(result.answers.colour.choice).toBe("red");
  }, 60_000);

  it("gives a 401 APICallError for a wrong key", async () => {
    const error = await experimental_decide({
      model: createWity({ apiKey: "wity_wrong_key_000000000000" }).decisionModel("wity-1"),
      state: "hello",
      questions: { q: { type: "boolean", instructions: "Is this a greeting?" } },
      maxRetries: 0,
    }).catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(401);
  }, 60_000);

  const thread = "From: dana@example.com\nSeal test failed.\n\nFrom: marcus@example.com\nRerun it on 9 October 2025.";
  const options = { toolCallId: "call_1", messages: [], context: {} };

  it("splits a thread into emails", async () => {
    const items = await wity.tools.split().execute?.({ text: thread, split: "one item per email" }, options);
    expect(items).toHaveLength(2);
  }, 150_000);

  it("extracts the senders", async () => {
    const fields = { sender: "The email address each email is from" };
    // The tool returns one result, never a stream.
    const values = (await wity.tools.extract().execute?.({ text: thread, fields }, options)) as Record<string, string[]>;
    // Extract can differ between runs, so check the wiring, not every value.
    expect(values?.sender).toContain("dana@example.com");
    for (const value of values?.sender ?? []) expect(thread).toContain(value);
  }, 150_000);
});
