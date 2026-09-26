/**
 * Shared factory for Evolution's chatbot integrations (Typebot, OpenAI, Dify,
 * Flowise, n8n, Evolution Bot, EvoAI). They all share one server controller and
 * the same route set under /<base>/*:
 *
 *   create, find, fetch/:id, update/:id, delete/:id, settings, fetchSettings,
 *   changeStatus, fetchSessions/:id, ignoreJid
 *
 * Path order is always bot id first, then instance.
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../../types.js";
import { ToolInputError, seg } from "../../client.js";
import { instanceField } from "../../schemas/common.js";
import { compact, missingKeys, pickDefined } from "../helpers.js";

/** Session behaviour fields shared by bot create/update and the integration settings. */
const behaviourShape = {
  expire: z.number().int().nonnegative().optional().describe("Session expiry in MINUTES (0 = never)."),
  keywordFinish: z.string().optional().describe("Keyword that closes the session."),
  delayMessage: z.number().int().nonnegative().optional().describe("Typing delay (ms) before each bot reply."),
  unknownMessage: z.string().optional().describe("Reply for unsupported message types."),
  listeningFromMe: z.boolean().optional().describe("Also react to messages sent by the instance."),
  stopBotFromMe: z
    .boolean()
    .optional()
    .describe("A human (fromMe) message pauses the bot for that chat."),
  keepOpen: z
    .boolean()
    .optional()
    .describe(
      "Keep the session row as 'closed' instead of deleting it. On 2.4 a closed session restarts on the " +
        "next message: use change_status 'paused' for human handoff.",
    ),
  debounceTime: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Seconds to aggregate consecutive user messages."),
  ignoreJids: z
    .array(z.string())
    .optional()
    .describe("JIDs the bot ignores ('@g.us' = all groups, '@s.whatsapp.net' = all 1:1 chats)."),
  splitMessages: z.boolean().optional().describe("Split bot replies on blank lines into several messages."),
  timePerChar: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Typing ms per character when splitMessages is on."),
};
const BEHAVIOUR_KEYS = Object.keys(behaviourShape);

/** Common bot fields (create/update). */
const commonBotShape = {
  enabled: z.boolean().describe("Bot active."),
  description: z.string().optional().describe("Label."),
  triggerType: z
    .enum(["all", "keyword", "none", "advanced"])
    .describe(
      "all = every message (only ONE enabled 'all' bot per integration); keyword = triggerOperator + " +
        "triggerValue; advanced = triggerValue expression; none = only via fallback/start.",
    ),
  triggerOperator: z
    .enum(["equals", "contains", "startsWith", "endsWith", "regex"])
    .optional()
    .describe("Required with triggerType 'keyword'."),
  triggerValue: z
    .string()
    .optional()
    .describe("Required with 'keyword'/'advanced'; must be unique per instance."),
  ...behaviourShape,
};

/** Server defaults returned by fetchSettings when nothing is stored yet. */
const SETTINGS_DEFAULTS: Record<string, unknown> = {
  expire: 300,
  keywordFinish: "bye",
  delayMessage: 1000,
  unknownMessage: "Sorry, I dont understand",
  listeningFromMe: true,
  stopBotFromMe: true,
  keepOpen: false,
  debounceTime: 1,
  ignoreJids: [],
  splitMessages: false,
  timePerChar: 0,
};

/** Required settings fields, per the settings schema of each integration. */
export const SETTINGS_REQUIRED_TYPEBOT = [
  "expire",
  "keywordFinish",
  "delayMessage",
  "unknownMessage",
  "listeningFromMe",
  "stopBotFromMe",
];
export const SETTINGS_REQUIRED_FLOWISE = [
  ...SETTINGS_REQUIRED_TYPEBOT,
  "keepOpen",
  "debounceTime",
  "ignoreJids",
];
export const SETTINGS_REQUIRED_FULL = [...SETTINGS_REQUIRED_FLOWISE, "splitMessages", "timePerChar"];

export interface BotSpec {
  /** Group key, used in tool names: evolution_<group>_<action>. */
  group: string;
  /** URL base segment, e.g. "typebot", "evolutionBot". */
  base: string;
  /** Human label, e.g. "Typebot". */
  label: string;
  /** Server env flag that must be on, e.g. "TYPEBOT_ENABLED" (undefined = always on). */
  envFlag?: string;
  /** Integration-specific bot fields (create schema). */
  specificShape: z.ZodRawShape;
  /** Required integration-specific create fields. */
  requiredSpecific: string[];
  /** Required settings fields (schema). */
  settingsRequired: string[];
  /** Extra integration-specific settings fields (e.g. OpenAI openaiCredsId). */
  settingsExtraShape?: z.ZodRawShape;
}

export function makeBotTools(spec: BotSpec): ToolDef[] {
  const { group, base, label, envFlag } = spec;
  const note = envFlag ? ` Requires ${envFlag} on the server.` : "";
  const idField = z.string().describe(`${label} bot id.`);

  const createShape = { ...commonBotShape, ...spec.specificShape };
  const botKeys = Object.keys(createShape);
  const requiredCreate = ["enabled", "triggerType", ...spec.requiredSpecific];

  const settingsShape = {
    ...behaviourShape,
    ...(spec.settingsExtraShape ?? {}),
    fallbackId: z
      .string()
      .optional()
      .describe(
        "Id of the default bot used when no trigger matches (the only fallback field the server reads). " +
          "Omit to keep the current one.",
      ),
  };
  const settingsMergeKeys = [...BEHAVIOUR_KEYS, ...Object.keys(spec.settingsExtraShape ?? {})];

  return [
    {
      name: `evolution_${group}_create`,
      description:
        `Create a ${label} bot. Duplicate triggers or a second enabled 'all' bot fail with HTTP 500.` + note,
      inputSchema: z.object({ instance: instanceField, ...createShape }),
      handler: async (client, args) => {
        const { instance, ...body } = args;
        const inst = client.resolveInstance(instance as string | undefined);
        return client.post(`/${base}/create/${inst}`, { body: compact(body) });
      },
    },
    {
      name: `evolution_${group}_find`,
      description: `List all ${label} bots in an instance.`,
      inputSchema: z.object({ instance: instanceField }),
      handler: async (client, args) => {
        const inst = client.resolveInstance(args.instance as string | undefined);
        return client.get(`/${base}/find/${inst}`);
      },
    },
    {
      name: `evolution_${group}_fetch`,
      description: `Fetch a single ${label} bot by id (null when not found).`,
      inputSchema: z.object({ instance: instanceField, id: idField }),
      handler: async (client, args) => {
        const inst = client.resolveInstance(args.instance as string | undefined);
        return client.get(`/${base}/fetch/${seg(args.id)}/${inst}`);
      },
    },
    {
      name: `evolution_${group}_update`,
      description:
        `Update a ${label} bot. Partial updates are safe: the current bot is read and merged when ` +
        `fields are omitted, including conditional trigger and bot-mode requirements.`,
      inputSchema: z
        .object(createShape)
        .partial()
        .extend({ instance: instanceField, id: idField }),
      handler: async (client, args) => {
        const { instance, id, ...changes } = args;
        const inst = client.resolveInstance(instance as string | undefined);
        let body = compact(changes);
        // Optional schema fields can still be required by the selected trigger or
        // bot mode, and credentials participate in server duplicate checks.
        if (missingKeys(body, botKeys).length > 0) {
          const current = await client.get(`/${base}/fetch/${seg(id)}/${inst}`);
          if (!current || typeof current !== "object" || Array.isArray(current)) {
            throw new ToolInputError(`${label} bot ${String(id)} not found in this instance.`);
          }
          // Only known bot fields; null columns are dropped (the schema rejects null).
          body = { ...pickDefined(current, botKeys), ...body };
        }
        const missing = missingKeys(body, requiredCreate);
        if (missing.length > 0) {
          throw new ToolInputError(`Missing required ${label} fields: ${missing.join(", ")}.`);
        }
        return client.put(`/${base}/update/${seg(id)}/${inst}`, { body });
      },
    },
    {
      name: `evolution_${group}_delete`,
      description: `Delete a ${label} bot by id.`,
      inputSchema: z.object({ instance: instanceField, id: idField }),
      handler: async (client, args) => {
        const inst = client.resolveInstance(args.instance as string | undefined);
        return client.delete(`/${base}/delete/${seg(args.id)}/${inst}`);
      },
    },
    {
      name: `evolution_${group}_change_status`,
      description:
        `Change the ${label} session status for a chat. 'paused' = bot ignores the chat (use for human ` +
        `handoff); 'opened' = resume; 'closed' = end the session; 'delete' = remove the chat's sessions. ` +
        `WARNING: 'closed' and 'delete' affect that contact's bot sessions of every bot type on every ` +
        `instance of the server.`,
      inputSchema: z.object({
        instance: instanceField,
        remoteJid: z.string().describe("Chat JID of the session (full JID)."),
        status: z.enum(["opened", "paused", "closed", "delete"]).describe("New session status."),
      }),
      handler: async (client, args) => {
        const { instance, ...body } = args;
        const inst = client.resolveInstance(instance as string | undefined);
        return client.post(`/${base}/changeStatus/${inst}`, { body });
      },
    },
    {
      name: `evolution_${group}_settings_set`,
      description:
        `Set the default ${label} settings for an instance. Partial updates are safe: missing required ` +
        `fields are filled from the current settings (or the server defaults). Set the default bot with fallbackId.`,
      inputSchema: z.object({ instance: instanceField, ...settingsShape }),
      handler: async (client, args) => {
        const { instance, ...changes } = args;
        const inst = client.resolveInstance(instance as string | undefined);
        let body = compact(changes);
        if (missingKeys(body, spec.settingsRequired).length > 0) {
          const current = await client.get(`/${base}/fetchSettings/${inst}`);
          body = {
            ...SETTINGS_DEFAULTS,
            ...pickDefined(current, settingsMergeKeys),
            ...body,
          };
        }
        const missing = missingKeys(body, spec.settingsRequired);
        if (missing.length > 0) {
          throw new ToolInputError(`Missing required ${label} settings: ${missing.join(", ")}.`);
        }
        return client.post(`/${base}/settings/${inst}`, { body });
      },
    },
    {
      name: `evolution_${group}_settings_fetch`,
      description: `Get the default ${label} settings for an instance (server defaults when never set).`,
      inputSchema: z.object({ instance: instanceField }),
      handler: async (client, args) => {
        const inst = client.resolveInstance(args.instance as string | undefined);
        return client.get(`/${base}/fetchSettings/${inst}`);
      },
    },
    {
      name: `evolution_${group}_fetch_sessions`,
      description:
        `List ${label} sessions for a bot. An unknown bot id returns all sessions of this integration type.`,
      inputSchema: z.object({ instance: instanceField, id: idField }),
      handler: async (client, args) => {
        const inst = client.resolveInstance(args.instance as string | undefined);
        return client.get(`/${base}/fetchSessions/${seg(args.id)}/${inst}`);
      },
    },
    {
      name: `evolution_${group}_ignore_jid`,
      description:
        `Add or remove a JID in the ${label} ignore list of the instance settings (fails with 500 ` +
        `if ${label} settings were never saved).`,
      inputSchema: z.object({
        instance: instanceField,
        remoteJid: z.string().describe("JID to add/remove ('@g.us' = all groups)."),
        action: z.enum(["add", "remove"]).describe("Add or remove."),
      }),
      handler: async (client, args) => {
        const { instance, ...body } = args;
        const inst = client.resolveInstance(instance as string | undefined);
        return client.post(`/${base}/ignoreJid/${inst}`, { body });
      },
    },
  ];
}

/** Build a complete opt-in group for a bot integration. */
export function makeBotGroup(spec: BotSpec, extraTools: ToolDef[] = []): ToolGroup {
  return {
    group: spec.group,
    core: false,
    label: spec.label,
    tools: [...makeBotTools(spec), ...extraTools],
  };
}
