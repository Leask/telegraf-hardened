# Next: v6.1 (Unreleased)

## API Updates

- Support the [Bot API 10.3 specification](https://core.telegram.org/bots/api), building on [the maintainer's API sync](https://github.com/telegraf-hardened/telegraf-hardened/pull/30).
- Add rich messages, ephemeral messages, guest queries, live photos, managed bots, poll media, reaction moderation, and join-request query helpers.
- Preserve business connections, forum topics, and reply targets across all 23 supported `future` reply helpers by reusing the Context send methods, including their method-specific restrictions.
- Add `ctx.purchasedPaidMedia` for the `purchased_paid_media` update.
- Keep the deprecated `getChatMembersCount` helper as an alias of the supported `getChatMemberCount` method.

## Corrected Contracts

These corrections apply to the unreleased 10.3 work, not a previously released public API.

- Ephemeral message IDs are numbers. Editing or deleting an ephemeral message also requires the recipient's `receiver_user_id`. Context helpers require that user ID explicitly; the user causing the current update is not necessarily the recipient.
- `ctx.answerGuestQuery(result)` takes an `InlineQueryResult` and returns a `SentGuestMessage`, not a text argument or a regular `Message`.
- `ctx.sendLivePhoto(photo, livePhoto, extra)` accepts uploads or file IDs for both inputs. Its payload uses `photo` and `live_photo`. Live-photo media groups and paid media use `media` for the video and `photo` for the still image.
- Reaction moderation identifies the actor using `user_id` or `actor_chat_id`. Bulk deletion acts on the actor's recent reactions across the chat, not a single message.
- `ctx.answerChatJoinRequestQuery('approve' | 'decline' | 'queue')` and `ctx.sendChatJoinRequestWebApp(url)` send `chat_join_request_query_id` and the documented result/URL fields.
- `InputRichMessageDraft` and `InputRichBlockDraft` allow `thinking` blocks, including nested ones, only through draft helpers. Ordinary sends, edits, and inline results reject these blocks at compile time. Received `PollMedia` permits zero or one media field, not multiple fields.

```ts
// In an update containing an ephemeral message:
await ctx.editEphemeralMessageText(receiverUserId, 'Updated')
await ctx.deleteEphemeralMessage(receiverUserId)

// To target a message outside the current update:
await bot.telegram.deleteEphemeralMessage(chatId, receiverUserId, ephemeralId)
```

## Breaking Type Changes

- `ctx.editMessageText` and the related text-edit helpers accept a union of tuples enforcing **text or `rich_message`, not both**. Existing calls passing a variable typed as the broad `Convenience.ExtraEditMessageText` may no longer compile, even if the value only contains text-edit options. For text edits, exclude `rich_message` from that variable's type. For rich edits, pass `undefined` as the text argument and preserve the required `rich_message` field with `satisfies` or a suitably narrow type.
- `ReplyParameters` is now a union requiring at least one numeric message target: `message_id` or `ephemeral_message_id`. It can no longer be extended as an interface. Use an intersection for extensions, and retain a required target when constructing reply parameters; an empty object or an all-optional mapped type is not a valid reply target. Replies to ephemeral messages must themselves be ephemeral, as required by Telegram.

```ts
import type { Convenience, ReplyParameters } from 'telegraf-hardened/types'

const textExtra: Omit<Convenience.ExtraEditMessageText, 'rich_message'> = {
    parse_mode: 'HTML',
}
await ctx.editMessageText('Updated', textExtra)

const richExtra = {
    rich_message: { html: '<b>Updated</b>' },
} satisfies Convenience.ExtraEditMessageText
await ctx.editMessageText(undefined, richExtra)

const reply = { message_id: 42 } satisfies ReplyParameters
await ctx.reply('Reply', { reply_parameters: reply })

const ephemeralReply = { ephemeral_message_id: 7 } satisfies ReplyParameters
await ctx.reply('Reply', {
    reply_parameters: ephemeralReply,
    ephemeral_message_parameters: { receiver_user_id: 99 },
})
```

## Regression Coverage

- Compare the typed method inventory with an independent snapshot of all 185 methods in the official Bot API 10.3 documentation, captured on October 2, 2026.
- Check wrapper coverage, outgoing JSON/multipart payloads, Context defaults, and positive/negative TypeScript contracts.
- Parse the README's JavaScript examples to catch syntax regressions.
- Tests use offline fixtures and loopback HTTP servers. They do not establish live Telegram acceptance, permissions, or third-party framework compatibility.

## Network and Test Infrastructure

- Restore `npm test` to the complete AVA suite, not only the API synchronization tests. Run clean installs, tests, and lint on Node 18, 20, 22, 24, and 26.
- Keep request cancellation active while reading response bodies, preserve timeout reasons, and retry transient polling failures. Stopping polling interrupts backoff promptly.
- Normalize response read failures without losing HTTP errors. Bound and sanitize diagnostic causes without mutating native errors or leaking bot tokens.
- Invoke injected fetch functions without an options-object receiver, while preserving explicitly bound proxy transports. Synchronous API fetch errors cross the same sanitized network-error boundary as rejected promises.
- Infer `{ url, filename? }` uploads only in known file fields; unrelated URL objects remain JSON, including inside multipart requests. Explicit `InputFile` source objects retain their existing upload behavior.
- On polling shutdown, suppress only the cancelled request's `TelegrafNetworkError` with `errorName: 'AbortError'`. Other request failures and update-handler failures remain observable. Update handlers run outside the polling iterator's request-error catch.
- The original timeout and error-boundary fixes are also available independently of 10.3 in [PR #31](https://github.com/telegraf-hardened/telegraf-hardened/pull/31); this candidate adds the review refinements described above.

## Release Prerequisites

**Release blocker: do not publish this branch while `@telegraf/types` uses the personal Git fork.** The corrected types are pending in [types PR #6](https://github.com/telegraf-hardened/types/pull/6) and [#7](https://github.com/telegraf-hardened/types/pull/7). Until they are published, this branch uses an immutable HTTPS Git dependency. Run `npm ci` with lifecycle scripts enabled to generate its declaration files; an SSH key is not needed. This temporary CI exception enables lifecycle scripts for all dependencies, not just types. PR CI uses read-only repository permissions and does not persist checkout credentials, but that does not make dependency scripts inherently trusted.

Before a release, switch `@telegraf/types` back to `npm:@telegraf-hardened/types@^10.3.1` (or the version actually released), regenerate the lockfile, restore `npm ci --ignore-scripts` with an explicit project build in CI, validate a clean install and the complete Node matrix, and complete the community live-bot checks tracked in [Roadmap v4](https://github.com/telegraf-hardened/telegraf-hardened/issues/28). The package version has not been bumped or published by this change.
