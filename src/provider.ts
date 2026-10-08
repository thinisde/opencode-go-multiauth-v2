import { Model, Provider, type Plugin } from "@opencode/plugin"
import type { ModelConfig, ResolvedProfile } from "./config.js"
import { cloneDefaultModels, DEFAULT_MODELS } from "./models.js"

const PROBE_TIMEOUT_MS = 3000

async function timedFetch(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export interface ProviderSource {
  info: Provider.Info
  models: Model.Info[]
}

const OPENAI_PACKAGE = "@opencode/ai/providers/openai-compatible"
const ANTHROPIC_PACKAGE = "@opencode/ai/providers/anthropic"

function nativePackage(value: string | undefined): string | undefined {
  if (value === "@ai-sdk/openai-compatible") return OPENAI_PACKAGE
  if (value === "@ai-sdk/anthropic") return ANTHROPIC_PACKAGE
  return value
}

export async function buildProviderConfig(
  profile: ResolvedProfile,
): Promise<ProviderSource> {
  let models = profile.models

  if (!models) {
    try {
      models = await fetchAndProbeModels(profile)
    } catch {
      console.warn(`[opencode-go-multi-auth] Failed to dynamically fetch models for ${profile.id}; using the default catalog.`)
      models = cloneDefaultModels()

      // Fallback: qwen models require the Anthropic messages format.
      for (const [id, model] of Object.entries(models)) {
        if (id.startsWith("qwen")) {
          model.package = ANTHROPIC_PACKAGE
        }
      }
    }
  }

  const providerID = Provider.ID.make(profile.providerId)
  return {
    info: {
      ...Provider.Info.empty(providerID),
      name: profile.name,
      activation: "enabled",
      package: OPENAI_PACKAGE,
      settings: { apiKey: profile.apiKey, baseURL: profile.baseURL },
    },
    models: Object.entries(models).map(([id, definition]) => {
      const { provider: legacy, ...overrides } = definition
      return {
        ...Model.Info.default(providerID, Model.ID.make(id)),
        ...overrides,
        id: Model.ID.make(id),
        providerID,
        modelID: Model.ID.make(definition.modelID ?? id),
        package: nativePackage(definition.package ?? legacy?.npm),
        ...(legacy?.api ? {
          settings: { baseURL: legacy.api, ...definition.settings },
        } : {}),
      }
    }),
  }
}

export async function registerProfiles(
  provider: Pick<Plugin.Context["provider"], "transform">,
  profiles: ResolvedProfile[],
): Promise<void> {
  // Network work must finish before registering the synchronous, replayable transform.
  const sources = await Promise.all(profiles.map(buildProviderConfig))
  await provider.transform((editor) => {
    for (const [index, source] of sources.entries()) {
      const profile = profiles[index]
      const models = source.models.map((model) => {
        // Source records include inactive built-ins, so no account must be
        // authenticated just to inherit its catalog's reasoning controls.
        const catalog = editor.get("opencode-go")?.models.get(model.modelID)
          ?? editor.get("opencode")?.models.get(model.modelID)
        if (!catalog) return model

        const explicit = profile.models?.[model.id]
        const inherited: Partial<Model.Info> = {}
        // Variant settings must use the same native protocol as their catalog
        // model (for example, Muse uses Responses). Explicit routing wins.
        if (model.package === undefined && !explicit?.package && !explicit?.provider?.npm) {
          Object.assign(inherited, { package: catalog.package })
        }
        for (const key of ["variants", "capabilities", "compatibility", "limit", "family", "time"] as const) {
          if (explicit?.[key] === undefined) {
            Object.assign(inherited, { [key]: structuredClone(catalog[key]) })
          }
        }
        // Credentials, URLs, and base request settings stay account-specific.
        return { ...model, ...inherited }
      })
      editor.add({ ...source, models })
    }
  })
}

async function fetchAndProbeModels(profile: ResolvedProfile): Promise<Record<string, ModelConfig>> {
  const baseUrl = profile.baseURL.replace(/\/+$/, "")
  const modelsUrl = `${baseUrl}/models`

  const res = await timedFetch(modelsUrl, {
    headers: { 'Authorization': `Bearer ${profile.apiKey}` }
  }, PROBE_TIMEOUT_MS)

  if (!res.ok) {
    throw new Error(`Models fetch failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as { data?: { id: string }[] }
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Invalid models response format")
  }

  const discoveredModels = data.data.map(m => m.id)

  // Build a model entry, applying the Anthropic override only when needed.
  const makeEntry = (modelId: string, format: 'oa-compat' | 'anthropic'): ModelConfig => {
    const name = DEFAULT_MODELS.find(m => m.id === modelId)?.name || modelId
    const entry: ModelConfig = { name }
    if (format === 'anthropic') {
      entry.package = ANTHROPIC_PACKAGE
    }
    return entry
  }

  // Known models that require the Anthropic messages format. Used as the
  // default whenever a probe is inconclusive (e.g. times out at startup).
  const requiresAnthropic = (id: string) => id.startsWith("qwen")

  // Seed EVERY discovered model up front. Model visibility comes from the
  // /models endpoint, not from probe success — so a slow or aborted probe
  // never causes a model (or the whole provider) to disappear.
  const result: Record<string, ModelConfig> = {}
  for (const modelId of discoveredModels) {
    result[modelId] = makeEntry(modelId, requiresAnthropic(modelId) ? 'anthropic' : 'oa-compat')
  }

  // Probe in parallel ONLY to refine the detected format. A failed/aborted
  // probe leaves the seeded default in place.
  const probes = discoveredModels.map(async (modelId) => {
    try {
      const oaRes = await timedFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${profile.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'probe' }],
          max_tokens: 1
        })
      }, PROBE_TIMEOUT_MS)

      if (oaRes.ok) {
        return { id: modelId, format: 'oa-compat' as const }
      }

      const errText = await oaRes.text()
      if (errText.includes('not supported for format oa-compat')) {
        const antRes = await timedFetch(`${baseUrl.replace(/\/v1$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': profile.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'probe' }],
            max_tokens: 1
          })
        }, PROBE_TIMEOUT_MS)

        if (antRes.ok) {
          return { id: modelId, format: 'anthropic' as const }
        }
      }
    } catch {
      // Ignore network errors / aborts on individual probes; keep the default.
    }
    return { id: modelId, format: 'unknown' as const }
  })

  const probeResults = await Promise.all(probes)

  for (const pr of probeResults) {
    if (pr.format === 'unknown') continue // keep the seeded default
    result[pr.id] = makeEntry(pr.id, pr.format)
  }

  return result
}
