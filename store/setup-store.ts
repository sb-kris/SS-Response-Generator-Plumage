"use client";

import { create } from "zustand";
import type { SurveySparrowRegion } from "@/lib/surveysparrow/regions";
import type { LLMProvider } from "@/lib/llm/models";
import { getProviderDefaultModels } from "@/lib/llm/models";

// IMPORTANT: this store is in-memory only. We deliberately do NOT use any persist
// middleware. API keys must vanish on refresh. Form values like region / model are
// also gone on refresh, but that's a fair trade for the security guarantee.

export type ConnectionStatus = "idle" | "validating" | "ok" | "error";

export interface ChannelConfig {
  /** React key — not sent to the API. */
  id: string;
  channelId: number;
  label: string;
  /** Percentage weight (1–99). All channels should sum to ~100. */
  weight: number;
  /** When true, auto-rebalance never mutates this channel's weight. */
  locked: boolean;
}

export interface ConnectionState {
  status: ConnectionStatus;
  // The error message returned by the API on failure
  error: string | null;
  // Wall-clock timestamp (ms) of the last successful test
  lastSuccessAt: number | null;
  // Optional human-readable detail shown on success (e.g. "Found 12 surveys")
  detail: string | null;
}

const idleConnection: ConnectionState = {
  status: "idle",
  error: null,
  lastSuccessAt: null,
  detail: null,
};

interface SurveySparrowConfig {
  region: SurveySparrowRegion;
  apiKey: string;
  workspaceNickname: string;
  /** When true, push events fire survey notification/automation rules. Default: false. */
  triggerWorkflow: boolean;
  /** When true, responses are distributed across `channels` by weight. */
  channelsEnabled: boolean;
  channels: ChannelConfig[];
}

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  personaModel: string;
  responseModel: string;
  /** OpenRouter only — actual upstream ID when `personaModel` is `openrouter:custom`. */
  customPersonaModelId: string;
  /** OpenRouter only — actual upstream ID when `responseModel` is `openrouter:custom`. */
  customResponseModelId: string;
}

interface SetupStore {
  surveySparrow: SurveySparrowConfig;
  llm: LLMConfig;
  ssConnection: ConnectionState;
  llmConnection: ConnectionState;

  // SurveySparrow
  setSSField: <K extends keyof SurveySparrowConfig>(key: K, value: SurveySparrowConfig[K]) => void;
  setSSConnection: (state: Partial<ConnectionState>) => void;

  // LLM
  setLLMProvider: (provider: LLMProvider) => void;
  setLLMApiKey: (apiKey: string) => void;
  setLLMPersonaModel: (model: string) => void;
  setLLMResponseModel: (model: string) => void;
  setLLMCustomPersonaModelId: (id: string) => void;
  setLLMCustomResponseModelId: (id: string) => void;
  setLLMConnection: (state: Partial<ConnectionState>) => void;

  reset: () => void;
}

const defaultSS: SurveySparrowConfig = {
  region: "us",
  apiKey: "",
  workspaceNickname: "",
  triggerWorkflow: false,
  channelsEnabled: false,
  channels: [],
};

// Default provider: Anthropic stays the default for backward compatibility
// with existing test flows + Phase 4 verification. The UI's "Recommended for
// most SEs" treatment is applied to Google Gemini (economy mode) via the
// model registry — users can pick it explicitly without us flipping the
// default model out from under existing deployments.
const DEFAULT_PROVIDER: LLMProvider = "anthropic";
const defaultDefaultModels = getProviderDefaultModels(DEFAULT_PROVIDER);
const defaultLLM: LLMConfig = {
  provider: DEFAULT_PROVIDER,
  apiKey: "",
  personaModel: defaultDefaultModels.personaModel,
  responseModel: defaultDefaultModels.responseModel,
  customPersonaModelId: "",
  customResponseModelId: "",
};

export const useSetupStore = create<SetupStore>((set) => ({
  surveySparrow: defaultSS,
  llm: defaultLLM,
  ssConnection: idleConnection,
  llmConnection: idleConnection,

  setSSField: (key, value) =>
    set((s) => {
      const next = { ...s.surveySparrow, [key]: value };
      // These fields don't affect API auth — changing them keeps the connection valid.
      const affectsConnection =
        key !== "workspaceNickname" &&
        key !== "triggerWorkflow" &&
        key !== "channelsEnabled" &&
        key !== "channels";
      const ssConnection =
        affectsConnection &&
        (s.ssConnection.status === "ok" || s.ssConnection.status === "error")
          ? idleConnection
          : s.ssConnection;
      return { surveySparrow: next, ssConnection };
    }),
  setSSConnection: (state) =>
    set((s) => ({ ssConnection: { ...s.ssConnection, ...state } })),

  setLLMProvider: (provider) =>
    set((s) => {
      const defaults = getProviderDefaultModels(provider);
      return {
        llm: {
          ...s.llm,
          provider,
          // API key is per-provider sensitive — never carry one across.
          // Keeping it cleared per provider is also the security-correct
          // default since the test-connection state we just invalidated is
          // tied to the previous key anyway.
          apiKey: "",
          personaModel: defaults.personaModel,
          responseModel: defaults.responseModel,
          // OpenRouter sentinel fields are reset whenever the provider
          // changes — they only have meaning under OpenRouter.
          customPersonaModelId: "",
          customResponseModelId: "",
        },
        llmConnection: idleConnection,
      };
    }),
  setLLMApiKey: (apiKey) =>
    set((s) => ({
      llm: { ...s.llm, apiKey },
      llmConnection:
        s.llmConnection.status === "ok" || s.llmConnection.status === "error"
          ? idleConnection
          : s.llmConnection,
    })),
  setLLMPersonaModel: (model) =>
    set((s) => ({
      llm: {
        ...s.llm,
        personaModel: model,
        // If user moves OFF the custom sentinel, the custom ID is no longer
        // meaningful — clear it so a stale value doesn't sneak into a request.
        customPersonaModelId:
          model === "openrouter:custom" ? s.llm.customPersonaModelId : "",
      },
      llmConnection:
        s.llmConnection.status === "ok" || s.llmConnection.status === "error"
          ? idleConnection
          : s.llmConnection,
    })),
  setLLMResponseModel: (model) =>
    set((s) => ({
      llm: {
        ...s.llm,
        responseModel: model,
        customResponseModelId:
          model === "openrouter:custom" ? s.llm.customResponseModelId : "",
      },
      llmConnection:
        s.llmConnection.status === "ok" || s.llmConnection.status === "error"
          ? idleConnection
          : s.llmConnection,
    })),
  setLLMCustomPersonaModelId: (id) =>
    set((s) => ({
      llm: { ...s.llm, customPersonaModelId: id },
      // Changing the upstream ID invalidates the previous test result.
      llmConnection:
        s.llmConnection.status === "ok" || s.llmConnection.status === "error"
          ? idleConnection
          : s.llmConnection,
    })),
  setLLMCustomResponseModelId: (id) =>
    set((s) => ({
      llm: { ...s.llm, customResponseModelId: id },
      llmConnection:
        s.llmConnection.status === "ok" || s.llmConnection.status === "error"
          ? idleConnection
          : s.llmConnection,
    })),
  setLLMConnection: (state) =>
    set((s) => ({ llmConnection: { ...s.llmConnection, ...state } })),

  reset: () =>
    set({
      surveySparrow: defaultSS,
      llm: defaultLLM,
      ssConnection: idleConnection,
      llmConnection: idleConnection,
    }),
}));
