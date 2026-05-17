import type { ProviderConfig } from "../../config/types.js";
import type { Provider } from "./types.js";
import { createOpenAIProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOllamaProvider } from "./ollama.js";

/**
 * Build providers from config. Order is preserved — first provider
 * is the primary, rest are failover candidates.
 */
export function createProviderRegistry(configs: ProviderConfig[]): Provider[] {
  return configs.map((config) => {
    switch (config.type) {
      case "openai":
        return createOpenAIProvider(config);
      case "anthropic":
        return createAnthropicProvider(config);
      case "ollama":
        return createOllamaProvider(config);
      default:
        throw new Error(`Unknown provider type: ${(config as ProviderConfig).type}`);
    }
  });
}
