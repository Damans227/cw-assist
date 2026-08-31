# ConnectWise support assist

A Chrome side panel for ConnectWise Manage. It reads the ticket you have open
and runs it past an AI model **you** point it at — summary, what's still
outstanding, a board-wide standing report, or a drafted GitHub issue.

Nothing is hardcoded to any company. You bring your own ConnectWise instance
and your own model (local Ollama/Open WebUI, or any OpenAI-compatible API).

## What it does

- **Summary** — condenses a ticket's notes into a quick read.
- **Standing report** — what's outstanding, across a whole board.
- **Issue draft** — turns a ticket into a ready-to-file GitHub issue.
- **Open in chat** — hands the ticket off to your own chat UI (e.g. Open WebUI),
  with the ticket content pre-loaded.

Every prompt above is a template you can override in Settings.

## Install

Not on the Chrome Web Store yet, so install it as an unpacked extension:

1. Download or clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**, pick the `cw-assist` folder.
5. Pin it — click the puzzle-piece icon in the toolbar, then the pin next to
   ConnectWise support assist.

## Setup

Open the side panel on a ConnectWise ticket, click **Settings**.

| Setting | What it's for |
|---|---|
| ConnectWise origin | Your CW pod, e.g. `https://na.myconnectwise.net`. Auto-fills from the open tab if you leave it blank. |
| AI base URL / model | Your OpenAI-compatible endpoint and model name. |
| AI key | Only if your endpoint needs one. |
| Vendor name | Who "we" refers to in the prompts. Leave blank for "our team". |
| Domain focus | A one-liner on what your team supports, e.g. "Apache CloudStack". Steers the AI's read of tickets. |
| GitHub token | Only needed for the issue-draft feature. |
| GitHub repos | The repos you want to file issues against. |

Nothing leaves your machine except what you send to the AI endpoint and
GitHub API you configured — there's no backend of ours in between.

## Permissions, plainly

- Reads the ConnectWise tab you have open, to grab the ticket.
- Talks to the AI endpoint and GitHub repo you configure — both blank by
  default, both opt-in.
- Everything is stored locally in the browser (`chrome.storage.local`).

## Export / import settings

Settings panel → footer has Export and Import, so you can move your setup
between machines or back it up as a JSON file. Keys/tokens are asked about
before being included.

## Known limits

- Only tested on Chrome/Chromium. Not published to any store yet.
- Assumes an English ConnectWise UI (a couple of features look for specific
  English button/label text on the page).
- Self-hosted ConnectWise on a domain other than `*.myconnectwise.net` needs
  a manual permission grant (Settings → Grant access).

## Contributing

Issues and PRs welcome. It's plain HTML/CSS/JS, no build step — edit and
reload the extension to see changes.

## License

MIT — see [LICENSE](LICENSE).
