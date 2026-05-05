import { Devvit, SettingScope, useState, useAsync } from '@devvit/public-api';

// ─── Types ────────────────────────────────────────────────────────────────────

type Strike = {
  id: string;
  username: string;
  reason: string;
  addedBy: string;
  addedAt: number;   // Unix ms timestamp
  expiresAt: number; // Unix ms timestamp
  contentId?: string;
  contentUrl?: string;
};

type DashboardData = {
  topUsers: { username: string; count: number }[];
  recentStrikes: Strike[];
  subredditName: string;
};

// ─── Settings ─────────────────────────────────────────────────────────────────

Devvit.configure({
  redditAPI: true,
  redis: true,
});

Devvit.addSettings([
  {
    type: 'number',
    name: 'strikesBeforeWarn',
    label: 'Strikes before warning DM',
    helpText: 'Send a warning DM to the user after this many active strikes.',
    defaultValue: 2,
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'strikesBeforeMute',
    label: 'Strikes before mute',
    helpText: 'Mute the user after this many active strikes.',
    defaultValue: 3,
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'strikesBeforeBan',
    label: 'Strikes before ban',
    helpText: 'Ban the user after this many active strikes.',
    defaultValue: 5,
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'strikeExpiryDays',
    label: 'Strike expiry (days)',
    helpText: 'Strikes automatically expire after this many days. Set to 0 to never expire.',
    defaultValue: 90,
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'warningMessage',
    label: 'Warning DM message',
    helpText:
      'Message sent to a user when they receive a warning. Use {username}, {count}, {reason}, and {subreddit} as placeholders.',
    defaultValue:
      'Hi u/{username},\n\nYou have received {count} strike(s) in r/{subreddit}. Continued violations may result in a mute or ban.\n\nMost recent reason: {reason}\n\nPlease review the subreddit rules and reach out to the mod team if you have questions.',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'muteMessage',
    label: 'Mute DM message',
    helpText:
      'Message sent to a user when they are muted. Use {username}, {count}, {reason}, and {subreddit} as placeholders.',
    defaultValue:
      'Hi u/{username},\n\nYou have been muted in r/{subreddit} due to reaching {count} strike(s). You will be unable to send modmail for 28 days.\n\nMost recent reason: {reason}',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'banMessage',
    label: 'Ban DM message',
    helpText:
      'Message sent to a user when they are banned. Use {username}, {count}, {reason}, and {subreddit} as placeholders.',
    defaultValue:
      'You have been banned from r/{subreddit} for accumulating {count} strike(s).\n\nMost recent reason: {reason}\n\nIf you believe this is an error, please contact the mod team via modmail.',
    scope: SettingScope.Installation,
  },
  {
    type: 'boolean',
    name: 'autoRemoveContent',
    label: 'Auto-remove content when adding a strike',
    helpText:
      'When a mod adds a strike from a post or comment, automatically remove that content.',
    defaultValue: true,
    scope: SettingScope.Installation,
  },
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STRIKES_KEY = (subreddit: string, username: string) =>
  `strikes:v1:${subreddit}:${username}`;

const LEADERBOARD_KEY = (subreddit: string) =>
  `strike_board:v1:${subreddit}`;

const RECENT_KEY = (subreddit: string) =>
  `strike_recent:v1:${subreddit}`;

const CLEANUP_JOB_KEY = (subreddit: string) =>
  `strike_cleanup_job:v1:${subreddit}`;

function formatMessage(
  template: string,
  params: { username: string; count: number; reason: string; subreddit: string }
): string {
  return template
    .replace(/{username}/g, params.username)
    .replace(/{count}/g, String(params.count))
    .replace(/{reason}/g, params.reason)
    .replace(/{subreddit}/g, params.subreddit);
}

async function getActiveStrikes(
  redis: Devvit.Context['redis'],
  subreddit: string,
  username: string
): Promise<Strike[]> {
  const raw = await redis.get(STRIKES_KEY(subreddit, username));
  if (!raw) return [];
  const all: Strike[] = JSON.parse(raw);
  const now = Date.now();
  return all.filter((s) => s.expiresAt === 0 || s.expiresAt > now);
}

async function saveStrikes(
  redis: Devvit.Context['redis'],
  subreddit: string,
  username: string,
  strikes: Strike[]
): Promise<void> {
  await redis.set(STRIKES_KEY(subreddit, username), JSON.stringify(strikes));
}

async function addStrikeRecord(
  context: Devvit.Context,
  params: {
    subreddit: string;
    username: string;
    reason: string;
    addedBy: string;
    contentId?: string;
    contentUrl?: string;
  }
): Promise<{ strikes: Strike[]; newStrike: Strike }> {
  const expiryDays = await context.settings.get<number>('strikeExpiryDays');
  const days = expiryDays ?? 90;

  const now = Date.now();
  const newStrike: Strike = {
    id: `${now}-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`,
    username: params.username,
    reason: params.reason,
    addedBy: params.addedBy,
    addedAt: now,
    expiresAt: days > 0 ? now + days * 24 * 60 * 60 * 1000 : 0,
    contentId: params.contentId,
    contentUrl: params.contentUrl,
  };

  const existing = await getActiveStrikes(context.redis, params.subreddit, params.username);
  const updated = [...existing, newStrike];
  await saveStrikes(context.redis, params.subreddit, params.username, updated);

  // Update the leaderboard sorted set
  await context.redis.zAdd(LEADERBOARD_KEY(params.subreddit), {
    member: params.username,
    score: updated.length,
  });

  // Keep a capped list of recent strikes (most recent 50)
  const recentRaw = await context.redis.get(RECENT_KEY(params.subreddit));
  const recent: Strike[] = recentRaw ? JSON.parse(recentRaw) : [];
  const updatedRecent = [newStrike, ...recent].slice(0, 50);
  await context.redis.set(RECENT_KEY(params.subreddit), JSON.stringify(updatedRecent));

  return { strikes: updated, newStrike };
}

async function enforceActions(
  context: Devvit.Context,
  subredditName: string,
  username: string,
  strikeCount: number,
  latestReason: string
): Promise<void> {
  const [warnThreshold, muteThreshold, banThreshold, warnMsg, muteMsg, banMsg] =
    await Promise.all([
      context.settings.get<number>('strikesBeforeWarn'),
      context.settings.get<number>('strikesBeforeMute'),
      context.settings.get<number>('strikesBeforeBan'),
      context.settings.get<string>('warningMessage'),
      context.settings.get<string>('muteMessage'),
      context.settings.get<string>('banMessage'),
    ]);

  const msgParams = {
    username,
    count: strikeCount,
    reason: latestReason,
    subreddit: subredditName,
  };

  if (strikeCount >= (banThreshold ?? 5)) {
    await context.reddit.banUser({
      subredditName,
      username,
      reason: `Accumulated ${strikeCount} strikes. Latest: ${latestReason}`,
      message: formatMessage(banMsg ?? '', msgParams),
    });
    return;
  }

  if (strikeCount >= (muteThreshold ?? 3)) {
    await context.reddit.muteUser({ subredditName, username });
    try {
      await context.reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: subredditName,
        to: username,
        subject: `You have been muted in r/${subredditName}`,
        text: formatMessage(muteMsg ?? '', msgParams),
      });
    } catch {
      // DM may fail if user has messages blocked – ignore
    }
    return;
  }

  if (strikeCount >= (warnThreshold ?? 2)) {
    try {
      await context.reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: subredditName,
        to: username,
        subject: `Strike warning in r/${subredditName}`,
        text: formatMessage(warnMsg ?? '', msgParams),
      });
    } catch {
      // DM may fail if user has messages blocked – ignore
    }
  }
}

// ─── App Install: Schedule daily cleanup ──────────────────────────────────────

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    const subredditName = context.subredditName ?? 'unknown';
    const jobId = await context.scheduler.runJob({
      name: 'expireStrikes',
      data: { subredditName },
      cron: '0 3 * * *', // 3 AM UTC every day
    });
    await context.redis.set(CLEANUP_JOB_KEY(subredditName), jobId);
    console.log(`[StrikeSystem] Installed in r/${subredditName}. Cleanup job: ${jobId}`);
  },
});

Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (_event, context) => {
    const subredditName = context.subredditName ?? 'unknown';
    // Cancel old job if it exists and reschedule
    const oldJobId = await context.redis.get(CLEANUP_JOB_KEY(subredditName));
    if (oldJobId) {
      try {
        await context.scheduler.cancelJob(oldJobId);
      } catch {
        // Job may no longer exist
      }
    }
    const jobId = await context.scheduler.runJob({
      name: 'expireStrikes',
      data: { subredditName },
      cron: '0 3 * * *',
    });
    await context.redis.set(CLEANUP_JOB_KEY(subredditName), jobId);
    console.log(`[StrikeSystem] Upgraded in r/${subredditName}. New cleanup job: ${jobId}`);
  },
});

// ─── Scheduled Job: Expire strikes ────────────────────────────────────────────

Devvit.addSchedulerJob({
  name: 'expireStrikes',
  onRun: async (event, context) => {
    const subredditName = (event.data?.subredditName as string) ?? context.subredditName ?? '';
    if (!subredditName) return;

    console.log(`[StrikeSystem] Running strike expiry cleanup for r/${subredditName}`);

    // Scan all members in the leaderboard to find users with strikes
    const leaderboard = await context.redis.zRange(LEADERBOARD_KEY(subredditName), 0, -1, {
      by: 'rank',
    });

    const now = Date.now();
    for (const entry of leaderboard) {
      const username = entry.member;
      const raw = await context.redis.get(STRIKES_KEY(subredditName, username));
      if (!raw) continue;

      const all: Strike[] = JSON.parse(raw);
      const active = all.filter((s) => s.expiresAt === 0 || s.expiresAt > now);

      if (active.length !== all.length) {
        await saveStrikes(context.redis, subredditName, username, active);
        // Update leaderboard score
        if (active.length > 0) {
          await context.redis.zAdd(LEADERBOARD_KEY(subredditName), {
            member: username,
            score: active.length,
          });
        }
      }
    }

    console.log(`[StrikeSystem] Cleanup done for r/${subredditName}`);
  },
});

// ─── Forms ────────────────────────────────────────────────────────────────────

const addStrikeForm = Devvit.createForm(
  {
    title: 'Add Strike',
    description: 'Add a strike to this user. Automatic enforcement actions will apply based on total strike count.',
    fields: [
      {
        type: 'string',
        name: 'reason',
        label: 'Reason for strike',
        helpText: 'A brief description of why this strike is being issued.',
        required: true,
      },
      {
        type: 'boolean',
        name: 'removeContent',
        label: 'Remove the associated content',
        defaultValue: true,
      },
    ],
    acceptLabel: 'Add Strike',
    cancelLabel: 'Cancel',
  },
  async ({ values }, context) => {
    const reason = (values.reason as string) ?? 'Unspecified';
    const removeContent = values.removeContent as boolean;

    const subredditName = context.subredditName ?? '';
    const modUsername = context.username ?? 'moderator';
    const targetId = context.postId ?? context.commentId ?? '';

    if (!targetId) {
      context.ui.showToast({ text: 'Could not determine target content.', appearance: 'neutral' });
      return;
    }

    let targetUsername = '';
    let contentUrl = '';

    try {
      if (targetId.startsWith('t3_') || context.postId) {
        const post = await context.reddit.getPostById(context.postId ?? targetId);
        targetUsername = post.authorName ?? '';
        contentUrl = post.url;
        if (removeContent) {
          await post.remove(false);
        }
      } else if (context.commentId) {
        const comment = await context.reddit.getCommentById(context.commentId);
        targetUsername = comment.authorName ?? '';
        contentUrl = `https://reddit.com${comment.permalink}`;
        if (removeContent) {
          await comment.remove(false);
        }
      }
    } catch (err) {
      console.error('[StrikeSystem] Error fetching content:', err);
    }

    if (!targetUsername) {
      context.ui.showToast({ text: 'Could not identify the content author.', appearance: 'neutral' });
      return;
    }

    const { strikes } = await addStrikeRecord(context, {
      subreddit: subredditName,
      username: targetUsername,
      reason,
      addedBy: modUsername,
      contentId: targetId,
      contentUrl,
    });

    await enforceActions(context, subredditName, targetUsername, strikes.length, reason);

    context.ui.showToast({
      text: `✅ Strike added to u/${targetUsername}. Total active strikes: ${strikes.length}`,
      appearance: 'success',
    });
  }
);

const removeStrikeForm = Devvit.createForm(
  {
    title: 'Remove Latest Strike',
    description: 'Remove the most recent active strike for this user.',
    fields: [
      {
        type: 'string',
        name: 'username',
        label: 'Reddit username (without u/)',
        helpText: 'The username of the user to remove a strike from.',
        required: true,
      },
    ],
    acceptLabel: 'Remove Strike',
    cancelLabel: 'Cancel',
  },
  async ({ values }, context) => {
    const username = (values.username as string)?.trim().replace(/^u\//, '');
    if (!username) {
      context.ui.showToast({ text: 'Please enter a valid username.', appearance: 'neutral' });
      return;
    }

    const subredditName = context.subredditName ?? '';
    const strikes = await getActiveStrikes(context.redis, subredditName, username);

    if (strikes.length === 0) {
      context.ui.showToast({
        text: `u/${username} has no active strikes.`,
        appearance: 'neutral',
      });
      return;
    }

    // Strikes are appended in chronological order; slice(0, -1) removes the last (most recent).
    const updated = strikes.slice(0, -1);
    await saveStrikes(context.redis, subredditName, username, updated);

    // Update leaderboard
    if (updated.length > 0) {
      await context.redis.zAdd(LEADERBOARD_KEY(subredditName), {
        member: username,
        score: updated.length,
      });
    }

    context.ui.showToast({
      text: `✅ Removed 1 strike from u/${username}. Remaining: ${updated.length}`,
      appearance: 'success',
    });
  }
);

const viewStrikesForm = Devvit.createForm(
  {
    title: 'View User Strikes',
    fields: [
      {
        type: 'string',
        name: 'username',
        label: 'Reddit username (without u/)',
        required: true,
      },
    ],
    acceptLabel: 'Look up',
    cancelLabel: 'Cancel',
  },
  async ({ values }, context) => {
    const username = (values.username as string)?.trim().replace(/^u\//, '');
    if (!username) {
      context.ui.showToast({ text: 'Please enter a valid username.', appearance: 'neutral' });
      return;
    }

    const subredditName = context.subredditName ?? '';
    const strikes = await getActiveStrikes(context.redis, subredditName, username);

    if (strikes.length === 0) {
      context.ui.showToast({
        text: `u/${username} has no active strikes in r/${subredditName}.`,
        appearance: 'neutral',
      });
      return;
    }

    const lines = strikes.map((s, i) => {
      const date = new Date(s.addedAt).toLocaleDateString();
      return `#${i + 1} [${date}] ${s.reason} (by u/${s.addedBy})`;
    });

    context.ui.showToast({
      text: `u/${username} — ${strikes.length} strike(s):\n${lines.slice(0, 3).join('\n')}${
        strikes.length > 3 ? `\n…and ${strikes.length - 3} more` : ''
      }`,
      appearance: 'neutral',
    });
  }
);

// ─── Menu Items ───────────────────────────────────────────────────────────────

Devvit.addMenuItem({
  label: '⚠️ Add Strike',
  description: 'Issue a strike to the post author',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showForm(addStrikeForm);
  },
});

Devvit.addMenuItem({
  label: '⚠️ Add Strike',
  description: 'Issue a strike to the comment author',
  location: 'comment',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showForm(addStrikeForm);
  },
});

Devvit.addMenuItem({
  label: '✅ Remove Strike',
  description: 'Remove the most recent strike from a user',
  location: ['post', 'comment', 'subreddit'],
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showForm(removeStrikeForm);
  },
});

Devvit.addMenuItem({
  label: '🔍 View User Strikes',
  description: "Look up a user's current strikes",
  location: ['post', 'comment', 'subreddit'],
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showForm(viewStrikesForm);
  },
});

Devvit.addMenuItem({
  label: '📊 Create Strike Dashboard',
  description: 'Pin a live-updating strike dashboard post to this subreddit',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const subredditName = context.subredditName ?? '';
    const post = await context.reddit.submitPost({
      subredditName,
      title: `📊 Mod Strike Dashboard — r/${subredditName}`,
      preview: (
        <vstack alignment="center middle" height="100%" width="100%">
          <text size="medium" color="neutral-content">Loading dashboard…</text>
        </vstack>
      ),
    });
    context.ui.showToast({
      text: `Dashboard post created! Pin it for easy mod access.`,
      appearance: 'success',
    });
    context.ui.navigateTo(post);
  },
});

// ─── Custom Post: Strike Dashboard ────────────────────────────────────────────

Devvit.addCustomPostType({
  name: 'Strike Dashboard',
  description: 'Live-updating moderation strike leaderboard',
  height: 'tall',
  render: (context) => {
    const subredditName = context.subredditName ?? '';

    const { data: dashboardData, loading } = useAsync<DashboardData>(async () => {
      const [leaderboardEntries, recentRaw] = await Promise.all([
        context.redis.zRange(LEADERBOARD_KEY(subredditName), 0, 9, {
          by: 'rank',
          reverse: true,
        }),
        context.redis.get(RECENT_KEY(subredditName)),
      ]);

      const topUsers = leaderboardEntries.map((e) => ({
        username: e.member,
        count: Math.round(e.score),
      }));

      const recentStrikes: Strike[] = recentRaw ? JSON.parse(recentRaw) : [];

      return {
        topUsers,
        recentStrikes: recentStrikes.slice(0, 5),
        subredditName,
      };
    });

    const [view, setView] = useState<'leaderboard' | 'recent'>('leaderboard');

    if (loading) {
      return (
        <vstack alignment="center middle" height="100%" width="100%" backgroundColor="#1a1a1b">
          <text size="large" color="#d7dadc">Loading dashboard…</text>
        </vstack>
      );
    }

    const data = dashboardData ?? { topUsers: [], recentStrikes: [], subredditName };

    return (
      <vstack height="100%" width="100%" backgroundColor="#1a1a1b" padding="medium" gap="medium">
        {/* Header */}
        <vstack alignment="center middle" gap="small">
          <text size="xxlarge" weight="bold" color="#ff4500">⚠️ Strike Dashboard</text>
          <text size="small" color="#818384">r/{data.subredditName} — Moderation Overview</text>
        </vstack>

        {/* Tab selector */}
        <hstack gap="small" alignment="center middle">
          <button
            appearance={view === 'leaderboard' ? 'primary' : 'secondary'}
            size="small"
            onPress={() => setView('leaderboard')}
          >
            🏆 Top Offenders
          </button>
          <button
            appearance={view === 'recent' ? 'primary' : 'secondary'}
            size="small"
            onPress={() => setView('recent')}
          >
            🕐 Recent Strikes
          </button>
        </hstack>

        {/* Leaderboard view */}
        {view === 'leaderboard' && (
          <vstack gap="small" grow>
            {data.topUsers.length === 0 ? (
              <vstack alignment="center middle" grow>
                <text size="medium" color="#818384">No strikes recorded yet.</text>
              </vstack>
            ) : (
              data.topUsers.map((u, i) => (
                <hstack
                  key={u.username}
                  backgroundColor={i === 0 ? '#2d1a00' : '#272729'}
                  padding="small"
                  cornerRadius="small"
                  alignment="start middle"
                  gap="medium"
                >
                  <text size="medium" weight="bold" color="#ff4500" width="24px">
                    {i + 1}.
                  </text>
                  <text size="medium" color="#d7dadc" grow>
                    u/{u.username}
                  </text>
                  <hstack
                    backgroundColor="#ff4500"
                    padding="small"
                    cornerRadius="small"
                    alignment="center middle"
                  >
                    <text size="small" weight="bold" color="white">
                      {u.count} ⚠️
                    </text>
                  </hstack>
                </hstack>
              ))
            )}
          </vstack>
        )}

        {/* Recent strikes view */}
        {view === 'recent' && (
          <vstack gap="small" grow>
            {data.recentStrikes.length === 0 ? (
              <vstack alignment="center middle" grow>
                <text size="medium" color="#818384">No recent strikes.</text>
              </vstack>
            ) : (
              data.recentStrikes.map((s) => {
                const date = new Date(s.addedAt).toLocaleDateString();
                return (
                  <vstack
                    key={s.id}
                    backgroundColor="#272729"
                    padding="small"
                    cornerRadius="small"
                    gap="small"
                  >
                    <hstack alignment="start middle" gap="small">
                      <text size="small" weight="bold" color="#ff6314">
                        u/{s.username}
                      </text>
                      <text size="xsmall" color="#818384" grow>
                        — by u/{s.addedBy} on {date}
                      </text>
                    </hstack>
                    <text size="xsmall" color="#d7dadc" wrap>
                      {s.reason}
                    </text>
                  </vstack>
                );
              })
            )}
          </vstack>
        )}

        {/* Footer */}
        <text size="xsmall" color="#555657" alignment="center">
          Powered by Mod Strike System • r/{data.subredditName}
        </text>
      </vstack>
    );
  },
});

export default Devvit;
