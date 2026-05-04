/**
 * Must be the FIRST import in main.ts.
 * Overrides process.emitWarning before any dependency is loaded,
 * so transitive punycode deprecation (DEP0040) never reaches stderr.
 */

if (!process.env.AGENT_DEBUG_WARNINGS) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _orig: (...args: any[]) => void = process.emitWarning.bind(process)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process as any).emitWarning = function (...args: any[]) {
    // Suppress DEP0040 (punycode module deprecated) from transitive deps
    const code =
      typeof args[1] === 'object' && args[1] !== null
        ? (args[1] as Record<string, unknown>).code
        : typeof args[2] === 'object' && args[2] !== null
          ? (args[2] as Record<string, unknown>).code
          : undefined
    if (code === 'DEP0040') return
    _orig(...args)
  }
}
