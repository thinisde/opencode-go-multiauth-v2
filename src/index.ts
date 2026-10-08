import { Plugin } from "@opencode/plugin"
import { resolveProfiles } from "./config.js"
import { registerProfiles } from "./provider.js"

export const OpencodeGoMultiAuthPlugin = Plugin.define({
  id: "opencode-go-multi-auth",
  async setup(ctx) {
    const input = ctx.options.profiles
    if (!Array.isArray(input) || input.length === 0) {
      console.warn(
        "[opencode-go-multi-auth] No profiles configured. " +
        "Add profiles to this plugin's options in the 'plugins' config array.",
      )
      return
    }

    const { profiles, errors } = resolveProfiles(input)
    for (const error of errors) {
      console.error(`[opencode-go-multi-auth] ${error.message}`)
    }
    if (profiles.length === 0) {
      console.warn("[opencode-go-multi-auth] No valid profiles to register.")
      return
    }

    await registerProfiles(ctx.provider, profiles)
  },
})

export default OpencodeGoMultiAuthPlugin
