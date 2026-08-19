import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../utils/logger.js';
import { createToolPermissionCallback, getSafetyConfig } from './safety.js';
import type { AgentResult, AgentProgress, AgentStats } from '../../types/index.js';
import type { PRDetails } from '../git/github-api.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Claude Agent SDK Service
 *
 * This service replaces the legacy raw API approach with the full Agent SDK,
 * giving Claude real agentic capabilities:
 *
 * - READ files and explore codebase structure
 * - EDIT files surgically (not full replacement)
 * - RUN bash commands (npm test, npm build, etc.)
 * - SEARCH with glob and grep patterns
 * - ITERATE until tests pass or issues are resolved
 *
 * The Agent SDK handles the agentic loop internally - Claude can try things,
 * see results, and adjust its approach automatically.
 */

// Image data for passing to Claude (downloaded from Slack)
export interface DownloadedImage {
  filename: string;
  mimetype: string;
  base64: string;
}

export interface AgentSDKConfig {
  repoPath: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  maxDurationMs?: number;
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
  prContext?: PRDetails[];  // PR context for when user references specific PRs
  images?: DownloadedImage[];  // Screenshots/images from Slack
}

/**
 * Save downloaded images to temp directory for Claude Agent to read
 * Returns array of saved file paths
 */
async function saveImagesToTemp(images: DownloadedImage[]): Promise<string[]> {
  const tempDir = path.join(os.tmpdir(), 'claude-autofix-images');
  await fs.mkdir(tempDir, { recursive: true });

  const savedPaths: string[] = [];

  for (const image of images) {
    try {
      const filename = `${Date.now()}-${image.filename}`;
      const filepath = path.join(tempDir, filename);
      const buffer = Buffer.from(image.base64, 'base64');
      await fs.writeFile(filepath, buffer);
      savedPaths.push(filepath);
      logger.debug('Saved image to temp', { filepath, sizeKb: Math.round(buffer.length / 1024) });
    } catch (error) {
      logger.warn('Failed to save image to temp', {
        filename: image.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return savedPaths;
}

/**
 * Clean up temp images after processing
 */
async function cleanupTempImages(paths: string[]): Promise<void> {
  for (const filepath of paths) {
    try {
      await fs.unlink(filepath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Load documentation from the target repository dynamically
 * This reads CLAUDE.md and skill files from the repo at runtime
 */
async function loadRepoDocumentation(repoPath: string): Promise<{
  claudeMd: string;
  backendClaudeMd: string;
  frontendClaudeMd: string;
  skills: Map<string, string>;
}> {
  const result = {
    claudeMd: '',
    backendClaudeMd: '',
    frontendClaudeMd: '',
    skills: new Map<string, string>(),
  };

  // Load main CLAUDE.md files
  const claudeMdPath = path.join(repoPath, 'CLAUDE.md');
  const backendClaudeMdPath = path.join(repoPath, 'apps/backend/CLAUDE.md');
  const frontendClaudeMdPath = path.join(repoPath, 'apps/frontend/CLAUDE.md');

  try {
    result.claudeMd = await fs.readFile(claudeMdPath, 'utf-8');
    logger.debug('Loaded CLAUDE.md', { path: claudeMdPath, chars: result.claudeMd.length });
  } catch {
    logger.warn('Could not load CLAUDE.md', { path: claudeMdPath });
  }

  try {
    result.backendClaudeMd = await fs.readFile(backendClaudeMdPath, 'utf-8');
    logger.debug('Loaded backend CLAUDE.md', { path: backendClaudeMdPath, chars: result.backendClaudeMd.length });
  } catch {
    logger.warn('Could not load backend CLAUDE.md', { path: backendClaudeMdPath });
  }

  try {
    result.frontendClaudeMd = await fs.readFile(frontendClaudeMdPath, 'utf-8');
    logger.debug('Loaded frontend CLAUDE.md', { path: frontendClaudeMdPath, chars: result.frontendClaudeMd.length });
  } catch {
    logger.warn('Could not load frontend CLAUDE.md', { path: frontendClaudeMdPath });
  }

  // Load key skills from .claude/skills/
  const skillsDir = path.join(repoPath, '.claude/skills');
  const keySkills = [
    'create-commit/SKILL.md',
    'create-pr/SKILL.md',
    'create-pr/examples.md',
  ];

  for (const skillPath of keySkills) {
    const fullPath = path.join(skillsDir, skillPath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      result.skills.set(skillPath, content);
      logger.debug('Loaded skill', { skill: skillPath, chars: content.length });
    } catch {
      logger.warn('Could not load skill', { path: fullPath });
    }
  }

  return result;
}

/**
 * Build the system prompt for the agent
 *
 * This prompt instructs Claude to read the repo's documentation files
 * rather than duplicating the content here. Single source of truth!
 */
function buildSystemPrompt(): string {
  return `You are a senior software engineer fixing issues in a codebase.

## MANDATORY FIRST STEP - READ DOCUMENTATION

Before making ANY changes, you MUST read the codebase documentation files using the Read tool:

1. **ALWAYS READ FIRST**: Look for \`CLAUDE.md\` or \`README.md\` in repo root - architecture navigation and critical rules
2. **Check for sub-documentation**: Look for additional CLAUDE.md files in subdirectories for specific areas
3. **Follow existing conventions**: Read nearby files to understand patterns before making changes

**Documentation files are the SOURCE OF TRUTH for conventions. Follow them exactly.**

If the repo contains skills in \`.claude/skills/\`, read the relevant skill files for any task you're working on.

## UNDERSTANDING SLACK TEMPLATES

Team members use these templates to submit requests:

### 🐛 Bug Report Fields:
- **Title**: Brief bug description
- **Steps to Reproduce**: Numbered steps to recreate
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Severity**: Critical (app down), High (major feature broken), Medium (degraded), Low (cosmetic)
- **Related PR** (optional): #123 or full GitHub URL
- **Additional Context** (optional): Screenshots, error messages, console logs

### ✨ Feature Request Fields:
- **Title**: Brief feature description
- **Description**: What the feature should do
- **Acceptance Criteria**: Checkboxes that must be met
- **Related Files/Areas** (optional): Hints for implementation location
- **Related PR** (optional): #123 or full GitHub URL
- **Additional Context** (optional): Mockups, links, user stories

### How to Use Template Information:
1. **Severity** determines thoroughness - Critical bugs need extra verification
2. **Steps to Reproduce** are your debugging roadmap
3. **Acceptance Criteria** are your success checklist - ensure ALL are met
4. **Related Files** are starting points for investigation
5. **Related PR** context (if provided) contains crucial information

## CRITICAL TOOL USAGE RULES

**These rules prevent common errors that will cause your edits to fail:**

### Read Before Write (MANDATORY)
- **ALWAYS read a file with the Read tool BEFORE using Edit or Write on it**
- The Edit tool will FAIL with "File has not been read yet" if you skip this step
- Even if you think you know the file contents, READ IT FIRST
- This is NOT optional - it's a hard requirement of the tool system

### Edit Tool Best Practices
- **Use exact string matching** - The \`old_string\` must match the file EXACTLY (including whitespace and indentation)
- **Read the file immediately before editing** - File contents may have changed
- **Keep edits small and surgical** - Don't try to replace large blocks of code
- **If an edit fails, re-read the file** - The content you're trying to match may be different

### Write Tool Restrictions
- **Only use Write for NEW files** - Never use Write to modify existing files (use Edit instead)
- **Still requires Read first** - Even for new files in existing directories, read surrounding files to understand patterns

### Bash Tool Notes
- **IMPORTANT: This environment does NOT have node_modules installed** - You cannot run npm/bun/yarn commands for the target repo
- **Do NOT try to run lint, build, or test commands** - They will fail with "command not found"
- **Do NOT use \`gh\` CLI** - It's not installed
- **Always use full paths** - Don't rely on \`cd\` commands persisting between tool calls
- **Do NOT use git commands** - The system handles all git operations (commit, push, PR creation) automatically

## YOUR WORKFLOW

1. **READ DOCS** - Start by reading CLAUDE.md files (mandatory - use Read tool!)
2. **EXPLORE** - Use Glob/Grep to find relevant files
3. **INVESTIGATE** - Read files, trace code paths
4. **FIX** - Make surgical, minimal changes using the Edit tool
5. **VERIFY** - Review your changes carefully (lint/build unavailable in this environment)

**IMPORTANT:** Do NOT commit, push, or create PRs. The system handles all git operations automatically after you finish making changes.

## CRITICAL REMINDERS

### Tool Usage Mistakes (will cause failures)
- **NEVER Edit/Write a file without Reading it first** - This WILL fail
- **NEVER assume file contents** - Always read to get exact current state
- **NEVER use \`cd\` and expect it to persist** - Use full absolute paths
- **NEVER try to run npm/bun/yarn commands** - node_modules is not installed
- **NEVER use git commands** - The system handles git automatically

### Code Convention Mistakes (read CLAUDE.md files for full rules)
- Don't skip reading CLAUDE.md files - they contain critical project-specific rules
- Don't commit, push, or create PRs - the system does this automatically
- Don't add unnecessary comments or documentation
- Don't refactor unrelated code
- Don't modify .env files, credentials, or config/application.yml

## WHEN YOU'RE DONE

1. Summarize what you fixed and why
2. List the files you modified
3. Specify if changes were in backend, frontend, or both
4. If you couldn't fix the issue, explain what you tried and why it didn't work`;
}

/**
 * Format PR context into a readable string for Claude
 */
function formatPRContext(prDetails: PRDetails[]): string {
  if (prDetails.length === 0) return '';

  const sections: string[] = [];

  for (const pr of prDetails) {
    const prSection: string[] = [];
    prSection.push(`### PR #${pr.number}: ${pr.title}`);
    prSection.push(`- **State:** ${pr.state}`);
    prSection.push(`- **Author:** ${pr.author}`);
    prSection.push(`- **Branch:** \`${pr.branch}\` → \`${pr.baseBranch}\``);
    prSection.push(`- **URL:** ${pr.url}`);

    if (pr.body) {
      prSection.push(`\n**Description:**\n${pr.body.substring(0, 1000)}${pr.body.length > 1000 ? '...' : ''}`);
    }

    // Include files changed with their patches (limited to most important ones)
    if (pr.files.length > 0) {
      prSection.push(`\n**Files Changed (${pr.files.length}):**`);
      // Sort by changes (additions + deletions) and take top 10
      const sortedFiles = [...pr.files].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)).slice(0, 10);
      for (const file of sortedFiles) {
        prSection.push(`- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`);
        // Include patch if it's not too long
        if (file.patch && file.patch.length < 1500) {
          prSection.push('```diff');
          prSection.push(file.patch);
          prSection.push('```');
        }
      }
      if (pr.files.length > 10) {
        prSection.push(`... and ${pr.files.length - 10} more files`);
      }
    }

    // Include review comments
    if (pr.reviews.length > 0) {
      prSection.push(`\n**Reviews:**`);
      for (const review of pr.reviews.slice(0, 5)) {
        prSection.push(`- ${review.author} (${review.state}): ${review.body.substring(0, 200)}${review.body.length > 200 ? '...' : ''}`);
      }
    }

    // Include PR comments
    if (pr.comments.length > 0) {
      prSection.push(`\n**Comments:**`);
      for (const comment of pr.comments.slice(0, 5)) {
        prSection.push(`- ${comment.author}: ${comment.body.substring(0, 200)}${comment.body.length > 200 ? '...' : ''}`);
      }
    }

    sections.push(prSection.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Main function to analyze and fix an issue using the Agent SDK
 */
export async function analyzeAndFixWithAgentSDK(
  issueDescription: string,
  config: AgentSDKConfig
): Promise<AgentResult> {
  const safetyConfig = getSafetyConfig();
  const startTime = Date.now();

  const maxBudget = config.maxBudgetUsd ?? safetyConfig.maxBudgetUsd;
  const maxTurns = config.maxTurns ?? safetyConfig.maxTurns;

  logger.info('🤖 Starting Claude Agent SDK', {
    issue: issueDescription.substring(0, 100),
    repoPath: config.repoPath,
    maxBudget: `$${maxBudget}`,
    maxTurns,
    hasPRContext: (config.prContext?.length ?? 0) > 0,
    hasImages: (config.images?.length ?? 0) > 0,
  });

  // Track progress for Slack updates
  const progressEvents: AgentProgress[] = [];
  let currentPhase: AgentProgress['phase'] = 'exploring';
  let lastToolUsed: string | undefined;
  let filesModified: string[] = [];
  let commandsRun: string[] = [];

  // Track pending edits - file paths that Claude ATTEMPTED to edit
  // We'll only add them to filesModified if the tool_result doesn't have an error
  const pendingEdits: Map<string, string> = new Map();  // toolUseId -> filePath

  // Save images to temp files for Claude Agent to read
  let savedImagePaths: string[] = [];
  if (config.images && config.images.length > 0) {
    logger.info('📷 Saving images for Claude Agent', { count: config.images.length });
    savedImagePaths = await saveImagesToTemp(config.images);
  }

  try {
    // Build the prompt with optional PR context and images
    const prContextStr = config.prContext && config.prContext.length > 0
      ? `\n\n## Referenced Pull Request(s)\n\nThe user has referenced the following PR(s). Please review them carefully and address any concerns, issues, or requests mentioned:\n\n${formatPRContext(config.prContext)}`
      : '';

    // Build image context string - tell Claude to read the screenshots
    const imageContextStr = savedImagePaths.length > 0
      ? `\n\n## Screenshots/Images Attached\n\nThe user has attached ${savedImagePaths.length} screenshot(s) to help illustrate the issue. **IMPORTANT: You MUST use the Read tool to view these images before proceeding.** The screenshots may show UI bugs, error messages, or expected behavior.\n\nImage files to read:\n${savedImagePaths.map((p, i) => `${i + 1}. \`${p}\``).join('\n')}\n\nPlease read and analyze these images first to understand the visual context of the issue.`
      : '';

    const prompt = `## Issue to Fix

${issueDescription}${prContextStr}${imageContextStr}

## Instructions

Please analyze this issue and implement a fix. Follow your workflow:
${savedImagePaths.length > 0 ? '0. **FIRST: Read the attached screenshot(s) to understand the visual context**\n' : ''}1. Explore the codebase to understand the structure
2. Investigate the specific problem${config.prContext?.length ? ' (paying special attention to the referenced PR context above)' : ''}
3. Implement a surgical fix
4. Verify the fix works (run tests/build if available)

${savedImagePaths.length > 0 ? 'Start by reading the attached screenshot(s), then explore the codebase structure.' : 'Start by exploring the codebase structure.'}`;

    // Build additional directories list (temp image dir if images present)
    const additionalDirs: string[] = [];
    if (savedImagePaths.length > 0) {
      // Add the temp directory containing images so Claude can read them
      const tempImageDir = path.join(os.tmpdir(), 'claude-autofix-images');
      additionalDirs.push(tempImageDir);
    }

    // Create the query with Agent SDK
    const agentQuery = query({
      prompt,
      options: {
        cwd: config.repoPath,
        model: 'claude-sonnet-4-6',
        tools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'acceptEdits',
        maxBudgetUsd: maxBudget,
        maxTurns: maxTurns,
        canUseTool: createToolPermissionCallback(config.repoPath),
        systemPrompt: buildSystemPrompt(),
        additionalDirectories: additionalDirs.length > 0 ? additionalDirs : undefined,
      },
    });

    // Process the streaming response
    let finalResult: AgentResult | null = null;
    let totalCost = 0;
    let totalTurns = 0;
    let assistantMessages: string[] = [];

    for await (const message of agentQuery) {
      // Handle different message types
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            logger.debug('Agent session initialized', {
              sessionId: message.session_id,
            });

            // Report initial progress
            const initProgress: AgentProgress = {
              phase: 'exploring',
              message: 'Starting analysis...',
              timestamp: new Date(),
            };
            progressEvents.push(initProgress);
            await config.onProgress?.(initProgress);
          }
          break;

        case 'user':
          // Tool results come back as user messages
          const userContent = (message as any).message?.content;
          if (userContent && Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type === 'tool_result') {
                // Log tool results for debugging
                const resultContent = typeof block.content === 'string'
                  ? block.content.substring(0, 500)
                  : JSON.stringify(block.content).substring(0, 500);
                logger.debug('Tool result', {
                  toolUseId: block.tool_use_id,
                  isError: block.is_error,
                  content: resultContent,
                });

                // Check if this was a pending edit
                const pendingFilePath = pendingEdits.get(block.tool_use_id);
                if (pendingFilePath) {
                  if (block.is_error) {
                    // Edit failed - don't add to filesModified
                    logger.warn('Tool execution error (edit failed)', {
                      toolUseId: block.tool_use_id,
                      filePath: pendingFilePath,
                      error: resultContent,
                    });
                  } else {
                    // Edit succeeded - add to filesModified
                    if (!filesModified.includes(pendingFilePath)) {
                      filesModified.push(pendingFilePath);
                      logger.info('File successfully modified', {
                        toolUseId: block.tool_use_id,
                        filePath: pendingFilePath,
                      });
                    }
                  }
                  // Remove from pending map
                  pendingEdits.delete(block.tool_use_id);
                } else if (block.is_error) {
                  // Non-edit tool error
                  logger.warn('Tool execution error', {
                    toolUseId: block.tool_use_id,
                    error: resultContent,
                  });
                }
              }
            }
          }
          break;

        case 'assistant':
          // Claude is responding
          const content = message.message?.content;
          if (content && Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                assistantMessages.push(block.text);

                // Detect phase from content
                const text = block.text.toLowerCase();
                let newPhase: AgentProgress['phase'] = currentPhase;
                if (text.includes('exploring') || text.includes('searching') || text.includes('looking for')) {
                  newPhase = 'exploring';
                } else if (text.includes('reading') || text.includes('analyzing') || text.includes('investigating')) {
                  newPhase = 'analyzing';
                } else if (text.includes('editing') || text.includes('fixing') || text.includes('changing') || text.includes('updating')) {
                  newPhase = 'fixing';
                } else if (text.includes('running') || text.includes('testing') || text.includes('verifying') || text.includes('npm')) {
                  newPhase = 'testing';
                }

                if (newPhase !== currentPhase) {
                  currentPhase = newPhase;
                  const phaseProgress: AgentProgress = {
                    phase: currentPhase,
                    message: block.text.substring(0, 200),
                    timestamp: new Date(),
                  };
                  progressEvents.push(phaseProgress);
                  await config.onProgress?.(phaseProgress);
                }
              } else if (block.type === 'tool_use') {
                // Track tool usage
                lastToolUsed = block.name;

                // Extract useful info from tool inputs
                const toolInput = block.input as Record<string, unknown>;
                let detail = '';

                if (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') {
                  const filePath = (toolInput.file_path || toolInput.path) as string;
                  detail = filePath || '';
                  if (block.name === 'Edit' || block.name === 'Write') {
                    // Track this as a PENDING edit - we'll confirm it worked when we get the tool_result
                    if (filePath) {
                      pendingEdits.set(block.id, filePath);
                      logger.debug('Pending edit tracked', { toolUseId: block.id, filePath });
                    }
                  }
                } else if (block.name === 'Bash') {
                  const command = toolInput.command as string;
                  detail = command?.substring(0, 50) || '';
                  if (command) {
                    commandsRun.push(command);
                  }
                } else if (block.name === 'Glob') {
                  detail = (toolInput.pattern as string) || '';
                } else if (block.name === 'Grep') {
                  detail = (toolInput.pattern as string) || '';
                }

                const toolProgress: AgentProgress = {
                  phase: currentPhase,
                  message: `Using ${block.name}${detail ? `: ${detail}` : ''}`,
                  tool: block.name,
                  detail,
                  timestamp: new Date(),
                };
                progressEvents.push(toolProgress);
                await config.onProgress?.(toolProgress);

                logger.debug('Tool used', {
                  tool: block.name,
                  detail: detail.substring(0, 100),
                });
              }
            }
          }
          totalTurns++;
          break;

        case 'result':
          // Final result
          totalCost = message.total_cost_usd || 0;
          const duration = Date.now() - startTime;

          const stats: AgentStats = {
            durationMs: duration,
            costUsd: totalCost,
            turns: totalTurns,
            inputTokens: message.usage?.input_tokens || 0,
            outputTokens: message.usage?.output_tokens || 0,
          };

          // Determine success based on subtype
          const isSuccess = message.subtype === 'success';

          // Log detailed result info for debugging
          logger.info('Agent result details', {
            subtype: message.subtype,
            hasPermissionDenials: 'permission_denials' in message,
            permissionDenials: (message as any).permission_denials,
            hasErrors: 'errors' in message,
            errors: (message as any).errors,
          });

          // Extract the final analysis from assistant messages
          const analysis = assistantMessages.join('\n\n');

          // Get error message from result (including permission denials)
          let errorMessage: string | undefined;
          if (!isSuccess) {
            const errors: string[] = [];
            if ('errors' in message && Array.isArray(message.errors)) {
              errors.push(...message.errors);
            }
            if ('permission_denials' in message && Array.isArray((message as any).permission_denials)) {
              const denials = (message as any).permission_denials.map((d: any) =>
                `${d.tool || 'unknown'}: ${d.message || d.reason || 'denied'}`
              );
              errors.push(...denials);
            }
            errorMessage = errors.length > 0 ? errors.join('; ') : undefined;
          }

          finalResult = {
            success: isSuccess,
            analysis,
            filesModified,
            commandsRun,
            stats,
            error: errorMessage,
          };

          // Report completion
          const completeProgress: AgentProgress = {
            phase: 'complete',
            message: isSuccess ? 'Fix complete!' : 'Fix failed',
            timestamp: new Date(),
          };
          progressEvents.push(completeProgress);
          await config.onProgress?.(completeProgress);

          logger.info('Agent completed', {
            success: isSuccess,
            duration: `${(duration / 1000).toFixed(1)}s`,
            cost: `$${totalCost.toFixed(4)}`,
            turns: totalTurns,
            filesModified: filesModified.length,
          });
          break;
      }
    }

    // If we didn't get a result message, something went wrong
    if (!finalResult) {
      throw new Error('Agent completed without returning a result');
    }

    return finalResult;

  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Agent SDK error', {
      error: error instanceof Error ? error.message : String(error),
      duration: `${(duration / 1000).toFixed(1)}s`,
    });

    // Report error progress
    const errorProgress: AgentProgress = {
      phase: 'complete',
      message: `Error: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
    progressEvents.push(errorProgress);
    await config.onProgress?.(errorProgress);

    return {
      success: false,
      analysis: '',
      filesModified: [],
      commandsRun: [],
      stats: {
        durationMs: duration,
        costUsd: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up temp images
    if (savedImagePaths.length > 0) {
      logger.debug('Cleaning up temp images', { count: savedImagePaths.length });
      await cleanupTempImages(savedImagePaths);
    }
  }
}

/**
 * Service class wrapper for consistency with existing codebase
 */
class ClaudeAgentSDKService {
  /**
   * Analyze an issue and generate a fix using the Agent SDK
   */
  async analyzeAndFix(
    issueDescription: string,
    config: AgentSDKConfig
  ): Promise<AgentResult> {
    return analyzeAndFixWithAgentSDK(issueDescription, config);
  }
}

// Export singleton instance
export const claudeAgentSDKService = new ClaudeAgentSDKService();
