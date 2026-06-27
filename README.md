# 🤖 VibeVibes - Coding projects at AI speed!

An automated pipeline that uses **Ollama + LLMs** to continuously generate, scaffold, and publish full-stack projects to GitHub — complete with implementation whitepapers.

## How It Works

The script runs in an infinite loop, each iteration executing 5 steps:

```
┌─────────────────────────────────────────────────────┐
│  🔁  while (true)                                   │
│                                                     │
│  1. 🧠  Generate project name & concept  (small LLM) │
│  2. 📄  Write implementation whitepaper  (large LLM) │
│  3. 📁  Create ~/Code/<project-name>/ folder         │
│  4. 🚀  Scaffold project with opencode   (large LLM) │
│  5. 🐙  Publish to GitHub via git CLI                │
│                                                     │
│  ─── then repeat ───                                │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

- **Node.js** v18+ (ESM)
- **Ollama** running locally (or on your network)
- **Git** installed and configured
- **GitHub personal access token** (with `repo`, `user`, and `org` scopes if using an org)

## Setup

### 1. Clone or copy the files

```bash
git clone <this-repo> && cd vibevibes
npm install
```

### 2. Configure `.env`

Copy the example and edit:

```bash
cp .env.example .env
```

| Variable | Description | Example |
|----------|-------------|---------|
| `OLLAMA_HOST` | Ollama server URL | `http://100.118.11.83:11434` |
| `SMALL_MODEL` | Model for name/concept generation | `gpt-oss:20b-cloud` |
| `LARGE_MODEL` | Model for whitepaper + opencode scaffolding | `deepseek-v4-flash:cloud` |
| `GITHUB_USER` | GitHub username (unused if `GITHUB_ORG` is set) | `myuser` |
| `GITHUB_ORG` | GitHub organization to publish under | `MyOrg` |
| `GITHUB_TOKEN` | GitHub personal access token | `ghp_...` |
| `PROMPT_PREFIX` | Seed idea the AI builds upon | `A modern web application written in NodeJS that` |

### 3. Run

```bash
./generate-project.js
```

The script will loop forever, generating one project after another. Press `Ctrl+C` to stop.

## What Gets Generated

### Per project

| Artifact | Location |
|----------|----------|
| 📄 **Implementation Whitepaper** | `~/Documents/<project-name>-whitepaper.md` |
| 📁 **Project folder** | `~/Code/<project-name>/` |
| 🐙 **GitHub repository** | `https://github.com/<org>/<project-name>` |

### Whitepaper sections

The large model produces a 10-section blueprint:

1. Executive Summary
2. System Architecture (with ASCII diagram)
3. Core Features (P0/P1/P2 priority)
4. Data Model & Schema
5. API Design (endpoints, request/response shapes)
6. Frontend Architecture (component tree, state, routing)
7. Implementation Phases (MVP → v1 → v2)
8. Testing Strategy
9. Deployment & DevOps
10. Future Roadmap

## How It Uses Models

| Step | Model | Purpose |
|------|-------|---------|
| Name & concept | `SMALL_MODEL` | Creative brainstorming — fast, cheap inference |
| Whitepaper | `LARGE_MODEL` | Deep architectural reasoning — needs more capacity |
| opencode scaffold | `LARGE_MODEL` | Code generation — needs strong coding ability |

The Ollama official npm library (`ollama.generate()`) is used for steps 1–2. The opencode step shells out to `ollama launch opencode` directly.

## GitHub Publishing

The script:

1. Creates a **new repository** on GitHub via the REST API (single `curl` call)
2. Initializes git in the project folder
3. Stages all files (`git add .`)
4. Commits (`git commit -m "Initial commit: <ProjectName>"`)
5. Pushes to `main` branch
6. **Cleans up** the remote URL to remove the embedded token

> **Note:** If `GITHUB_TOKEN` is not set, the publish step is skipped and you can push manually.

## Project Structure

```
vibevibes/
├── .env.example      # Configuration template
├── generate-project.js  # The main script
├── package.json      # ESM + ollama dependency
└── README.md         # This file
```

## Customization

- **Change the seed idea** — edit `PROMPT_PREFIX` in `.env`
- **Use different models** — swap `SMALL_MODEL` / `LARGE_MODEL` in `.env`
- **Adjust whitepaper structure** — edit the prompt in `step2GenerateWhitepaper()`
- **Change output directories** — modify `homedir()` paths in the step functions

## License

MIT
