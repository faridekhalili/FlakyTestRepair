import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { config } from './config.js'

/**
 * OpenRouter speaks the OpenAI chat API, so we use Strands' OpenAIModel
 * pointed at the OpenRouter base URL. The concrete model is picked via
 * OPENROUTER_MODEL in .env.
 */
export function createModel() {
  return new OpenAIModel({
    api: 'chat',
    apiKey: config.openRouter.apiKey,
    modelId: config.openRouter.modelId,
    maxTokens: config.openRouter.maxTokens,
    temperature: 0,
    clientConfig: {
      baseURL: config.openRouter.baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'http://localhost',
        'X-OpenRouter-Title': 'flaky-build-orchestrator',
      },
    },
  })
}
