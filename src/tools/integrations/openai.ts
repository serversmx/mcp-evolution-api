/**
 * OpenAI integration — /openai/*  (bots + credentials + models)
 */

import { z } from "zod";
import type { ToolDef } from "../../types.js";
import { seg } from "../../client.js";
import { instanceField } from "../../schemas/common.js";
import { postBody } from "../helpers.js";
import { makeBotGroup, SETTINGS_REQUIRED_FLOWISE } from "./botFactory.js";

const extraTools: ToolDef[] = [
  {
    name: "evolution_openai_creds_set",
    description: "Add an OpenAI API credential to an instance (an API key can be registered only once).",
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
    description: "Delete an OpenAI credential by id.",
    inputSchema: z.object({
      instance: instanceField,
      id: z.string().describe("Credential id."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.delete(`/openai/creds/${seg(args.id)}/${inst}`);
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
  },
  extraTools,
);
