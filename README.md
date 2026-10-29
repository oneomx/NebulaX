<div align="center">

# NebulaX

**The AI terminal workstation for ops engineers.**

Multi-protocol terminal meets a local-first AI copilot —
diagnose, audit, and automate your servers without your data ever leaving your machine.

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blue)
![Tests](https://img.shields.io/badge/tests-139%20passed-brightgreen)
[![License](https://img.shields.io/badge/license-Source%20Available-lightgrey)](./LICENSE)

*A modern alternative to Xshell & MobaXterm, supercharged with AI.*

</div>

---

## Highlights

- **🖥 Multi-protocol terminal** — SSH, Telnet, local shells, Serial (with live plotting), RDP & VNC in one unified workspace
- **⚡ Power-user terminal** — split panes (2/4), synchronized input broadcast, macros, regex search, session restore
- **🤖 AI ops copilot (local-first)** — chat-to-command, error explanation, diagnostic agent — your context stays on your machine, only your chosen model API is called
- **🔍 Security auditing** — deterministic local rule engine (low false-positives, whitelists, evidence verification) + AI semantic analysis
- **📈 Predictive patrol** — scheduled metric collection, threshold alerts, trend forecasting with early warnings, auto-generated diagnostic reports
- **🗄 Database diagnostics** — read-only MySQL/PostgreSQL health checks with AI-powered optimization advice
- **📦 85 built-in runbooks** — built-in ops knowledge base with RAG retrieval, injected into AI context automatically
- **🔒 Security by design** — system-level credential vault (DPAPI), SSH host-key TOFU verification, jump hosts & SOCKS5 tunnels
- **📂 SFTP** — drag & drop uploads, resumable transfers, transfer queue
- **🔑 Offline licensing** — machine-bound activation codes, fully offline verification, 14-day full-featured trial

## Screenshots

<div align="center">

<!-- Replace with real screenshots: put files into screenshots/ and uncomment -->
<!--

![Terminal](screenshots/terminal.png)
*Split-pane SSH sessions with AI panel*

![AI Assistant](screenshots/ai-panel.png)
*Natural-language diagnostics with server context*

![Security Audit](screenshots/audit.png)
*Rule-engine driven security audit*

-->

*(Screenshots coming soon)*

</div>

## Quick Start

### Users

Download `NebulaX Setup x.y.z.exe` from [Releases](../../releases), install, and go.
First launch starts a **14-day full-featured trial** — no account required.

### Developers

```bash
git clone <this-repo>
cd NebulaX
npm install

npm run dev        # development mode (Vite + Electron hot reload)
npm run build      # build renderer + main process
npm test           # run 139 core-module tests

npx electron-builder --win   # produce installer into release/
```

Requirements: **Node.js 20+**, Windows 10/11 x64.

## How the AI works

NebulaX's AI never gets a blank prompt — every request is packed with **local context**:

| Capability | What it does |
|---|---|
| Terminal assistant | Natural language → commands, with live server info & command history |
| Diagnostic agent | Plans read-only diagnostic steps, analyzes results, exports reports |
| Security audit | Local rules first (deterministic scoring), AI adds semantic findings with verbatim evidence |
| Predictive patrol | Collects metrics on a schedule, forecasts trends, alerts before thresholds break |
| Database diagnosis | Read-only collection + rule analysis for MySQL/PG, AI explains & optimizes |
| Performance tuning | Read-only sysctl/ulimit/netstat collection with actionable suggestions — **never changes settings automatically** |
| Script generation | One-click bash/PowerShell scripts from natural language |
| Knowledge base | 85 built-in runbooks retrieved via RAG and injected into every diagnosis |

Supported providers: DeepSeek · OpenAI · Anthropic · Zhipu · Moonshot · Qwen · Ollama (fully local) · any OpenAI-compatible endpoint.

## Architecture

```
NebulaX
├── Renderer   React 18 · Zustand · Tailwind CSS · xterm.js
│              split panes · modals · AI panels
└── Main       TypeScript / Node
    ├── ssh/telnet/serial sessions   unified event channels
    ├── ai/                          audit · diagnosis · patrol · RAG · routing
    ├── license.ts                   offline HMAC verification
    └── vault.ts                     DPAPI-encrypted credential storage
```

## Roadmap

See [NebulaX-产品迭代路线图.md](./NebulaX-产品迭代路线图.md) for the full product roadmap:
auto-updater, i18n, code signing, bundle-size optimization, and more.

## Contributing

Issues and discussions are welcome. Since this is a **source-available commercial product**,
external pull requests are not accepted at this time — but bug reports and feature requests
via Issues help a lot. Please **do not open issues requesting activation-code bypasses**;
they will be closed immediately.

## License

Source code is published for **reference and evaluation** under the terms in [LICENSE](./LICENSE).

© 2026 NebulaX. All rights reserved. Commercial use, redistribution, or derivative
commercial products require explicit written permission from the author.

---

<div align="center">
Made for operators who live in the terminal.
</div>
