/**
 * OpenAI integration — /openai/*  (bots + credentials + models)
 */

import { z } from "zod";
import type { ToolDef } from "../../types.js";
import { ToolInputError, seg } from "../../client.js";
import { instanceField } from "../../schemas/common.js";
import { postBody } from "../helpers.js";
import { makeBotGroup, SETTINGS_REQUIRED_FLOWISE } from "./botFactory.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const extraTools: ToolDef[] = [
  {
    name: "evolution_openai_creds_set",
    description:
      "Add an OpenAI API credential to an instance. The API key and the credential name must both be unique " +
      "across the whole server: a reused key fails with 400, a name already used on another instance with HTTP 500.",
    inputSchema: z.object({
      instance: instanceField,
      name: z.string().describe("Credential name."),
      apiKey: z.string().describe("OpenAI API key."),
    }),
    handler: postBody("/openai/creds"),
  },
  {
    name: "evolution_openai_creds_find",
    description: "List OpenAI credentials for an instance (API keys are returned in clear).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/openai/creds/${inst}`);
    },
  },
  {
    name: "evolution_openai_creds_delete",
    description:
      "Delete an OpenAI credential by id. WARNING: the database cascade permanently deletes every OpenAI " +
      "bot that uses it, so the tool refuses while bots of this instance do (move them with " +
      "evolution_openai_update first, or pass force: true). The credential set in the OpenAI settings " +
      "cannot be deleted (Evolution fails with HTTP 500): point the settings to another credential first.",
    inputSchema: z.object({
      instance: instanceField,
      id: z.string().describe("Credential id."),
      force: z
        .boolean()
        .optional()
        .describe("Delete even if OpenAI bots use this credential: those bots are permanently deleted too."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      const id = args.id as string;
      // OpenaiSetting -> OpenaiCreds is ON DELETE RESTRICT: the delete would fail with HTTP 500.
      const settings = await client.get(`/openai/fetchSettings/${inst}`);
      if (isRecord(settings) && settings.openaiCredsId === id) {
        throw new ToolInputError(
          `OpenAI credential ${id} is the default credential of this instance's OpenAI settings, so ` +
            "Evolution cannot delete it (HTTP 500): point the settings to another credential first " +
            "(evolution_openai_settings_set).",
        );
      }
      // OpenaiBot -> OpenaiCreds is ON DELETE CASCADE: the delete would silently remove these bots.
      if (args.force !== true) {
        const bots = await client.get(`/openai/find/${inst}`);
        if (!Array.isArray(bots)) {
          throw new Error(
            `Cannot verify which OpenAI bots use credential ${id} (unexpected bot list): nothing was deleted.`,
          );
        }
        const users = bots.filter(
          (bot): bot is Record<string, unknown> => isRecord(bot) && bot.openaiCredsId === id,
        );
        if (users.length > 0) {
          const names = users.map((bot) =>
            typeof bot.description === "string" && bot.description
              ? `${String(bot.id)} (${bot.description})`
              : String(bot.id),
          );
          throw new ToolInputError(
            `OpenAI credential ${id} is used by ${users.length} bot(s): ${names.join(", ")}. Deleting it ` +
              "would permanently delete them (database cascade). Move them to another credential with " +
              "evolution_openai_update first, or pass force: true to delete them too.",
          );
        }
      }
      return client.delete(`/openai/creds/${seg(id)}/${inst}`);
    },
  },
  {
    name: "evolution_openai_get_models",
    description: "List the OpenAI models available to a stored credential.",
    inputSchema: z.object({
      instance: instanceField,
      openaiCredsId: z
        .string()
        .optional()
        .describe("Credential id to use (defaults to the credential in the OpenAI settings)."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/openai/getModels/${inst}`, {
        query: { openaiCredsId: args.openaiCredsId as string | undefined },
      });
    },
  },
];

export const openaiGroup = makeBotGroup(
  {
    group: "openai",
    base: "openai",
    label: "OpenAI",
    envFlag: "OPENAI_ENABLED",
    specificShape: {
      openaiCredsId: z.string().describe("Credential id from evolution_openai_creds_set."),
      botType: z.enum(["assistant", "chatCompletion"]).describe("Mode."),
      assistantId: z.string().optional().describe("Required in assistant mode: OpenAI assistant id."),
      functionUrl: z.string().optional().describe("assistant mode: URL called for function calls."),
      model: z.string().optional().describe("Required in chatCompletion mode: model name."),
      systemMessages: z.array(z.string()).optional().describe("chatCompletion: system prompts."),
      assistantMessages: z.array(z.string()).optional().describe("chatCompletion: seed assistant messages."),
      userMessages: z.array(z.string()).optional().describe("chatCompletion: seed user messages."),
      maxTokens: z.number().int().positive().optional().describe("Required in chatCompletion mode: max tokens."),
    },
    requiredSpecific: ["openaiCredsId", "botType"],
    settingsRequired: [...SETTINGS_REQUIRED_FLOWISE, "openaiCredsId"],
    settingsExtraShape: {
      openaiCredsId: z.string().optional().describe("Default credential id for the instance (required)."),
      speechToText: z.boolean().optional().describe("Transcribe incoming audio with Whisper."),
    },
    // settings() writes openaiIdFallback next to an OpenaiCreds relation connect: Prisma rejects it.
    fallbackRejected: true,
    // Every speechToText read is a truthiness check, so false behaves like a stored NULL.
    emptyCarrier: { key: "speechToText", value: false },
  },
  extraTools,
);
