/**
 * Aggregates every tool group. Order here is the order tools are listed.
 */

import type { ToolGroup } from "../types.js";

import { serverGroup } from "./server.js";
import { instanceGroup } from "./instance.js";
import { settingsGroup } from "./settings.js";
import { messageGroup } from "./message.js";
import { chatGroup } from "./chat.js";
import { profileGroup } from "./profile.js";
import { labelGroup } from "./label.js";
import { groupGroup } from "./group.js";
import { proxyGroup } from "./proxy.js";
import { templateGroup } from "./template.js";
import { businessGroup } from "./business.js";

import { webhookGroup } from "./integrations/webhook.js";
import { websocketGroup } from "./integrations/websocket.js";
import { rabbitmqGroup } from "./integrations/rabbitmq.js";
import { sqsGroup } from "./integrations/sqs.js";
import { natsGroup } from "./integrations/nats.js";
import { kafkaGroup } from "./integrations/kafka.js";
import { pusherGroup } from "./integrations/pusher.js";
import { chatwootGroup } from "./integrations/chatwoot.js";
import { typebotGroup } from "./integrations/typebot.js";
import { openaiGroup } from "./integrations/openai.js";
import { difyGroup } from "./integrations/dify.js";
import { evolutionBotGroup } from "./integrations/evolutionBot.js";
import { flowiseGroup } from "./integrations/flowise.js";
import { n8nGroup } from "./integrations/n8n.js";
import { evoaiGroup } from "./integrations/evoai.js";

export const allGroups: ToolGroup[] = [
  // Core (enabled by default)
  serverGroup,
  instanceGroup,
  settingsGroup,
  messageGroup,
  chatGroup,
  profileGroup,
  labelGroup,
  groupGroup,
  webhookGroup,
  // Opt-in
  proxyGroup,
  templateGroup,
  businessGroup,
  websocketGroup,
  rabbitmqGroup,
  sqsGroup,
  natsGroup,
  kafkaGroup,
  pusherGroup,
  chatwootGroup,
  typebotGroup,
  openaiGroup,
  difyGroup,
  evolutionBotGroup,
  flowiseGroup,
  n8nGroup,
  evoaiGroup,
];
