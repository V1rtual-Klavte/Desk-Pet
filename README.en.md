<div align="center">

# V1rtual-Desk-Pet

<sub>Virtual Desktop Pet</sub>

**A desktop pet with customizable character and appearance — always on your desktop, ready to chat, aware of what you're doing, and happy to help with small tasks.**

[![Release](https://img.shields.io/github/v/release/V1rtual-Klavte/Desk-Pet)](https://github.com/V1rtual-Klavte/Desk-Pet/releases/latest)
[![License](https://img.shields.io/github/license/V1rtual-Klavte/Desk-Pet)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#download--install)
[![Bundled Node](https://img.shields.io/badge/node-22.22.3_bundled-3c873a)](packaging/node-runtime.json)

<p align="center">
  <img src="docs/images/theme-1.webp" width="270" alt="Desktop pet demo · Theme 1 (light)">
  <img src="docs/images/theme-2.webp" width="270" alt="Desktop pet demo · Theme 2 (bright)">
  <img src="docs/images/theme-3.webp" width="270" alt="Desktop pet demo · Theme 3 (dark)">
</p>

[English](README.en.md) · [简体中文](README.md)

</div>

## What it is

V1rtual-Desk-Pet is a **desktop pet with customizable character cards and layered artwork**, built to do lightweight companionship and chatting really well.

The character lives on your desktop as a transparent, always-on-top window: she chats with you, watches the foreground window, speaks up at the right moments, and can use tools to read and write files, run commands, and orchestrate tasks. The app consists of a native Rust host (native UI and platform capabilities) plus a single bundled Node runtime — **no WebView**. The installer is ready out of the box; you don't need Node installed.

Design goals: lightweight, low memory, high performance, token-efficient, feature-complete. Target platforms: Windows and macOS.

## Features

### Companionship & chat

- **Humanized delivery**: regular chat replies arrive bubble by bubble with a typing indicator; tool tasks report results immediately. Can be turned off in AI settings.
- **Interject & queue**: you can keep sending messages while a reply is being generated — choose *Interject* to process after the current response, or *Continue later* to let the task finish naturally. Queued messages can be withdrawn one by one.
- **Image messages**: click *Image* in the chat box, drag in the original file, or paste from the clipboard (⌘V / Ctrl+V).
- **Conversation continuity**: multiple sessions with history restore; long sessions are compacted under a budget while the full transcript stays on disk.

### Character & appearance

- **Cards**: a card defines the character's persona, language style, and variables; you can switch between multiple cards for the same pet. The default character *void* ships without a name — you give her one in conversation. The *Personality* settings page supports create / edit / rename / import / export / delete, plus an **authoring template** you can hand to an AI to generate a new card.
- **Variables**: a card can declare its own variables (name, affinity, …) that the character updates in conversation according to card rules. Types and ranges are hard-constrained — the model cannot add variables or write out-of-range values. Variables persist with the card, change her tone and state, and crossing configured thresholds can become a reason for her to speak up.
- **Layered parallax**: character art is split into layers that shift slightly with the cursor for a depth-following effect (toggle and strength under *Appearance → Character display*). The layer editor adjusts order, visibility, and scale; the *No assets?* panel provides **asset-generation prompts** you can hand to an image AI to generate per-layer art, or drop in images for cutout/touch-up.
- **Profiles**: collections of artwork and assets — create (start empty and add assets), rename, delete, import, and export.
- **Themes**: five built-in themes and a global font (Settings / Appearance).

### Memory & proactive companionship

- **Silent understanding**: under *AI → Silent access*, the *Silent understanding frequency* tier (off / low / medium / high) turns automatic understanding on and off — *off* means no automatic observation (reads only on request); low / medium / high run a fixed slot schedule of 2 / 4 / 6 rounds per day. At runtime it screenshots the foreground window first, and the AI decides which local files or directories to read based on the current window (whole-machine read-only, with credential paths, secret paths, and the app data root still blocked). The host validates every read item by item, never writes, and keeps sourced understanding separate from user facts.
- **Long-term memory**: eligible trusted user sources are committed automatically after batch validation; right-click your own message in chat and choose *Remember this*, or simply say "remember …". The *Memory* settings page lets you inspect source quotes and version history, toggle core-profile marks, correct and forget items (invalidating stale memory projections in flight), continue or preview curation jobs, and back up/restore. Curation runs on an idle policy with a persistent budget by default, and can also be triggered manually from settings.
- **Proactive companionship**: under *AI → Proactive*, choose a *Proactive message tier* (off / low / medium / high, roughly 1–2 / 2–4 / 4–8 messages per day) and quiet hours (optional; she stays silent in that window). When enabled she follows up on sourced items, explicit agreements, seasonal moments, light topics, and limited show-and-tell — all bounded by busy state, unreplied-message tiers, and a daily budget. Humanized delivery and silent understanding are independent switches; agreements still run when silent understanding is off. Send `/behavior clear` in chat to erase the derived observation profile. See [Proactive companionship](docs/current/proactive.md) for runtime boundaries.

### Tools & extensions

- **Built-in tools**: file read/write, Bash, system info, screenshots, clipboard, planning and sub-agents.
- **Skills**: loaded on demand, never occupying resident context.
- **MCP**: servers are borrowed at runtime per use (stdio or Streamable HTTP); disabled servers are never connected and don't take a process; no MCP connection at startup.
- All execution is bounded by a unified permission policy and the Rust security baseline.

### Desktop & platform

- **One-key summon & dismiss**: a custom hotkey (Settings → General → Shortcuts; at least one modifier) brings her up or puts her away anytime. On summon, focus lands directly in the input box; on dismiss, focus returns to the app you were using — no mouse required, and you can still ask her to look things up or run errands. Summon position supports follow-cursor and fixed-position modes.
- Transparent always-on-top window, five-layer character rendering, tray, and sound effects.
- Single-instance guard: one host per data root; a duplicate launch exits with a clear message.
- In-app auto-update: checks once about 30 seconds after launch (or manually via Settings → General), then downloads, verifies, restarts, and installs after your confirmation.

## Footprint & performance

Measured on packaged builds per platform; only two resident processes: the Rust host and the single Node harness (not resident while MCP is unused).

| Platform · state | Memory (private accounting) | CPU |
|---|---|---|
| macOS (arm64) · dismissed (idle) | host ≈ 91 MB (≈ 11 MB active private, the rest compressed on demand by the system) + bundled Node ≈ 36 MB | ≈ 0.2% |
| macOS (arm64) · open | host ≈ 91 MB (≈ 11 MB active private, the rest compressed on demand by the system) + bundled Node ≈ 36 MB | ≈ 1.4% |
| Windows · dismissed / open | to be measured | to be measured |

## Architecture

The app runs as two processes: **`crates/native-host` — the native Rust host** (the only resident process; owns UI, observation, and execution) and **`src/` — the single Node process** (business and model side), talking over a private IPC channel. The UI is drawn natively — no WebView.

### Project layout

```text
Desk-Pet/
├── crates/native-host/            Native host (Rust): windows · rendering · observation · execution · updates
│   └── src/
│       ├── ui/                    Main window · settings · layer editor · tray · themes
│       ├── render/                Five-layer character stage (CALayer / Layered Window)
│       ├── monitor/ window/       Foreground window · lock screen · screenshot observation
│       ├── memory/ proactive/     Long-term memory and proactive chain (same SQLite DB, opened lazily)
│       ├── commands/              Tool execution: Bash pool · files · screenshots · MCP process bridge
│       ├── host/ ipc/             NativeDispatcher · Node supervisor · private channel
│       └── paths/ update/         Paths and security baseline · in-app updates
├── src/
│   ├── harness/main.ts            The single Node entry (bootstrap)
│   └── services/                  Business layer (TypeScript, on bundled Node 22.22.3)
│       ├── engine/                Pi agent turns · session JSONL · context compaction
│       ├── context/               Layered prompt building and shared budgets · tool-output projection
│       ├── tool/ safety/ skill/   Tool routing · permission policy · skill catalog
│       ├── agent/memory/          Memory recall · source collection · dreaming curation
│       ├── proactive/             Opportunities · agreements · budgets · delivery receipts
│       ├── native-ui/             Projection frame assembly · host request handling
│       └── personality/ reply/    Cards · interaction variables · reply metadata
├── resources/defaults/            Factory resources: character cards · themes · font assets
├── packaging/                     Packaging config and locked bundled Node version
├── scripts/                       Dev and verification scripts: dev launch · versioning · packaging
├── test/                          Three-layer tests · contracts · benchmarks (rules in test/AGENTS.md)
└── docs/                          Design and engineering docs (index in docs/INDEX.md)
```

Per-directory module maps, state ownership, and full call chains live in the [system map](docs/current/system-design.md).

### Dependencies

- **Zero external runtime dependencies**: Node 22.22.3 ships in the bundle and the UI is drawn natively; MCP servers are borrowed on demand and never connected or resident while disabled.
- **The only network egress is the model service**: OpenAI-compatible endpoints (DeepSeek by default; OpenAI / Ollama / LM Studio etc. also work). Provider calls are funneled through one point, `engine/harness/model-gateway.ts`.
- **The only cross-process channel is private IPC** (macOS Unix socket / Windows named pipe): Node → host commands (`HostCommandMap`, one-to-one with the Rust `NativeDispatcher`), host → Node requests (`HostRequestMap` with `host_request_result` receipts), and events (`HostEventMap`); oversized fields automatically travel as binary blob frames. The business layer never touches windows directly, and the host never touches the model directly.

## Download & install

Grab the file for your platform from [Releases](https://github.com/V1rtual-Klavte/Desk-Pet/releases/latest)
(the other files on the page are for auto-update; manual installs don't need them):

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `v1rtual-desk-pet_x.y.z_aarch64.dmg` | Open and drag the app into *Applications*. Intel Macs are not supported yet |
| Windows (installer) | `v1rtual-desk-pet_x.y.z_x64-setup.exe` | Double-click to install |

> **The first launch will be blocked by the system** — the current installers are **not code-signed or notarized**:
> - If macOS says the app "is damaged and can't be opened", drag the app into *Applications* and run
>   `xattr -dr com.apple.quarantine /Applications/v1rtual-desk-pet.app`, then open it again.
> - If Windows SmartScreen warns you, click *More info → Run anyway*.

Factory defaults are provided; you only need to configure an API key.

Once installed you don't need to chase versions manually: the app checks for updates about
30 seconds after launch, and you can also check manually under Settings → General →
*Check for updates*. After you confirm once, the app downloads, verifies, restarts, and
installs automatically (installation is finished by a standalone helper after exit — no manual
steps at any point); installers and temporary files are cleaned up on the first launch of the
new version.
Note: the updater fetches release files from GitHub — if GitHub is not directly reachable on
your network, make sure a proxy is enabled.

## Run from source

The download above is the packaged build; the same code also runs from source, and the two are equivalent.

The installer has no extra runtime dependencies (Node ships in the bundle; the UI is natively drawn). Building from source additionally needs:

- Node.js 22 (dev toolchain only; `build:harness` targets Node 22)
- Rust toolchain
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ build tools

The pnpm version is pinned by `packageManager` in [package.json](package.json).

```bash
git clone https://github.com/V1rtual-Klavte/Desk-Pet.git
cd Desk-Pet
pnpm install

# Create a local config (first-time development; do not overwrite if it already exists)
cp CONFIG-DEV.yaml.example CONFIG-DEV.yaml

pnpm dev
```

`pnpm dev` has two steps: it stages bundled resources into `packaging/dist/` (fetching the
[locked Node version](packaging/node-runtime.json) from nodejs.org with SHA-256 verification,
skipped when already current; then builds the harness artifact and links default resources as
the seed), and then cargo-builds and launches `target/debug/native-host`. The debug data root
is `data/desk-pet/`.

Edit `CONFIG-DEV.yaml` to fill in your model service and key. DeepSeek is the default; OpenAI,
Ollama, LM Studio, and other OpenAI-compatible endpoints are supported.

Window observation on macOS requires *System Settings → Privacy & Security → Accessibility*;
screenshots require the system's Screen Recording permission, and fall back to window
information when unavailable.

## Usage

On first launch, pick a Card, Profile, and AI model in the settings window (General / AI /
Memory / Tools / Appearance), and configure humanized delivery, silent access, MCP servers,
and skills as needed. Type `/help` in the chat box to see all commands: `/skill` invokes a
skill, `/compact` compacts the current session's context.

With memory enabled, chat draws on user facts and the committed conversation transcript —
current and cross-session. Her past words keep their role and time provenance, so you can ask
"what was that thing you recommended last time?". Closing a session tab keeps its history;
only deleting a session removes the transcript. Her past words are never saved as user facts.
Factory defaults are provided; you only need to configure an API key.

You can keep sending messages while a reply is being generated — choose *Interject* to process
after the current response or *Continue later* to let the task finish naturally; queued
messages can be withdrawn one by one.

## Common commands

| Command | Description |
|---|---|
| `pnpm dev` | Full dev environment: stage bundled resources → debug build → launch the native host |
| `pnpm run dev:prepare` | Stage bundled resources only (bundled Node / harness / default resources; idempotent) |
| Local packaging | See the [workflow docs](.github/workflows/README.md), "verifying packaging locally"; official artifacts are built by release.yml on tags |
| `pnpm run test:types` | TypeScript type check and Rust compile check |
| `pnpm run test:rust` | Rust unit tests |
| `pnpm run check:contract-hashes` | Seconds-long contract source check; shared by CI and E2E preflight |
| `pnpm run test:e2e -- --module <module>` | Run E2E scenes for one module |
| `pnpm run test:memory-quality` | Real memory-quality collection, judged after independent review |
| `pnpm run test:memory-bench:prepare` | Install external memory-benchmark data (locked revision → chosen directory; datasets never enter the repo) |
| `pnpm run test:memory-bench` | External memory-benchmark observation run (LongMemEval / LoCoMo / MemoryBank, not in CI) |
| `pnpm run test:memory-bench:<tier>` | Tiered observation runs: `smoke` / `regression` / `zh` / `difficulty` / `external`; `regression` is the daily default — see [benchmark README](test/memory-bench/README.md) §8 |
| `pnpm run test:memory-performance` | Release-storage and debug-IPC performance benchmarks |
| `pnpm run test:trace-review -- <ideal> <trace> <manifest> <review>` | Evidence gate for AI review of user-authored ideal traces |
| `pnpm run test:release` | Release gate: types and compile + discipline scan + Rust unit tests + L2/L3 + full E2E with strict contracts and 3 trials |

## Testing

Type and compile checks do not prove runtime behavior. L4 end-to-end runs against the real
native host and the single Node process (bundled Node, never a browser), exercising the real
service layer, Rust IPC, and the full session/tool/persistence chain, with an isolated data
root and either a real provider or a deterministic fake. The release gate enforces strict
contract validation and three repeated trials; skipped and timed-out scenes never count as
passed. See the [test README](test/README.md) for command details and scene conventions.

[CI](.github/workflows/ci.yml) runs compile checks, Rust unit tests, and the L2 / L3 fast
layers on macOS and Windows (through a retrying entry point, plus the test-discipline scan and
the FLAKY ratchet); it does not run L4 end-to-end.

## Data & configuration

Development data lives in `data/desk-pet/`; production data lives in the app-specific
directory (macOS `~/Library/Application Support/com.v1rtual.deskpet`, Windows
`%LOCALAPPDATA%\com.v1rtual.deskpet`) — neither is distributed with the repo. Before changing
`.gitignore` or committing local config, make sure no keys or user data come along.

**Where data lives**: **on Windows it defaults to the pet's own folder —
`<install dir>\userdata\`** — sessions, memory, settings, and the default-resource copy all
land there, never on the system drive (it follows the install drive; when installed to a
read-only location the app logs this and falls back to the system directory). macOS uses the
conventional `~/Library/Application Support/com.v1rtual.deskpet` (the `.app` lives in
`/Applications`, which regular users can't write to); for a portable setup, put an empty
`portable.txt` **next to** the `.app` and data moves to a sibling `userdata/`.

**Uninstall** is separate from user data: the uninstaller asks whether to delete data and
**keeps it by default** (sessions and memory can't be regenerated); if kept, the data stays in
that `userdata\` (or the macOS system directory) and a reinstall picks it up. Upgrades and
reinstalls never ask and never delete data.

**macOS uninstall**: there is no uninstaller on Mac — drag `v1rtual-desk-pet.app` to the Trash.
**Data does not follow**: to clean everything, delete
`~/Library/Application Support/com.v1rtual.deskpet` as well. If you used portable mode from
the start (data in the sibling `userdata/`), deleting the folder containing the `.app` clears
it too.

## Documentation

- [Documentation index](docs/INDEX.md): the full table of contents and task-based navigation
- [Product design](docs/DES.md): gameplay, interactions, and user-visible behavior
- [System map](docs/current/system-design.md): module locations, main call chains, and state ownership
- [Engineering reference](docs/current/development.md): logging, errors, IPC, and build troubleshooting
- [Development constraints](AGENTS.md): code, documentation, and commit conventions

## License

[MIT](LICENSE)
