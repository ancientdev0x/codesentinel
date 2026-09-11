# Helps you ship faster 🚢

Shippie is an extendable code-review agent. It runs an agent loop that reads your diff, explores the codebase with real developer tools, and posts focused review comments — picking up issues a human reviewer would, such as:

- Exposed secrets
- Slow or inefficient code
- Potential bugs or unhandled edge cases

Shippie can also act as a Model Context Protocol (MCP) client to reach external tools like browser automation, observability and documentation.

## Demo

https://github.com/user-attachments/assets/code-review-gpt-3.mp4

## Ethos 💭

- **A prebuilt review workflow, not a bespoke CLI** — the agent loop runs on flue + pi.
- **Runs anywhere**: Node, Cloudflare, GitHub Actions, GitLab CI.
- **Functions as a human code reviewer**, using flue's built-in tools instead of a hand-rolled tool registry.
- **Provider-agnostic**: Anthropic, OpenAI, OpenRouter, and Cloudflare Workers AI out of the box.
- **Acts as an MCP client** for integration with external tools.

---

## Quick start 🚀

### GitHub Action

Run `npx shippie init` to scaffold the workflow below, then add your provider API key as a repo secret. Or add it manually — it needs a full checkout (`fetch-depth: 0`), PR write permissions, and a provider API key.

```yaml
# .github/workflows/shippie.yml
name: Shippie

on:
  pull_request:

permissions:
  pull-requests: write
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: mattzcarey/shippie@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

See [Action Options](docs/action-options.md) for all inputs (`MODEL`, `THINKING_LEVEL`, `IGNORE`, `CUSTOM_INSTRUCTIONS`, `MCP_SERVERS`, and the provider keys).

### Local

Run the review workflow locally with no server. Local mode reviews your staged changes (`git diff --cached`) and writes results to `.shippie/review/local_*.md`:

```bash
npx shippie review
```

### Run on demand with `/shippie`

Comment `/shippie review` on a pull request to run shippie on demand — either via a GitHub Actions workflow (no server) or a deployed webhook channel. See [Run Shippie on demand](docs/tag-shippie.md).

---

## Setup Instructions 💫

See the [setup instructions](docs/setup.md) for more docs on how to set up shippie in your CI/CD pipeline and run it locally.

### Additional Documentation

- [Setup](docs/setup.md) - Get shippie running in CI and locally
- [AI Provider Configuration](docs/ai-provider-config.md) - Configure Anthropic, OpenAI, OpenRouter, and Cloudflare Workers AI
- [Action Options](docs/action-options.md) - GitHub Action configuration options
- [Model Context Protocol (MCP)](docs/mcp.md) - Give shippie access to external tools
- [Rules Files](docs/rules-files.md) - Inject project context via AGENTS.md / CLAUDE.md and Agent Skills
- [Subagent Tool](docs/subagent-tool.md) - Delegate work to flue subagents with the task tool
- [On-demand /shippie](docs/tag-shippie.md) - Run shippie by commenting /shippie (Actions or webhook)

---

## Development 🔧

This repo targets Node >= 22.19 with npm.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/mattzcarey/shippie.git
   cd shippie
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up your API key:**
   - Copy `.env.example` to `.env`.
   - Set the provider key you want to use, e.g. `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`).

4. **Run the review workflow:**
   ```bash
   npm run review
   ```

5. **Useful commands:**
   - `npm run dev` — run flue in dev mode
   - `npm run build` — build a publishable Node server to `dist/server.mjs` (run it with `npm run start`, then `POST /workflows/review?wait=result`)
   - `npm run check` — lint with oxlint + check formatting with oxfmt
   - `npm run check:types` — typecheck with tsc
   - `npm test` — run tests

See `package.json` for the full list of scripts.
