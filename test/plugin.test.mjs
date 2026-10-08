import assert from "node:assert/strict"
import { test } from "node:test"
import { Model, Provider } from "@opencode/plugin"
import plugin from "../dist/index.js"
import { resolveProfiles } from "../dist/src/config.js"
import { buildProviderConfig } from "../dist/src/provider.js"

const OA = "@opencode/ai/providers/openai-compatible"
const ANT = "@opencode/ai/providers/anthropic"

function profile(overrides = {}) {
  return {
    id: "personal",
    providerId: "opencode-go-personal",
    name: "Personal",
    baseURL: "https://example.invalid/v1",
    apiKeyEnv: "MULTIAUTH_TEST_PERSONAL_KEY",
    apiKey: "dummy-personal-key",
    ...overrides,
  }
}

function environment(t) {
  for (const [name, value] of Object.entries({
    MULTIAUTH_TEST_PERSONAL_KEY: "dummy-personal-key",
    MULTIAUTH_TEST_WORK_KEY: "dummy-work-key",
  })) {
    const original = process.env[name]
    process.env[name] = value
    t.after(() => {
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    })
  }
}

function diagnostics(t) {
  const logs = []
  t.mock.method(console, "warn", (...args) => logs.push(args.join(" ")))
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")))
  return logs
}

function context(options) {
  const sources = []
  let replay
  return {
    sources,
    replay: () => replay({ add: (source) => sources.push(source) }),
    ctx: {
      options,
      provider: {
        async transform(callback) {
          replay = callback
          assert.equal(callback({ add: (source) => sources.push(source) }), undefined)
          return { async dispose() {} }
        },
      },
    },
  }
}

function valid(source) {
  Provider.Info.make(source.info)
  for (const model of source.models) Model.Info.make(model)
}

const personal = {
  id: "personal", name: "Personal", apiKeyEnv: "MULTIAUTH_TEST_PERSONAL_KEY",
}

test("V2 setup registers isolated accounts and replay does no network work", async (t) => {
  environment(t)
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch") })
  const configured = context({ profiles: [
    { ...personal, models: { "glm-5": { name: "GLM-5" } } },
    { id: "work", name: "Work", apiKeyEnv: "MULTIAUTH_TEST_WORK_KEY", models: { "glm-5": {} } },
  ] })
  assert.equal(plugin.id, "opencode-go-multi-auth")
  assert.equal(typeof plugin.setup, "function")
  await plugin.setup(configured.ctx)
  assert.equal(configured.sources.length, 2)
  const [one, two] = configured.sources
  valid(one)
  valid(two)
  assert.equal(one.info.id, "opencode-go-personal")
  assert.equal(two.info.id, "opencode-go-work")
  assert.equal(one.info.activation, "enabled")
  assert.equal(one.info.package, OA)
  assert.equal(one.info.settings.apiKey, "dummy-personal-key")
  assert.equal(two.info.settings.apiKey, "dummy-work-key")
  assert.equal(one.models[0].providerID, one.info.id)
  assert.equal(two.models[0].providerID, two.info.id)
  assert.notEqual(one.info.settings, two.info.settings)
  const before = structuredClone(configured.sources)
  configured.replay()
  assert.deepEqual(configured.sources.slice(2), before)
  assert.equal(fetch.mock.callCount(), 0)
})

test("static V2 model routing, aliases, and legacy overrides are preserved", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch") })
  const source = await buildProviderConfig(profile({ models: {
    coder: { name: "Coder", modelID: "glm-5", limit: { context: 128000, output: 8000 } },
    qwen: { package: ANT, settings: { baseURL: "https://example.invalid/alt/v1" } },
    legacy: { provider: { npm: "@ai-sdk/anthropic", api: "https://example.invalid/legacy/v1" } },
  } }))
  valid(source)
  assert.equal(source.models[0].id, "coder")
  assert.equal(source.models[0].modelID, "glm-5")
  assert.equal(source.models[0].limit.context, 128000)
  assert.equal(source.models[1].package, ANT)
  assert.equal(source.models[2].package, ANT)
  assert.equal(source.models[2].settings.baseURL, "https://example.invalid/legacy/v1")
  assert.equal("provider" in source.models[2], false)
  assert.equal(fetch.mock.callCount(), 0)
})

test("discovery uses account credentials and detects Anthropic routing", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "glm-5" }, { id: "custom-ant" }] })
    const { model } = JSON.parse(init.body)
    if (model === "custom-ant" && url.endsWith("/chat/completions")) {
      return new Response("not supported for format oa-compat", { status: 400 })
    }
    return Response.json({})
  })
  const source = await buildProviderConfig(profile({ baseURL: "https://example.invalid/v1/" }))
  valid(source)
  assert.equal(source.models[0].package, undefined)
  assert.equal(source.models[1].package, ANT)
  assert.equal(calls.length, 4)
  for (const { url, init } of calls) {
    if (url.endsWith("/messages")) {
      assert.equal(url, "https://example.invalid/v1/messages")
      assert.equal(init.headers["x-api-key"], "dummy-personal-key")
    } else assert.equal(init.headers.Authorization, "Bearer dummy-personal-key")
  }
})

test("inconclusive probes keep every discovered model and Qwen format defaults", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen-custom" }, { id: "glm-5" }] })
    throw new Error("offline")
  })
  const source = await buildProviderConfig(profile())
  valid(source)
  assert.deepEqual(source.models.map((model) => model.id), ["qwen-custom", "glm-5"])
  assert.equal(source.models[0].package, ANT)
  assert.equal(source.models[1].package, undefined)
})

test("catalog failures use native fallbacks and do not log upstream errors", async (t) => {
  const logs = diagnostics(t)
  t.mock.method(globalThis, "fetch", async () => { throw new Error("dummy-personal-key upstream payload") })
  const source = await buildProviderConfig(profile())
  valid(source)
  assert.ok(source.models.length > 0)
  assert.ok(source.models.filter((model) => model.id.startsWith("qwen")).every((model) => model.package === ANT))
  assert.ok(logs.length > 0)
  assert.ok(logs.every((log) => !log.includes("dummy-personal-key") && !log.includes("upstream payload")))
})

test("catalog HTTP and malformed response failures fall back", async (t) => {
  diagnostics(t)
  for (const response of [new Response("failure", { status: 500 }), Response.json({ invalid: [] })]) {
    t.mock.method(globalThis, "fetch", async () => response)
    const source = await buildProviderConfig(profile())
    valid(source)
    assert.ok(source.models.some((model) => model.id === "glm-5"))
  }
})

test("a timed-out probe retains its model", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "qwen-timeout" }] })
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  })
  const source = await buildProviderConfig(profile())
  valid(source)
  assert.equal(source.models[0].id, "qwen-timeout")
  assert.equal(source.models[0].package, ANT)
})

test("malformed profiles and missing keys do not stop valid profiles", (t) => {
  environment(t)
  const resolved = resolveProfiles([
    null, [], 42, {},
    { ...personal, id: "-bad" },
    { ...personal, id: "bad-optional", providerId: 42 },
    { ...personal, id: "bad-url", baseURL: 42 },
    { ...personal, id: "bad-models", models: { invalid: null } },
    { ...personal, id: "missing-key", apiKeyEnv: "MULTIAUTH_TEST_ABSENT_KEY" },
    { ...personal, models: {} },
    { ...personal },
    { ...personal, id: "other", providerId: "opencode-go-personal" },
  ])
  assert.equal(resolved.profiles.length, 1)
  assert.equal(resolved.errors.length, 11)
  assert.ok(resolved.errors.every((error) => !error.message.includes("dummy-personal-key")))
})

test("setup skips missing options and invalid accounts with diagnostics", async (t) => {
  const logs = diagnostics(t)
  for (const options of [{}, { profiles: [] }, { profiles: [null] }]) {
    const configured = context(options)
    await plugin.setup(configured.ctx)
    assert.equal(configured.sources.length, 0)
  }
  assert.ok(logs.some((log) => log.includes("plugins")))
})

test("OpenCode V2 resolves and loads the local plugin directory", async () => {
  const { Host } = await import("@opencode/plugin/host")
  const { fileURLToPath } = await import("node:url")
  const directory = fileURLToPath(new URL("..", import.meta.url))
  const entrypoints = Host.resolve({ directory })
  assert.ok(entrypoints.server)
  const loaded = await Host.load(entrypoints.server)
  assert.equal(loaded.default.id, plugin.id)
  assert.equal(typeof loaded.default.setup, "function")
})


test("numbered profiles keep their existing provider namespaces", async (t) => {
  environment(t)
  const configured = context({ profiles: [
    { ...personal, id: "1", models: { "glm-5.1": {} } },
    { ...personal, id: "2", apiKeyEnv: "MULTIAUTH_TEST_WORK_KEY", models: { "glm-5.1": {} } },
  ] })
  await plugin.setup(configured.ctx)
  assert.deepEqual(configured.sources.map(source => source.info.id), ["opencode-go-1", "opencode-go-2"])
  configured.sources.forEach(valid)
  const { errors } = resolveProfiles([{ ...personal, id: "3", providerId: "3" }])
  assert.ok(errors.some(error => error.message.includes("malformed providerId")))
})
