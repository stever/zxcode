import { config, assertRuntimeConfig } from './config.js';
import { htmlToBasic } from './basic.js';
import { extractProjectRef } from './project.js';
import { basicToMedia, projectToMedia } from './media.js';
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

async function handleMention(self: MastodonAccount, n: MastodonNotification): Promise<void> {
    const status = n.status;
    if (!status) return;
    if (status.account.id === self.id) return; // never answer ourselves

    // A project link takes precedence over inline BASIC: the source already
    // lives on the site, so render it directly rather than parsing the toot.
    const projectRef = extractProjectRef(status.content, config.projectHost);
    const code = projectRef ? null : htmlToBasic(status.content);
    if (!projectRef && !code) {
        console.log(`Mention ${n.id} from @${status.account.acct}: no project link or BASIC found, skipping`);
        return;
    }
    const projectPath = projectRef ? `${projectRef.userSlug}/${projectRef.projectSlug}` : '';
    console.log(
        projectRef
            ? `Mention ${n.id} from @${status.account.acct}: project ${projectPath}`
            : `Mention ${n.id} from @${status.account.acct}: ${code!.split('\n').length} line(s)`,
    );

    const visibility = replyVisibility(status.visibility);

    if (config.dryRun) {
        console.log(projectRef ? `[dry-run] would render project ${projectPath}` : `[dry-run] would run:\n${code}`);
        return;
    }

    const result = projectRef ? await projectToMedia(projectRef) : await basicToMedia(code!);

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

async function pollOnce(self: MastodonAccount): Promise<void> {
    const state = await loadState();
    const mentions = await fetchMentions(state.lastNotificationId);
    if (mentions.length === 0) return;

    for (const n of mentions) {
        try {
            await handleMention(self, n);
        } catch (err) {
            // Advance past poison mentions rather than retrying forever.
            console.error(`Failed to handle mention ${n.id}:`, err);
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
