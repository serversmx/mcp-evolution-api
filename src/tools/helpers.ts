/**
 * Small helpers shared by tool handlers.
 */

import type { EvolutionClient } from "../client.js";
import type { ToolDef } from "../types.js";

/** Split the `instance` argument from the rest (the request body). */
export function splitInstance(
  client: EvolutionClient,
  args: Record<string, unknown>,
): { inst: string; rest: Record<string, unknown> } {
  const { instance, ...rest } = args;
  return { inst: client.resolveInstance(instance as string | undefined), rest };
}

/** Handler: POST `<prefix>/<instance>` with every argument except `instance` as the JSON body. */
export function postBody(prefix: string): ToolDef["handler"] {
  return async (client, args) => {
    const { inst, rest } = splitInstance(client, args);
    return client.post(`${prefix}/${inst}`, { body: rest });
  };
}

/** Handler: GET `<prefix>/<instance>`. */
export function getByInstance(prefix: string): ToolDef["handler"] {
  return async (client, args) => {
    const inst = client.resolveInstance(args.instance as string | undefined);
    return client.get(`${prefix}/${inst}`);
  };
}

/** Keep only the keys whose value is neither undefined nor null. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Pick `keys` from `obj` (as a plain record), skipping undefined/null values. */
export function pickDefined(obj: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  const src = obj as Record<string, unknown>;
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}

/** Keys of `required` that are absent (undefined/null) in `obj`. */
export function missingKeys(obj: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((k) => obj[k] === undefined || obj[k] === null);
}
