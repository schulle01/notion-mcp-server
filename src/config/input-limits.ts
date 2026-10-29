/** Reject invalid limits rather than silently disabling a security boundary. */
export function positiveIntegerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function maxToolInputElements(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(env, "MCP_MAX_TOOL_INPUT_ELEMENTS", 100_000);
}
