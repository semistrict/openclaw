# OpenClaw Slack Integration -- Full Technical Reference

This document describes every aspect of how OpenClaw interacts with Slack: from receiving messages, through agent processing, to delivering replies. It covers the infrastructure, behavioral prompts, optimizations, security model, and historical evolution.

> **Code pointers** use GitHub permalinks pinned to commit `4b993ba`. File references use `owner/repo` relative paths.
>
> **Key directories:**
> - [`extensions/slack/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/slack) -- Slack channel plugin (bundled)
> - [`extensions/slack/src/monitor/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/slack/src/monitor) -- Inbound event handling, provider lifecycle
> - [`extensions/slack/src/monitor/message-handler/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/slack/src/monitor/message-handler) -- Message preparation and dispatch
> - [`extensions/slack/src/monitor/events/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/slack/src/monitor/events) -- Bolt event listeners
> - [`extensions/slack/src/http/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/slack/src/http) -- HTTP webhook routes
> - [`src/routing/`](https://github.com/openclaw/openclaw/tree/4b993ba/src/routing) -- Session key and route resolution
> - [`src/auto-reply/reply/`](https://github.com/openclaw/openclaw/tree/4b993ba/src/auto-reply/reply) -- Agent reply pipeline, prompt composition, group behavior
> - [`src/channels/`](https://github.com/openclaw/openclaw/tree/4b993ba/src/channels) -- Shared channel abstractions (mention gating, etc.)
> - [`extensions/thread-ownership/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/thread-ownership) -- Thread ownership plugin

---

## Table of Contents

1. [Plugin Architecture](#plugin-architecture)
2. [Channel Plugin Contract](#channel-plugin-contract)
3. [Connection Modes](#connection-modes)
4. [Inbound Pipeline](#inbound-pipeline)
   - [Event Registration](#event-registration)
   - [Deduplication and Race Handling](#deduplication-and-race-handling)
   - [Debouncing](#debouncing)
   - [Authorization](#authorization)
   - [Mention Detection and Gating](#mention-detection-and-gating)
   - [Content Resolution](#content-resolution)
   - [Thread Context Assembly](#thread-context-assembly)
   - [Context Payload Assembly](#context-payload-assembly)
5. [Event Handling Beyond Messages](#event-handling-beyond-messages)
6. [Session and Threading Model](#session-and-threading-model)
7. [Agent Prompt Composition](#agent-prompt-composition)
   - [System Prompt Structure](#system-prompt-structure)
   - [Group Chat Behavioral Prompts](#group-chat-behavioral-prompts)
   - [The Silent Reply Mechanism](#the-silent-reply-mechanism)
   - [What the LLM Sees](#what-the-llm-sees)
8. [Outbound Pipeline](#outbound-pipeline)
   - [Text Formatting](#text-formatting)
   - [Text Chunking](#text-chunking)
   - [Block Kit Rendering](#block-kit-rendering)
   - [Media Upload](#media-upload)
   - [Streaming](#streaming)
   - [Interactive Replies](#interactive-replies)
9. [Agent Tool Actions](#agent-tool-actions)
10. [Status Indicators and Reactions](#status-indicators-and-reactions)
    - [Assistants API Usage](#assistants-api-usage)
    - [Typing Reactions](#typing-reactions)
    - [Status Reaction Lifecycle](#status-reaction-lifecycle)
    - [Ack Reactions](#ack-reactions)
11. [Configuration and Multi-Account Support](#configuration-and-multi-account-support)
    - [Account Resolution](#account-resolution)
    - [Token Management](#token-management)
    - [Config Options Reference](#config-options-reference)
12. [Security Model](#security-model)
    - [DM Access Control](#dm-access-control)
    - [Channel Access Control](#channel-access-control)
    - [Allowlist Matching](#allowlist-matching)
    - [Thread Context Filtering](#thread-context-filtering)
    - [Exec Approvals](#exec-approvals)
13. [Setup and Diagnostics](#setup-and-diagnostics)
14. [Slash Commands](#slash-commands)
15. [Thread Ownership Plugin](#thread-ownership-plugin)
16. [Historical Evolution](#historical-evolution)
17. [Slack-Unique Features in Depth](#slack-unique-features-in-depth)
18. [Slack vs. Discord](#slack-vs-discord)

---

## Plugin Architecture

Slack is a **bundled channel plugin** at `extensions/slack/`. It follows the standard Plugin SDK contract: all production imports go through `openclaw/plugin-sdk/*` subpaths or local barrels (`./api.ts`, `./runtime-api.ts`). Core code never deep-imports extension internals.

The plugin registers via `defineChannelPluginEntry` in [`extensions/slack/index.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/index.ts):

- **`id`**: `"slack"`
- **`plugin`**: The channel plugin object ([`slackPlugin`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L299)) built by `createChatChannelPlugin` in [`extensions/slack/src/channel.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts)
- **`setRuntime`**: Injects the runtime context (config loader, etc.)
- **`registerFull`**: Registers HTTP webhook routes for HTTP mode

Dependencies: `@slack/bolt` (^4.6.0) for Socket Mode and event handling, `@slack/web-api` (^7.15.0) for API calls.

The manifest ([`extensions/slack/openclaw.plugin.json`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/openclaw.plugin.json)) declares `channels: ["slack"]` and the `package.json` metadata defines the channel as `"Slack (Socket Mode)"` with `markdownCapable: true`.

---

## Channel Plugin Contract

Slack is a **chat channel plugin** -- one of 22 channel plugins in the OpenClaw plugin system. It implements the [`ChannelPlugin<ResolvedAccount, Probe>`](https://github.com/openclaw/openclaw/blob/4b993ba/src/channels/plugins/types.plugin.ts#L82) contract, which is a composition of ~30 adapter slots. The Slack plugin fills 24 of them, putting it in the top tier alongside Discord (25) and Telegram (25).

> **Contract definition files:**
> [`types.plugin.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/src/channels/plugins/types.plugin.ts#L82) (top-level shape) |
> [`types.core.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/src/channels/plugins/types.core.ts) (capabilities, messaging, threading, mentions) |
> [`types.adapters.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/src/channels/plugins/types.adapters.ts) (config, setup, status, gateway, outbound, security, etc.)
>
> **Builder:** [`createChatChannelPlugin`](https://github.com/openclaw/openclaw/blob/4b993ba/src/plugin-sdk/channel-core.ts#L365) -- convenience factory that assembles the base + security + pairing + threading + outbound slots.
>
> **Entry point:** [`defineChannelPluginEntry`](https://github.com/openclaw/openclaw/blob/4b993ba/src/plugin-sdk/channel-core.ts#L277) -- wraps the plugin in the registration lifecycle (setRuntime, registerChannel, registerFull).

### Declared Capabilities

The Slack plugin declares these static capability flags in [`shared.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/shared.ts#L185):

```typescript
capabilities: {
  chatTypes: ["direct", "channel", "thread"],
  reactions: true,
  threads: true,
  media: true,
  nativeCommands: true,
}
```

| Flag | Value | Meaning |
|---|---|---|
| `chatTypes` | `["direct", "channel", "thread"]` | Supports DMs, public/private channels, and threaded conversations |
| `reactions` | `true` | Can add/remove emoji reactions on messages |
| `threads` | `true` | Supports thread-scoped conversations and reply threading |
| `media` | `true` | Can send and receive files/images/audio |
| `nativeCommands` | `true` | Supports native channel commands (but `nativeCommandsAutoEnabled: false`) |
| `polls` | _not set_ | No native poll support |
| `edit` | _not set_ | Message editing is done via tool actions, not the edit capability flag |
| `blockStreaming` | _not set_ | Block streaming uses the default behavior |

### Adapter Slots Implemented

The table below lists every slot of the `ChannelPlugin` contract and whether the Slack plugin implements it. All wiring is in [`channel.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L299) (the `slackPlugin` export) and [`shared.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/shared.ts#L160) (the `createSlackPluginBase` factory).

| Adapter slot | Implemented | Purpose | Key implementation |
|---|---|---|---|
| **`id`** | Yes | Channel identifier | `"slack"` |
| **`meta`** | Yes | Display metadata (label, docs path, blurb) | `getChatChannelMeta("slack")` + `preferSessionLookupForAnnounceTarget: true` |
| **`capabilities`** | Yes | Static capability flags | See table above |
| **`defaults`** | -- | Queue/debounce defaults | Uses SDK defaults |
| **`reload`** | Yes | Config hot-reload prefixes | `configPrefixes: ["channels.slack"]` |
| **`setupWizard`** | Yes | Interactive setup wizard | [`setup-surface.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/setup-surface.ts) (token collection, allowlist, DM policy, interactive replies) |
| **`config`** | Yes | Account resolution, inspection, allowFrom | [`slackConfigAdapter`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/shared.ts#L148) via `createScopedChannelConfigAdapter` |
| **`configSchema`** | Yes | Zod schema + UI hints | [`config-schema.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/config-schema.ts) + [`config-ui-hints.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/config-ui-hints.ts) |
| **`setup`** | Yes | CLI setup adapter (`--bot-token`, `--app-token`) | [`setup-core.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/setup-core.ts) |
| **`pairing`** | Yes | DM pairing flow (challenge code, notify) | Text pairing with `normalizeAllowEntry` stripping `slack:`/`user:` prefixes |
| **`security`** | Yes | DM policy, security warnings, audit findings | [`resolveDmPolicy`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L77), [`collectWarnings`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L279), [`collectAuditFindings`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/security-audit.ts#L23) |
| **`groups`** | Yes | Per-channel mention requirement and tool policy | [`resolveSlackGroupRequireMention`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/group-policy.ts), `resolveSlackGroupToolPolicy` |
| **`mentions`** | Yes | Mention strip patterns for `<@U...>` tags | `stripPatterns: () => ["<@[^>\\s]+>"]` |
| **`messaging`** | Yes | Target normalization, session routing, interactive replies | Explicit target parsing, outbound session route resolution, target resolver, `enableInteractiveReplies` |
| **`directory`** | Yes | Peer and group directory (config + live API) | [`createChannelDirectoryAdapter`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L356) with config-based and live (Slack API) listing |
| **`resolver`** | Yes | Resolve user/channel names to IDs via Slack API | [`resolveSlackChannelAllowlist`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L367), `resolveSlackUserAllowlist` |
| **`actions`** | Yes | Message tool actions (send, read, edit, react, pin, etc.) | [`createSlackActions`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel-actions.ts#L27) -- 13 action types |
| **`status`** | Yes | Account status, probe, capability diagnostics | [`createComputedAccountStatusAdapter`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L415) with `probeSlack` and scope inspection |
| **`gateway`** | Yes | Start/stop per-account provider (Socket Mode or HTTP) | [`startAccount`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel.ts#L482) -> `monitorSlackProvider` |
| **`allowlist`** | Yes | DM allowlist editing + group overrides + name resolution | Legacy DM allowlist adapter + scoped group overrides + Slack API name resolution |
| **`approvalCapability`** | Yes | Native exec approval delivery via Slack messages | [`slackApprovalCapability`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/approval-native.ts#L119) -- origin + DM delivery |
| **`commands`** | Yes | Native command config | `nativeCommandsAutoEnabled: false`, renames `status` -> `agentstatus` |
| **`doctor`** | Yes | Diagnostic checks and legacy config migration | [`slackDoctor`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/doctor.ts#L331) -- streaming aliases, DM alias normalization, mutable allowlist warnings |
| **`agentPrompt`** | Yes | LLM formatting hints and tool hints | Slack mrkdwn rules + interactive reply directive examples |
| **`streaming`** | Yes | Block streaming coalesce defaults | `minChars: 1500, idleMs: 1000` |
| **`threading`** | Yes | Reply-to mode, auto-thread ID, reply transport | Scoped account reply mode, thread tool context, auto-threading per `replyToMode` |
| **`outbound`** | Yes | Message delivery (text, media, blocks, chunking) | `deliveryMode: "direct"`, `textChunkLimit: 8000`, send with token override, attached result sends |
| **`auth`** | -- | _Not implemented_ | No dedicated auth adapter (auth is handled by token management) |
| **`elevated`** | -- | _Not implemented_ | No channel-specific elevated mode |
| **`lifecycle`** | -- | _Not implemented_ | No explicit lifecycle hooks (uses gateway start/stop) |
| **`heartbeat`** | -- | _Not implemented_ | No Slack-specific heartbeat |
| **`bindings`** | -- | _Not implemented_ | No binding provider |
| **`conversationBindings`** | Auto | Conversation binding support | Set to `supportsCurrentConversationBinding: true` by `createChatChannelPlugin` |
| **`agentTools`** | -- | _Not implemented_ | Slack tools are registered via the `actions` adapter, not as standalone agent tools |

### Type Parameterization

The Slack plugin is parameterized on two types:

- **`ResolvedSlackAccount`** -- The resolved account object produced by [`resolveSlackAccount`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/accounts.ts#L45). Carries `accountId`, `enabled`, `name`, three tokens (bot/app/user) with their sources, `groupPolicy`, `textChunkLimit`, `mediaMaxMb`, `replyToMode`, `actions`, `slashCommand`, `dm` policy, `channels` config, and more.

- **`SlackProbe`** -- The probe result from [`probeSlack`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/probe.ts#L12). Contains `ok`, `status`, `elapsedMs`, `bot: { id, name }`, `team: { id, name }`.

These types flow through the generic `ChannelPlugin<ResolvedAccount, Probe>` contract so that status, security, config, and gateway adapters receive strongly typed account and probe objects.

### Plugin Registration Lifecycle

When the plugin is loaded, registration happens in three phases (via [`defineChannelPluginEntry`](https://github.com/openclaw/openclaw/blob/4b993ba/src/plugin-sdk/channel-core.ts#L277)):

1. **`setRuntime(api.runtime)`** -- Injects the host runtime (config loader, logger, store) into the plugin via [`setSlackRuntime`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/index.ts#L4).
2. **`api.registerChannel({ plugin })`** -- Registers the `slackPlugin` object with the channel registry. This makes all adapter slots available to core.
3. **`registerFull(api)`** (full mode only) -- Calls [`registerSlackPluginHttpRoutes`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/http/plugin-routes.ts#L13) to register HTTP webhook routes for each configured account.

In `cli-metadata` mode (used for CLI help/completions), only `registerCliMetadata` runs -- the full plugin is not loaded.

### Where Slack Sits Among Channel Plugins

Slack sits in the top tier of channel plugins alongside Discord (25 slots, 36K LOC) and Telegram (25 slots, 27K LOC). A detailed head-to-head comparison follows in [Slack vs. Discord](#slack-vs-discord) at the end of this document, and Slack's platform-exclusive features are covered in [Slack-Unique Features in Depth](#slack-unique-features-in-depth).

---

## Connection Modes

Slack supports **Socket Mode** (default, persistent WebSocket) and **HTTP Mode** (webhook receiver). See [Dual Connection Mode (Socket + HTTP)](#dual-connection-mode-socket--http) for token requirements, reconnection policy, and implementation details.

**Additional Socket Mode details** not covered in the unique features section:

- The `@slack/bolt` import uses a hardened interop resolver (`resolveSlackBoltInterop`) that tries multiple resolution strategies (direct module, nested default, namespace default, constructor detection) to handle Bun vs. Node ESM vs. CJS differences. This was added after Node 25.x compatibility issues.
- [`gracefulStopSlackApp`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/provider.ts#L192) pre-sets `shuttingDown = true` on the internal `SocketModeClient` before calling `stop()` to prevent orphaned ping intervals from firing reconnects during shutdown.

---

## Inbound Pipeline

A Slack message passes through these stages:

```
Slack Event API
  -> Bolt Event Listener (events/messages.ts)
  -> Message Handler Entry (message-handler.ts)   -- dedup, subtype filter, thread resolution, debounce
  -> Preparation (message-handler/prepare.ts)      -- auth, routing, content, context assembly
  -> Dispatch (message-handler/dispatch.ts)        -- agent dispatch, streaming, reply delivery, cleanup
```

> **Key file links:**
> [`events/messages.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/events/messages.ts) |
> [`message-handler.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler.ts) |
> [`prepare.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare.ts) |
> [`dispatch.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/dispatch.ts) |
> [`context.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/context.ts)

### Event Registration

Two Bolt event listeners in [`extensions/slack/src/monitor/events/messages.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/events/messages.ts#L11):

- **`app.event("message")`** -- All message types (channels, groups, IMs, MPIMs). Slack fires this for every message regardless of mention.
- **`app.event("app_mention")`** -- Explicit `@bot` mentions only. Has a dedup guard: if the channel type is `im` or `mpim`, the event is silently dropped (the `message` event already handles DMs).

Both handlers first call `ctx.shouldDropMismatchedSlackEvent(body)` which compares `api_app_id` and `team_id` against the configured context, silently dropping events from other apps sharing the same endpoint.

Message subtypes like `message_changed`, `message_deleted`, and `thread_broadcast` are routed to `enqueueSystemEvent` via `resolveSlackMessageSubtypeHandler` rather than normal message handling. Only `file_share` and `bot_message` subtypes are allowed through the main pipeline.

### Deduplication and Race Handling

Three dedup layers protect against duplicate processing:

1. **Seen message cache**: A TTL cache (60 seconds, max 500 entries) keyed on `${channelId}:${ts}`. `markMessageSeen()` returns `true` if already seen.

2. **App mention retry keys**: When a `message` event is seen first, a retry key is primed (60-second TTL). If `app_mention` fires later for the same message, it is allowed through by consuming the retry key. This handles the race where Slack fires both events for an @-mention in a channel.

3. **Dispatched keys**: If `app_mention` dispatches first, a dispatched key is recorded. When the `message` event arrives later, it checks for the dispatched key and drops silently.

This ensures exactly one dispatch per message regardless of event ordering.

### Debouncing

Short consecutive messages from the same sender in the same context are batched into a single agent turn using `createChannelInboundDebouncer` from the Plugin SDK.

**Debounce key construction** ([`buildSlackDebounceKey`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler.ts#L71)):

| Context | Key pattern | Rationale |
|---|---|---|
| Thread message | `slack:{accountId}:{channel}:{thread_ts}:{senderId}` | Thread-scoped |
| Top-level channel msg | `slack:{accountId}:{channel}:{message_ts}:{senderId}` | Per-message scoping prevents cross-message merging |
| DM | `slack:{accountId}:{channel}:{senderId}` | Channel-scoped to preserve short-message batching |

**Debounce eligibility**: `shouldDebounceTextInbound` checks global config and whether the message has media (media messages skip debouncing).

**Flush behavior**: All accumulated entries are merged into a synthetic message: texts joined with `\n`, the last message's metadata used as the base, `wasMentioned` OR'd across all entries. For multi-message batches, `MessageSids`, `MessageSidFirst`, and `MessageSidLast` are set for traceability.

**Conversation flush**: When a non-debounceable message (e.g., a command) arrives for a conversation that has pending debounce keys, all pending keys are flushed first. This prevents a fast follow-up from being blocked behind a debounce timer.

### Authorization

Authorization happens in `authorizeSlackInboundMessage` (in [`prepare.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare.ts#L172)) through several gates:

1. **Bot self-filter**: Messages from the bot's own user ID are always dropped.
2. **Bot message gating**: If `message.bot_id` is set and `allowBots` is false (default), the message is dropped.
3. **Channel policy** (`isChannelAllowed` in `context.ts`):
   - DMs: controlled by `dmEnabled`
   - Group DMs: controlled by `groupDmEnabled` + optional `groupDmChannels` allowlist
   - Rooms: evaluated via [`isSlackChannelAllowedByPolicy`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/policy.ts#L3) with three policies: `open` (all allowed), `disabled` (none allowed), `allowlist` (only matched channels)
4. **Allowlist resolution** ([`resolveSlackEffectiveAllowFrom`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/auth.ts#L58)): Merges static config allowlist with dynamically paired users from the store. Uses a WeakMap cache with 5-second TTL and inflight dedup to avoid parallel store reads.
5. **DM authorization** ([`authorizeSlackDirectMessage`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/dm-auth.ts#L7)): See [DM Access Control](#dm-access-control).
6. **Per-channel user authorization**: Rooms with per-channel `users` allowlists check the sender. Unauthorized senders in rooms are silently dropped.
7. **Command authorization**: `resolveControlCommandGate` determines whether the sender can run control commands, considering both global and per-channel allowlists. Unauthorized control commands in rooms are dropped.

### Mention Detection and Gating

Three kinds of mention are detected in [`prepare.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare.ts#L369):

1. **Explicit mention**: Message text contains `<@BOT_USER_ID>`.
2. **Regex mention**: Message matches configured `mentionPatterns` (custom agent names/aliases).
3. **Implicit mention**: The bot started the thread (`parent_user_id === botUserId`) or has previously participated in the thread (tracked via [`sent-thread-cache.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/sent-thread-cache.ts#L26), a 24-hour TTL, 5000-entry in-memory cache).

`matchesMentionWithExplicit` combines all three signals into `wasMentioned`.

**Mention gating** ([`resolveMentionGatingWithBypass`](https://github.com/openclaw/openclaw/blob/4b993ba/src/channels/mention-gating.ts#L38)):

- In rooms where `requireMention: true` (the default), messages without any detected mention are **dropped** -- but the message text is recorded as a "pending history entry" so the agent has context when it is eventually mentioned.
- **Command bypass**: If the message contains a control command from an authorized sender, mention gating is bypassed even when `requireMention` is true.
- **Implicit mention counts**: Thread participation counts as a mention for gating purposes. This means the agent receives every message in threads it has participated in, even conversations between humans.

The `WasMentioned` field on the context payload is only set for room-ish chats. DMs never need it.

### Content Resolution

`resolveSlackMessageContent` in [`prepare-content.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare-content.ts) handles:

- **File deduplication**: For thread replies, filters out files belonging to the thread starter (Slack sometimes includes parent files on replies).
- **Media download**: Up to 8 files, 3 concurrent. Each download:
  - SSRF protection: only `*.slack.com`, `*.slack-edge.com`, `*.slack-files.com` allowed
  - Auth: first request uses `Bearer` token; redirects strip auth (Slack CDN uses pre-signed URLs)
  - HTML guard: rejects responses that look like login/auth HTML pages
  - Voice normalization: `slack_audio` subtype with `video/*` MIME remapped to `audio/*`
  - Size limits enforced (`mediaMaxBytes`)
- **Forwarded attachments**: `resolveSlackAttachmentContent` extracts text and media from forwarded messages (identified by `is_share: true`), up to 8 attachments with image downloads.
- **Body assembly**: Concatenates message text, attachment text, bot fallback text, media placeholders (e.g., `[Slack file: report.pdf]`), and file name fallbacks. Returns `null` (dropping the message) if the raw body is empty.

### Thread Context Assembly

[`resolveSlackThreadContextData`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare-thread-context.ts#L49) runs only for thread replies:

- **Thread starter**: Fetched via `resolveSlackThreadStarter` (cached 6 hours, max 2000 entries). Extracts text, user, files.
- **Sender authorization for context**: `isSlackThreadContextSenderAllowed` checks if the thread starter and history message senders are in the allowlist. Messages from unauthorized senders can be omitted based on `contextVisibilityMode`.
- **Thread starter media**: If the direct message has no media but the thread starter does, the starter's files are downloaded as supplemental media.
- **Thread history**: For new sessions only (no previous timestamp), fetches up to `initialHistoryLimit` (default 20) messages via cursor pagination. Filters by sender authorization, resolves user names, and formats each entry with `formatInboundEnvelope`.
- Returns: `threadStarterBody`, `threadHistoryBody`, `threadSessionPreviousTimestamp`, `threadLabel`, `threadStarterMedia`.

### Context Payload Assembly

The final `FinalizedMsgContext` includes:

| Field | Source |
|---|---|
| `Body` | Formatted envelope with pending history prepended |
| `RawBody` | Original message text |
| `CommandBody` | Text with mentions stripped for command detection |
| `From` / `To` | `slack:U123` or `slack:channel:C123` / `user:U123` or `channel:C123` |
| `SessionKey` | Computed session key (see threading model) |
| `ChatType` | `"direct"` / `"channel"` / `"group"` |
| `SenderName` / `SenderId` | Resolved display name / Slack user ID |
| `WasMentioned` | Boolean, only for room-ish chats |
| `ThreadStarterBody` | Only for new thread sessions |
| `ThreadHistoryBody` | Thread message history |
| `ThreadLabel` | Thread description label |
| `IsFirstThreadTurn` | True on first reply in a thread |
| `GroupSubject` | Channel name (e.g., `#general`) |
| `GroupSystemPrompt` | Per-channel system prompt if configured |
| `UntrustedContext` | Channel topic/purpose (labeled as untrusted) |
| `MediaPath` / `MediaType` | Primary media file |
| `MediaPaths` / `MediaTypes` | All media files |
| `ReplyToId` | Thread ts for reply targeting |
| `MessageThreadId` | Thread ts for session routing |
| `ParentSessionKey` | Parent session key when thread inherits |
| `CommandAuthorized` | Whether sender can run commands |

---

## Event Handling Beyond Messages

Beyond the core message pipeline, the Slack plugin registers handlers for several other event types:

### Reaction Events

`reaction_added` and `reaction_removed` events are tracked. Reaction notifications can be filtered via `reactionNotifications` config:
- `"off"`: no notifications
- `"own"`: only reactions on the bot's own messages
- `"allowlist"`: filtered by a configurable reaction allowlist
- Default: all reactions forwarded

### Channel Events

- **`channel_created`** and **`channel_rename`**: Forwarded as system events.
- **`channel_id_changed`**: Triggers **automatic config migration** -- when Slack reassigns a channel ID (e.g., during workspace migration), the handler migrates channel config entries from the old ID to the new one via [`migrateSlackChannelConfig`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/channel-migration.ts#L59). It reloads config, runs the migration, and writes the updated config to disk. Gated behind `configWrites`.

### Member Events

`member_joined_channel` and `member_left_channel` are forwarded as system events for group awareness.

### Pin Events

`pin_added` and `pin_removed` are forwarded as system events.

### Interaction Events

Block actions, modal submissions (`view_submission`), and modal closures (`view_closed`) are handled:

- **Block actions**: Routed to plugin interactive handlers via `dispatchSlackPluginInteractiveHandler`. After processing, `updateSlackLegacyBlockAction` replaces the clicked action row with a confirmation context block showing which option was selected and by whom.
- **Plugin binding approvals**: `handleSlackPluginBindingApproval` handles a dedicated interactive flow for plugin binding approval custom IDs.
- **Modals**: Both `view_submission` and `view_closed` handlers process modals with `openclaw:` prefixed callback IDs, extracting view state values into summarized input payloads.

### Event Liveness Tracking

Every inbound event updates `lastEventAt` and `lastInboundAt` timestamps on the provider status, enabling health monitoring to detect "half-dead" sockets that pass health checks but stop delivering events.

---

## Session and Threading Model

Every inbound message gets a **session key** that determines which agent conversation it belongs to.

### Base Session Key

Built by [`resolveAgentRoute`](https://github.com/openclaw/openclaw/blob/4b993ba/src/routing/resolve-route.ts#L631) -> [`buildAgentPeerSessionKey`](https://github.com/openclaw/openclaw/blob/4b993ba/src/routing/session-key.ts#L127):

| Slack context | Peer kind | `dmScope` | Session key pattern |
|---|---|---|---|
| DM | `direct` | `main` (default) | `agent:<agentId>:main` |
| DM | `direct` | `per-peer` | `agent:<agentId>:direct:<userId>` |
| DM | `direct` | `per-channel-peer` | `agent:<agentId>:slack:direct:<userId>` |
| DM | `direct` | `per-account-channel-peer` | `agent:<agentId>:slack:<accountId>:direct:<userId>` |
| Channel msg | `channel` | -- | `agent:<agentId>:slack:channel:<channelId>` |
| Group DM | `group` | -- | `agent:<agentId>:slack:group:<channelId>` |

### Thread Suffix

[`resolveThreadSessionKeys`](https://github.com/openclaw/openclaw/blob/4b993ba/src/routing/session-key.ts#L234) appends `:thread:<thread_ts>` when a thread ID is present:

```
<baseSessionKey>:thread:<thread_ts>
```

The `canonicalThreadId` is determined by [`resolveSlackRoutingContext`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare.ts#L258):

| Scenario | Thread ID used | Effect |
|---|---|---|
| Channel/group thread reply (`thread_ts` != `ts`) | `thread_ts` | Forks into thread-specific session |
| Top-level channel message | None | Stays on per-channel session |
| DM with `replyToMode=all` | `message.ts` | Each DM turn gets its own thread session |
| DM thread reply | `thread_ts` | Uses thread session |

### Concrete Examples

```
# DM (dmScope=main, replyToMode=all):
agent:main:main:thread:1712234567.000100

# DM (dmScope=per-peer, replyToMode=off):
agent:main:direct:u12345

# Top-level message in #general (C09ABC):
agent:main:slack:channel:c09abc

# Thread reply in #general under ts 1712200000.000001:
agent:main:slack:channel:c09abc:thread:1712200000.000001
```

### Thread Inheritance

When `thread.inheritParent` is enabled, the thread session gets a `parentSessionKey` pointing to the base (channel-level) session, letting the agent inherit context from the parent conversation.

### Identity Links

The `session.identityLinks` config maps cross-channel user IDs to a canonical identity, so the same person across channels shares a session.

---

## Agent Prompt Composition

### System Prompt Structure

For a Slack group message, the LLM's system prompt is assembled as:

```
1. Static identity, safety rules, tool listing, workspace info, project context (SOUL.md etc.)
2. Silent reply instructions (NO_REPLY token rules)
3. --- CACHE BOUNDARY ---
4. ## Group Chat Context
   a. Inbound Context (trusted metadata) JSON block
   b. Group chat context line
   c. Group intro (first turn / activation change only)
   d. Per-channel system prompt (if configured)
5. Runtime info line
```

The cache boundary separates the stable prefix (cacheable across turns) from dynamic per-session content. This is a deliberate optimization for prompt cache stability.

### Inbound Metadata (Trusted)

The [`buildInboundMetaSystemPrompt`](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/reply/inbound-meta.ts#L53) function produces a trusted JSON block:

```json
{
  "schema": "openclaw.inbound_meta.v1",
  "chat_id": "<slack chat id>",
  "account_id": "<account>",
  "channel": "slack",
  "provider": "slack",
  "surface": "slack",
  "chat_type": "group",
  "response_format": {
    "text_markup": "slack_mrkdwn",
    "rules": [
      "Use Slack mrkdwn, not standard Markdown.",
      "Bold uses *single asterisks*.",
      "Links use <url|label>.",
      ...
    ]
  }
}
```

The `response_format.rules` tell the LLM to use Slack mrkdwn formatting. These come from the Slack plugin's `agentPrompt.inboundFormattingHints()` in [`shared.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/shared.ts).

### Group Chat Behavioral Prompts

[**`buildGroupChatContext`**](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/reply/groups.ts#L102) (every turn for group chats):

> "You are in the Slack group chat "#channel-name". Participants: user1, user2. Your replies are automatically sent to this group chat. Do not use the message tool to send to this same group -- just reply normally."

[**`buildGroupIntro`**](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/reply/groups.ts#L122) (first turn or activation change only):

For `activation=mention` (default for channels with `requireMention=true`):
> "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Avoid Markdown tables. Don't type literal \n sequences; use real line breaks sparingly. Address the specific sender noted in the message context."

For `activation=always` (`requireMention=false`):
> "Activation: always-on (you receive every group message). If no response is needed, reply with exactly "NO_REPLY" (and nothing else) so OpenClaw stays silent. Do not add any other words, punctuation, tags, markdown/code blocks, or explanations. Be extremely selective: reply only when directly addressed or clearly helpful. Otherwise stay silent. Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available. Write like a human. Avoid Markdown tables. Don't type literal \n sequences; use real line breaks sparingly. Address the specific sender noted in the message context."

**Important limitation**: There is no specific prompt for the case where two humans are having a conversation in a thread the bot has joined. The bot receives every message in such threads (via implicit mention), and the "mostly lurk" / "reply only when directly addressed" guidance is the only guard. The `WasMentioned` field tells the LLM whether it was explicitly tagged, but implicit thread mentions set `effectiveWasMentioned=true`, so the LLM doesn't get a clear signal that the message was not directed at it.

### WasMentioned Side Effects

Beyond prompt wording, `WasMentioned` triggers several behavioral differences:

| Behavior | When mentioned | When not mentioned |
|---|---|---|
| **Typing indicator** | Starts immediately (`instant` mode) | Starts only when renderable text appears (`message` mode) |
| **Elevated directives** | Allowed | Silently stripped (except `off`) |
| **Exec directives** | Allowed | Silently stripped (except `deny`) |
| **User context metadata** | `was_mentioned: true` in conversation info JSON | Field omitted |

This means in group chats where the bot is not explicitly mentioned (but receives the message via implicit thread mention or always-on mode), it cannot be escalated to elevated or exec mode -- a safety guard.

### The Silent Reply Mechanism

**Token**: `NO_REPLY` (defined in [`src/auto-reply/tokens.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/tokens.ts#L4))

**Detection**: [`isSilentReplyText`](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/tokens.ts#L31) matches `^\s*NO_REPLY\s*$` (case-insensitive). Also supports JSON envelope form `{"action": "NO_REPLY"}`.

**Prefix detection**: `isSilentReplyPrefixText` catches streaming fragments like `"NO"` or `"NO_R"` that are partial matches, preventing premature typing indicators from flashing when the bot decides to stay quiet.

**Processing**: In `normalize-reply.ts`, if the entire reply is the silent token, the payload is dropped (returns null). If it appears in mixed content, it is stripped. The `onSkip("silent")` callback fires for diagnostics.

**Typing interaction**: The typing signaler ([`resolveTypingMode`](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/reply/typing-mode.ts#L17)) checks `isSilentReplyText` on incoming text deltas. Silent reply prefixes suppress the typing indicator entirely.

### What the LLM Sees

For the **user-role message**, the content is assembled by [`buildInboundUserContextPrefix`](https://github.com/openclaw/openclaw/blob/4b993ba/src/auto-reply/reply/inbound-meta.ts#L93). The structure (simplified) is:

1. **Thread context** (if in thread, new sessions only):
   `[Thread history - for context]` followed by formatted thread messages

2. **Conversation info** (untrusted metadata JSON):
   `message_id`, `reply_to_id`, `sender_id`, `sender`, `timestamp`, `group_subject`, `was_mentioned`, `is_group_chat`, `has_thread_starter`, `history_count`

3. **Sender** (untrusted metadata JSON):
   `label` (e.g., `"Alice (U12345)"`), `id`, `name`

4. **Thread starter** (untrusted, if applicable):
   `{"body": "Original thread message text"}`

5. **Chat history entries** (for room-ish chats with history enabled)

6. **Untrusted context** (channel topic/purpose, labeled as metadata)

7. **Message body** with Slack metadata appended:
   `<actual text>\n[slack message id: 1712345678.000100 channel: C09ABC thread_ts: 1712345600.000001]`

---

## Outbound Pipeline

> **Key file links:**
> [`send.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/send.ts) |
> [`outbound-adapter.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/outbound-adapter.ts#L177) |
> [`format.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/format.ts) |
> [`streaming.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/streaming.ts) |
> [`draft-stream.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/draft-stream.ts) |
> [`interactive-replies.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/interactive-replies.ts)

### Text Formatting

[`extensions/slack/src/format.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/format.ts#L121) converts standard Markdown to Slack mrkdwn:

- Bold: `**text**` -> `*text*`
- Italic: `_text_` -> `_text_`
- Strikethrough: `~~text~~` -> `~text~`
- Code: backticks pass through
- Code blocks: triple backticks pass through
- Links: `[label](url)` -> `<url|label>` (skipped when label equals URL)
- Headings: rendered as bold text
- Special characters (`&`, `<`, `>`) are HTML-entity-escaped, preserving Slack tokens like `<@U123>`, `<#C123>`, `<!here>`

### Text Chunking

Messages are chunked at 8000 characters ([`SLACK_TEXT_LIMIT`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/limits.ts#L1)). The pipeline:

1. `resolveChunkMode(cfg, "slack", accountId)` -- determines chunk mode (e.g., `"newline"`)
2. `chunkMarkdownTextWithMode(text, limit, mode)` -- pre-chunks at newlines
3. `markdownToSlackMrkdwnChunks(chunk, limit)` -- converts each pre-chunk via an IR (intermediate representation), splitting at IR node boundaries rather than naive character positions
4. `resolveTextChunksWithFallback(original, chunks)` -- fallback if chunking produced nothing

Each chunk is sent as a separate Slack message.

### Block Kit Rendering

Three independent pipelines produce Block Kit output (tables, interactive blocks, arbitrary tool blocks), merged at delivery time with a combined limit of 50 blocks. See [Block Kit Rendering (Three Merged Pipelines)](#block-kit-rendering-three-merged-pipelines) for full pipeline details and limits.

### Media Upload

Three-step upload flow in [`send.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/send.ts#L305):

1. `files.getUploadURLExternal` -- get a presigned upload URL
2. HTTP POST to the presigned URL (with SSRF protection)
3. `files.completeUploadExternal` -- finalize and share to channel/thread

The first text chunk is sent as a caption on the media message; remaining chunks follow as separate messages. Media is loaded via `loadOutboundMediaFromUrl` supporting both local file paths (scoped to `mediaLocalRoots` for security) and remote URLs.

### Streaming

Slack supports three streaming modes: **native** (Slack's ChatStreamer API), **draft preview** (message edit loop), and **off**. See [Native Streaming via ChatStreamer API](#native-streaming-via-chatstreamer-api) for full details on the mode cascade, fallback behavior, and draft stream mechanics.

### Interactive Replies

The LLM can embed `[[slack_buttons:...]]` and `[[slack_select:...]]` directives in reply text, which are compiled into Block Kit components. A heuristic also auto-detects `Options: a, b, c` lines. See [Interactive Reply Directive Syntax](#interactive-reply-directive-syntax) for full syntax, limits, and interaction routing details.

---

## Agent Tool Actions

The AI agent receives a Slack message tool with these actions (gated by per-account `actions` config in [`message-actions.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/message-actions.ts#L7), dispatched by [`handleSlackAction`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/action-runtime.ts#L135)):

| Action | Config gate | Description |
|---|---|---|
| `send` | Always on | Send message (text + optional Block Kit blocks) |
| `react` | `actions.reactions` | Add emoji reaction |
| `reactions` | `actions.reactions` | List reactions on a message |
| `read` | `actions.messages` | Read messages from channel/thread |
| `edit` | `actions.messages` | Edit a message |
| `delete` | `actions.messages` | Delete a message |
| `download-file` | `actions.messages` | Download a file (with scope validation) |
| `upload-file` | `actions.messages` | Upload a file |
| `pin` / `unpin` | `actions.pins` | Pin/unpin a message |
| `list-pins` | `actions.pins` | List pinned messages |
| `member-info` | `actions.memberInfo` | Look up workspace member info |
| `emoji-list` | `actions.emojiList` | List custom workspace emoji |

**Token selection for tool actions**: A dual-token model:
- Read operations: prefer `userToken`, fall back to `botToken`
- Write operations: use `botToken` by default; only use `userToken` if `userTokenReadOnly === false`

**Auto-threading for tool sends**: [`resolveSlackAutoThreadId`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/action-threading.ts#L3) ensures tool-initiated sends respect the conversation's threading mode:
- `replyToMode=all`: always injects the current `thread_ts`
- `replyToMode=first`: injects `thread_ts` only for the first message (tracked via `hasRepliedRef`)
- `replyToMode=off`: never auto-injects

---

## Status Indicators and Reactions

### Assistants API Usage

The plugin uses `assistant.threads.setStatus` (OAuth scope: `assistant:write`) to show "is typing..." in Slack's thread panel during agent processing. Only `setStatus` is used -- not `setSuggestedPrompts` or `setTitle`. See [Assistants API Thread Status](#assistants-api-thread-status) for implementation details.

### Typing Reactions

Configurable per-account via `typingReaction`. When processing starts:
1. Sets thread status to "is typing..." via Assistants API
2. Adds the configured emoji reaction to the user's message

When processing completes: clears status and removes the reaction. Unicode emoji are translated to Slack shortcodes via a `UNICODE_TO_SLACK` mapping table.

### Status Reaction Lifecycle

A `StatusReactionController` manages an emoji lifecycle on the triggering message:

| Stage | Emoji | Trigger |
|---|---|---|
| Queued | eyes (configurable) | Message received, agent queued |
| Thinking | thinking_face | Reasoning stream starts |
| Tool use | hammer_and_wrench | Tool execution starts |
| Done | white_check_mark | Reply delivered |
| Error | x | Error during processing |

Each transition removes the previous reaction and adds the new one. Timing is configurable via `cfg.messages.statusReactions.timing` (hold durations for done/error states). The entire lifecycle is wrapped in try/catch/finally to ensure cleanup even on errors.

### Ack Reactions

A lightweight acknowledgment reaction (e.g., eyes) added immediately when a message is received, before the agent starts processing. Configurable via `resolveAckReaction(cfg, agentId)`. Can be scoped to DMs only, groups only, or mention-required channels. Removed after the reply is delivered (if `removeAckAfterReply` is set).

---

## Configuration and Multi-Account Support

### Account Resolution

The plugin supports multiple Slack workspaces via `channels.slack.accounts.<id>`. Each account is independently configured (see [`accounts.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/accounts.ts)):

- `listSlackAccountIds(cfg)` enumerates all configured account IDs
- [`resolveSlackAccount({ cfg, accountId })`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/accounts.ts#L45) merges global `channels.slack` config with account-specific overrides
- `listEnabledSlackAccounts(cfg)` returns accounts where both global and per-account `enabled` are not `false`

### Token Management

Three token types, each with config and env sources:

| Token | Config path | Env variable | Purpose |
|---|---|---|---|
| Bot token | `channels.slack.botToken` | `SLACK_BOT_TOKEN` | Standard API operations |
| App token | `channels.slack.appToken` | `SLACK_APP_TOKEN` | Socket Mode connection |
| User token | `channels.slack.userToken` | `SLACK_USER_TOKEN` | Optional user-context reads |

Environment variables are only honored for the **default account**. All tokens support `SecretRef` objects for external secret management. HTTP mode substitutes `signingSecret` for `appToken`.

### Config Options Reference

All paths below are relative to `channels.slack` (or `channels.slack.accounts.<id>` for per-account overrides).

| Config path | Type | Default | Description |
|---|---|---|---|
| `dmPolicy` | `"pairing"` / `"open"` / `"disabled"` | `"pairing"` | DM access control mode |
| `allowFrom` | `string[]` | `[]` | Allowed user IDs for DM access |
| `allowBots` | `boolean` | `false` | Allow bot-authored messages |
| `groupPolicy` | `"open"` / `"disabled"` / `"allowlist"` | `"open"` | Channel access policy |
| `channels.<id>.requireMention` | `boolean` | `true` | Require @mention to trigger |
| `channels.<id>.users` | `string[]` | -- | Per-channel user allowlist |
| `channels.<id>.allowBots` | `boolean` | -- | Per-channel bot override |
| `channels.<id>.skills` | `string[]` | -- | Per-channel skill command filter |
| `channels.<id>.systemPrompt` | `string` | -- | Per-channel system prompt |
| `replyToMode` | `"off"` / `"first"` / `"all"` | varies | Threading behavior |
| `streaming` | `"off"` / `"partial"` / `"block"` / `"progress"` | `"partial"` | Streaming mode |
| `nativeStreaming` | `boolean` | `true` (when `streaming=partial`) | Use Slack ChatStreamer API |
| `capabilities.interactiveReplies` | `boolean` | `false` | Enable inline interactive directives |
| `actions.reactions` | `boolean` | `true` | Enable reaction tool actions |
| `actions.messages` | `boolean` | `true` | Enable read/edit/delete tool actions |
| `actions.pins` | `boolean` | `true` | Enable pin tool actions |
| `actions.memberInfo` | `boolean` | `true` | Enable member info action |
| `actions.emojiList` | `boolean` | `true` | Enable emoji list action |
| `thread.historyScope` | `"thread"` / `"channel"` | `"thread"` | Reply history scope |
| `thread.inheritParent` | `boolean` | `false` | Inherit parent session transcript |
| `thread.initialHistoryLimit` | `number` | `20` | Max messages fetched for new thread |
| `userTokenReadOnly` | `boolean` | `true` | Restrict user token to reads |
| `execApprovals.enabled` | `"auto"` / `true` / `false` | `"auto"` | Exec approval routing |
| `execApprovals.approvers` | `string[]` | -- | Approver user IDs |
| `execApprovals.target` | `"dm"` / `"channel"` / `"both"` | -- | Where approval prompts go |
| `slashCommand.enabled` | `boolean` | `false` | Enable slash command |
| `slashCommand.name` | `string` | `"openclaw"` | Slash command name |
| `slashCommand.ephemeral` | `boolean` | `true` | Ephemeral responses |
| `mediaMaxMb` | `number` | -- | Max media file size in MB |
| `textChunkLimit` | `number` | -- | Override text chunk limit |
| `mode` | `"socket"` / `"http"` | `"socket"` | Connection mode |
| `webhookPath` | `string` | -- | HTTP webhook path |
| `configWrites` | `boolean` | `true` | Allow config writes from events |
| `messages.removeAckAfterReply` | `boolean` | `false` | Remove ack reaction after reply delivery |

---

## Security Model

### DM Access Control

Three DM policies (`dmPolicy`):

- **`pairing`** (default): Unknown senders receive a pairing challenge code. Once paired, the user is added to the dynamic allowlist. Pairing codes are issued via `createChannelPairingChallengeIssuer`.
- **`open`**: All DMs accepted.
- **`disabled`**: All DMs rejected.

The effective allowlist merges config-based `allowFrom` with dynamically paired users from the store, cached for 5 seconds with inflight dedup.

### Channel Access Control

Controlled by `groupPolicy`:

- **`open`**: All channels allowed (mention-gated by default).
- **`disabled`**: No channel messages processed.
- **`allowlist`**: Only channels matching `channels.<id>` entries are allowed.

Per-channel user allowlists (`channels.<id>.users`) further restrict who can trigger the agent within an allowed channel.

### Allowlist Matching

[`resolveSlackAllowListMatch`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/allow-list.ts#L54) supports multiple match strategies:

| Strategy | Example | Notes |
|---|---|---|
| `wildcard` | `*` | Matches all |
| `id` | `U12345ABC` | Direct Slack ID (case-insensitive) |
| `prefixed-id` | `slack:U123`, `user:U123` | Prefixed format |
| `name` | `alice` | Display name (only when `dangerousNameMatching=true`) |
| `prefixed-name` | `@alice` | At-prefixed name |

Name-based matching is off by default to prefer stable IDs. The `openclaw doctor` command warns about mutable allowlist entries.

### Thread Context Filtering

Thread starter and history messages are filtered by allowlist before being shown to the agent (see [`prepare-thread-context.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/message-handler/prepare-thread-context.ts#L28)). The `contextVisibilityMode` config controls exposure:
- Messages from unauthorized senders can be omitted from thread context
- This prevents information leakage in threads where some participants are not in the allowlist

This was a targeted security fix (commit `ac5bc4fb3`) to prevent unauthorized senders' messages from appearing in the agent's context.

### Exec Approvals

The Slack plugin implements native exec approval delivery ([`approval-native.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/approval-native.ts#L119)):

- Approval requests can be sent to the **origin channel/thread** or to **approver DMs** (or both)
- Approvers are resolved from `execApprovals.approvers` or `commands.ownerAllowFrom`
- Turn-source matching validates that the approval request originated from a Slack conversation
- `notifyOriginWhenDmOnly: true` -- when using DM-only delivery, also notifies the origin channel

---

## Setup and Diagnostics

### Setup Wizard

Interactive flow via `ChannelSetupWizard`:

1. Status check (configured vs. needs tokens)
2. Setup instructions (5-step Slack App creation guide with manifest JSON)
3. Environment variable shortcut (offers to use `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` if detected)
4. Credential collection (bot token, then app token)
5. DM policy selection with allowFrom prompting
6. Channel allowlist configuration (resolves channel names to IDs via API)
7. Interactive replies opt-in
8. Enable/disable toggle

The manifest ([`buildSlackManifest`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/shared.ts#L24)) includes all required bot scopes, event subscriptions, slash commands, and Socket Mode configuration.

### Doctor Checks

[`slackDoctor`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/doctor.ts#L331) runs several diagnostic checks:

- **Legacy config migration**: Normalizes `streamMode` -> `streaming` + `nativeStreaming`, `dm.policy` -> `dmPolicy`, `dm.allowFrom` -> `allowFrom`
- **Mutable allowlist warnings**: Flags entries using display names rather than stable Slack IDs
- **Security audit** ([`collectSlackSecurityAuditFindings`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/security-audit.ts#L23)):
  - Warns if `commands.useAccessGroups=false` while slash commands are enabled (unrestricted command access)
  - Warns if slash commands are enabled but no allowlists are configured

### Health Probe

[`probeSlack(token, timeoutMs=2500)`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/probe.ts#L12) calls `auth.test()` to verify token validity, returning bot info, team info, and latency. Used by `openclaw channels status --probe`.

### Scope Inspection

[`fetchSlackScopes`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/scopes.ts#L92) discovers granted OAuth scopes by trying `auth.scopes` then `apps.permissions.info`. Used in deep status diagnostics.

---

## Slash Commands

Slash commands are opt-in (`slashCommand.enabled: true`). Configuration (see [`commands.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/commands.ts#L18) and [`slash.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/slash.ts)):

- `name`: defaults to `"openclaw"` (the `/openclaw` command)
- `sessionPrefix`: defaults to `"slack:slash"`
- `ephemeral`: defaults to `true` (responses visible only to the caller)

The command handler uses the same authorization pipeline as messages, with `resolveSlackAllowListMatch` and per-channel user checks. Responses are delivered via Bolt's `respond()` function with ephemeral or in_channel visibility.

External argument menus support interactive selection via buttons (max 5 per row), overflow menus, and selects (max 100 options, 75 chars each) with optional confirmation dialogs.

---

## Thread Ownership Plugin

A separate plugin at [`extensions/thread-ownership/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/thread-ownership) prevents multiple agents from responding in the same Slack thread:

- Calls a `slack-forwarder` HTTP API (`forwarderUrl`, default `http://slack-forwarder:8750`) to claim thread ownership
- Configurable `abTestChannels` for scoped enforcement
- Useful in multi-agent deployments where several OpenClaw instances share the same Slack workspace

---

## Historical Evolution

Key changes to the Slack integration over time, derived from git history:

### Security Hardening

1. **Group subject spoofing fix** (Feb 10): Removed attacker-controlled labels (group subject, members) from system prompts. Now they appear only as "untrusted context" in user-role messages, not trusted system prompt content.

2. **System event marker spoofing fix** (Mar 2): Moved system events from user body to system prompt. Previously, attackers could spoof `[System: ...]` markers in message text; now system events are in the trusted system prompt layer.

3. **Thread context allowlist filtering** (Apr 2): Added per-sender filtering for thread context messages. Messages from unauthorized senders are now omitted based on `contextVisibilityMode`.

### Threading Bug Fixes

- **Session isolation regression** (noted in code comments referencing #10686): A bug where every channel message used its own `ts` as `threadId`, creating isolated sessions per message. Fixed by only forking channel messages into thread-specific sessions when they are actual thread replies (`thread_ts` present and different from `ts`).

### Streaming Reliability

- **Duplicate reply prevention** (Mar 31): Preview edit finalization now verifies edits via readback. When `editSlackMessage` throws (e.g., socket closed), the code reads back the message to check if the edit actually applied, preventing duplicate replies.

- **DM streaming optimization** (Mar 24): Preview streaming disabled for DMs without threads; draft stream object lazily initialized only when needed.

- **Chunk limit unification** (Mar 23): Replaced hardcoded `4000` char limits with the shared `SLACK_TEXT_LIMIT` constant (8000) across all paths.

### Architecture Migration

- **Plugin extraction** (Mar 14): All Slack code moved from `src/slack/` to `extensions/slack/src/`, adopting the Plugin SDK contract.
- **Import boundary enforcement**: All deep relative imports migrated to `openclaw/plugin-sdk/*` namespaced imports.
- **Channel-specific behavior to plugins** (Apr 3): Provider-specific group intro hints, mention resolution, and channel labels moved from core into plugins. Core `groups.ts` no longer has a `CHANNEL_LABELS` map or WhatsApp-specific JID hints.

### Bolt Interop Hardening

- **Node/Bun ESM/CJS compatibility** (Mar 16): Replaced a 3-line import hack with a 60+ line `resolveSlackBoltInterop()` function that tries multiple resolution strategies for `@slack/bolt`'s `App` and `HTTPReceiver` constructors.
- **Graceful shutdown fix** (Apr 4): Pre-sets `shuttingDown` on the `SocketModeClient` before `stop()` to prevent orphaned ping intervals from firing reconnect attempts during shutdown.

### Prompt Evolution

- Group prompts became more generic (no more embedded channel-specific subject/members)
- `GroupSystemPrompt` expanded from room-only to all conversations (enabling scoped DM prompts)
- Interactive reply capability made opt-in per account
- Date substitution added to session reset prompts so the bot always knows the current date

---

## Slack-Unique Features in Depth

These features exist only in the Slack channel plugin -- no other channel in the repo implements them.

### Native Streaming via ChatStreamer API

> [`extensions/slack/src/streaming.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/streaming.ts) |
> [`extensions/slack/src/stream-mode.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/stream-mode.ts)

Slack's `ChatStreamer` SDK provides a platform-native streaming UX where the message updates word-by-word in the Slack client, matching Slack's "Agents & AI Apps" pattern.

**Three lifecycle functions:**
- **`startSlackStream`** -- Creates a `ChatStreamer` via `client.chatStream()` with channel, thread_ts, and optionally team_id/user_id (user_id required for DM streaming). Initial text is appended via `streamer.append({ markdown_text })`.
- **`appendSlackStream`** -- Appends markdown text to the active stream. No-ops if stopped or empty.
- **`stopSlackStream`** -- Finalizes the stream with optional final text. The streamed message becomes a normal Slack message.

**Mode selection cascade:**

| Config | Result |
|---|---|
| `streaming: "partial"` + `nativeStreaming: true` (default) | Native ChatStreamer |
| `streaming: "partial"` + `nativeStreaming: false` | Draft stream, "replace" mode (edit-in-place) |
| `streaming: "block"` | Draft stream, "append" mode (cumulative) |
| `streaming: "progress"` | Draft stream, "status_final" mode (animated "thinking..." dots) |
| `streaming: "off"` | No streaming |

**Fallback behavior:** During native streaming, if the stream fails, or the payload has media/blocks/no text, the dispatch falls back to normal message posting. The `streamFailed` flag ensures all subsequent payloads also fall back. Legacy `streamMode` config values (`replace`/`status_final`/`append`) are auto-mapped.

**Draft stream fallback** ([`draft-stream.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/draft-stream.ts#L18)): Throttled edit loop (default 1000ms, min 250ms). Sends first chunk as new message, edits the same message on updates. Max 8000 chars. `forceNewMessage()` resets state at assistant message boundaries. The `status_final` variant shows animated dots (`"Status: thinking."` / `".."` / `"..."`) and posts the final answer as a separate message.

**Preview finalization:** When draft streaming was used, the dispatch attempts to edit the draft in-place to become the final reply (avoiding a duplicate message). If the edit fails, a readback verification checks whether it actually applied before falling back.

### Assistants API Thread Status

> [`extensions/slack/src/monitor/context.ts:255`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/context.ts#L255)

The only channel plugin using a platform-provided typing status API. Calls `assistant.threads.setStatus` with `{ channel_id, thread_ts, status }` via two resolution paths:
1. `client.assistant.threads.setStatus(payload)` (typed SDK method)
2. `client.apiCall("assistant.threads.setStatus", payload)` (raw fallback)

**OAuth scope:** `assistant:write`

**Lifecycle:** Called twice per message:
1. **Start:** Sets `status: "is typing..."` when agent begins processing
2. **Stop:** Sets `status: ""` (clears) when agent finishes

Only works in threaded conversations (no-ops if `threadTs` is falsy). Failures are logged but never thrown -- best-effort. Shows as a status indicator below the bot's name in Slack's thread panel.

### Block Kit Rendering (Three Merged Pipelines)

> [`block-kit-tables.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/block-kit-tables.ts) |
> [`blocks-render.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/blocks-render.ts) |
> [`blocks-input.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/blocks-input.ts) |
> [`reply-blocks.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/reply-blocks.ts)

Three independent pipelines produce Block Kit output, merged at delivery time:

**Pipeline 1 -- Table blocks** (`block-kit-tables.ts`): Converts parsed Markdown tables into Slack's native `type: "table"` block with `column_settings` and `raw_text` cells. Limits: 20 columns, 100 rows. Includes a pipe-delimited ASCII fallback (80-char cells, 4000-char total). Tables go into `attachments`, not `blocks`.

**Pipeline 2 -- Interactive blocks** (`blocks-render.ts`): Converts the generic `InteractiveReply` model into Block Kit:
- Text -> `section` blocks (max 3000 chars)
- Buttons -> `actions` blocks with `openclaw:reply_button:{row}:{col}` action IDs, max 75-char labels
- Selects -> `actions` blocks with `openclaw:reply_select:{row}` action IDs, 75-char option labels

**Pipeline 3 -- Arbitrary tool blocks** (`blocks-input.ts`): Validates raw Block Kit JSON from `channelData.slack.blocks`. Max 50 blocks, each must have a string `type`.

**Merge** (`reply-blocks.ts`): `resolveSlackReplyBlocks` concatenates channel blocks first, then interactive blocks. Combined total must not exceed 50. Table blocks are separate (via `attachments`).

### Dual Connection Mode (Socket + HTTP)

> [`extensions/slack/src/monitor/provider.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/provider.ts) |
> [`extensions/slack/src/http/plugin-routes.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/http/plugin-routes.ts)

No other channel supports two connection modes. Selection: `account.config.mode ?? "socket"`.

**Socket mode** requires `botToken` + `appToken`. Uses Bolt's `socketMode: true` with a full reconnect loop. Validates that the app token's embedded API app ID matches the bot's.

Reconnection policy (defined in [`reconnect-policy.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/monitor/reconnect-policy.ts#L4)): non-recoverable auth errors (invalid token, revoked app) stop permanently. Transient errors use exponential backoff: 2s initial, 30s max, 1.8x factor, 25% jitter, 12 max attempts.

**HTTP mode** requires `botToken` + `signingSecret`. Uses Bolt's `HTTPReceiver` with Slack's HMAC-SHA256 request verification. Request guards: 1 MB body limit, 30s timeout. Each account gets its own webhook path (default `/slack/events`). After setup, the provider awaits the abort signal -- no reconnect loop needed.

### Interactive Reply Directive Syntax

> [`extensions/slack/src/interactive-replies.ts`](https://github.com/openclaw/openclaw/blob/4b993ba/extensions/slack/src/interactive-replies.ts#L177)

The LLM can embed structured UI directives directly in reply text. Two detection mechanisms:

**1. Explicit directives** -- Regex: `\[\[(slack_buttons|slack_select):\s*([^\]]+)\]\]`

```
[[slack_buttons: Yes:yes:primary, No:no:danger, Maybe:maybe]]
[[slack_select: Pick a color | Red:red, Blue:blue, Green:green]]
```

- **Buttons:** `[[slack_buttons: label:value:style, ...]]` -- max 5 items, styles: `primary`/`secondary`/`success`/`danger`
- **Selects:** `[[slack_select: placeholder | label:value, ...]]` -- max 100 options, `|` separates placeholder from options

Directives are stripped from visible text. Text between directives becomes `text` blocks.

**2. Auto-detection** -- If no directives found, checks the last line for `Options: foo, bar, baz`:
- Must have 2-12 items, alphanumeric, unique
- <=5 items -> buttons
- 6-12 items -> select dropdown
- The `Options:` line is removed from visible text

**Incoming interactions:** Button clicks and select choices arrive as `block_actions` events. The handler acks immediately, authorizes the sender, dispatches to plugin handlers, or enqueues as a system event. The original message is updated to show a confirmation (`"Selected Label" selected by @user`). Interaction payloads are sanitized (max 2400 chars, sensitive keys redacted).

Requires `capabilities.interactiveReplies: true` per account.

---

## Slack vs. Discord

Discord is the closest peer to Slack in this codebase -- same adapter slot tier, same feature categories, but different platform constraints lead to very different implementation choices.

### Size and Feature Coverage

| Channel | Prod files | Prod LOC | Adapter slots |
|---|---|---|---|
| **Discord** | 183 | 36,456 | 25 |
| **Slack** | 132 | 16,877 | 24 |

Discord's codebase is 2x larger, driven primarily by voice/forum channel support, Components V2 rendering, guild management actions, and subagent thread binding infrastructure.

> **Discord key files:**
> [`extensions/discord/src/channel.ts`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/discord/src/channel.ts) |
> [`extensions/discord/src/shared.ts`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/discord/src/shared.ts) |
> [`extensions/discord/src/monitor/`](https://github.com/openclaw/openclaw/tree/4b993ba/extensions/discord/src/monitor)

### Connection Model

| | Slack | Discord |
|---|---|---|
| **Primary connection** | Socket Mode (Bolt `App` with `socketMode: true`) | WebSocket Gateway (`@buape/carbon/gateway`) |
| **Alternative** | HTTP webhook receiver with signing secret | None (gateway only) |
| **Library** | `@slack/bolt` + `@slack/web-api` | `@buape/carbon` + `@buape/carbon/gateway` |
| **Reconnection** | Exponential backoff (2s-30s, 1.8x, 12 max attempts) | Gateway supervisor with restart logic |
| **Multi-account startup** | Parallel | Staggered (10s between accounts) to avoid Discord rate limits |
| **Intents/scopes** | OAuth scopes (`assistant:write`, `chat:write`, etc.) | Gateway intents (`Guilds`, `MessageContent`, `GuildVoiceStates`, etc.) |

### Message Limits and Formatting

| | Slack | Discord |
|---|---|---|
| **Text limit** | 8,000 chars | 2,000 chars |
| **Markup format** | Slack mrkdwn (bold: `*text*`, links: `<url\|label>`) | Standard Markdown |
| **Chunking** | IR-based splitting at node boundaries | Fence-aware splitting with italic rebalancing |
| **Structured UI** | Block Kit (sections, tables, actions) | Components V2 (containers, sections, media galleries) |
| **Tables** | Native `type: "table"` block with ASCII fallback | Markdown table conversion |

### Streaming

| | Slack | Discord |
|---|---|---|
| **Native streaming** | Yes -- `ChatStreamer` API (`startStream`/`appendStream`/`stopStream`) | No |
| **Draft streaming** | Yes -- message edit loop, 1000ms throttle, 8000 char cap | Yes -- message edit loop, 1200ms throttle, 2000 char cap |
| **Streaming modes** | `off` / `partial` (native) / `block` / `progress` | `off` / `partial` (edit) / `block` |
| **DM optimization** | Skips preview for DMs without thread | `minInitialChars` debounce for push notification quality |

### Threading

| | Slack | Discord |
|---|---|---|
| **Thread model** | Parent message + replies (flat threads) | Public/private threads, forums, media channels, announcement threads |
| **Auto-thread creation** | Via `replyToMode: "all"` (messages become thread parents) | Configurable per channel, with AI-generated thread titles |
| **Thread bindings** | None | Full subagent-to-thread binding with webhook personas, idle timeout, farewell messages |
| **Implicit mention** | Bot participation in thread = implicit mention | Similar via sent-thread tracking |
| **Session inheritance** | `thread.inheritParent` config | Parent session key tracked per thread |

### Threading Model: Slack vs. Discord vs. Telegram

All three channel plugins share the same core session routing infrastructure ([`resolveAgentRoute`](https://github.com/openclaw/openclaw/blob/4b993ba/src/routing/resolve-route.ts#L631) + [`resolveThreadSessionKeys`](https://github.com/openclaw/openclaw/blob/4b993ba/src/routing/session-key.ts#L234) + `buildAgentPeerSessionKey`), but diverge significantly in how platform threads map to agent sessions.

| | Slack | Discord | Telegram |
|---|---|---|---|
| **Thread primitive** | Parent message + replies (flat, identified by `thread_ts`) | Platform threads (public/private), forum posts, media channel posts | Forum topics (identified by `message_thread_id`) |
| **Session key for threads** | Base key + `:thread:<thread_ts>` only for actual thread replies | Thread/channel ID IS the conversation ID (threads are first-class) | Topic embedded in peer ID: `<chatId>:topic:<topicId>` | 
| **Thread = new conversation?** | No -- threads fork from the channel session | Yes -- each thread has its own session key | Partially -- forum topics yes, non-forum reply threads ignored |
| **Forum/topic support** | None | Full (forums, media channels, announcement threads) | Full (`isForum` flag, topic-scoped sessions) |
| **Topic-bound agents** | N/A | Via thread bindings (subagent webhook personas) | Via `topicAgentId` -- each topic can route to a different agent |
| **Thread participation tracking** | `sent-thread-cache` (24h TTL, 5000 entries) for implicit mention | Similar | Uses reply-to relationships instead |
| **DM threads** | `replyToMode=all` creates threads from each message | No DM threading | `dmThreadId` creates session isolation per DM topic |
| **Auto-thread creation** | Via `replyToMode` (replies become thread parents) | Per-channel `autoThread` with AI-generated titles | N/A (topics are pre-created in forums) |
| **Non-forum reply threads** | Full session fork | Full session fork | Explicitly ignored (`!isForum` -> skip `message_thread_id`) |
| **Parent session** | `thread.inheritParent` -> `parentSessionKey` | `parentConversationId` -> `parentPeer` | `parentConversationCandidates: [chatId]` (base chat is always parent) |

**The fundamental difference:** Slack treats threads as session forks from a channel. Discord treats threads as first-class conversations (they get their own channel IDs from the Discord API). Telegram treats forum topics as the conversation unit while ignoring non-forum reply threads entirely.

### Interactive Components

| | Slack | Discord |
|---|---|---|
| **Buttons** | Yes -- Block Kit buttons, max 5 per row | Yes -- action row buttons, max 5 per row, plus per-user allowlists |
| **Selects** | Yes -- static select, max 100 options | Yes -- string/user/role/mentionable/channel selects |
| **Modals/Forms** | Block Kit modal views (via `view_submission`) | Native modals with text inputs, checkboxes, radio groups, selects |
| **Inline directives** | `[[slack_buttons:...]]`, `[[slack_select:...]]`, auto-detected `Options:` | Rendered from generic `InteractiveReply` model |
| **Rich containers** | Block Kit sections/dividers/context | Components V2 containers with accent colors, thumbnails, media galleries |

### Tool Actions

| Category | Slack | Discord |
|---|---|---|
| **Core messaging** | send, read, edit, delete, upload-file, download-file | send, read, edit, delete |
| **Reactions/emoji** | react, reactions, emoji-list | react, reactions, emoji-list, emoji-upload, sticker, sticker-upload |
| **Pins** | pin, unpin, list-pins | pin, unpin, list-pins |
| **Threads** | (handled via session/replyToMode) | thread-create, thread-list, thread-reply |
| **Search** | (not a tool action) | search |
| **Channel management** | -- | channel-info, channel-list, channel-create, channel-edit, channel-delete, channel-move, category-create/edit/delete |
| **Member/role** | member-info | member-info, role-info, role-add, role-remove |
| **Moderation** | -- | timeout, kick, ban |
| **Voice** | -- | voice-status |
| **Events** | -- | event-list, event-create |
| **Polls** | -- | poll |
| **Presence** | -- | set-presence |

Discord has **~35 tool actions** vs. Slack's **~13**. Discord's guild model (channels, categories, roles, moderation) creates a much larger action surface.

### Platform-Specific Features

| Feature | Slack | Discord |
|---|---|---|
| **Assistants API** | `assistant.threads.setStatus` for typing indicators | -- |
| **Block Kit tables** | Native `type: "table"` block | -- |
| **HTTP webhook mode** | Full dual-mode support | -- |
| **Voice channels** | -- | Join, listen, transcribe, TTS with session management |
| **Forum channels** | -- | Dedicated thread-based forum handling |
| **Auto-presence** | -- | Bot status reflects health (healthy/degraded/exhausted) |
| **PluralKit** | -- | Recognizes proxy bot messages |
| **Model picker** | -- | Native button/select UI with pagination |
| **Subagent personas** | -- | Thread bindings with per-subagent webhook identity |

### Security Model

Both use similar layered security:
- **DM access**: allowlist/pairing/open/disabled policies
- **Channel access**: allowlist-based with per-channel user restrictions
- **Command authorization**: owner allowlist + per-channel user gates
- **Exec approvals**: native interactive delivery to origin or approver DMs

Discord adds **hierarchical allowlists** (guild > channel > user granularity), more granular than Slack's workspace-flat model.
