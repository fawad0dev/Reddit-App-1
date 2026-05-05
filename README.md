# Reddit-App-1

# Mod Strike System — Devvit Moderation App

A fully-featured Reddit moderation tool built on [Devvit](https://developers.reddit.com/), Reddit's Developer Platform. **Mod Strike System** gives subreddit moderators a transparent, automated, and configurable strike-based enforcement system right inside Reddit — no external bots, no third-party services.

---

## 🚀 Features

| Feature | Description |
|---|---|
| **Strike tracking** | Tracks per-user strikes in each subreddit using Redis. Strikes auto-expire after a configurable number of days. |
| **Automatic escalation** | Automatically warns, mutes, or bans users as their strike count crosses configurable thresholds. |
| **Mod menu actions** | Mods can add/remove strikes and look up any user's history directly from a post, comment, or subreddit context menu — no external dashboard needed. |
| **Remove content on strike** | Optionally removes the associated post or comment when a strike is issued. |
| **Custom DM messages** | Fully customizable warning, mute, and ban notification messages sent from the subreddit. |
| **Live Strike Dashboard** | A pinnable custom post that shows a real-time top-offenders leaderboard and recent strikes feed. |
| **Daily cleanup** | A scheduled job runs every night to purge expired strikes and keep the leaderboard accurate. |

---

## 📦 Project Structure

```
mod-strike-system/
├── devvit.yaml          # Devvit app manifest
├── package.json         # Node dependencies
├── tsconfig.json        # TypeScript config (mirrors devvit.tsconfig.json)
└── src/
    └── main.tsx         # Full app logic (triggers, menu items, dashboard)
```

---

## 🛠️ Installation & Setup

### Prerequisites

- Node.js ≥ 18
- [Devvit CLI](https://developers.reddit.com/docs/get-started): `npm install -g devvit`

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Upload to Reddit

```bash
devvit upload
```

### Playtest locally

```bash
devvit playtest <your-test-subreddit>
```

---

## ⚙️ Configuration

After installing the app on a subreddit, moderators can configure the following settings via the **App Settings** panel:

| Setting | Default | Description |
|---|---|---|
| Strikes before warning DM | `2` | Send an automated warning DM at this strike count |
| Strikes before mute | `3` | Mute the user at this strike count |
| Strikes before ban | `5` | Ban the user at this strike count |
| Strike expiry (days) | `90` | Strikes expire automatically; set `0` to never expire |
| Warning DM message | (see app) | Customizable template with `{username}`, `{count}`, `{reason}`, `{subreddit}` |
| Mute DM message | (see app) | Same placeholders |
| Ban DM message | (see app) | Same placeholders |
| Auto-remove content | `true` | Remove the post/comment when a strike is issued from it |

---

## 🎮 How to Use

### Adding a Strike

1. Navigate to any post or comment in your subreddit.
2. Open the **⋮ More options** menu.
3. Select **⚠️ Add Strike**.
4. Enter the reason and choose whether to remove the content.
5. The system automatically applies the appropriate enforcement action.

### Removing a Strike

1. Open **⋮ More options** on any post, comment, or the subreddit.
2. Select **✅ Remove Strike**.
3. Enter the username to remove their most recent strike.

### Viewing a User's Strikes

1. Open **⋮ More options** on any post, comment, or the subreddit.
2. Select **🔍 View User Strikes**.
3. Enter the username to see a summary of their current active strikes.

### Creating the Strike Dashboard

1. Go to your subreddit.
2. Open the subreddit menu.
3. Select **📊 Create Strike Dashboard**.
4. Pin the resulting post so your mod team always has it visible.

---

## 🏗️ Technical Details

- **Storage**: Uses Devvit's built-in Redis client for persistent strike records, a sorted leaderboard (`ZADD`), and a recent-strikes log.
- **Scheduling**: On app install, a cron job (`0 3 * * *`) is registered to expire old strikes nightly.
- **Custom Post**: The Strike Dashboard uses `useAsync` and `useState` for live data loading and tab-switching without page reloads.
- **Reddit API**: Uses `banUser`, `muteUser`, and `sendPrivateMessageAsSubreddit` for automated enforcement actions.

---

## 🏆 Hackathon Submission

This app was built for the [Reddit Mod Tools & Migrated Apps Hackathon](https://www.reddit.com/r/devvit) (April 29 – May 27).

**Category**: New Mod Tool

**Target communities**: Any active subreddit with 500+ WAU that currently relies on manual moderation or AutoModerator rules for repeat offenders.

**Impact**:
- Reduces the time mods spend manually tracking repeat rule-breakers.
- Provides a single transparent system that users and mods can reference.
- Prevents escalation errors (e.g., banning a first-time offender) by enforcing a configurable progressive system.
