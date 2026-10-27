# Syncing Settings with GitHub

AgenteCode lets you easily sync your settings, keyboard shortcuts, snippets and extension list across different computers using a **secret Gist** on your own GitHub account.

No token needs to be typed by hand: you sign in securely and quickly through the browser (GitHub **Device Flow**).

---

## How It Works

- Your settings are bundled and saved in a Gist on your GitHub account.
- **Privacy notice:** The generated Gist is **secret** (it does not appear in public GitHub searches or on your public profile), but anyone who has the direct link can read its content.
- **Automatic safety:** AgenteCode automatically removes passwords, authentication tokens (such as API keys, credentials and sensitive variables) and paths specific to your local machine before sending any data.

---

## 1. First Use (Upload Settings)

1. In the lower-left corner of the screen, click the **gear icon** (Settings) or the **account icon** and select **Sync Settings with GitHub...**
2. If this is your first time, choose **Connect to GitHub and Upload My Settings**.
3. Read the privacy notice and click **Continue**.
4. A notification will show a one-time code (e.g. `ABCD-1234`). Click the **Copy Code and Open GitHub** button.
5. The browser opens GitHub's activation page (`github.com/login/device`). Paste the copied code and click **Continue**.
6. Authorize the **AgenteCode** app to create and manage your Gists.
7. Done! AgenteCode detects the authorization automatically and performs the first upload. At the end, you can click **Copy Gist URL** or **Open in Browser** to see the Gist that was created.

---

## 2. On Another Computer (Download Settings)

1. On the new computer, open the **Sync Settings with GitHub...** menu.
2. Select **Download Settings from Another Computer**.
3. If you are not yet connected on this computer, complete the quick code authorization in the browser.
4. AgenteCode will find your synced Gist and show a **preview** of the differences.
5. You can inspect the differences file by file and confirm applying them.
6. A backup of your current local files is created automatically before the changes are applied.
7. When it finishes, a detailed summary shows all updated files and installed extensions.

---

## 3. Automatic Sync

- While you are connected, AgenteCode watches for changes to your local settings.
- When you change a file (`settings.json`, `keybindings.json` or snippets), it waits 30 seconds (configurable) and quietly uploads the changes to your Gist if the content has changed.
- When you open the editor, if there are newer settings on GitHub saved by another computer, AgenteCode shows a notification asking whether you want to download them. **The editor never overwrites your local files without your permission.**
- You can turn automatic upload on or off at any time from the menu using the **Auto sync: On/Off** option.

---

## 4. How to Undo a Sync

If you downloaded settings and want to go back to the previous state:
1. Open the **Sync Settings with GitHub...** menu.
2. Click **Undo Last Sync**.
3. AgenteCode will restore the most recent local backup (the last 10 local backups are kept on your computer).

---

## 5. How to Disconnect

1. Open the **Sync Settings with GitHub...** menu.
2. Click **Disconnect**.
3. The access token is securely removed from the IDE's encrypted storage.
4. Your Gist on GitHub is **not** deleted when you disconnect, so you do not lose your history. If you want to delete it, you can use the **Open Gist in Browser** option before disconnecting.

## 6. Also Sync the Claude Configuration (optional)

By default, only the IDE settings are synced. If you want your agent's "way of working" to follow you to another computer:

1. Open the **Sync Settings with GitHub...** menu.
2. Click **Claude configuration: Off** and confirm with **Turn On**.
3. Your global `CLAUDE.md` and the files in `~/.claude/commands`, `agents` and `skills` are now uploaded (text only, up to 200 KB each).

What is **never** sent: your Claude login, your conversation history and Claude's `settings.json`. Files that contain keys or tokens are skipped automatically.

> **Warning:** the Gist is secret, but anyone who has the link can read its content. Do not leave confidential information in those files.

When downloading on another computer, the Claude files also go through the preview, and a copy of the ones that would be replaced is saved for **Undo**.
