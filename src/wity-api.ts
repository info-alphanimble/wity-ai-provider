import { createJsonErrorResponseHandler } from "@ai-sdk/provider-utils";
import * as z from "zod/v4";

// Wity's answer to POST /v1/systemone. Only the fields we read; extra fields are ignored.
const reasoningSchema = z.record(z.string(), z.unknown()).nullish();

/**
 * An object whose values all match `value`. Used instead of z.record for maps keyed by the user's
 * question IDs and option names: before zod 4.2, z.record refuses an object with a "constructor" key.
 */
function recordOf<T extends z.ZodType>(value: T) {
  return z.custom<Record<string, z.output<T>>>(
    (input) =>
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      Object.values(input).every((item) => value.safeParse(item).success),
  );
}

export const wityDecisionResponseSchema = z.object({
  model: z.string().nullish(),
  answers: recordOf(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        probabilities: recordOf(z.number()),
        confidence: z.number().nullish(),
        direct_probabilities: recordOf(z.number()).nullish(),
        reasoning: reasoningSchema,
      }),
      z.object({
        type: z.literal("score"),
        score: z.number(),
        probabilities: recordOf(z.number()),
        confidence: z.number().nullish(),
        direct_probabilities: recordOf(z.number()).nullish(),
        reasoning: reasoningSchema,
      }),
      z.object({
        type: z.literal("noul"),
        noul: z.number(),
        direct_noul: z.number().nullish(),
        reasoning: reasoningSchema,
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .nullish(),
});

// Wity's errors come as {"error": "..."} on /v1/systemone and {"detail": ...} from the gateway.
export const wityFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: z.object({
    error: z.union([z.string(), z.object({ message: z.string().nullish() })]).nullish(),
    detail: z.unknown().nullish(),
    message: z.string().nullish(),
  }),
  errorToMessage: (error) =>
    (typeof error.error === "string" ? error.error : error.error?.message) ??
    error.message ??
    (typeof error.detail === "string" ? error.detail : error.detail != null ? JSON.stringify(error.detail) : null) ??
    "Wity request failed",
});

// Wity's answer to POST /v1/split. Only the items: each one is an exact slice of the text.
export const witySplitResponseSchema = z.object({
  items: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});

// Wity's answer to POST /v1/extract. Only the values by field, which are keyed by the caller's field names.
export const wityExtractResponseSchema = z.object({
  fields: recordOf(z.array(z.string())),
});
