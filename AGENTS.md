# Agent & Contributor Guidelines 🤖

Welcome to **CodeSentinel**! This document provides instructions, architectural context, and development guidelines for AI agents and human contributors working within this repository.

---

## 🏛️ Architecture & Project Structure

CodeSentinel is built on the [`@flue/runtime`](https://github.com/withastro/flue) agent framework. It implements autonomous review, QA, and workflow execution capabilities.

### Directory Layout

```
CodeSentinel/
├── flue.config.ts                  # Flue runtime configuration (target: 'node')
├── action.yml                      # Composite GitHub Action for PR code reviews
├── qa/
│   └── action.yml                  # Composite GitHub Action for ambient QA
├── src/
│   ├── agents/                     # Agent definitions (createAgent)
│   │   ├── reviewer.ts             # PR code review agent with suggest_change tool
│   │   ├── qa-lead.ts              # Ambient QA test conductor and triage agent
│   │   └── mention.ts              # Mention handler agent (@shippie / @codesentinel)
│   ├── workflows/                  # Flue workflow definitions
│   │   ├── review.ts               # One-shot review workflow (POST /workflows/review)
│   │   └── qa.ts                   # Ambient QA execution workflow
│   ├── tools/                      # Agent tools (defineTool with Valibot schemas)
│   │   ├── suggest-change.ts       # Inline code suggestion tool
│   │   ├── classify-finding.ts     # QA finding categorization tool
│   │   ├── open-pull-request.ts    # Automated PR creation tool for test fixes
│   │   ├── run-spec.ts             # Test runner execution tool
│   │   └── catalog-flows.ts        # User journey / flow discovery tool
│   ├── review/                     # Review workflow internals
│   │   ├── config.ts               # Payload & environment configuration resolver
│   │   ├── diff.ts                 # Git diff fetching, parsing, and chunking
│   │   ├── context.ts              # PR context and metadata assembly
│   │   ├── instructions.ts         # Reviewer system instructions & AGENTS.md injector
│   │   ├── constants.ts            # Constants and defaults
│   │   ├── prompt/fileInfo.ts      # Per-file diff prompt formatting
│   │   └── utils/filterFiles.ts    # File filtering (ignore patterns, lockfiles, etc.)
│   ├── qa/                         # QA engine and flow execution
│   │   ├── config.ts               # QA configuration resolver
│   │   ├── driver.ts               # Browser automation driver
│   │   ├── exec.ts                 # Flow execution runner
│   │   ├── healer.ts               # Self-healing test logic
│   │   ├── pr-policy.ts            # QA pull-request gating policies
│   │   └── catalog.ts              # Journey catalog manager
│   ├── skills/                     # Built-in skills (e.g. chrome-cdp)
│   │   └── chrome-cdp/             # Chrome DevTools Protocol automation scripts
│   ├── github/                     # GitHub integration
│   │   └── reporter.ts             # Octokit reporter for comments & inline review suggestions
│   ├── mcp/                        # Model Context Protocol
│   │   └── connect.ts              # Remote MCP server connection manager (HTTP/SSE)
│   └── common/                     # Shared types and formatting
│       ├── types.ts                # Core TypeScript types
│       ├── models.ts               # Model registry and resolution
│       ├── telemetry.ts            # Telemetry reporting
│       └── formatting/summary.ts   # Review summary markdown builder
├── tests/                          # Vitest specs mirroring src/ structure
├── bin/                            # Executable CLI scripts
├── apps/                           # Sub-packages / apps (e.g., server, www)
└── docs/                           # Detailed documentation
```

---

## 🛠️ Build, Test, and Quality Commands

Always run these commands from the repository root:

- **Install dependencies**:
  ```bash
  npm install
  ```
  *(Requires Node.js >= 22.19.0)*

- **Linting & Formatting**:
  ```bash
  npm run check         # oxlint + oxfmt check
  npm run check:fix     # Auto-fix safe lint & format issues
  ```

- **Type Checking**:
  ```bash
  npm run check:types   # tsc --noEmit
  ```

- **Running Tests**:
  ```bash
  npm test              # vitest run (single pass)
  npm run test:watch    # vitest watch mode
  ```

- **Building Production Server**:
  ```bash
  npm run build         # flue build --target node -> dist/server.mjs
  ```

- **Local Execution**:
  ```bash
  npm run review        # Run code review locally against staged changes
  npm run qa            # Run QA workflow locally
  ```

---

## 📐 Coding Conventions & Standards

1. **Formatter & Linter**:
   - **oxfmt**: 2-space indentation, single quotes, trailing commas (ES5), semicolons as-needed, line width 90.
   - **oxlint**: Follow rules in `.oxlintrc.json` (`correctness` rules enabled).
2. **TypeScript & Modules**:
   - Strict TypeScript mode enabled; resolve unused variables and missing types without `@ts-ignore`.
   - Native ESM (`"type": "module"` in `package.json`).
3. **Tool Schemas**:
   - Use **Valibot** (`v.object(...)`) for all tool input validation schemas in `src/tools/`.
4. **Prompt & Context Injection**:
   - The reviewer dynamically loads project guidelines (`AGENTS.md` / `CLAUDE.md`) and passes them to the agent prompt. Keep prompt modifications concise and high-signal.

---

## 🤖 Models & MCP Configuration

- Models are specified as `provider/model` strings (e.g., `anthropic/claude-sonnet-4-6`, `openai/gpt-4.1-mini`, `cloudflare-workers-ai/@cf/openai/gpt-oss-120b`).
- Authentication keys are provided via standard environment variables:
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`
  - `OPENROUTER_API_KEY`
  - `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`
- MCP servers are connected dynamically via the `MCP_SERVERS` input or `CodeSentinel_MCP_SERVERS` environment variable (remote HTTP/SSE endpoints only).

---

## 🚦 Pre-Push Verification Checklist

Before committing or pushing any change:
1. Run `npm run check` (ensure no lint or formatting errors).
2. Run `npm run check:types` (ensure clean TypeScript compilation).
3. Run `npm test` (ensure all vitest specs pass).
4. Run `npm run build` (ensure successful server bundling).
5. Follow **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
