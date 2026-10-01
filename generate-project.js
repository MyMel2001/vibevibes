#!/usr/bin/env node

/**
 * AI Project Generator
 *
 * Uses the Ollama official npm library + OpenCode + git CLI to:
 * 1. Generate a project name & concept (small model)
 * 2. Generate a detailed implementation whitepaper (medium model)
 * 3. Save the whitepaper to ~/Documents
 * 4. Create the project folder in ~/Code/<project-name>
 * 5. Run OpenCode to scaffold the project
 * 6. Run OpenCode again to debug/fix the project
 * 7. Publish to GitHub via the GitHub API + git CLI
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
  chmodSync,
  unlinkSync,
  readdirSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { Ollama } from 'ollama';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Load .env ───────────────────────────────────────────────────────────────

function loadEnv(filepath) {
  const env = {};

  if (!existsSync(filepath)) {
    console.error(`❌ .env file not found at: ${filepath}`);
    process.exit(1);
  }

  const content = readFileSync(filepath, 'utf-8');

  for (const line of content.split(/\r?\n/)) {
    let trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    // Support normal .env syntax and "export KEY=value".
    if (trimmed.startsWith('export ')) {
      trimmed = trimmed.slice(7).trim();
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

const envPath = join(__dirname, '.env');
const fileEnv = loadEnv(envPath);

// Environment variables supplied by the shell take precedence over .env.
const getEnv = (key, fallback = '') => process.env[key] ?? fileEnv[key] ?? fallback;

const OLLAMA_HOST = getEnv('OLLAMA_HOST', 'http://localhost:11434');
const SMALL_MODEL = getEnv('SMALL_MODEL', 'llama3.2:3b');
const LARGE_MODEL = getEnv('LARGE_MODEL', 'qwen2.5-coder:14b');
const MEDIUM_MODEL = getEnv('MEDIUM_MODEL', LARGE_MODEL);
const GITHUB_ORG = getEnv('GITHUB_ORG');
const GITHUB_USER = getEnv('GITHUB_USER', GITHUB_ORG);
const GITHUB_TOKEN = getEnv('GITHUB_TOKEN');
const PROMPT_PREFIX = getEnv('PROMPT_PREFIX', 'A modern web application that');

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT = Math.max(60000, Number.parseInt(getEnv('REQUEST_TIMEOUT_MS', '1800000'), 10) || 1800000); // 30 minutes by default
const MAX_RETRIES = 3;
const RETRY_DELAY = 10000; // 10 seconds
const OPENCODE_TIMEOUT = 12000000; // 200 minutes
const OPENCODE_TERM_GRACE = 10000; // 10 seconds

class OutputCollisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputCollisionError';
  }
}

// ─── Ollama client ──────────────────────────────────────────────────────────

const ollama = new Ollama({ host: OLLAMA_HOST });

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function generateWithRetry(model, prompt, retries = MAX_RETRIES) {
  console.log(`\n🤖 Querying model "${model}"...`);

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let timeoutId = null;
    let timedOut = false;

    try {
      // Use Ollama streaming for long generations. Non-streaming requests can
      // spend several minutes waiting for the first response headers when a
      // large/slow model is loaded, which can surface as the vague
      // `TypeError: fetch failed`. Streaming starts the HTTP response early
      // and lets us receive tokens as they are generated.
      const stream = await ollama.generate({
        model,
        prompt,
        stream: true,
        options: { temperature: 0.7 },
      });

      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          ollama.abort();
        } catch {
          // Ignore abort cleanup errors; the iterator will report the failure.
        }
      }, REQUEST_TIMEOUT);

      let output = '';

      for await (const chunk of stream) {
        if (typeof chunk?.response === 'string') {
          output += chunk.response;
        }
      }

      const text = output.trim();

      if (timedOut) {
        const error = new Error(
          `Request timed out after ${REQUEST_TIMEOUT / 1000}s for model "${model}".`
        );
        error.name = 'AbortError';
        throw error;
      }

      if (!text) {
        throw new Error(`Model "${model}" returned an empty response.`);
      }

      return text;
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt === retries;
      const isTimeout =
        timedOut ||
        err?.name === 'AbortError' ||
        err?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT';

      const cause = err?.cause;
      const causeText = cause
        ? ` | cause: ${cause.code || cause.name || 'unknown'}${cause.message ? ` — ${cause.message}` : ''}`
        : '';

      if (isTimeout) {
        console.warn(
          `⏰ Request timed out after ${REQUEST_TIMEOUT / 1000}s ` +
          `(attempt ${attempt}/${retries})`
        );
      } else {
        console.warn(
          `⚠️ Request failed: ${err?.message || String(err)}${causeText} ` +
          `(attempt ${attempt}/${retries})`
        );
      }

      if (isLastAttempt) {
        console.error(`❌ All ${retries} attempts failed for model "${model}"`);
        throw lastError;
      }

      const delay = RETRY_DELAY * attempt;
      console.log(`🔄 Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error(`Generation failed for model "${model}".`);
}

const generate = generateWithRetry;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug;
}

function cleanProjectName(value) {
  return String(value ?? '')
    .replace(/^[`"'*#\s]+|[`"'*#\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function run(command, args = [], opts = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`.trim());

  return execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: 'inherit',
    ...opts,
  });
}

function runSilent(command, args = [], opts = {}) {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
  });

  return result.status === 0;
}

function assertPrerequisites() {
  for (const command of ['ollama', 'git']) {
    if (!commandExists(command)) {
      throw new Error(`Required command "${command}" was not found in PATH.`);
    }
  }
}

/**
 * Run OpenCode non-interactively and wait for the actual child process.
 *
 * This avoids:
 * - shell quoting/injection problems
 * - fragile "nohup ... & echo $!" PID tracking
 * - incorrectly treating a still-running child as finished
 * - huge prompts being embedded directly in a shell command
 */
function runOpenCode({
  model,
  prompt,
  projectPath,
  logPath,
  label = 'opencode',
  timeout = OPENCODE_TIMEOUT,
  allowFailure = false,
}) {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 Starting ${label} with model "${model}"...`);
    console.log(`   Working directory: ${projectPath}`);
    console.log(`   Log file: ${logPath}`);

    const log = createWriteStream(logPath, { flags: 'w' });

    let settled = false;
    let timedOut = false;
    let timeoutId;
    let killTimer;

    const childEnv = {
      ...process.env,
      OLLAMA_HOST,
    };

    // Current OpenCode supports `run` for non-interactive scripted work,
    // and `--agent build` selects the build agent.
    const args = [
      'launch',
      'opencode',
      '--model',
      model,
      '--',
      'run',
      '--agent',
      'build',
      prompt,
    ];

    const child = spawn('ollama', args, {
      cwd: projectPath,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;

      clearTimeout(timeoutId);
      clearTimeout(killTimer);

      child.stdout.unpipe(log);
      child.stderr.unpipe(log);
      log.end();

      callback(value);
    };

    child.once('error', (err) => {
      finish(reject, err);
    });

    child.once('close', (code, signal) => {
      const result = {
        code,
        signal,
        timedOut,
      };

      if (timedOut) {
        const error = new Error(`${label} timed out after ${timeout / 1000}s.`);
        error.exitCode = code;
        error.signal = signal;

        if (allowFailure) {
          console.warn(`⚠️ ${error.message} Continuing because this pass is recoverable.`);
          finish(resolve, result);
        } else {
          finish(reject, error);
        }
        return;
      }

      if (code === 0) {
        finish(resolve, result);
        return;
      }

      const error = new Error(
        `${label} exited with code ${code ?? 'unknown'}` +
        (signal ? ` (signal ${signal})` : '')
      );
      error.exitCode = code;
      error.signal = signal;

      if (allowFailure) {
        console.warn(`⚠️ ${error.message} Continuing because this pass is recoverable.`);
        finish(resolve, result);
      } else {
        finish(reject, error);
      }
    });

    timeoutId = setTimeout(() => {
      if (settled) return;

      timedOut = true;

      console.warn(
        `\n⚠️ ${label} exceeded ${timeout / 1000}s — terminating it...`
      );

      child.kill('SIGTERM');

      killTimer = setTimeout(() => {
        if (!settled) {
          console.warn(`🔪 ${label} did not terminate after SIGTERM; forcing exit.`);
          child.kill('SIGKILL');
        }
      }, OPENCODE_TERM_GRACE);
    }, timeout);
  });
}

// ─── Step 1: Generate project name & concept ─────────────────────────────────

async function step1GenerateConcept() {
  console.log('\n' + '='.repeat(60));
  console.log('📋 STEP 1: Generating project name & concept');
  console.log('='.repeat(60));

  const prompt = `You are a creative product strategist. Based on the following seed idea, come up with a unique, catchy project name (one or two words, no existing well-known names) and a one-paragraph concept description. Make sure the project name and concept are original and aren't repetitive or redundant (i.e. don't spam "Node" this or "Flux" that in names - use names relevant yet catchy and unique).

Seed idea: ${PROMPT_PREFIX}

Respond in this VERY EXACT format (NO QUOTES):
PROJECT_NAME: <name>
CONCEPT: <one-paragraph description>`;

  const response = await generate(SMALL_MODEL, prompt);

  const nameMatch = response.match(
    /(?:^|\n)\s*PROJECT_NAME\s*:\s*(.+?)(?:\r?\n|$)/i
  );
  const conceptMatch = response.match(
    /(?:^|\n)\s*CONCEPT\s*:\s*([\s\S]*)/i
  );

  if (!nameMatch) {
    throw new Error(
      `Could not parse project name from model response:\n\n${response}`
    );
  }

  const projectName = cleanProjectName(nameMatch[1]);
  const concept = conceptMatch
    ? conceptMatch[1].trim()
    : response.trim();

  if (!projectName) {
    throw new Error('The model returned an empty project name.');
  }

  if (!concept) {
    throw new Error('The model returned an empty concept.');
  }

  const folderName = slugify(projectName);

  if (!folderName) {
    throw new Error(
      `Project name "${projectName}" produced an invalid folder/repository name.`
    );
  }

  console.log(`\n✅ Project Name: ${projectName}`);
  console.log(`📝 Concept: ${concept}`);

  return { projectName, concept, folderName };
}

// ─── Step 2: Generate whitepaper ────────────────────────────────────────────

async function step2GenerateWhitepaper(projectName, concept, folderName) {
  console.log('\n' + '='.repeat(60));
  console.log('📄 STEP 2: Generating implementation whitepaper');
  console.log('='.repeat(60));

  const docDir = join(homedir(), 'Documents');
  const docPath = join(docDir, `${folderName}-whitepaper.md`);

  mkdirSync(docDir, { recursive: true });

  if (existsSync(docPath)) {
    throw new OutputCollisionError(`Whitepaper already exists: ${docPath}`);
  }

  const prompt = `You are a senior software architect writing a detailed implementation blueprint/whitepaper.

Project Name: ${projectName}
Concept: ${concept}

Write a comprehensive, professional implementation whitepaper covering:

1. **Executive Summary** — high-level vision and goals
2. **System Architecture** — tech stack recommendations, architecture diagram description (ASCII), component breakdown
3. **Core Features** — detailed feature list with priority (P0/P1/P2)
4. **Data Model** — key entities, relationships, database schema outline
5. **API Design** — RESTful or GraphQL endpoints, request/response shapes
6. **Frontend Architecture** — component tree, state management, routing
7. **Implementation Phases** — phased rollout plan (Phase 1: MVP, Phase 2: v1, Phase 3: v2)
8. **Testing Strategy** — unit, integration, e2e
9. **Deployment & DevOps** — CI/CD, hosting, monitoring
10. **Future Roadmap** — post-v2 ideas

Format this as a proper markdown document with headings, code blocks, and tables where appropriate. Be thorough and specific — this is a real implementation blueprint.`;

  const response = await generate(MEDIUM_MODEL, prompt);

  const fullWhitepaper = [
    `# ${projectName} — Implementation Blueprint`,
    '',
    '## Concept',
    '',
    concept,
    '',
    '---',
    '',
    response,
    '',
  ].join('\n');

  writeFileSync(docPath, fullWhitepaper, 'utf-8');

  console.log(`\n✅ Whitepaper saved to: ${docPath}`);

  return {
    docPath,
    whitepaperContent: response,
  };
}

// ─── Step 3: Create project folder ──────────────────────────────────────────

function getProjectPath(folderName) {
  return join(homedir(), 'Code', folderName);
}

function assertOutputSlotsAvailable(folderName) {
  const projectPath = getProjectPath(folderName);
  const docPath = join(homedir(), 'Documents', `${folderName}-whitepaper.md`);

  if (existsSync(projectPath)) {
    throw new OutputCollisionError(`Project folder already exists: ${projectPath}`);
  }

  if (existsSync(docPath)) {
    throw new OutputCollisionError(`Whitepaper already exists: ${docPath}`);
  }
}

function step3CreateProjectFolder(folderName) {
  console.log('\n' + '='.repeat(60));
  console.log('📁 STEP 3: Creating project folder');
  console.log('='.repeat(60));

  const projectPath = getProjectPath(folderName);

  if (existsSync(projectPath)) {
    throw new OutputCollisionError(`Project folder already exists: ${projectPath}`);
  }

  mkdirSync(projectPath, { recursive: true });
  console.log(`✅ Created project folder: ${projectPath}`);

  return projectPath;
}

// ─── Step 4: Run OpenCode to scaffold project ────────────────────────────────

async function step4RunOpencode(projectName, concept, whitepaperContent, projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STEP 4: Running OpenCode to scaffold project');
  console.log('='.repeat(60));

  // Put the blueprint inside the project temporarily so OpenCode can read it
  // without hitting shell quoting or OS command-line-length limits.
  const blueprintPath = join(projectPath, '.project-blueprint.md');
  const gitignorePath = join(projectPath, '.gitignore');

  const blueprint = [
    `# ${projectName} — Private Implementation Blueprint`,
    '',
    `## Concept`,
    '',
    concept,
    '',
    '---',
    '',
    whitepaperContent,
    '',
  ].join('\n');

  writeFileSync(blueprintPath, blueprint, 'utf-8');

  // Ensure the temporary blueprint and generated logs are never published.
  writeFileSync(
    gitignorePath,
    [
      '# AI Project Generator temporary files',
      '.project-blueprint.md',
      'opencode.log',
      'opencode-debug.log',
      '',
    ].join('\n'),
    'utf-8'
  );

  const prompt = `Create this project completely and make it functional.

First, read .project-blueprint.md for the full private implementation blueprint.

Requirements:
- Implement all requested features; do not leave placeholders, TODO-only functions, mock implementations, or unfinished sections.
- Include a useful README.md.
- Include a .gitignore appropriate for the project.
- If environment configuration is needed, provide .env.example (not .env).
- Run the project's relevant tests, checks, build, or lint commands before finishing.
- If anything fails, diagnose it, fix it, and run the checks again.
- Keep iterating until the project is in a working state.
- Do not delete the blueprint until you are finished using it.`;

  try {
    await runOpenCode({
      model: LARGE_MODEL,
      prompt,
      projectPath,
      logPath: join(projectPath, 'opencode.log'),
      label: 'opencode scaffold',
      allowFailure: true,
    });
  } finally {
    // Keep the blueprint available for the debug pass; it is already ignored.
  }

  console.log(`\n✅ OpenCode scaffolding completed in: ${projectPath}`);
}

// ─── Step 4.5: Run OpenCode to debug project ────────────────────────────────

async function step45DebugOpencode(projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STEP 4.5: Running OpenCode to debug project');
  console.log('='.repeat(60));

  const prompt = `Thoroughly inspect this project and fix all bugs and issues you can find. Do not skip any.

Read .project-blueprint.md first so you understand the intended functionality.

Then:
- Inspect the source code and configuration.
- Run the relevant tests, builds, linters, type checks, or other validation commands.
- Fix every concrete bug, broken feature, missing dependency, incorrect configuration, and obvious integration issue you encounter.
- Do not leave placeholder implementations.
- Re-run validation after each set of fixes.
- Keep iterating until the project is working as completely as practical.
- Ensure README.md and .env.example remain accurate.`;

  await runOpenCode({
    model: MEDIUM_MODEL,
    prompt,
    projectPath,
    logPath: join(projectPath, 'opencode-debug.log'),
    label: 'opencode debug',
  });

  console.log(`\n✅ OpenCode debug pass completed in: ${projectPath}`);
}

// ─── Step 5: Publish to GitHub via GitHub API + git CLI ──────────────────────

async function githubRequest(apiUrl, options, maxRetries = 3) {
  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js with global fetch support (Node 18+).');
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let response;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        response = await fetch(apiUrl, {
          ...options,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = err;

      const isTimeout =
        err?.name === 'AbortError' ||
        err?.code === 'UND_ERR_HEADERS_TIMEOUT';

      if (isTimeout) {
        console.warn(
          `⏰ GitHub request timed out (attempt ${attempt}/${maxRetries})`
        );
      } else {
        console.warn(
          `⚠️ GitHub request failed: ${err?.message || String(err)} ` +
          `(attempt ${attempt}/${maxRetries})`
        );
      }

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = Math.min(5000 * 2 ** (attempt - 1), 60000);
      console.log(`🔄 Retrying in ${delay / 1000}s...`);
      await sleep(delay);
      continue;
    }

    const rawBody = await response.text();

    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }

    if (response.ok) {
      return body;
    }

    const message =
      body?.message ||
      body?.errors?.map(error => error?.message).filter(Boolean).join(', ') ||
      rawBody.slice(0, 500) ||
      `HTTP ${response.status}`;

    const retryable =
      response.status === 429 ||
      response.status >= 500;

    // Do not retry permanent API errors such as bad credentials,
    // insufficient permissions, validation failures, or an existing repo.
    if (!retryable) {
      throw new Error(`GitHub API ${response.status}: ${message}`);
    }

    if (attempt === maxRetries) {
      throw new Error(
        `GitHub API ${response.status}: ${message} ` +
        `(after ${maxRetries} attempts)`
      );
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(5000 * 2 ** (attempt - 1), 60000);

    console.warn(
      `⚠️ GitHub API request failed: ${message} ` +
      `(attempt ${attempt}/${maxRetries})`
    );
    console.log(`🔄 Retrying in ${delay / 1000}s...`);
    await sleep(delay);
  }

  throw lastError || new Error('GitHub API request failed.');
}

function writeAskPassHelper(filePath) {
  // The token stays in the environment instead of appearing in the remote URL,
  // command line, or .git/config.
  const helper = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "\${GIT_AUTH_USER:-x-access-token}" ;;
  *assword*) printf '%s\\n' "\${GIT_AUTH_TOKEN}" ;;
esac
`;

  writeFileSync(filePath, helper, 'utf-8');
  chmodSync(filePath, 0o700);
}

function removeFileIfExists(filepath) {
  try {
    unlinkSync(filepath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️ Could not remove ${filepath}: ${err.message}`);
    }
  }
}

async function step5PublishToGitHub(projectName, projectPath, folderName) {
  console.log('\n' + '='.repeat(60));
  console.log('🐙 STEP 5: Publishing to GitHub');
  console.log('='.repeat(60));

  if (!GITHUB_TOKEN) {
    console.warn('⚠️ GITHUB_TOKEN not set in .env — skipping GitHub publish.');
    return null;
  }

  const owner = GITHUB_ORG || GITHUB_USER;

  if (!owner) {
    console.warn(
      '⚠️ Neither GITHUB_USER nor GITHUB_ORG is set in .env — skipping GitHub publish.'
    );
    return null;
  }

  const repoName = folderName;
  const apiUrl = GITHUB_ORG
    ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`
    : 'https://api.github.com/user/repos';

  const body = {
    name: repoName,
    description: `AI-generated project: ${projectName}`,
    private: false,
    auto_init: false,
  };

  console.log(`\n📡 Creating GitHub repository "${owner}/${repoName}"...`);

  const parsed = await githubRequest(apiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!parsed?.clone_url || !parsed?.html_url) {
    throw new Error(
      `GitHub returned an unexpected response while creating ${owner}/${repoName}.`
    );
  }

  const repoUrl = parsed.clone_url;
  const repoHtmlUrl = parsed.html_url;

  console.log(`✅ GitHub repository created: ${repoHtmlUrl}`);

  // Make sure the generated project has something to commit.
  // `git status` cannot be used until the repository has been initialized.
  const generatorOnlyFiles = new Set([
    '.project-blueprint.md',
    'opencode.log',
    'opencode-debug.log',
  ]);

  const projectEntries = readdirSync(projectPath, { withFileTypes: true })
    .filter(entry => entry.name !== '.git')
    .filter(entry => !generatorOnlyFiles.has(entry.name))
    .filter(entry => entry.name !== '.gitignore');

  if (projectEntries.length === 0) {
    throw new Error(
      'OpenCode produced no actual project files. Refusing to publish an empty project.'
    );
  }

  console.log('\n📦 Initializing git and pushing...');

  let hasUserConfig = false;

  try {
    const name = runSilent('git', ['config', 'user.name'], { cwd: projectPath });
    const email = runSilent('git', ['config', 'user.email'], { cwd: projectPath });
    hasUserConfig = Boolean(name && email);
  } catch {
    hasUserConfig = false;
  }

  run('git', ['init'], { cwd: projectPath });

  if (!hasUserConfig) {
    console.log('⚙️ Git user not configured — setting temporary local commit author.');
    run(
      'git',
      ['config', 'user.name', 'AI Project Generator'],
      { cwd: projectPath }
    );
    run(
      'git',
      ['config', 'user.email', 'ai@project-generator.local'],
      { cwd: projectPath }
    );
  }

  run('git', ['add', '--all'], { cwd: projectPath });

  let stagedOutput;
  try {
    stagedOutput = runSilent('git', ['diff', '--cached', '--name-only'], {
      cwd: projectPath,
    });
  } catch (err) {
    throw new Error(`Unable to inspect staged files: ${err.message}`);
  }

  if (!stagedOutput.trim()) {
    throw new Error('Nothing was staged for the initial commit.');
  }

  run(
    'git',
    ['commit', '-m', `Initial commit: ${projectName}`],
    { cwd: projectPath }
  );

  // Use a clean remote URL and a temporary GIT_ASKPASS helper so the token
  // is never stored in .git/config or exposed in the command line.
  try {
    run('git', ['remote', 'remove', 'origin'], {
      cwd: projectPath,
    });
  } catch {
    // Remote did not exist; that is fine.
  }

  run('git', ['remote', 'add', 'origin', repoUrl], {
    cwd: projectPath,
  });

  run('git', ['branch', '-M', 'main'], {
    cwd: projectPath,
  });

  const askPassPath = join(
    tmpdir(),
    `ai-project-generator-askpass-${process.pid}.sh`
  );

  writeAskPassHelper(askPassPath);

  try {
    const pushEnv = {
      ...process.env,
      GIT_AUTH_USER: GITHUB_USER || owner,
      GIT_AUTH_TOKEN: GITHUB_TOKEN,
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: '0',
    };

    run('git', ['push', '-u', 'origin', 'main'], {
      cwd: projectPath,
      env: pushEnv,
    });
  } finally {
    removeFileIfExists(askPassPath);
  }

  console.log(`\n✅ Published to GitHub: ${repoHtmlUrl}`);

  return repoHtmlUrl;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  assertPrerequisites();

  console.log('\n' + '█'.repeat(60));
  console.log('█   🤖 AI PROJECT GENERATOR');
  console.log('█'.repeat(60));

  console.log(`\n📌 Small model: ${SMALL_MODEL}`);
  console.log(`📌 Medium model: ${MEDIUM_MODEL}`);
  console.log(`📌 Large model: ${LARGE_MODEL}`);
  console.log(`📌 Ollama host: ${OLLAMA_HOST}`);
  console.log(`📌 Seed idea: ${PROMPT_PREFIX}`);

  while (true) {
    try {
      const {
        projectName,
        concept,
        folderName,
      } = await step1GenerateConcept();

      // Check both destinations before spending more inference time or
      // creating an orphaned whitepaper.
      assertOutputSlotsAvailable(folderName);

      const {
        docPath,
        whitepaperContent,
      } = await step2GenerateWhitepaper(
        projectName,
        concept,
        folderName
      );

      const projectPath = step3CreateProjectFolder(folderName);

      await step4RunOpencode(
        projectName,
        concept,
        whitepaperContent,
        projectPath
      );

      await step45DebugOpencode(projectPath);

      // The blueprint is only an agent working file; the canonical copy is
      // already saved under ~/Documents.
      removeFileIfExists(join(projectPath, '.project-blueprint.md'));

      const repoUrl = await step5PublishToGitHub(
        projectName,
        projectPath,
        folderName
      );

      console.log('\n' + '✅'.repeat(30));
      console.log('\n🎉 ALL DONE!');
      console.log(`   📄 Whitepaper: ${docPath}`);
      console.log(`   📁 Project:    ${projectPath}`);
      console.log(`   🐙 Repo:       ${repoUrl || '(GitHub publish skipped)'}`);
      console.log('\n📁 Moving on to next project...');
    } catch (err) {
      if (err instanceof OutputCollisionError) {
        console.warn(`\n⚠️ ${err.message}`);
        console.log('\n🔄 Destination already exists; generating a fresh project...\n');
        continue;
      }

      throw err;
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err?.stack || err?.message || err);
  process.exit(1);
});
