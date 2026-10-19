# Shunshou Translate · 顺手翻译

[简体中文](README.md) | **English**

**Type Chinese in any text box on any website, hit the spacebar three times, and the text is replaced in place with your target language.**

A Chrome extension (Manifest V3) that works the moment you install it. No API key, no account, no configuration, no telemetry. It translates through a free channel by default, and you can optionally plug in your own OpenAI-compatible provider for better quality.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4.svg)](manifest.json)
[![No Telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)](SECURITY.md)
[![No API Key Required](https://img.shields.io/badge/API%20key-not%20required-success.svg)](#install)

![Translation in action](docs/screenshots/0-hero.png)

<details>
<summary>Settings page (light / dark)</summary>

| Light | Dark |
|---|---|
| ![Light](docs/screenshots/1-options-light.png) | ![Dark](docs/screenshots/2-options-dark.png) |

</details>

---

## Why this one

Most translation extensions either translate whole pages or make you select text and click a button. This one translates **where you type**, so you can write in your native language and send in another.

- **No setup.** The free channel is on by default. Install, type, done.
- **Fast.** Roughly 0.02 s with Chrome's built-in offline model, ~0.5 s through the free online channel.
- **Works on input boxes, not pages.** `input`, `textarea`, and `contenteditable` all work, including React / Vue controlled components.
- **Your keys never leave your machine.** No backend, no relay, no analytics.
- **Optional, not required.** AI providers are a quality upgrade, never a prerequisite.

## Install

**Option A — download the package**

Grab `shunshou-translate-x.y.z.zip` from [Releases](../../releases), unzip it anywhere, then follow the steps below.

**Option B — from source**

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the unzipped or cloned folder — the one that has `manifest.json` directly inside it.
5. Click the puzzle icon in the toolbar and pin **顺手翻译**.

Requires Chrome 110 or newer.

> The settings page opens automatically on first install. **You do not need to fill in anything** — the free engine is already enabled.

## Usage

1. Click into any text box on a normal web page.
2. Type your Chinese text.
3. Press the spacebar three times in a row.
4. The text is replaced by the translation. Press `Ctrl+Z` to undo.

The three-space trigger is configurable (2–4 presses, with a time window), and the extension ignores keystrokes produced by a Chinese IME so you will not trigger it accidentally while picking candidates.

**On `chrome://` pages, the new tab page, and the Chrome Web Store** no extension can inject a content script — that is a Chrome restriction, not a bug. Use the toolbar popup instead: it has a quick-translate box that works on any page.

## How it works

Translation goes through a chain and stops at the first engine that succeeds:

| Step | Engine | Typical latency | Needs a key |
|---|---|---|---|
| 1 | Chrome built-in offline model | ~0.02 s | No (off by default, downloads a model per language pair) |
| 2 | Google free channel | ~0.5 s | No |
| 3 | Your own AI provider(s) | 0.7–2 s | Yes |

If you add more than one provider, the extension benchmarks them in the background and always tries the fastest one first, falling back to the next on failure or rate limit. A provider that just failed enters a cooldown and is not retried immediately. Results are cached locally, so repeated sentences cost nothing.

## Adding an AI provider (optional)

The extension ships with **no providers at all** — it does not pick a vendor for you.

Settings → **AI 翻译服务** → **+ 添加服务**, then fill in three fields:

- **Endpoint** — any OpenAI-compatible `/v1/chat/completions` URL
- **Model** — e.g. `gpt-4o-mini`, `openai/gpt-oss-120b`, `glm-4-flash`
- **API Key**

Then click **测试连接** to confirm. Two or more providers is more resilient than one.

For reference, three services that were benchmarked and confirmed working (models, free tiers and sign-up links) are listed in the [Chinese README](README.md#想接-ai-服务商的话). They are documentation, not defaults.

## Security and privacy

| Question | Answer |
|---|---|
| Where is my API key stored? | `chrome.storage.local` on this machine only. Never uploaded anywhere. |
| Is it synced to my Google account? | No. `storage.sync` is deliberately not used. |
| Who can read it? | The background service worker. Not the popup, not the content script, not the page. |
| Does the page I translate see my key? | No. The content script is given a `hasKey` boolean, never the key itself. |
| What about my typed text? | It is sent only to the engine that translates it. Nothing is logged or collected. |
| Can a server error leak my key back into the UI? | Error text is passed through a redaction filter before it is shown. |
| Is there remote code? | No. Everything is in the package. |

Known limitations, stated plainly: `chrome.storage.local` is not encrypted at rest (anyone with access to your Chrome profile can read it), and the extension needs `<all_urls>` because it has to run in text boxes on whatever site you are on. Full details in [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nothing happens on three spaces | The page was opened before the extension was installed | Reload the page (`F5`) |
| "This page is not supported" | You are on `chrome://`, an extension page, or the new tab page | Use the popup's quick-translate box |
| Worked before, now always fails | Every engine is rate-limited, or a provider's model was retired | The popup shows which providers are usable; add a second one |
| "API key invalid or expired (HTTP 401)" | The key is genuinely wrong | Re-paste it — this is not a rate limit |
| The status dot is green but nothing translates | All providers failed at once | Click the retry line in the toast |

The settings page also detects the "I edited the code but forgot to click reload in `chrome://extensions`" case and shows a red banner instead of letting you debug a ghost.

## Project layout

```
shunshou-translate/
├── manifest.json          MV3 manifest
├── background.js          Service worker: cache → free channel → provider failover → stats
├── lib/                   Translation client, free engines, speed stats, cache, settings
├── content/               Trigger detection and in-place DOM replacement
├── popup/                 Toolbar popup, including the quick-translate box
├── options/               Settings page
├── icons/                 Extension icons
├── docs/screenshots/      Screenshots used by the READMEs
├── tools/                 Build and test scripts
└── test/test.html         Local manual test page
```

## Development

```bash
# unit tests: migration / provider filtering / failover / cache / free engines / key redaction
node tools/test_modules.mjs

# render checks for the settings page and the popup (needs Chrome + puppeteer-core)
node tools/options-render-test.cjs "$PWD"
node tools/popup-render-test.cjs "$PWD"

# build the release zip into dist/
python tools/build.py
```

No build step is needed to run the extension — load the folder directly.

## License

MIT. See [LICENSE](LICENSE).

Third-party services you choose to connect (Groq, Zhipu, Agnes AI, OpenAI, or anything else) are independent providers. This extension is only a client for their APIs; their quotas and model availability are up to them.
