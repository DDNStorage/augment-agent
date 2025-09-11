/**
 * GitHub API service for PR information extraction
 */

import { Octokit } from '@octokit/rest';
import { PullRequestInfo, PullRequestFile, PullRequestDiff } from '../types/github.js';
import { TEMPLATE_CONFIG, ERROR } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: { token: string; owner: string; repo: string; baseUrl?: string }) {
    try {
      const octokitConfig: any = { auth: config.token };
      if (config.baseUrl) {
        // Validate and potentially fix the GitHub Enterprise URL
        let baseUrl = config.baseUrl;

        // Ensure the URL ends with /api/v3 for GitHub Enterprise
        if (!baseUrl.endsWith('/api/v3')) {
          if (baseUrl.endsWith('/')) {
            baseUrl = baseUrl + 'api/v3';
          } else {
            baseUrl = baseUrl + '/api/v3';
          }
          logger.debug('Adjusted GitHub API URL to include /api/v3', {
            original: config.baseUrl,
            adjusted: baseUrl
          });
        }

        octokitConfig.baseUrl = baseUrl;
        logger.debug('Using custom GitHub API URL', {
          baseUrl: baseUrl,
          originalUrl: config.baseUrl,
          wasAdjusted: baseUrl !== config.baseUrl
        });
      } else {
        logger.debug('Using default GitHub.com API');
      }

      // Log token format for debugging (without exposing the actual token)
      const tokenPrefix = config.token.substring(0, 4);
      const tokenType = config.token.startsWith('ghp_') ? 'personal_access_token' :
                       config.token.startsWith('ghs_') ? 'server_to_server_token' :
                       config.token.startsWith('gho_') ? 'oauth_token' :
                       config.token.startsWith('ghu_') ? 'user_access_token' :
                       config.token.startsWith('github_pat_') ? 'fine_grained_token' : 'unknown';

      logger.debug('GitHub token info', {
        tokenPrefix: tokenPrefix + '...',
        tokenType,
        tokenLength: config.token.length
      });

      logger.debug('Creating Octokit instance with config', {
        hasAuth: !!octokitConfig.auth,
        hasBaseUrl: !!octokitConfig.baseUrl,
        baseUrl: octokitConfig.baseUrl,
        configKeys: Object.keys(octokitConfig)
      });

      // Try to create Octokit instance with explicit error handling
      try {
        this.octokit = new Octokit(octokitConfig);
        logger.debug('Octokit instance created successfully', {
          octokitVersion: (Octokit as any).VERSION || 'unknown',
          configUsed: octokitConfig,
          instanceType: typeof this.octokit,
          hasRequest: !!(this.octokit as any).request
        });
      } catch (octokitError) {
        logger.error('Failed to create Octokit instance', octokitError);
        throw new Error(`Failed to initialize GitHub API client: ${octokitError}`);
      }
      this.owner = config.owner;
      this.repo = config.repo;

      logger.debug('GitHubService initialized successfully', {
        owner: this.owner,
        repo: this.repo,
        hasOctokit: !!this.octokit,
        hasRestApi: !!(this.octokit && this.octokit.rest),
        hasUserApi: !!(this.octokit && this.octokit.rest && this.octokit.rest.user),
        // Debug the Octokit structure
        octokitKeys: this.octokit ? Object.keys(this.octokit) : [],
        restKeys: this.octokit?.rest ? Object.keys(this.octokit.rest) : [],
        userApiExists: this.octokit?.rest?.user !== undefined,
        userApiType: typeof this.octokit?.rest?.user
      });

      // Note: Authentication test will be called separately since constructors cannot be async
    } catch (error) {
      logger.error('Failed to initialize GitHubService', error);
      throw error;
    }
  }

  /**
   * Test authentication and API connectivity
   */
  async testAuthentication(): Promise<void> {
    try {
      logger.debug('Testing GitHub authentication and API connectivity', {
        hasUserApi: !!(this.octokit?.rest?.user),
        hasGetAuthenticated: !!(this.octokit?.rest?.user?.getAuthenticated),
        baseUrl: (this.octokit as any)?.request?.endpoint?.DEFAULTS?.baseUrl
      });

      // Check if user API is available
      if (!this.octokit?.rest?.user) {
        throw new Error('GitHub user API is not available on this Octokit instance');
      }

      if (!this.octokit.rest.user.getAuthenticated) {
        throw new Error('getAuthenticated method is not available on user API');
      }

      // Try to make an authenticated API call
      const { data } = await this.octokit.rest.user.getAuthenticated();
      logger.debug('Authentication successful', {
        username: data.login,
        userType: data.type,
        userId: data.id,
        apiUrl: (this.octokit as any)?.request?.endpoint?.DEFAULTS?.baseUrl
      });
    } catch (error: any) {
      logger.error('Authentication test failed', {
        error: error.message,
        status: error.status,
        response: error.response?.data,
        request: {
          method: error.request?.method,
          url: error.request?.url,
          headers: error.request?.headers ? Object.keys(error.request.headers) : undefined
        }
      });

      if (error.status === 401) {
        throw new Error('GitHub authentication failed. Please check your token and ensure it has the required permissions.');
      }
      if (error.status === 404) {
        throw new Error('GitHub API endpoint not found. Please verify the github_api_url is correct for your GitHub Enterprise instance.');
      }
      throw new Error(`GitHub API connectivity test failed: ${error.message}`);
    }
  }

  async getPullRequest(pullNumber: number): Promise<PullRequestInfo> {
    try {
      logger.debug(`Fetching PR ${pullNumber} from ${this.owner}/${this.repo}`);

      // Debug Octokit instance
      logger.debug('Octokit instance check', {
        hasOctokit: !!this.octokit,
        hasRest: !!(this.octokit && this.octokit.rest),
        hasPulls: !!(this.octokit && this.octokit.rest && this.octokit.rest.pulls),
        hasGet: !!(this.octokit && this.octokit.rest && this.octokit.rest.pulls && this.octokit.rest.pulls.get)
      });

      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        user: { login: data.user?.login || 'unknown' },
        head: {
          ref: data.head.ref,
          sha: data.head.sha,
          repo: {
            full_name: data.head.repo.full_name,
            name: data.head.repo.name,
            owner: {
              login: data.head.repo.owner.login,
            },
          },
        },
        base: {
          ref: data.base.ref,
          sha: data.base.sha,
          repo: {
            full_name: data.base.repo.full_name,
            name: data.base.repo.name,
            owner: {
              login: data.base.repo.owner.login,
            },
          },
        },
      };
    } catch (error: any) {
      const errorMessage = `${ERROR.GITHUB.API_ERROR}: Failed to fetch PR ${pullNumber}`;

      // Provide specific guidance for authentication errors
      if (error.status === 401) {
        logger.error(`${errorMessage} - Authentication failed. This could be due to:
1. Invalid or expired GitHub token
2. Token doesn't have required permissions (needs 'repo' scope)
3. For GitHub Enterprise: Incorrect github_api_url parameter
4. For GitHub Enterprise: Token might need to be generated from the Enterprise instance`, error);
      } else if (error.status === 404) {
        logger.error(`${errorMessage} - Repository or PR not found. Check:
1. Repository name format (should be 'owner/repo')
2. PR number exists
3. Token has access to the repository`, error);
      } else {
        logger.error(errorMessage, error);
      }

      throw error;
    }
  }

  async getPullRequestFiles(pullNumber: number): Promise<PullRequestFile[]> {
    try {
      logger.debug(`Fetching files for PR ${pullNumber}`);

      const allFiles: PullRequestFile[] = [];
      let page = 1;
      const perPage = 100; // GitHub's maximum per page

      while (true) {
        logger.debug(`Fetching PR files page ${page}`, {
          pullNumber,
          page,
          perPage,
        });

        const { data } = await this.octokit.rest.pulls.listFiles({
          owner: this.owner,
          repo: this.repo,
          pull_number: pullNumber,
          per_page: perPage,
          page,
        });

        // Map and add files from this page
        const pageFiles = data.map(file => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));

        allFiles.push(...pageFiles);

        logger.debug(`Fetched ${pageFiles.length} files from page ${page}`, {
          pullNumber,
          page,
          filesOnPage: pageFiles.length,
          totalFilesSoFar: allFiles.length,
        });

        // If we got fewer files than the page size, we've reached the end
        if (data.length < perPage) {
          break;
        }

        page++;
      }

      logger.info(`Successfully fetched all PR files`, {
        pullNumber,
        totalFiles: allFiles.length,
        totalPages: page,
      });

      return allFiles;
    } catch (error) {
      logger.error(`${ERROR.GITHUB.API_ERROR}: Failed to fetch PR files`, error);
      throw error;
    }
  }

  async getPullRequestDiff(pullNumber: number): Promise<PullRequestDiff> {
    try {
      logger.debug(`Fetching diff for PR ${pullNumber}`);

      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
        mediaType: { format: 'diff' },
      });

      const content = data as unknown as string;
      const size = Buffer.byteLength(content, 'utf8');
      const truncated = size > TEMPLATE_CONFIG.MAX_DIFF_SIZE;

      return {
        content: truncated ? content.substring(0, TEMPLATE_CONFIG.MAX_DIFF_SIZE) : content,
        size,
        truncated,
      };
    } catch (error) {
      logger.error(`${ERROR.GITHUB.API_ERROR}: Failed to fetch PR diff`, error);
      throw error;
    }
  }
}
