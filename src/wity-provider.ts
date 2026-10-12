import { type Experimental_DecisionModelV4 as DecisionModelV4, NoSuchModelError, type ProviderV4 } from "@ai-sdk/provider";
import { type FetchFunction, loadApiKey, loadOptionalSetting, withoutTrailingSlash } from "@ai-sdk/provider-utils";
import { WityDecisionModel, type WityDecisionModelId } from "./wity-decision-model";

/** Wity as an AI SDK provider. Wity only makes decisions, so only `decisionModel` works. */
export interface WityProvider extends ProviderV4 {
  decisionModel(modelId: WityDecisionModelId): DecisionModelV4;
}

export interface WityProviderSettings {
  /** API key. Defaults to the WITY_API_KEY environment variable. */
  apiKey?: string;
  /**
   * Wity's address. A trailing `/v1` is dropped. Defaults to the WITY_BASE_URL environment variable,
   * then https://api.wity.alphanimble.com.
   */
  baseURL?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Your own fetch, for example to add a proxy or for tests. */
  fetch?: FetchFunction;
}

export function createWity(options: WityProviderSettings = {}): WityProvider {
  // Paths are added per request, so an address copied with `/v1` would call `/v1/v1/...`.
  const baseURL = (
    withoutTrailingSlash(
      loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: "WITY_BASE_URL" }),
    ) ?? "https://api.wity.alphanimble.com"
  ).replace(/\/v1$/, "");

  // Read the key on each call, not here, so a key set after import still works.
  // Trimmed, because a key pasted with a leading space would otherwise be sent as "Bearer  wity_...".
  const headers = () => ({
    Authorization: `Bearer ${loadApiKey({
      apiKey: options.apiKey,
      environmentVariableName: "WITY_API_KEY",
      description: "Wity",
    }).trim()}`,
    ...options.headers,
  });

  const decisionModel = (modelId: WityDecisionModelId) =>
    new WityDecisionModel(modelId, { provider: "wity.decision", baseURL, headers, fetch: options.fetch });

  return {
    specificationVersion: "v4",
    decisionModel,
    languageModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    },
    embeddingModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
  };
}

/** The default provider. Reads WITY_API_KEY and WITY_BASE_URL. */
export const wity = createWity();
