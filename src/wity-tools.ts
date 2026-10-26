import {
  createJsonResponseHandler,
  type FetchFunction,
  postJsonToApi,
  type Resolvable,
  resolve,
  tool,
  withUserAgentSuffix,
} from "@ai-sdk/provider-utils";
import * as z from "zod/v4";
import { VERSION } from "./version";
import { wityExtractResponseSchema, wityFailedResponseHandler, witySplitResponseSchema } from "./wity-api";

export type WityToolsConfig = {
  baseURL: string;
  headers: Resolvable<Record<string, string | undefined>>;
  fetch?: FetchFunction;
};

const textSchema = z.string().describe("The whole document, up to 60,000 characters.");

/** Wity's split and extract as AI SDK tools. The agent's model calls them; Wity reads the document. */
export function createWityTools(config: WityToolsConfig) {
  async function post<T>(path: string, body: Record<string, unknown>, schema: z.ZodType<T>, abortSignal?: AbortSignal) {
    const { value } = await postJsonToApi({
      url: `${config.baseURL}${path}`,
      headers: withUserAgentSuffix(await resolve(config.headers), `wity-ai-provider/${VERSION}`),
      body,
      abortSignal,
      fetch: config.fetch,
      failedResponseHandler: wityFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(schema),
    });
    return value;
  }

  return {
    /** Cut a document into whole items, like emails in a thread. Returns each item exactly as written. */
    split: () =>
      tool({
        description:
          "Cut a document into whole items, like emails in a thread, clauses in a contract or entries in a log. " +
          "Returns the items in order, each exactly as written in the document.",
        inputSchema: z.object({
          text: textSchema,
          split: z
            .string()
            .optional()
            .describe('What one item is, in plain words, like "one item per email". Leave out for paragraphs.'),
        }),
        execute: async ({ text, split }, { abortSignal }) => {
          const response = await post(
            "/v1/split",
            { text, ...(split !== undefined && { split }) },
            witySplitResponseSchema,
            abortSignal,
          );
          return response.items.map((item) => item.text);
        },
      }),

    /** Pull named fields out of a document. Returns each field's values exactly as written. */
    extract: () =>
      tool({
        description:
          "Pull named fields out of a document, like names, dates, amounts or parties. " +
          "Returns each field's values exactly as written, or an empty list when the document has none.",
        inputSchema: z.object({
          text: textSchema,
          fields: z
            .record(z.string(), z.string())
            .describe('Field name to what it asks for, like {"party": "Who signs"}. 1 to 16 fields.'),
        }),
        execute: async ({ text, fields }, { abortSignal }) => {
          const response = await post("/v1/extract", { text, fields }, wityExtractResponseSchema, abortSignal);
          return response.fields;
        },
      }),
  };
}

export type WityTools = ReturnType<typeof createWityTools>;
