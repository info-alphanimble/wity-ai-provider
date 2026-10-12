import {
  type Experimental_DecisionModelV4 as DecisionModelV4,
  type Experimental_DecisionModelV4Answer as DecisionModelV4Answer,
  type Experimental_DecisionModelV4Input as DecisionModelV4Input,
  type Experimental_DecisionModelV4Question as DecisionModelV4Question,
  InvalidArgumentError,
  type JSONObject,
  type JSONValue,
  type SharedV4Warning,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import {
  combineHeaders,
  convertToBase64,
  createJsonResponseHandler,
  type FetchFunction,
  getTopLevelMediaType,
  isFullMediaType,
  parseProviderOptions,
  postJsonToApi,
  type Resolvable,
  resolve,
  serializeModelOptions,
  WORKFLOW_DESERIALIZE,
  WORKFLOW_SERIALIZE,
  withUserAgentSuffix,
} from "@ai-sdk/provider-utils";
import * as z from "zod/v4";
import { VERSION } from "./version";
import { wityDecisionResponseSchema, wityFailedResponseHandler } from "./wity-api";

export type WityDecisionModelId = "wity-1" | (string & {});

export type WityDecisionModelConfig = {
  provider: string;
  baseURL: string;
  headers: Resolvable<Record<string, string | undefined>>;
  fetch?: FetchFunction;
};

// Wity's limits. Anything else (text lengths, state size) Wity checks itself and answers with a 400.
const MAX_CHOICE_OPTIONS = 128;
const MAX_SCORE_LEVELS = 10;

/** Settings for one call, passed as `providerOptions: { wity: { ... } }`. */
export const wityProviderOptionsSchema = z.object({
  /** When Wity thinks before answering. Wity's default is `off`; `auto` thinks only when a question needs it. */
  reasoning: z.enum(["off", "auto", "always"]).optional(),
  /** Time limit for the request, a whole number from 200 to 120000 ms. */
  maxLatencyMs: z.number().int().min(200).max(120000).optional(),
});

export type WityProviderOptions = z.infer<typeof wityProviderOptionsSchema>;

const KNOWN_OPTIONS = new Set(Object.keys(wityProviderOptionsSchema.shape));

export class WityDecisionModel implements DecisionModelV4 {
  readonly specificationVersion = "v4";
  readonly supportedQuestionTypes = ["choice", "score", "boolean"] as const;

  constructor(
    readonly modelId: WityDecisionModelId,
    private readonly config: WityDecisionModelConfig,
  ) {}

  get provider() {
    return this.config.provider;
  }

  static [WORKFLOW_SERIALIZE](model: WityDecisionModel) {
    return serializeModelOptions({ modelId: model.modelId, config: model.config });
  }

  static [WORKFLOW_DESERIALIZE](options: { modelId: WityDecisionModelId; config: WityDecisionModelConfig }) {
    return new WityDecisionModel(options.modelId, options.config);
  }

  async doDecide({
    state,
    questions,
    headers,
    abortSignal,
    providerOptions,
  }: Parameters<DecisionModelV4["doDecide"]>[0]): Promise<Awaited<ReturnType<DecisionModelV4["doDecide"]>>> {
    const warnings: SharedV4Warning[] = Object.keys(providerOptions?.wity ?? {})
      .filter((option) => !KNOWN_OPTIONS.has(option))
      .map((option) => ({ type: "unsupported", feature: `providerOptions.wity.${option}` }));
    const options = await parseProviderOptions({
      provider: "wity",
      providerOptions,
      schema: wityProviderOptionsSchema,
    });

    const { text, image } = toWityState(state);
    refuseProtoKey(questions, "questions", "a question ID");

    const {
      value: response,
      rawValue,
      responseHeaders,
    } = await postJsonToApi({
      url: `${this.config.baseURL}/v1/systemone`,
      // Added after merging: the AI SDK sends its own user-agent as a call header, which would replace ours.
      headers: withUserAgentSuffix(
        combineHeaders(await resolve(this.config.headers), headers),
        `wity-ai-provider/${VERSION}`,
      ),
      body: {
        model: this.modelId,
        state: text,
        questions: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => [id, toWityQuestion(id, question)]),
        ),
        ...(image !== undefined && { image }),
        ...(options?.reasoning !== undefined && { reasoning: options.reasoning }),
        ...(options?.maxLatencyMs !== undefined && { max_latency_ms: options.maxLatencyMs }),
      },
      abortSignal,
      fetch: this.config.fetch,
      failedResponseHandler: wityFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(wityDecisionResponseSchema),
    });

    // Wity's extras, each keyed by question ID. directProbabilities is the answer before Wity thought.
    const confidence: JSONObject = {};
    const reasoning: JSONObject = {};
    const directProbabilities: JSONObject = {};
    const answers: Record<string, DecisionModelV4Answer> = {};
    for (const [id, answer] of Object.entries(response.answers)) {
      if (answer.reasoning != null) reasoning[id] = answer.reasoning as JSONValue;
      switch (answer.type) {
        case "noul":
          if (answer.direct_noul != null) directProbabilities[id] = answer.direct_noul;
          answers[id] = { type: "boolean", probability: answer.noul };
          break;
        case "choice":
        case "score":
          if (answer.confidence != null) confidence[id] = answer.confidence;
          if (answer.direct_probabilities != null) directProbabilities[id] = answer.direct_probabilities;
          answers[id] =
            answer.type === "choice"
              ? { type: "choice", choice: answer.choice, probabilities: answer.probabilities }
              : { type: "score", score: answer.score, probabilities: answer.probabilities };
          break;
      }
    }

    return {
      answers,
      usage: {
        inputTokens: response.usage?.input_tokens ?? undefined,
        outputTokens: response.usage?.output_tokens ?? undefined,
      },
      warnings,
      providerMetadata: { wity: { confidence, reasoning, directProbabilities } },
      response: {
        modelId: response.model ?? this.modelId,
        headers: responseHeaders,
        body: rawValue,
      },
    };
  }
}

/** Wity takes the state as one string, plus at most one image. */
function toWityState(state: Parameters<DecisionModelV4["doDecide"]>[0]["state"]): { text: string; image?: string } {
  // ai before 7.0.133 passes the state as a plain string or object.
  if (!Array.isArray(state)) {
    throw new InvalidArgumentError({
      argument: "state",
      message: "wity-ai-provider needs ai 7.0.133 or newer. Update the ai package.",
    });
  }
  const texts: string[] = [];
  let image: string | undefined;
  for (const part of state) {
    if (part.type === "text") {
      texts.push(part.text);
    } else if (part.type === "json") {
      texts.push(JSON.stringify(part.value));
    } else {
      if (getTopLevelMediaType(part.mediaType) !== "image" || part.data.type !== "data") {
        throw new UnsupportedFunctionalityError({
          functionality: "Wity decision file input other than an image",
        });
      }
      if (image !== undefined) {
        throw new UnsupportedFunctionalityError({ functionality: "More than one image in a Wity decision" });
      }
      // Wity reads the format from the bytes, so a vague media type is fine.
      const mediaType = isFullMediaType(part.mediaType) ? part.mediaType : "application/octet-stream";
      image = `data:${mediaType};base64,${convertToBase64(part.data.data)}`;
    }
  }
  return { text: texts.join("\n"), ...(image !== undefined && { image }) };
}

/** Wity's question shape: `boolean` is `noul`, text is plain strings, and every option has a description. */
function toWityQuestion(id: string, question: DecisionModelV4Question) {
  const instructions = toText(question.instructions);
  switch (question.type) {
    case "choice": {
      refuseProtoKey(question.criteria, `questions.${id}.criteria`, "an option name");
      const options = Object.entries(question.criteria);
      if (options.length < 2 || options.length > MAX_CHOICE_OPTIONS) {
        throw new InvalidArgumentError({
          argument: `questions.${id}.criteria`,
          message: `Wity Choice questions need 2 to ${MAX_CHOICE_OPTIONS} options. This one has ${options.length}.`,
        });
      }
      return {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(options.map(([name, description]) => [name, toText(description ?? name)])),
      };
    }
    case "score": {
      if (question.criteria.length > MAX_SCORE_LEVELS) {
        throw new InvalidArgumentError({
          argument: `questions.${id}.criteria`,
          message: `Wity Score questions support at most ${MAX_SCORE_LEVELS} levels. This one has ${question.criteria.length}.`,
        });
      }
      return {
        type: "score",
        instructions,
        criteria: question.criteria.map((level, index) => toText(level ?? `Level ${index}`)),
      };
    }
    case "boolean": {
      const yes = question.criteria?.true;
      const no = question.criteria?.false;
      if (yes == null && no == null) return { type: "noul", instructions };
      return { type: "noul", instructions, criteria: { true: toText(yes ?? "Yes"), false: toText(no ?? "No") } };
    }
  }
}

/** The AI SDK refuses any JSON reply with a `__proto__` key, so Wity's answer would be billed and then lost. */
function refuseProtoKey(record: object, argument: string, what: string) {
  if (Object.hasOwn(record, "__proto__")) {
    throw new InvalidArgumentError({ argument, message: `"__proto__" can't be used as ${what} with Wity.` });
  }
}

function toText(value: DecisionModelV4Input): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
