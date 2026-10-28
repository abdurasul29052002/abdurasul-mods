/** When the last request happened (a prompt or a finished turn), in `$.clock.now()` milliseconds; null before the first. */
export type LastPromptAt = number | null

declare module 'claude-code' {
  interface PluginState {
    'token-saver': {
      lastPromptAt: LastPromptAt
      /** Prompts the person typed (no slash commands) since the session started or was last cleared. */
      promptCount: number
    }
  }
}
