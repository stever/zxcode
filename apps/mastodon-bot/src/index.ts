import { config, assertRuntimeConfig } from './config.js';
import { htmlToBasic, leadingMentions } from './basic.js';
import { extractProjectRef } from './project.js';
import { parseDirectives } from './directives.js';
import { allowRequest } from './ratelimit.js';
import { sourceToMedia, projectToMedia } from './media.js';
import { loadState, saveState } from './state.js';
import {
    MastodonAccount,
    MastodonNotification,
    MastodonStatus,
    Visibility,
    fetchMentions,
    postReply,
    sleep,
    uploadMedia,
    verifyCredentials,
} from './mastodon.js';

// Mirror the mention's visibility: a public mention gets a public reply (so it
// lands in the #ZXPlay hashtag feed and the profile gallery), while a private
// or direct mention is answered just as privately.
function replyVisibility(original: Visibility): Visibility {
    return original;
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// True when the bot's own handle is the first @mention in the toot, i.e. the
// post is addressed to the bot rather than merely referencing it in passing.
// The rendered mention text is the bare "@username"; we also accept a
// "username@domain" form defensively in case an instance renders the full acct.
function addressesBot(content: string, self: MastodonAccount): boolean {
    const first = leadingMentions(content)[0];
    if (!first) return false;
    const username = self.username.toLowerCase();
    return first === username || first === self.acct.toLowerCase() || first.startsWith(`${username}@`);
}

async function handleMention(self: MastodonAccount, n: MastodonNotification): Promise<void> {
    const status = n.status;
    if (!status) return;
    if (status.account.id === self.id) return; // never answer ourselves

    // Only act when the toot is addressed to the bot, i.e. our handle is the
    // first thing in it. A mid-sentence mention ("love what @bot does") is
    // conversation, not a submission, so ignore it rather than parse the
    // chatter as a program and reply with a compile error.
    if (!addressesBot(status.content, self)) {
        console.log(`Mention ${n.id} from @${status.account.acct}: not addressed to the bot, skipping`);
        return;
    }

    // A project link takes precedence over inline source: the program already
    // lives on the site, so render it directly rather than parsing the toot.
    // Directives (#128/#48 machine, #asm language) are read from the toot text
    // in both cases; for a project link the URL's ?m= hint wins over a tag.
    const projectRef = extractProjectRef(status.content, config.projectHost);
    const directives = parseDirectives(htmlToBasic(status.content));
    const code = projectRef ? null : directives.code;
    if (!projectRef && !code) {
        console.log(`Mention ${n.id} from @${status.account.acct}: no project link or source found, skipping`);
        return;
    }

    // Rate-limit per account to blunt a flood of mentions. Skip silently rather
    // than reply, so an attacker can't turn the limit into reply amplification.
    if (!allowRequest(status.account.acct, config.maxPerUserPerHour)) {
        console.log(`Mention ${n.id} from @${status.account.acct}: rate limit reached, skipping`);
        return;
    }

    const machineType = projectRef ? (projectRef.machineType ?? directives.machineType) : directives.machineType;
    const lang = directives.lang ?? 'basic';
    const projectPath = projectRef ? `${projectRef.userSlug}/${projectRef.projectSlug}` : '';
    const machineNote = machineType ? ` @${machineType}K` : '';
    console.log(
        projectRef
            ? `Mention ${n.id} from @${status.account.acct}: project ${projectPath}${machineNote}`
            : `Mention ${n.id} from @${status.account.acct}: ${code!.split('\n').length} line(s) of ${lang}${machineNote}`,
    );

    const visibility = replyVisibility(status.visibility);

    if (config.dryRun) {
        console.log(
            projectRef
                ? `[dry-run] would render project ${projectPath}${machineNote}`
                : `[dry-run] would run ${lang}${machineNote}:\n${code}`,
        );
        return;
    }

    const result = projectRef
        ? await projectToMedia(projectRef, machineType)
        : await sourceToMedia(code!, lang, machineType);

    if (!result.ok) {
        await postReply({
            inReplyToId: status.id,
            statusText: truncate(`That didn't compile or run:\n\n${result.error}`, 480),
            visibility,
        });
        return;
    }

    if (result.data.length > config.maxMediaBytes) {
        await postReply({
            inReplyToId: status.id,
            statusText: 'That program produced a file too large to post here.',
            visibility,
        });
        return;
    }

    const mediaId = await uploadMedia(result.data, result.contentType, result.filename, result.altText);
    await postReply({
        inReplyToId: status.id,
        statusText: config.replyCaption,
        mediaIds: [mediaId],
        visibility,
    });
    console.log(`Replied to ${n.id} with ${result.data.length} byte ${result.contentType}`);
}

// Best-effort generic reply when handleMention throws, so an unexpected failure
// isn't silent. Skips self/empty mentions and swallows its own errors (a failure
// to post the error reply must not break the poll loop).
async function replyWithError(self: MastodonAccount, n: MastodonNotification): Promise<void> {
    const status = n.status;
    if (!status || status.account.id === self.id) return;
    try {
        await postReply({
            inReplyToId: status.id,
            statusText: 'Something went wrong rendering that. Please try again later.',
            visibility: replyVisibility(status.visibility),
        });
    } catch (err) {
        console.error(`Also failed to send error reply for ${n.id}:`, err);
    }
}

async function pollOnce(self: MastodonAccount): Promise<void> {
    const state = await loadState();
    const mentions = await fetchMentions(state.lastNotificationId);
    if (mentions.length === 0) return;

    for (const n of mentions) {
        try {
            await handleMention(self, n);
        } catch (err) {
            // Advance past poison mentions rather than retrying forever, but tell
            // the sender something failed instead of going silent.
            console.error(`Failed to handle mention ${n.id}:`, err);
            await replyWithError(self, n);
        }
        state.lastNotificationId = n.id;
        await saveState(state);
    }
}

async function main(): Promise<void> {
    assertRuntimeConfig();
    const self = await verifyCredentials();
    console.log(
        `Bot running as @${self.acct} (id ${self.id}); polling ${config.instanceUrl} every ${config.pollIntervalMs}ms`,
    );

    for (;;) {
        try {
            await pollOnce(self);
        } catch (err) {
            console.error('Poll failed:', err);
        }
        await sleep(config.pollIntervalMs);
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
