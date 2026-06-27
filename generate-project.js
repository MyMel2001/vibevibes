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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
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
const GITHUB_USER = env.GITHUB_USER || '';
const GITHUB_ORG = env.GITHUB_ORG || '';
const GITHUB_TOKEN = env.GITHUB_TOKEN || '';
const PROMPT_PREFIX = env.PROMPT_PREFIX || 'A modern web application that';

// ─── Ollama client ──────────────────────────────────────────────────────────

const ollama = new Ollama({ host: OLLAMA_HOST });

async function generate(model, prompt) {
  console.log(`\n🤖 Querying model "${model}"...`);
  const response = await ollama.generate({
    model,
    prompt,
    options: { temperature: 0.7 },
  });
  return response.response.trim();
}

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

// ─── Step 1: Generate project name & concept ──────────���─────────────────────

async function step1GenerateConcept() {
  console.log('\n' + '='.repeat(60));
  console.log('📋 STEP 1: Generating project name & concept');
  console.log('='.repeat(60));

  const prompt = `You are a creative product strategist. Based on the following seed idea, come up with a unique, catchy project name (one or two words, no existing well-known names) and a one-paragraph concept description.

Seed idea: ${PROMPT_PREFIX}

Respond in this exact format:
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

  const response = await generate(LARGE_MODEL, prompt);

  const docPath = join(homedir(), 'Documents', `${slugify(projectName)}-whitepaper.md`);
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
  } else {
    mkdirSync(projectPath, { recursive: true });
    console.log(`✅ Created project folder: ${projectPath}`);
  }

  return { folderName, projectPath };
}

// ─── Step 4: Run opencode to scaffold project ───────────────────────────────

async function step4RunOpencode(projectName, concept, projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 STEP 4: Running opencode to scaffold project');
  console.log('='.repeat(60));

  const prompt = `Create project with these specs: ${concept}`;

  const cmd = `cd "${projectPath}" && OLLAMA_HOST="${OLLAMA_HOST}" ollama launch opencode --model "${LARGE_MODEL}" -- --prompt="${prompt}. IMPORTANT: Make sure the project is 100% complete and includes all features and a README. No placeholder/incomplete functions are allowed."`;

  console.log(`\nRunning in: ${projectPath}`);
  console.log(`Command: ${cmd}`);

  run(cmd);
  console.log(`\n✅ opencode completed in: ${projectPath}`);
}

// ─── Step 5: Publish to GitHub via git CLI ──────────────────────────────────

async function step5PublishToGitHub(projectName, projectPath) {
  console.log('\n' + '='.repeat(60));
  console.log('🐙 STEP 5: Publishing to GitHub via git CLI');
  console.log('='.repeat(60));

  const repoName = slugify(projectName);

  if (!GITHUB_TOKEN) {
    console.warn('⚠️  GITHUB_TOKEN not set in .env — skipping GitHub publish.');
    console.warn('   Set GITHUB_TOKEN in .env and run git init + push manually.');
    return;
  }

  const owner = GITHUB_ORG || GITHUB_USER;
  if (!owner) {
    console.warn('⚠️  Neither GITHUB_USER nor GITHUB_ORG set in .env — skipping GitHub publish.');
    return;
  }

  // Create repo on GitHub via API (curl — the only curl call, for repo creation)
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

  const result = execSync(
    `curl -s -X POST "${apiUrl}" \
      -H "Authorization: token ${GITHUB_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '${body.replace(/'/g, "'\\''")}'`,
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );

  const parsed = JSON.parse(result);
  if (parsed.errors) {
    console.error(`❌ GitHub API error: ${parsed.errors.map(e => e.message).join(', ')}`);
    console.error('   Full response:', JSON.stringify(parsed, null, 2));
    return;
  }

  const repoUrl = parsed.clone_url || `https://github.com/${owner}/${repoName}.git`;
  const repoHtmlUrl = parsed.html_url || `https://github.com/${owner}/${repoName}`;
  console.log(`✅ GitHub repository created: ${repoHtmlUrl}`);

  // Configure git remote with token embedded for auth, then push
  console.log('\n📦 Initializing git and pushing...');

  const authUrl = `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${owner}/${repoName}.git`;

  const commands = [
    `cd "${projectPath}"`,
    'git init',
    'git add .',
    `git commit -m "Initial commit: ${projectName}"`,
    `git remote add origin ${authUrl}`,
    'git branch -M main',
    'git push -u origin main',
  ];

  for (const cmd of commands) {
    try {
      run(cmd, { cwd: projectPath });
    } catch (err) {
      console.error(`⚠️  Command failed: ${cmd}`);
      console.error(`   ${err.message}`);
    }
  }

  // Update remote to not expose token in plain text
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
    const { folderName, projectPath } = await step3CreateProjectFolder(projectName);
    await step4RunOpencode(projectName, concept, projectPath);
    await step5PublishToGitHub(projectName, projectPath);

    console.log('\n' + '✅'.repeat(30));
    console.log(`\n🎉 ALL DONE!`);
    console.log(`   📄 Whitepaper: ${whitepaperPath}`);
    console.log(`   📁 Project:    ${projectPath}`);
    console.log(`   🐙 Repo name:  ${folderName}`);
    console.log('\n');
    console.log("📁 Moving on to next project...")
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
