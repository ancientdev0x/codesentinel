# CodeSentinel 🚢

> **An extensible, AI-powered code review and QA agent built on [flue](https://github.com/withastro/flue).**

CodeSentinel runs autonomous agent workflows to review pull requests, identify bugs, test critical user flows via browser automation, and post actionable inline code suggestions directly to GitHub or your local terminal.

---

## ✨ Features

- 🔍 **Intelligent Code Review**: Analyzes git diffs, project guidelines (`AGENTS.md` / `CLAUDE.md`), and custom instructions to provide contextual, high-signal reviews.
- 💬 **Inline Suggestions**: Posts line-level code suggestions via GitHub review comments with ready-to-commit patches.
- 🧪 **Ambient QA & Flow Testing**: Discovers and runs automated browser tests using Chrome DevTools Protocol (CDP) to verify UI flows and report findings.
- 🔌 **Model Context Protocol (MCP)**: Connect remote HTTP/SSE MCP servers to equip CodeSentinel with custom tools and live external documentation.
- 🌐 **Multi-Model Provider Support**: First-class support for Anthropic (`claude-sonnet-4-6`), OpenAI (`gpt-4.1-mini`, `gpt-5`), OpenRouter, and Cloudflare Workers AI / AI Gateway.
- 💻 **Run Anywhere**: Use as a GitHub Action on Pull Requests, locally against staged files (`git diff --cached`), or as a standalone HTTP server.

---

## 🚀 Quickstart: GitHub Action

Add CodeSentinel to your repository in `.github/workflows/codesentinel.yml`:

```yaml
name: CodeSentinel Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Full history required for git diff

      - name: Run CodeSentinel
        uses: ancientdev0x/CodeSentinel@main
        with:
          MODEL: "anthropic/claude-sonnet-4-6"
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 💻 Local CLI Usage

You can review uncommitted or staged changes locally before opening a pull request.

### 1. Installation

Requires **Node.js >= 22.19.0**:

```bash
git clone https://github.com/ancientdev0x/CodeSentinel.git
cd CodeSentinel
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root directory:

```env
CodeSentinel_MODEL=anthropic/claude-sonnet-4-6
ANTHROPIC_API_KEY=your-anthropic-api-key
```

### 3. Run Review

Stage the files you want reviewed and execute:

```bash
git add .
npm run review
```

Review feedback and inline suggestions will be output to `.CodeSentinel/review/local_*.md`.

---

## ⚙️ Configuration & Inputs

### GitHub Action Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `MODEL` | `anthropic/claude-sonnet-4-6` | Model identifier in `provider/model` format |
| `REVIEW_LANGUAGE` | `English` | Language for review feedback |
| `THINKING_LEVEL` | `medium` | Reasoning effort: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `IGNORE` | — | Comma-separated glob patterns to exclude (e.g. `**/*.test.ts,dist/**`) |
| `CUSTOM_INSTRUCTIONS`| — | Custom prompt instructions appended to reviewer instructions |
| `MCP_SERVERS` | — | JSON string specifying remote MCP servers |
| `GITHUB_TOKEN` | — | **Required**. GitHub token for posting review comments |
| `ANTHROPIC_API_KEY` | — | API key for Anthropic models |
| `OPENAI_API_KEY` | — | API key for OpenAI models |
| `OPENROUTER_API_KEY` | — | API key for OpenRouter models |
| `CLOUDFLARE_API_KEY` | — | API token for Cloudflare Workers AI / AI Gateway |

### Model Providers

| Provider | Example Model Specifier | Required Credentials |
| :--- | :--- | :--- |
| **Anthropic** | `anthropic/claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `openai/gpt-4.1-mini`, `openai/gpt-5` | `OPENAI_API_KEY` |
| **OpenRouter** | `openrouter/anthropic/claude-3.7-sonnet` | `OPENROUTER_API_KEY` |
| **Cloudflare Workers AI** | `cloudflare-workers-ai/@cf/openai/gpt-oss-120b` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` |
| **Cloudflare AI Gateway** | `cloudflare-ai-gateway/<model>` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` |

---

## 🔌 Connecting MCP (Model Context Protocol)

Attach remote MCP servers over HTTP/SSE via the `MCP_SERVERS` input or `CodeSentinel_MCP_SERVERS` environment variable:

```yaml
- name: Run CodeSentinel with MCP
  uses: ancientdev0x/CodeSentinel@main
  with:
    MODEL: anthropic/claude-sonnet-4-6
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    MCP_SERVERS: |
      {
        "context7": {
          "url": "https://mcp.context7.ai/sse",
          "headers": {
            "Authorization": "Bearer ${{ secrets.CONTEXT7_API_KEY }}"
          }
        }
      }
```

---

## 🏗️ Repository Architecture

```
CodeSentinel/
├── action.yml               # Composite GitHub Action entrypoint
├── flue.config.ts           # Flue runtime configuration
├── src/
│   ├── agents/              # Flue agents (reviewer, QA lead, mentions)
│   ├── workflows/           # Orchestrated workflows (review, QA)
│   ├── tools/               # Agent tools (suggest_change, classify_finding, run_spec)
│   ├── review/              # Diff parsing, context building, filtering, prompt generation
│   ├── qa/                  # Ambient QA runner, flow catalogs, self-healing tests
│   ├── github/              # Octokit client and review reporting logic
│   └── mcp/                 # Model Context Protocol remote connection manager
├── tests/                   # Vitest unit and integration test suites
├── apps/                    # Web apps and Cloudflare server workers
└── docs/                    # In-depth architectural & user guides
```

---

## 🛠️ Development & Testing

```bash
# Install dependencies
npm install

# Run type check
npm run check:types

# Run linter and formatting check
npm run check

# Auto-fix linting and formatting
npm run check:fix

# Run tests
npm test

# Build production bundle
npm run build
```

---

## 📄 License

MIT License © 2026 [ancientdev0x](https://github.com/ancientdev0x).
