/**
 * MCP titles and annotations for every tool, keyed by tool name.
 *
 * Hosts act on these hints. ChatGPT asks for confirmation before any tool without readOnlyHint: true.
 * Claude may run readOnlyHint tools without asking and always asks before destructiveHint tools.
 * Every hint is spelled out because omitted ones take the MCP defaults (readOnlyHint false,
 * destructiveHint true, idempotentHint false, openWorldHint true). Each tool was classified from its
 * handler and the Evolution API 2.3.7/2.4 source, not from its HTTP verb or name.
 *
 * readOnlyHint: true only if the call never changes state in Evolution, WhatsApp, Meta, OpenAI,
 * Chatwoot or a bot platform. Several reads are POSTs (chat/findMessages, chat/whatsappNumbers,
 * chat/getBase64FromMediaMessage, verify-creds), and two GETs write: instance/connect starts a
 * connection and group/acceptInviteCode joins the group. Evolution refreshing its own lookup caches
 * (the onWhatsApp cache) is not a state change.
 *
 * destructiveHint (false on every read-only tool) is true when the call:
 * - deletes or removes: instances, bots with their sessions, credentials (with the OpenAI bots that
 *   use them), templates, messages, the profile picture, bot sessions (change_status closed/delete),
 *   group membership (leaving; removing or demoting participants);
 * - logs out, restarts or reconnects the WhatsApp session;
 * - revokes access: blocking a contact, revoking an invite link, restricting what group members can do;
 * - overwrites stored values with the ones it passes: profile, privacy and group details, instance,
 *   webhook, proxy, event, Chatwoot and bot settings, bots, templates, message edits;
 * - reaches other people in a way that cannot be recalled. OpenAI's plugin guidelines treat
 *   irreversible sends as destructive ("being able to undo an action does not, by itself, justify
 *   setting destructiveHint to false") and a delivered WhatsApp message cannot be unsent, so every
 *   message, status, reaction, poll, group invite and Typebot flow is destructive, and so are group
 *   changes announced to other people (creating a group with participants, joining by invite).
 * It is false for additive writes (instances, bots, templates, credentials), for starting a
 * connection, and for private flags that the opposite call restores exactly (archived, unread, chat
 * labels, bot ignore lists). Presence and receipts are not destructive either: a typing indicator,
 * an online status or a read/played receipt carries no content (sendPresence itself ends with
 * "paused").
 *
 * idempotentHint (true on every read-only tool) is true when repeating the call with the same
 * arguments adds no effect: set-to-value updates, deletions, flags, joins and leaves, and edits or
 * deletions of a sent message, which converge. The group subject, permission, member-add-mode and
 * disappearing-message setters are set-to-value: Baileys sends only the new value, with no revision id,
 * so a repeat sets the same state. It is false for creates; for sends, because each call delivers and
 * stores a new message (the optional messageId only deduplicates on 2.4+); for restarts, invite
 * revocation (a new link each time) and chat presence (shown again); for group picture and description
 * changes (each call is a new picture or a new description revision, announced to the members); and
 * for writes after which Evolution reconnects the WhatsApp session (profile picture, privacy, instance
 * settings with a WAVoIP token), opens a new Chatwoot conversation (autoCreate) or starts a new Meta
 * review (template edits).
 *
 * openWorldHint is true when the call itself reaches past Evolution's database and configuration:
 * the WhatsApp network (other users, groups, profiles, media), the Meta Graph API, OpenAI, Typebot,
 * Chatwoot, or arbitrary hosts (proxy test, picture URLs). Reads of stored data and writes that only
 * store configuration are closed-world, even when that configuration later makes Evolution call out
 * (webhooks, bots, operator-configured event brokers; SQS may create the instance's queues in the
 * operator's own AWS account).
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** A title and all four hints. */
export type ToolHints = Required<ToolAnnotations>;

type Destructiveness = "destructive" | "non-destructive";
type Idempotency = "idempotent" | "not-idempotent";
type World = "open-world" | "closed-world";

/** A tool that changes nothing anywhere: never destructive, always idempotent. */
function read(title: string, world: World): ToolHints {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: world === "open-world",
  };
}

/** A tool that changes state; the other three hints are decided per tool. */
function write(title: string, destructive: Destructiveness, idempotent: Idempotency, world: World): ToolHints {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: destructive === "destructive",
    idempotentHint: idempotent === "idempotent",
    openWorldHint: world === "open-world",
  };
}

export const toolAnnotations: Readonly<Record<string, ToolHints>> = {
  // Server
  evolution_server_verify_creds: read("Verify API credentials", "closed-world"),

  // Instance. create connects to WhatsApp with qrcode: true; connect returns the pending QR code when
  // repeated; set_presence is transient session state.
  evolution_instance_create: write("Create instance", "non-destructive", "not-idempotent", "open-world"),
  evolution_instance_fetch: read("List instances", "closed-world"),
  evolution_instance_connect: write("Connect instance", "non-destructive", "idempotent", "open-world"),
  evolution_instance_connection_state: read("Get connection state", "closed-world"),
  evolution_instance_restart: write("Restart instance", "destructive", "not-idempotent", "open-world"),
  evolution_instance_set_presence: write("Set instance presence", "non-destructive", "idempotent", "open-world"),
  evolution_instance_logout: write("Log out instance", "destructive", "idempotent", "open-world"),
  evolution_instance_delete: write("Delete instance", "destructive", "idempotent", "open-world"),

  // Settings. Every write closes and reopens the WhatsApp socket when a WAVoIP token is stored.
  evolution_settings_set: write("Update instance settings", "destructive", "not-idempotent", "open-world"),
  evolution_settings_find: read("Get instance settings", "closed-world"),

  // Messages: each call delivers a new message that cannot be recalled.
  evolution_message_send_text: write("Send text message", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_media: write("Send media message", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_ptv: write("Send video note", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_audio: write("Send voice note", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_sticker: write("Send sticker", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_location: write("Send location", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_contact: write("Send contact card", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_reaction: write("React to message", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_poll: write("Send poll", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_list: write("Send list message", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_buttons: write("Send button message", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_status: write("Post status", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_template: write("Send template message", "destructive", "not-idempotent", "open-world"),
  evolution_message_send_carousel: write("Send carousel", "destructive", "not-idempotent", "open-world"),

  // Chats. check_numbers, profile_picture_url and media_base64 query WhatsApp; the find_* tools and
  // get_poll_vote read the database. An edit or a delete for everyone converges when repeated.
  evolution_chat_check_numbers: read("Check WhatsApp numbers", "open-world"),
  evolution_chat_mark_read: write("Mark messages as read", "non-destructive", "idempotent", "open-world"),
  evolution_chat_mark_played: write("Mark voice notes as played", "non-destructive", "idempotent", "open-world"),
  evolution_chat_mark_unread: write("Mark chat as unread", "non-destructive", "idempotent", "open-world"),
  evolution_chat_archive: write("Archive chat", "non-destructive", "idempotent", "open-world"),
  evolution_chat_delete_message: write("Delete message for everyone", "destructive", "idempotent", "open-world"),
  evolution_chat_send_presence: write("Show chat presence", "non-destructive", "not-idempotent", "open-world"),
  evolution_chat_update_block: write("Block or unblock contact", "destructive", "idempotent", "open-world"),
  evolution_chat_profile_picture_url: read("Get profile picture URL", "open-world"),
  evolution_chat_media_base64: read("Download message media", "open-world"),
  evolution_chat_find_contacts: read("Find stored contacts", "closed-world"),
  evolution_chat_find_messages: read("Find stored messages", "closed-world"),
  evolution_chat_find_status: read("Find message status updates", "closed-world"),
  evolution_chat_find_chats: read("List stored chats", "closed-world"),
  evolution_chat_find_chat_by_jid: read("Get stored chat", "closed-world"),
  evolution_chat_update_message: write("Edit sent message", "destructive", "idempotent", "open-world"),
  evolution_chat_get_poll_vote: read("Get poll results", "closed-world"),
  evolution_chat_find_channels: read("List stored channels", "closed-world"),

  // Profile. Picture and privacy writes reload the WhatsApp connection.
  evolution_profile_fetch_business: read("Get business profile", "open-world"),
  evolution_profile_fetch: read("Get profile", "open-world"),
  evolution_profile_update_name: write("Update profile name", "destructive", "idempotent", "open-world"),
  evolution_profile_update_status: write("Update profile status", "destructive", "idempotent", "open-world"),
  evolution_profile_update_picture: write("Update profile picture", "destructive", "not-idempotent", "open-world"),
  evolution_profile_remove_picture: write("Remove profile picture", "destructive", "not-idempotent", "open-world"),
  evolution_profile_fetch_privacy: read("Get privacy settings", "open-world"),
  evolution_profile_update_privacy: write("Update privacy settings", "destructive", "not-idempotent", "open-world"),

  // Labels are private to the business account; handle adds or removes one on a chat.
  evolution_label_find: read("List labels", "closed-world"),
  evolution_label_handle: write("Add or remove chat label", "non-destructive", "idempotent", "open-world"),

  // Groups. Changes are announced to the members; invite_code reads the current link. Picture and
  // description changes are not idempotent: each call is a new picture or a new description revision
  // (Evolution uploads the picture again, Baileys gives each description a fresh id), announced to the
  // members. The subject, permission, member-add-mode and disappearing-message setters send only the
  // new value, with no revision id, so a repeat converges on the same state.
  evolution_group_create: write("Create group", "destructive", "not-idempotent", "open-world"),
  evolution_group_update_picture: write("Update group picture", "destructive", "not-idempotent", "open-world"),
  evolution_group_update_subject: write("Rename group", "destructive", "idempotent", "open-world"),
  evolution_group_update_description: write("Update group description", "destructive", "not-idempotent", "open-world"),
  evolution_group_invite_code: read("Get group invite link", "open-world"),
  evolution_group_revoke_invite: write("Revoke group invite link", "destructive", "not-idempotent", "open-world"),
  evolution_group_accept_invite: write("Join group by invite", "destructive", "idempotent", "open-world"),
  evolution_group_invite_info: read("Preview group invite", "open-world"),
  evolution_group_send_invite: write("Send group invite", "destructive", "not-idempotent", "open-world"),
  evolution_group_find_info: read("Get group info", "open-world"),
  evolution_group_fetch_all: read("List groups", "open-world"),
  evolution_group_participants: read("List group participants", "open-world"),
  evolution_group_update_participant: write("Update group participants", "destructive", "idempotent", "open-world"),
  evolution_group_update_setting: write("Update group permissions", "destructive", "idempotent", "open-world"),
  evolution_group_update_member_add_mode: write("Set who can add members", "destructive", "idempotent", "open-world"),
  evolution_group_toggle_ephemeral: write("Set disappearing messages", "destructive", "idempotent", "open-world"),
  evolution_group_leave: write("Leave group", "destructive", "idempotent", "open-world"),

  // Webhook: storing the URL is closed-world; Evolution only posts to it later.
  evolution_webhook_set: write("Configure webhook", "destructive", "idempotent", "closed-world"),
  evolution_webhook_find: read("Get webhook settings", "closed-world"),

  // Proxy: the proxy is tested against an external IP echo service before it is saved.
  evolution_proxy_set: write("Configure proxy", "destructive", "idempotent", "open-world"),
  evolution_proxy_find: read("Get proxy settings", "closed-world"),

  // Meta templates (Graph API). An edit is a new submission that Meta reviews.
  evolution_template_create: write("Create Meta template", "non-destructive", "not-idempotent", "open-world"),
  evolution_template_edit: write("Edit Meta template", "destructive", "not-idempotent", "open-world"),
  evolution_template_delete: write("Delete Meta template", "destructive", "idempotent", "open-world"),
  evolution_template_find: read("List Meta templates", "open-world"),

  // Business catalog (WhatsApp)
  evolution_business_get_catalog: read("Get product catalog", "open-world"),
  evolution_business_get_collections: read("Get catalog collections", "open-world"),

  // Event transports: per-instance switches for brokers that the operator configures server-wide.
  evolution_websocket_set: write("Configure Websocket events", "destructive", "idempotent", "closed-world"),
  evolution_websocket_find: read("Get Websocket settings", "closed-world"),
  evolution_rabbitmq_set: write("Configure RabbitMQ events", "destructive", "idempotent", "closed-world"),
  evolution_rabbitmq_find: read("Get RabbitMQ settings", "closed-world"),
  evolution_sqs_set: write("Configure AWS SQS events", "destructive", "idempotent", "closed-world"),
  evolution_sqs_find: read("Get AWS SQS settings", "closed-world"),
  evolution_nats_set: write("Configure NATS events", "destructive", "idempotent", "closed-world"),
  evolution_nats_find: read("Get NATS settings", "closed-world"),
  evolution_kafka_set: write("Configure Kafka events", "destructive", "idempotent", "closed-world"),
  evolution_kafka_find: read("Get Kafka settings", "closed-world"),

  // Pusher: the credentials are stored; Evolution only publishes to Pusher later.
  evolution_pusher_set: write("Configure Pusher events", "destructive", "idempotent", "closed-world"),
  evolution_pusher_find: read("Get Pusher settings", "closed-world"),

  // Chatwoot: with autoCreate, each write calls Chatwoot and opens a new init conversation.
  evolution_chatwoot_set: write("Configure Chatwoot", "destructive", "not-idempotent", "open-world"),
  evolution_chatwoot_find: read("Get Chatwoot settings", "closed-world"),

  // Bot integrations: the CRUD routes only touch Evolution's database. change_status closes or
  // deletes sessions; ignore_jid adds or removes one JID. typebot_start sends the flow's messages.
  evolution_typebot_create: write("Create Typebot bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_typebot_find: read("List Typebot bots", "closed-world"),
  evolution_typebot_fetch: read("Get Typebot bot", "closed-world"),
  evolution_typebot_update: write("Update Typebot bot", "destructive", "idempotent", "closed-world"),
  evolution_typebot_delete: write("Delete Typebot bot", "destructive", "idempotent", "closed-world"),
  evolution_typebot_change_status: write("Change Typebot session status", "destructive", "idempotent", "closed-world"),
  evolution_typebot_settings_set: write("Update Typebot settings", "destructive", "idempotent", "closed-world"),
  evolution_typebot_settings_fetch: read("Get Typebot settings", "closed-world"),
  evolution_typebot_fetch_sessions: read("List Typebot sessions", "closed-world"),
  evolution_typebot_ignore_jid: write("Update Typebot ignore list", "non-destructive", "idempotent", "closed-world"),
  evolution_typebot_start: write("Start Typebot flow", "destructive", "not-idempotent", "open-world"),

  evolution_openai_create: write("Create OpenAI bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_openai_find: read("List OpenAI bots", "closed-world"),
  evolution_openai_fetch: read("Get OpenAI bot", "closed-world"),
  evolution_openai_update: write("Update OpenAI bot", "destructive", "idempotent", "closed-world"),
  evolution_openai_delete: write("Delete OpenAI bot", "destructive", "idempotent", "closed-world"),
  evolution_openai_change_status: write("Change OpenAI session status", "destructive", "idempotent", "closed-world"),
  evolution_openai_settings_set: write("Update OpenAI settings", "destructive", "idempotent", "closed-world"),
  evolution_openai_settings_fetch: read("Get OpenAI settings", "closed-world"),
  evolution_openai_fetch_sessions: read("List OpenAI sessions", "closed-world"),
  evolution_openai_ignore_jid: write("Update OpenAI ignore list", "non-destructive", "idempotent", "closed-world"),
  evolution_openai_creds_set: write("Add OpenAI credential", "non-destructive", "not-idempotent", "closed-world"),
  evolution_openai_creds_find: read("List OpenAI credentials", "closed-world"),
  evolution_openai_creds_delete: write("Delete OpenAI credential", "destructive", "idempotent", "closed-world"),
  evolution_openai_get_models: read("List OpenAI models", "open-world"),

  evolution_dify_create: write("Create Dify bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_dify_find: read("List Dify bots", "closed-world"),
  evolution_dify_fetch: read("Get Dify bot", "closed-world"),
  evolution_dify_update: write("Update Dify bot", "destructive", "idempotent", "closed-world"),
  evolution_dify_delete: write("Delete Dify bot", "destructive", "idempotent", "closed-world"),
  evolution_dify_change_status: write("Change Dify session status", "destructive", "idempotent", "closed-world"),
  evolution_dify_settings_set: write("Update Dify settings", "destructive", "idempotent", "closed-world"),
  evolution_dify_settings_fetch: read("Get Dify settings", "closed-world"),
  evolution_dify_fetch_sessions: read("List Dify sessions", "closed-world"),
  evolution_dify_ignore_jid: write("Update Dify ignore list", "non-destructive", "idempotent", "closed-world"),

  evolution_evolutionbot_create: write("Create Evolution Bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_evolutionbot_find: read("List Evolution Bots", "closed-world"),
  evolution_evolutionbot_fetch: read("Get Evolution Bot", "closed-world"),
  evolution_evolutionbot_update: write("Update Evolution Bot", "destructive", "idempotent", "closed-world"),
  evolution_evolutionbot_delete: write("Delete Evolution Bot", "destructive", "idempotent", "closed-world"),
  evolution_evolutionbot_change_status: write(
    "Change Evolution Bot session status",
    "destructive",
    "idempotent",
    "closed-world",
  ),
  evolution_evolutionbot_settings_set: write(
    "Update Evolution Bot settings",
    "destructive",
    "idempotent",
    "closed-world",
  ),
  evolution_evolutionbot_settings_fetch: read("Get Evolution Bot settings", "closed-world"),
  evolution_evolutionbot_fetch_sessions: read("List Evolution Bot sessions", "closed-world"),
  evolution_evolutionbot_ignore_jid: write(
    "Update Evolution Bot ignore list",
    "non-destructive",
    "idempotent",
    "closed-world",
  ),

  evolution_flowise_create: write("Create Flowise bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_flowise_find: read("List Flowise bots", "closed-world"),
  evolution_flowise_fetch: read("Get Flowise bot", "closed-world"),
  evolution_flowise_update: write("Update Flowise bot", "destructive", "idempotent", "closed-world"),
  evolution_flowise_delete: write("Delete Flowise bot", "destructive", "idempotent", "closed-world"),
  evolution_flowise_change_status: write("Change Flowise session status", "destructive", "idempotent", "closed-world"),
  evolution_flowise_settings_set: write("Update Flowise settings", "destructive", "idempotent", "closed-world"),
  evolution_flowise_settings_fetch: read("Get Flowise settings", "closed-world"),
  evolution_flowise_fetch_sessions: read("List Flowise sessions", "closed-world"),
  evolution_flowise_ignore_jid: write("Update Flowise ignore list", "non-destructive", "idempotent", "closed-world"),

  evolution_n8n_create: write("Create n8n bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_n8n_find: read("List n8n bots", "closed-world"),
  evolution_n8n_fetch: read("Get n8n bot", "closed-world"),
  evolution_n8n_update: write("Update n8n bot", "destructive", "idempotent", "closed-world"),
  evolution_n8n_delete: write("Delete n8n bot", "destructive", "idempotent", "closed-world"),
  evolution_n8n_change_status: write("Change n8n session status", "destructive", "idempotent", "closed-world"),
  evolution_n8n_settings_set: write("Update n8n settings", "destructive", "idempotent", "closed-world"),
  evolution_n8n_settings_fetch: read("Get n8n settings", "closed-world"),
  evolution_n8n_fetch_sessions: read("List n8n sessions", "closed-world"),
  evolution_n8n_ignore_jid: write("Update n8n ignore list", "non-destructive", "idempotent", "closed-world"),

  evolution_evoai_create: write("Create EvoAI bot", "non-destructive", "not-idempotent", "closed-world"),
  evolution_evoai_find: read("List EvoAI bots", "closed-world"),
  evolution_evoai_fetch: read("Get EvoAI bot", "closed-world"),
  evolution_evoai_update: write("Update EvoAI bot", "destructive", "idempotent", "closed-world"),
  evolution_evoai_delete: write("Delete EvoAI bot", "destructive", "idempotent", "closed-world"),
  evolution_evoai_change_status: write("Change EvoAI session status", "destructive", "idempotent", "closed-world"),
  evolution_evoai_settings_set: write("Update EvoAI settings", "destructive", "idempotent", "closed-world"),
  evolution_evoai_settings_fetch: read("Get EvoAI settings", "closed-world"),
  evolution_evoai_fetch_sessions: read("List EvoAI sessions", "closed-world"),
  evolution_evoai_ignore_jid: write("Update EvoAI ignore list", "non-destructive", "idempotent", "closed-world"),
};
