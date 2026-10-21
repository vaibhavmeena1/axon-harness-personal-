# Axon user guide

## What is Axon?

Axon is an AI coding assistant you use from your terminal. It launches **Pi**, the coding agent, with your organization's sign-in, configuration, tools, and updates already managed for you.

Use it inside a project to understand code, make changes, investigate bugs, and run commands or tests. You do not need to install Pi separately or configure a personal model API key for the managed setup.

## 1. Install Axon

### Before you begin

- **A Mac**: Apple Silicon (M-series) or Intel. Linux and Windows are not currently supported by the distributed installer.
- **Node.js 22.19 or newer and npm.** Check with `node --version` and `npm --version`. If they are missing or outdated, the installer can offer to install or upgrade Node.js through an existing Homebrew installation. Otherwise, install them from [nodejs.org](https://nodejs.org/) first.
- An internet connection and access to [deputydev.ai/axon/ping](https://deputydev.ai/axon/ping).

### Install from your terminal

Run this command to install Axon:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://deputydev.ai/axon/install.sh | sh
```

The installer puts Axon in `~/.axon/bin` and adds that directory to your shell configuration. **Open a new terminal**, or run the shell-specific PATH command printed by the installer, then check:

```bash
axon --version
```

Axon installs its own Pi runtime on first use. This can take longer than later launches and does not change a separately installed Pi.

## 2. Log in

Run:

```bash
axon
```

Axon guides you through sign-in automatically when needed—no separate login command is required.

### What the login flow looks like

1. The terminal shows **Login from browser**. Select it and press Enter.
2. Axon opens your default browser to the sign-in page.
3. Sign in with your **1mg email address** and complete the approval flow. Keep the terminal open while it waits.
4. Once sign-in is complete, **return to the CLI**. The terminal prints **Axon encrypted session saved locally.**, and you can start working.

Check your login at any time:

```bash
axon auth status
```

A successful check prints **Axon session is valid.** Axon verifies your session before starting Pi and silently refreshes expired access when possible. If a new login is required, an interactive launch offers the browser flow again. An existing DeputyDev sign-in may already be available because the applications share login credentials.

Login waits up to five minutes. If it fails or times out, check your connection and run `axon` again.

## 3. Start working

Open your project directory and launch Axon:

```bash
cd /path/to/your/project
axon
```

`axon pi` starts the same coding assistant.

Type a request in plain language, for example:

- "Explain how authentication works in this project."
- "Find the cause of this failing test and fix it."
- "Add input validation to this endpoint and run the relevant tests."

Review the changes and test results before committing. Axon currently requires an online session check to start; offline mode does not bypass login verification.

## 4. Choose a model and thinking level

Run these commands **inside the coding session**, not in your normal terminal shell.

### Select a model

Type `/model` or press **Ctrl+L** to open the model picker. Search the list, select a model, and press Enter to use it for the current session. Managed models are available through **Axon AI Gateway**; the provider ID used in commands is `litellm`.

Available models depend on your organization's access. If Axon offers task-based recommendations, you can choose a suggested model or keep your current one.

### Set the thinking level

Type `/thinking` to choose how much reasoning the selected model uses, or press **Shift+Tab** to cycle through its supported levels. You can also set a level directly:

```text
/thinking high
```

Pi supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but **not every model supports every level**. Use the choices shown by `/thinking`. Lower levels generally favor speed; higher levels can help with difficult reasoning but may take longer and cost more.

**Ctrl+T only shows or hides thinking output**; it does not change the thinking level.

### Save defaults or choose at launch

In the `/model` or `/thinking` picker, press **Ctrl+S** on your choice to save it as a startup default. Enter changes the current session without saving a new default. Resuming a session restores its recorded model and thinking level. Your organization's managed model default may be reapplied on a later launch.

For a specific launch, use:

```bash
axon pi --list-models
axon pi --provider litellm --model MODEL_ID --thinking high
```

Replace `MODEL_ID` with an available model ID from the list. Launch flags override startup defaults, and Pi limits the requested thinking level to the model's capabilities.

## 5. Standard mode and YOLO mode

Terminal execution starts in **Standard mode**. Routine supported commands can run automatically; commands that the model or your organization's policy marks for review, along with complex shell commands, require confirmation.

To see the current mode and restrictions, type this **inside the coding session**, not in your normal terminal shell:

```text
/terminal-permissions
```

### Enable or disable YOLO

Inside the coding session, type:

```text
/yolo
```

- `/yolo` toggles YOLO **on** immediately, with no extra confirmation. The session header displays **YOLO**.
- Type `/yolo` again to return to Standard mode.
- YOLO is available only if your administrator permits it. If unavailable, ask your administrator; a local environment variable cannot enable it.
- It applies only to the current session and resets to Standard when the session is created/replaced, shut down, or extensions are reloaded.

> **Use with care:** YOLO runs terminal commands without approval, including commands that would normally need review. This can modify or delete files or affect external systems. Recognized blocked commands are still denied, but blocklists are best-effort—not a security sandbox. Use a clean working tree or commit your work first. Turning YOLO off does not stop commands already running or resolve approval prompts already open.

## 6. Update Axon

```bash
axon update --check   # check without installing
axon update           # install the latest release
axon --version        # see the installed version
```

Interactive online coding launches also check for updates before starting Pi. When a newer release is available, Axon installs it and continues your launch automatically. If the update fails, it warns and continues with the installed version.

Update Axon rather than running `axon pi update`; Axon manages its own Pi version.

## 7. Check or repair your setup

Run:

```bash
axon doctor
```

Doctor checks local setup such as Axon's PATH, managed-directory permissions, Pi installation/version, and required packages. It prints findings and suggested fixes; it does not install missing Pi components itself. It may ask you to log in if no saved session exists.

If Pi or required packages are missing or need repair, run these while online:

```bash
axon setup pi --sync-packages
axon doctor pi
```

A missing Pi runtime before your first coding launch is expected; `axon` can install it automatically. To see where Axon stores its managed files, run `axon paths`.

## 8. Import or restore a session

To continue a backed-up Axon session on this machine, use **Restore a session**. The command is `restore`, not `import`.

First, clone or otherwise prepare the project locally. Restore brings back the conversation, **not your repository, uncommitted changes, dependencies, or credentials**.

### Guided restore

```bash
cd /path/to/your/project
axon sessions
```

1. Choose **Restore a session**.
2. Search your backups by title, backup date, or session ID, then select one.
3. Choose an **existing local project directory**. The default is your current directory.
4. Review the details and confirm the restore. Confirmation defaults to **No**.
5. Axon downloads and verifies the backup, then creates a **new local session**, without overwriting an active one.
6. Run the resume commands Axon prints. Restore does not start the coding assistant automatically.

### Backup status and management

Backups are controlled by your administrator and may not be enabled for your team. When enabled, managed sessions attempt backups at session start/shutdown and when you request a checkpoint—not after every message.

Run `axon sessions` and choose:

- **Backup status** to check backup policy, the last confirmed backup, and pending/paused work.
- **Retry paused backups** to clear eligible queue errors so backups can retry at the next backup boundary.
- **Delete a backup** to select a backup and confirm its deletion. Local sessions are kept.

To request a checkpoint while working, type `/axon-backup-now` inside the coding session.

Only the **latest confirmed checkpoint** is restorable; pending uploads are not a confirmed backup. Backup history is not retained.

> **Privacy:** backups include the complete session transcript, including prompts, tool output, code, images, and any secrets present in the conversation. There is no transcript redaction or client-side encryption layer. Follow your organization's data policy.

## Quick troubleshooting

| Problem | What to do |
| --- | --- |
| `axon: command not found` | Open a new terminal or run the PATH command printed by the installer. The default binary is `~/.axon/bin/axon`. |
| Login fails or times out | Check your connection and browser sign-in, then run `axon` again and select **Login from browser** when prompted. Contact your administrator if it persists. |
| Pi fails to start | Run `axon auth status`, then `axon doctor pi`. Use `axon setup pi --sync-packages` for missing or broken managed components. |
| Update fails | Check your connection, follow the reported fix, and retry `axon update`. |
| No backups appear | Run `axon sessions` and choose **Backup status**. Confirm backups are enabled with your administrator and that a checkpoint has been successfully committed. |
| YOLO is unavailable | Run `/terminal-permissions` inside the session and ask your administrator whether YOLO is permitted. |

For more commands, run `axon --help` or `axon sessions --help`.

## More Pi features

For other coding-session features, refer to the [Pi documentation](https://pi.dev/docs/latest).

When following Pi examples, use `axon pi` in place of `pi`. **Keep using Axon's installation, automatic sign-in through `axon`, and `axon update` instructions above** for the managed setup, rather than Pi's standalone installation/provider-login/update flow. Axon stores its managed Pi data under `~/.axon/pi`, separately from standalone Pi. Online docs may describe a newer Pi version; use `axon pi --help` and the in-session command menu to check what your installed version supports.
