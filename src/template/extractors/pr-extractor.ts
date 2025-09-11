/**
 * PR data extractor - responsible for extracting and formatting PR data from GitHub API
 */

import { join } from 'node:path';
import { BaseExtractor } from './base-extractor.js';
import { GitHubService } from '../../services/github-service.js';
import { FileUtils } from '../../utils/file-utils.js';
import { logger } from '../../utils/logger.js';
import { ValidationUtils } from '../../utils/validation.js';
import { PATHS } from '../../config/constants.js';
import type { PullRequestFile } from '../../types/github.js';
import type { PRData } from '../../types/context.js';
import type { ActionInputs } from '../../types/inputs.js';

export class PRExtractor extends BaseExtractor<PRData> {
  constructor(private githubService?: GitHubService) {
    super('PR Data');
  }

  /**
   * Creates a PRExtractor instance configured for the given inputs
   */
  static create(inputs: ActionInputs): PRExtractor {
    // If we have complete repo information, create with pre-configured GitHub service
    if (inputs.repoName && inputs.githubToken) {
      try {
        const repoInfo = ValidationUtils.parseRepoName(inputs.repoName);

        logger.debug('Creating GitHubService with config', {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          hasToken: !!inputs.githubToken,
          githubApiUrl: inputs.githubApiUrl,
          hasGithubApiUrl: !!inputs.githubApiUrl
        });

        const githubService = new GitHubService({
          token: inputs.githubToken,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          baseUrl: inputs.githubApiUrl,
        });
        logger.debug('PRExtractor created with pre-configured GitHubService', {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
        });
        return new PRExtractor(githubService);
      } catch (error) {
        logger.debug('Failed to create pre-configured GitHubService, will create lazily', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Fall through to create without GitHubService
      }
    }

    // Create without GitHubService for lazy configuration
    logger.debug('PRExtractor created without GitHubService (will be created lazily)');
    return new PRExtractor();
  }

  /**
   * Determines if PR extraction should be performed
   */
  shouldExtract(inputs: ActionInputs): boolean {
    return !!(inputs.pullNumber && inputs.pullNumber > 0 && inputs.repoName && inputs.githubToken);
  }

  /**
   * Performs the actual PR data extraction
   */
  protected async performExtraction(inputs: ActionInputs): Promise<PRData> {
    const pullNumber = inputs.pullNumber!;

    // Get or create GitHubService lazily
    const githubService = this.githubService;
    if (!githubService) {
      throw new Error('GitHubService not provided');
    }

    // Test authentication before making API calls
    // Temporarily disabled - will test with actual PR API call
    // await githubService.testAuthentication();

    const prData = await githubService.getPullRequest(pullNumber);
    const files = await githubService.getPullRequestFiles(pullNumber);
    const diffFilePath = await this.writeDiffFile(pullNumber, githubService);

    const extractedData: PRData = {
      number: prData.number,
      title: prData.title,
      author: prData.user.login,
      head: {
        ref: prData.head.ref,
        sha: prData.head.sha,
        repo: {
          full_name: prData.head.repo.full_name,
          name: prData.head.repo.name,
          owner: prData.head.repo.owner.login,
        },
      },
      base: {
        ref: prData.base.ref,
        sha: prData.base.sha,
        repo: {
          full_name: prData.base.repo.full_name,
          name: prData.base.repo.name,
          owner: prData.base.repo.owner.login,
        },
      },
      body: prData.body || '',
      state: prData.state,
      changed_files: files.map(file => file.filename).join('\n'),
      changed_files_list: files,
      diff_file: diffFilePath,
    };

    logger.info('PR data extraction completed', {
      pullNumber,
      fileCount: files.length,
      diffFile: diffFilePath,
    });

    return extractedData;
  }

  private async writeDiffFile(pullNumber: number, githubService: GitHubService): Promise<string> {
    try {
      const diff = await githubService.getPullRequestDiff(pullNumber);

      if (diff.truncated) {
        logger.warning('PR diff was truncated due to size', {
          originalSize: diff.size,
          truncated: diff.truncated,
        });
      }

      const diffFileName = PATHS.DIFF_FILE_PATTERN.replace('{pullNumber}', pullNumber.toString());
      const diffFilePath = join(PATHS.TEMP_DIR, diffFileName);

      await FileUtils.ensureDirectoryExists(PATHS.TEMP_DIR);
      await FileUtils.writeFile(diffFilePath, diff.content);

      logger.debug('Diff file written', { diffFilePath, size: diff.size });
      return diffFilePath;
    } catch (error) {
      logger.error('Failed to write diff file', error);
      throw error;
    }
  }
}
