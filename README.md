# opencode-go-multi-auth

OpenCode **V2** plugin that exposes multiple OpenCode Go subscription identities as separate, selectable providers, each backed by its own API key.

Select an account by choosing its model namespace, such as `opencode-go-personal/glm-5.1` or `opencode-go-work/glm-5.1`. Each provider has independent credentials. The plugin discovers the live model catalog and probes each model's API format, using native OpenAI-compatible or Anthropic-compatible routing as appropriate.

Version 0.2.1 targets the OpenCode V2 plugin API shipped with `@opencode/plugin` **2.0.24**. It does not expose the V1 plugin function. For OpenCode V1, use the earlier 0.1.x implementation.

## Install

```bash
git clone https://github.com/schlambos/opencode-go-multiauth.git
cd opencode-go-multiauth
npm install
npm run build
```

Use Node.js 20 or later to build. Keep the clone and its `node_modules` on disk: OpenCode imports `dist/index.js`, whose runtime dependency is `@opencode/plugin`.

## Configuration

Add an entry to the **`plugins`** array in your V2 `opencode.jsonc`. Use the absolute path to the cloned repository:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-go-multiauth",
      "options": {
        "profiles": [
          {
            "id": "personal",
            "name": "OpenCode Go Personal",
            "apiKeyEnv": "OPENCODE_GO_PERSONAL_KEY"
          },
          {
            "id": "work",
            "name": "OpenCode Go Work",
            "apiKeyEnv": "OPENCODE_GO_WORK_KEY"
          }
        ]
      }
    }
  ],
  "model": "opencode-go-personal/glm-5.1"
}
```

V2 delivers `options` directly to the plugin. A shim and a custom top-level `opencodeGoMultiAuth` key are no longer needed.

Export the API keys in the shell that launches OpenCode, or in its shell profile:

```bash
export OPENCODE_GO_PERSONAL_KEY="oc_go_xxxxxxxx"
export OPENCODE_GO_WORK_KEY="oc_go_yyyyyyyy"
```

Restart OpenCode after building or changing dependencies. The V2 background server owns plugins and must receive the exported key variables when it starts. If it was already running before you exported the keys, restart it from that shell with `opencode service restart`; restarting only the TUI does not update the server's environment. Do this when no sessions are actively generating. Keys remain in the process environment and do not need to be saved in service configuration. Verify that `opencode-go-multi-auth` appears in the active plugin list and that the model picker contains the account namespaces. Through the V2 CLI API:

```bash
opencode api get /api/plugin
opencode api get /api/provider
opencode api get /api/model
```

Use `opencode2` instead if that is the name of your V2 executable. A profile with an unset or empty API key is skipped with a diagnostic naming only the environment variable.

### Migrating an existing V1 installation

1. Build this version with `npm install` and `npm run build`.
2. Remove the old function-based shim from your OpenCode plugin directories so V2 does not try to load it.
3. Move the same profiles into the `plugins` object entry shown above. Replace the singular V1 `plugin` field, and remove any `opencodeGoMultiAuth` top-level section.
4. Keep your existing environment variables and model references, then restart OpenCode.

The generated provider IDs and model aliases stay the same. Legacy static model overrides using `provider: { npm: "@ai-sdk/anthropic", api: "..." }` are translated into V2 package/settings overrides. For new configurations, use the native fields below.

## Profile schema

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | yes | — | Starts with a lowercase letter or digit; lowercase letters, digits, and hyphens |
| `name` | yes | — | Display name in the model picker |
| `apiKeyEnv` | yes | — | Environment variable containing this account's API key |
| `providerId` | no | `opencode-go-${id}` | Override the provider ID; must start with a lowercase letter |
| `baseURL` | no | `https://opencode.ai/zen/go/v1` | Upstream API base URL |
| `models` | no | Live catalog from `/models` | Static map of model aliases to model overrides; skips discovery and probing |

### Static models

Static entries use V2 model fields. Defaults come from `Model.Info.default`: models are enabled, support tools and text/image input, and have a 200,000-token context limit and 32,000-token output limit. Set capabilities and limits to match your selected upstream models. Use `modelID` when an alias differs from the upstream ID.

```jsonc
{
  "id": "personal",
  "name": "OpenCode Go Personal",
  "apiKeyEnv": "OPENCODE_GO_PERSONAL_KEY",
  "models": {
    "glm-5.1": { "name": "GLM-5.1" },
    "qwen3.7-max": {
      "name": "Qwen3.7 Max",
      "package": "@opencode/ai/providers/anthropic"
    }
  }
}
```

Every model inherits its account's API key and base URL through provider settings. Per-model `package` selects a native adapter; per-model `settings` can override its base URL. Do not put API keys in model overrides.

## Discovery and validation

At setup, each account fetches `/models`, then probes discovered models in parallel. Profiles are also loaded concurrently. Each HTTP fetch has a 3-second timeout. A format mismatch on `/chat/completions` triggers an Anthropic `/messages` probe. Inconclusive probes retain the model: `qwen*` defaults to Anthropic-compatible routing and other models to OpenAI-compatible routing. If catalog discovery fails, the bundled default catalog is used.

Discovery finishes before the synchronous provider transform is registered. Replaying that transform performs no network work. OpenCode owns the registration lifecycle and removes it when the plugin unloads.

Invalid profile objects, missing required fields, malformed or duplicate IDs, invalid optional field types, and missing API-key variables are reported and skipped individually. No profiles means no provider registrations.

## Optional: JSON-driven local plugin

To keep accounts in a shared JSON file, create a **V2 object-based** wrapper in your auto-discovered `~/.config/opencode/plugins/` directory. Do not also configure this plugin in the `plugins` array, as that would load it twice.

```js
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import plugin from "file:///absolute/path/to/opencode-go-multiauth/dist/index.js"

export default {
  id: plugin.id,
  async setup(ctx) {
    const path = join(homedir(), ".config", "opencode", "opencode-go.json")
    const { accounts } = JSON.parse(readFileSync(path, "utf8"))
    return plugin.setup({ ...ctx, options: { ...ctx.options, profiles: accounts } })
  },
}
```

Use this JSON structure, including any optional profile fields you need:

```json
{
  "accounts": [
    { "id": "personal", "name": "OpenCode Go Personal", "apiKeyEnv": "OPENCODE_GO_PERSONAL_KEY" },
    { "id": "work", "name": "OpenCode Go Work", "apiKeyEnv": "OPENCODE_GO_WORK_KEY" }
  ]
}
```

## Thinking options

Account models inherit variants, context limits, and capabilities from OpenCode's built-in `opencode-go` catalog, falling back to its `opencode` catalog for matching model IDs. T3 Code uses these variants to show its **Reasoning** selector. For example, select `opencode-go-2/muse-spark-1.3-contributor#high` to request high reasoning effort.

Only models with catalog variants expose a selector; models with fixed thinking behavior or no matching catalog entry keep their existing defaults. A static model's explicit `variants` array overrides the inherited options, including `[]` to disable the selector. Credentials and request routing remain specific to each account.

After rebuilding a locally installed plugin, reload the OpenCode configuration and refresh T3's OpenCode provider models so the updated metadata appears.

## Security

- The plugin never logs API keys or upstream response bodies. Fallback diagnostics identify only the affected profile.
- Each provider holds its own `settings.apiKey`; there is no shared mutable authentication state between accounts.
- Unless a static `models` map is supplied, startup makes authenticated requests to the profile's configured `baseURL`: one `GET /models`, one OpenAI-compatible probe per model, and an additional Anthropic probe after an explicit format mismatch. These are small inference requests and may consume subscription usage.
- Keys are sent in `Authorization` or `x-api-key` headers. The plugin does not write keys or response data to disk.

## Build and verify

```bash
npm install
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

Tests use dummy credentials and mocked endpoints, covering V2 setup, schema-valid providers and models, independent account credentials, replay without HTTP requests, static routing, format detection, timeouts, and fallback behavior. They do not use real accounts.

Published packages include the compiled entrypoint and declarations; `@opencode/plugin` is a production dependency so package installation can resolve its runtime imports.

Official references: [V2 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1) and [V2 provider transforms](https://opencode.ai/v2/docs/build/plugins/).

## Changelog

### 0.2.2 — 2026-10-08

- Preserve built-in OpenCode model variants and their native protocols when registering account aliases, restoring T3 Code's Reasoning selector for models with configurable thinking. Inherit model limits and capabilities without copying another provider's credentials or API URL; explicit routing overrides still win.
- Keep explicit static metadata overrides, including an empty variants array, and leave unknown or fixed-thinking models without invented options. Add regression coverage for inheritance, account isolation, and transform replay.

### 0.2.1 — 2026-10-08

- Restore numeric and digit-leading profile IDs accepted by the V1 implementation, so existing accounts such as `1` and `2` keep the `opencode-go-1` and `opencode-go-2` namespaces. Custom provider IDs still require a leading lowercase letter.
- Add a regression test for numbered accounts and document that the V2 background server must inherit exported API-key variables; changing shell exports alone does not update an already-running server.

### 0.2.0 — 2026-10-08

**OpenCode V2 migration**

- Replaced the V1 function/config hook with a stable `Plugin.define` ID and `setup(ctx)`, reading profiles directly from `ctx.options`.
- Register account providers and complete model definitions through V2's synchronous `ctx.provider.transform`. Discovery finishes before registration, so transform replay does not make network requests; profiles are discovered concurrently.
- Use native `@opencode/ai` OpenAI-compatible and Anthropic packages, with credentials in provider settings and format overrides on individual models. Preserve account/model namespaces, timeout fallbacks, and static catalogs; translate legacy static `provider.npm`/`provider.api` overrides.
- Add a root `server.js` entrypoint and a `./server` package export so V2 can resolve both local plugin directories and installed packages.
- Replace the V1 peer dependency with a pinned runtime dependency on `@opencode/plugin` 2.0.24 and update the package version to 0.2.0.
- Replace the mandatory V1 shim instructions with V2 `plugins` object configuration and an optional JSON-driven V2 wrapper. Document removal of old shims and keep credentials out of fallback diagnostics.
- Verified loading with OpenCode 2.0.24, including an installed package, and live GLM-5.1 and Qwen3.7 Max requests.
- Validate malformed profile objects and optional field types without stopping valid accounts, and add migration tests for account isolation, native model schemas, replay, format routing, and discovery failures.

### 0.1.4 — 2026-06-01

**Startup hang fix + probe robustness**

- Wrapped every network call in `fetchAndProbeModels()` (the `/models` fetch and each per-model probe) in a 3-second `AbortController` timeout via a new `timedFetch()` helper. Previously these calls had no timeout, so a slow or unresponsive endpoint could block the OpenCode `config` hook — and therefore the TUI — for up to ~60s per profile.
- Fixed a latent defect where model visibility was tied to live probe success: probes that timed out or errored returned `unsupported` and the model was dropped entirely. With the shorter timeout this caused every model (and the whole provider) to vanish when probes did not resolve in time. Model visibility now comes from the `/models` endpoint — every discovered model is seeded up front, and probing only *refines* the format. A failed or aborted probe leaves the model registered with a safe default instead of dropping it.
- Inconclusive probes now fall back to a heuristic: `qwen*` models default to the Anthropic messages format (which they require); all others default to openai-compatible.
- The `/models`-fetch-failure fallback now applies the Anthropic provider override to all `qwen*` models, not just `qwen3.7-max`.

### 0.1.3 — 2026-05-30

**Agent installation guide**

- Added a collapsible "Agent installation instructions" section to the Build section — a step-by-step guide written for an LLM agent to install the plugin on behalf of a user, covering prerequisites, cloning and building, shim creation, API key setup, and verification steps.

### 0.1.2 — 2026-05-30

**README accuracy fixes**

- Corrected "Why this exists" — removed the incorrect claim that all providers use `@ai-sdk/openai-compatible`; anthropic-format models get a per-model `@ai-sdk/anthropic` override since 0.1.1.
- Corrected profile schema `models` default — was "Built-in OpenCode Go model list"; now accurately states "Live list fetched from `/models`" with the static list as fallback, and notes that providing `models` skips probing.

### 0.1.1 — 2026-05-30

**Dynamic model enumeration with format detection**

- Added `fetchAndProbeModels()` in `src/provider.ts`. At startup the plugin now calls the `/models` endpoint for each profile to discover the live model list, then probes each model with a minimal request to determine whether it speaks the openai-compatible or anthropic API format. Probes run in parallel per profile.
- Models that respond correctly on the openai-compatible path are registered as normal. Models that fail with a format error are re-probed against the Anthropic messages endpoint; on success they are registered with a per-model `provider` override pointing at `@ai-sdk/anthropic`.
- Added `qwen3.7-max` to the static `DEFAULT_MODELS` list in `src/models.ts`.
- The fallback path (used when the `/models` fetch or any probe fails) now applies an anthropic provider override specifically for `qwen3.7-max` so it remains usable without a successful probe.
- Fixed a missing `await` on the `injectProfiles()` call in `src/index.ts`. Without it the async config mutation was fire-and-forget, meaning providers could silently fail to register if the probe network calls had not resolved before OpenCode finished reading the config.
- Updated `.gitignore` to exclude local probe and debug scripts (`probe.js`, `probe2.cjs`, `probe_anthropic.cjs`, `test-config.cjs`) and `schema.json`.

### 0.1.0 — 2026-05-29

**Initial release**

- Core plugin structure: `OpencodeGoMultiAuthPlugin` reads profiles from plugin options or the `opencodeGoMultiAuth` config key and injects one `@ai-sdk/openai-compatible` provider per resolved profile into the OpenCode config object.
- `src/config.ts`: profile resolution with full validation — checks for missing fields, duplicate IDs, malformed provider IDs, and unset env vars. Invalid profiles are dropped individually; the rest still register.
- `src/models.ts`: static `DEFAULT_MODELS` list covering the initial OpenCode Go model catalog (MiniMax, Kimi, MiMo, GLM, DeepSeek, Qwen families).
- `src/provider.ts`: `buildProviderConfig` and `injectProfiles` utilities that assemble the provider config shape expected by OpenCode.
- Shim-based setup documented to work around two current OpenCode limitations: rejection of unknown top-level config keys and missing plugin options delivery at runtime.
- Optional JSON-driven shim pattern documented for config-file-based account management.

## License

MIT — see [LICENSE](LICENSE).
