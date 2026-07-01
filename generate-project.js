#!/usr/bin/env node

/**
 * AI Project Generator
 *
 * Uses Ollama official npm library + git CLI to:
 * 1. Generate a project name & concept (small model)
 * 2. Generate a detailed implementation whitepaper (large model)
 * 3. Save whitepaper to ~/Documents
 * 4. Create project folder in ~/Code/<project-name>
 * 5. Run opencode to scaffold the project
 * 6. Publish to GitHub via git CLI
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
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
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const envPath = join(__dirname, '.env');
const env = loadEnv(envPath);

const OLLAMA_HOST = env.OLLAMA_HOST || 'http://localhost:11434';
const SMALL_MODEL = env.SMALL_MODEL || 'llama3.2:3b';
const LARGE_MODEL = env.LARGE_MODEL || 'qwen2.5-coder:14b';
const MEDIUM_MODEL = env.MEDIUM_MODEL || env.LARGE_MODEL || 'qwen2.5-coder:14b';
const GITHUB_ORG = env.GITHUB_ORG || '';
const GITHUB_USER = env.GITHUB_USER || env.GITHUB_ORG || '';
const GITHUB_TOKEN = env.GITHUB_TOKEN || '';
const PROMPT_PREFIX = env.PROMPT_PREFIX || 'A modern web application that';

// ─── Ollama client ──────────────────────────────────────────────────────────

const ollama = new Ollama({ host: OLLAMA_HOST });

const REQUEST_TIMEOUT = 900000; // 15 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY = 10000; // 10 seconds

async function generateWithRetry(model, prompt, retries = MAX_RETRIES) {
  console.log(`\n🤖 Querying model "${model}"...`);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const response = await ollama.generate({
        model,
        prompt,
        options: { temperature: 0.7 },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.response.trim();
    } catch (err) {
      const isLastAttempt = attempt === retries;
      const isTimeout = err.name === 'AbortError' || err.code === 'UND_ERR_HEADERS_TIMEOUT';

      if (isTimeout) {
        console.warn(`⏰ Request timed out after ${REQUEST_TIMEOUT / 1000}s (attempt ${attempt}/${retries})`);
      } else {
        console.warn(`⚠️ Request failed: ${err.message} (attempt ${attempt}/${retries})`);
      }

      if (isLastAttempt) {
        console.error(`❌ All ${retries} attempts failed for model "${model}"`);
        throw err;
      }

      const delay = RETRY_DELAY * attempt;
      console.log(`🔄 Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const generate = generateWithRetry;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf-8', stdio: 'inherit', ...opts });
}

function runSilent(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
}

/**
 * Handles executing an opencode agent execution reliably using native spawn.
 * Streams stdout/stderr directly to the designated log file.
 */
function runOpencodeAgent({ prompt, model, projectPath, logFileName }) {
  return new Promise((resolve, reject) => {
    const logPath = join(projectPath, logFileName);
    const logStream = createWriteStream(logPath, { flags: 'a' });
    
    console.log(`\n⏳ Launching opencode agent... (Logs tracking at: ${logPath})`);

    const args = [
      'launch', 'opencode',
      '--model', model,
      '--',
      '--agent', 'build', '--auto', '--prompt', prompt
    ];

    const child = spawn(`OLLAMA_HOST=${OLLAMA_HOST} ollama`, args, {
      cwd: projectPath,
      env: { ...process.env, OLLAMA_HOST },
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stdout.write(`\r⏳ opencode still running... (${elapsed}s elapsed)`);
    }, 5000);

    child.on('close', (code) => {
      clearInterval(interval);
      console.log('');
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`opencode process exited with bad error code: ${code}`));
      }
    });

    child.on('error', (err) => {
      clearInterval(interval);
      reject(err);
    });
  });
}

// ─── Step 1: Generate project name & concept ──────────────────────────────────

async function step1GenerateConcept() {
  console.log('\n' + '='.repeat(60));
  console.log('📋 STEP 1: Generating project name & concept');
  console.log('='.repeat(60));

  const prompt = `You are a creative product strategist. Based on the following seed idea, come up with a unique, catchy project name (one or two words, no existing well-known names) and a one-paragraph concept description. Make sure the project name and concept are original and aren't repetative or redundant (i.e. don't spam "Node" this or "Flux" that in names - use names relevant yet catchy and unique.).

Seed idea: ${PROMPT_PREFIX}

Respond in this VERY EXACT format (NO QUOTES):
PROJECT_NAME: <name>
CONCEPT: <one-paragraph description>`;

  const response = await generate(SMALL_MODEL, prompt);

  const nameMatch = response.match(/PROJECT_NAME:\s*(.+)/i);
  const conceptMatch = response.match(/CONCEPT:\s*(.+)/is);

  if (!nameMatch) {
    console.error('❌ Could not parse project name from response:', response);
    process.exit(1);
  }

  const projectName = nameMatch[1].trim();
  const concept = conceptMatch ? conceptMatch[1].trim() : response;

  console.log(`\n✅ Project Name: ${projectName}`);
  console.log(`📝 Concept: ${concept}`);

  return { projectName, concept };
}

// ─── Step 2: Generate whitepaper ────────────────────────────────────────────

async function step2GenerateWhitepaper(projectName, concept) {
  console.log('\n' + '='.repeat(60));
  console.log('📄 STEP 2: Generating implementation whitepaper');
  console.log('='.repeat(60));

  const docDir = join(homedir(), 'Documents');
  const docPath = join(docDir, `${slugify(projectName)}-whitepaper.md`);
  mkdirSync(docDir, { recursive: true });
  
  if (existsSync(docPath)) {
    console.log(`⚠️  Whitepaper already exists: ${docPath}`);
    return null; // Return null instead of recursing main()
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
  writeFileSync(docPath, `# ${projectName} — Implementation Blueprint\n\n## Concept\n\n${concept}\n\n---\n\n${response}`, 'utf-8');
  console.log(`\n✅ Whitepaper saved to: ${docPath}`);
  return docPath;
}

// ─── Step 3: Create project folder ──────────────────────────────────────────

async function step3CreateProjectFolder(projectName) {
  console.log('\n' + '='.repeat(60));
  console.log('📁 STEP 3: Creating project folder');
  console.log('='.repeat(60));

  const folderName = slugify(projectName);
  const projectPath = join(homedir(), 'Code', folderName);

  if (existsSync(projectPath)) {
    console.log(`⚠️  Project folder already exists: ${projectPath}`);
    return null; // Return null instead of recursing main()
  }
  
  mkdirSync(projectPath, { recursive: true });
  console.log(`✅ Created project folder: ${projectPath}`);

  return { folderName, projectPath };
}

// ─── Step 4: Run opencode to scaffold project ───────────────────────────────

async function step4RunOpencode(projectName, concept, projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STEP 4: Running opencode to scaffold project');
  console.log('='.repeat(60));

  const prompt = `Create project with these specs: ${concept}. IMPORTANT: Make sure the project is 100% complete and includes all features, a .gitignore, and a README. No placeholder/incomplete functions are allowed. Be sure example .env file is named ".env.example"! Make sure everything is complete and functional, test the code at the end, and if it doesn't work fix it, test it again, and do this over and over until it works. Make sure the code is 100% feature complete, completing all project phases (ignore any timelines, etc. I just want this done.)`;

  try {
    await runOpencodeAgent({
      prompt,
      model: LARGE_MODEL,
      projectPath,
      logFileName: 'opencode.log'
    });
    console.log(`\n✅ opencode code creation completed in: ${projectPath}`);
  } catch (err) {
    console.error(`\n❌ Step 4 execution encountered errors: ${err.message}`);
    process.exit(1);
  }
}

async function step45DebugOpencode(projectName, projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STEP 4.5: Running opencode to debug project');
  console.log('='.repeat(60));

  const prompt = 'Please fix all bugs and issues in this project. Do not skip any!';

  try {
    await runOpencodeAgent({
      prompt,
      model: MEDIUM_MODEL,
      projectPath,
      logFileName: 'opencode-debug.log'
    });
    console.log(`\n✅ opencode debug completed in: ${projectPath}`);
  } catch (err) {
    console.error(`\n⚠️  Step 4.5 debugging met errors: ${err.message}`);
  }
}

// ─── Step 5: Publish to GitHub via git CLI ──────────────────────────────────

async function curlGitHubWithRetry(apiUrl, body, maxRetries = 3) {
  const escapedBody = body.replace(/'/g, "'\\''");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = execSync(
        `curl -s -X POST "${apiUrl}" \
          -H "Authorization: token ${GITHUB_TOKEN}" \
          -H "Content-Type: application/json" \
          -d '${escapedBody}'`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      const parsed = JSON.parse(result);

      if (parsed.errors) {
        const messages = parsed.errors.map(e => e.message).join(', ');
        console.error(`❌ GitHub API error: ${messages}`);
        return null;
      }

      if (parsed.message && parsed.message.toLowerCase().includes('rate limit')) {
        const isLast = attempt === maxRetries;
        console.warn(`⚠️  Rate limited by GitHub API (attempt ${attempt}/${maxRetries})`);
        if (isLast) return null;
        const delay = Math.min(60000 * attempt, 120000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      return parsed;
    } catch (err) {
      const isLast = attempt === maxRetries;
      if (isLast) return null;
      const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return null;
}

async function step5PublishToGitHub(projectName, projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🐙 STEP 5: Publishing to GitHub via git CLI');
  console.log('='.repeat(60));

  const repoName = slugify(projectName);

  if (!GITHUB_TOKEN) {
    console.warn('⚠️  GITHUB_TOKEN not set in .env — skipping GitHub publish.');
    return;
  }

  const owner = GITHUB_ORG || GITHUB_USER;
  if (!owner) {
    console.warn('⚠️  Neither GITHUB_USER nor GITHUB_ORG set in .env — skipping GitHub publish.');
    return;
  }

  const apiUrl = GITHUB_ORG
    ? `https://api.github.com/orgs/${owner}/repos`
    : `https://api.github.com/user/repos`;

  const body = JSON.stringify({
    name: repoName,
    description: `AI-generated project: ${projectName}`,
    private: false,
    auto_init: false,
  });

  console.log(`\n📡 Creating GitHub repository "${owner}/${repoName}"...`);

  const parsed = await curlGitHubWithRetry(apiUrl, body);
  if (!parsed) {
    console.error('❌ Failed to create GitHub repository. Skipping publish.');
    return;
  }

  const repoHtmlUrl = parsed.html_url || `https://github.com/${owner}/${repoName}`;
  console.log(`✅ GitHub repository created: ${repoHtmlUrl}`);

  console.log('\n📦 Initializing git and pushing...');
  const authUrl = `https://${owner}:${GITHUB_TOKEN}@github.com/${owner}/${repoName}.git`;

  let hasUserConfig = false;
  try {
    const name = runSilent('git config user.name', { cwd: projectPath });
    const email = runSilent('git config user.email', { cwd: projectPath });
    hasUserConfig = !!(name && email);
  } catch {
    hasUserConfig = false;
  }

  const commands = [
    'git init',
    'git add .',
  ];

  if (!hasUserConfig) {
    commands.push(
      'git config user.name "AI Project Generator"',
      'git config user.email "ai@project-generator.local"',
    );
  }

  commands.push(
    `git commit -m "Initial commit: ${projectName}"`,
    `git remote add origin ${authUrl} 2>/dev/null; git remote set-url origin ${authUrl}`,
    'git branch -M main',
    'git push -u origin main',
  );

  for (const cmd of commands) {
    try {
      run(cmd, { cwd: projectPath });
    } catch (err) {
      console.error(`⚠️  Command failed: ${cmd}`);
    }
  }

  try {
    run(`git remote set-url origin https://github.com/${owner}/${repoName}.git`, { cwd: projectPath });
    console.log('🔒 Cleaned up remote URL (removed token)');
  } catch (_) {}

  console.log(`\n✅ Published to GitHub: ${repoHtmlUrl}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '█'.repeat(60));
  console.log('█   🤖 AI PROJECT GENERATOR');
  console.log('█'.repeat(60));
  console.log(`\n📌 Small model: ${SMALL_MODEL}`);
  console.log(`📌 Large model: ${LARGE_MODEL}`);
  console.log(`📌 Ollama host: ${OLLAMA_HOST}`);
  console.log(`📌 Seed idea: ${PROMPT_PREFIX}`);
  
  while (true) {
    const { projectName, concept } = await step1GenerateConcept();
    
    const whitepaperPath = await step2GenerateWhitepaper(projectName, concept);
    if (whitepaperPath === null) {
      console.log('🔄 Restarting loop to generate a fresh concept...');
      continue; // Cleanly loops back to step 1
    }
    
    const projectFolderData = await step3CreateProjectFolder(projectName);
    if (projectFolderData === null) {
      console.log('🔄 Restarting loop to generate a fresh concept...');
      continue; // Cleanly loops back to step 1
    }
    
    const { projectPath } = projectFolderData;
    await step4RunOpencode(projectName, concept, projectPath);
    await step45DebugOpencode(projectName, projectPath);
    await step5PublishToGitHub(projectName, projectPath);
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});