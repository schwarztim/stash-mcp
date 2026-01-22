#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { pathToFileURL } from 'url';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.File({ filename: 'stash.log' })],
});

interface BitbucketActivity {
  action: string;
  [key: string]: unknown;
}

interface BitbucketConfig {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  defaultProject?: string;
  maxLinesPerFile?: number;
  readOnly?: boolean;
}

interface RepositoryParams {
  project?: string;
  repository?: string;
}

interface PullRequestParams extends RepositoryParams {
  prId?: number;
}

interface MergeOptions {
  message?: string;
  strategy?: 'merge-commit' | 'squash' | 'fast-forward';
}

interface CommentOptions {
  text: string;
  parentId?: number;
}

interface InlineCommentOptions extends CommentOptions {
  filePath: string;
  line: number;
  lineType: 'ADDED' | 'REMOVED';
}

interface PullRequestInput extends RepositoryParams {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers?: string[];
}

interface ListOptions {
  limit?: number;
  start?: number;
}

interface ListRepositoriesOptions extends ListOptions {
  project?: string;
}

interface SearchOptions extends ListOptions {
  project?: string;
  repository?: string;
  query: string;
  type?: 'code' | 'file';
}

interface FileContentOptions extends ListOptions {
  project?: string;
  repository?: string;
  filePath: string;
  branch?: string;
}

interface AuthErrorResponse {
  content: { type: 'text'; text: string }[];
  isError: true;
}

const readOnlyTools = [
  'list_projects',
  'list_repositories',
  'get_pull_request',
  'get_diff',
  'get_reviews',
  'get_activities',
  'get_comments',
  'search',
  'get_file_content',
  'browse_repository',
];

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function buildAuthError(config: BitbucketConfig): AuthErrorResponse | null {
  if (!config.baseUrl || (!config.token && !(config.username && config.password))) {
    const required = ['BITBUCKET_URL', 'BITBUCKET_TOKEN or BITBUCKET_USERNAME/BITBUCKET_PASSWORD'];
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'Authentication required',
              message: 'Configure credentials in ~/.claude/user-mcps.json',
              required,
            },
            null,
            2
          ),
        },
      ],
    };
  }
  return null;
}

function resolveProject(project: string | undefined, defaultProject: string | undefined): string | undefined {
  return project || defaultProject || undefined;
}

function truncateFileSection(fileLines: string[], fileName: string, maxLines: number): string[] {
  if (fileLines.length <= maxLines) {
    return fileLines;
  }

  const contentLines = fileLines.filter((line) => !line.startsWith('@@'));
  const hunkHeaders = fileLines.filter((line) => line.startsWith('@@'));

  if (contentLines.length <= maxLines) {
    return fileLines;
  }

  const showAtStart = Math.floor(maxLines * 0.6);
  const showAtEnd = Math.floor(maxLines * 0.4);
  const truncatedCount = contentLines.length - showAtStart - showAtEnd;

  const result: string[] = [];
  result.push(...hunkHeaders);
  result.push(...contentLines.slice(0, showAtStart));
  result.push('');
  result.push(`[*** FILE TRUNCATED: ${truncatedCount} lines hidden from ${fileName} ***]`);
  result.push(`[*** File had ${contentLines.length} total lines, showing first ${showAtStart} and last ${showAtEnd} ***]`);
  result.push('[*** Use maxLinesPerFile=0 to see complete diff ***]');
  result.push('');
  result.push(...contentLines.slice(-showAtEnd));

  return result;
}

function truncateDiff(diffContent: string, maxLinesPerFile: number): string {
  if (!maxLinesPerFile || maxLinesPerFile <= 0) {
    return diffContent;
  }

  const lines = diffContent.split('\n');
  const result: string[] = [];
  let currentFileLines: string[] = [];
  let currentFileName = '';
  let inFileContent = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentFileLines.length > 0) {
        result.push(...truncateFileSection(currentFileLines, currentFileName, maxLinesPerFile));
        currentFileLines = [];
      }
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      currentFileName = match ? match[2] : 'unknown';
      inFileContent = false;
      result.push(line);
    } else if (line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
      result.push(line);
    } else if (line.startsWith('@@')) {
      inFileContent = true;
      currentFileLines.push(line);
    } else if (inFileContent) {
      currentFileLines.push(line);
    } else {
      result.push(line);
    }
  }

  if (currentFileLines.length > 0) {
    result.push(...truncateFileSection(currentFileLines, currentFileName, maxLinesPerFile));
  }

  return result.join('\n');
}

class StashServer {
  private readonly server: Server;
  private readonly config: BitbucketConfig;
  private api?: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'stash-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.config = {
      baseUrl: process.env.BITBUCKET_URL ?? '',
      token: process.env.BITBUCKET_TOKEN,
      username: process.env.BITBUCKET_USERNAME,
      password: process.env.BITBUCKET_PASSWORD,
      defaultProject: process.env.BITBUCKET_DEFAULT_PROJECT,
      maxLinesPerFile: process.env.BITBUCKET_DIFF_MAX_LINES_PER_FILE
        ? parseInt(process.env.BITBUCKET_DIFF_MAX_LINES_PER_FILE, 10)
        : undefined,
      readOnly: process.env.BITBUCKET_READ_ONLY === 'true',
    };

    this.setupToolHandlers();
    this.server.onerror = (error) => logger.error('[MCP Error]', error);
  }

  private getApi(): AxiosInstance {
    const authError = buildAuthError(this.config);
    if (authError) {
      throw new McpError(ErrorCode.InvalidParams, 'Authentication required');
    }

    if (!this.api) {
      this.api = axios.create({
        baseURL: `${this.config.baseUrl}/rest/api/1.0`,
        headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
        auth:
          this.config.username && this.config.password
            ? { username: this.config.username, password: this.config.password }
            : undefined,
        httpAgent,
        httpsAgent,
      });
    }

    return this.api;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_projects',
          description:
            'Discover and list all Bitbucket projects you have access to. Use this first to explore available projects, find project keys, or when you need to work with a specific project but do not know its exact key.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Number of projects to return (default: 25, max: 1000)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' },
            },
          },
        },
        {
          name: 'list_repositories',
          description:
            'Browse and discover repositories within a project or across accessible projects. Returns repository names, slugs, clone URLs, and project associations.',
          inputSchema: {
            type: 'object',
            properties: {
              project: {
                type: 'string',
                description:
                  'Bitbucket project key to list repositories from. If omitted, uses BITBUCKET_DEFAULT_PROJECT or lists all accessible repositories across projects.',
              },
              limit: { type: 'number', description: 'Number of repositories to return (default: 25, max: 1000)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' },
            },
          },
        },
        {
          name: 'create_pull_request',
          description:
            'Create a new pull request to propose code changes, request reviews, or merge feature branches.',
          inputSchema: {
            type: 'object',
            properties: {
              project: {
                type: 'string',
                description:
                  'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable. Use list_projects to discover available projects.',
              },
              repository: { type: 'string', description: 'Repository slug where the pull request will be created.' },
              title: { type: 'string', description: 'Clear, descriptive title for the pull request.' },
              description: { type: 'string', description: 'Detailed description of changes (Markdown supported).' },
              sourceBranch: { type: 'string', description: 'Source branch containing the changes.' },
              targetBranch: { type: 'string', description: 'Target branch for merging.' },
              reviewers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of Bitbucket usernames to assign as reviewers.',
              },
            },
            required: ['repository', 'title', 'sourceBranch', 'targetBranch'],
          },
        },
        {
          name: 'get_pull_request',
          description:
            'Retrieve detailed information about a pull request including status, reviewers, and metadata.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID.' },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'merge_pull_request',
          description: 'Merge an approved pull request into the target branch.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to merge.' },
              message: { type: 'string', description: 'Custom merge commit message.' },
              strategy: {
                type: 'string',
                enum: ['merge-commit', 'squash', 'fast-forward'],
                description: 'Merge strategy (merge-commit, squash, fast-forward).',
              },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'decline_pull_request',
          description: 'Decline a pull request that should not be merged.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to decline.' },
              message: { type: 'string', description: 'Reason for declining the pull request.' },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'add_comment',
          description: 'Add a comment to a pull request for review feedback or discussion.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to comment on.' },
              text: { type: 'string', description: 'Comment text (Markdown supported).' },
              parentId: { type: 'number', description: 'Parent comment ID for threaded replies.' },
            },
            required: ['repository', 'prId', 'text'],
          },
        },
        {
          name: 'add_comment_inline',
          description: 'Add an inline comment to a specific line in a pull request diff.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to comment on.' },
              text: { type: 'string', description: 'Comment text (Markdown supported).' },
              parentId: { type: 'number', description: 'Parent comment ID for threaded replies.' },
              filePath: { type: 'string', description: 'Path to the file in the repository.' },
              line: { type: 'number', description: 'Line number (1-based) to attach the comment to.' },
              lineType: { type: 'string', enum: ['ADDED', 'REMOVED'], description: 'Line type (ADDED or REMOVED).' },
            },
            required: ['repository', 'prId', 'text', 'filePath', 'line', 'lineType'],
          },
        },
        {
          name: 'get_diff',
          description: 'Retrieve the diff for a pull request with optional truncation for large files.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get diff for.' },
              contextLines: { type: 'number', description: 'Context lines around changes (default: 10).' },
              maxLinesPerFile: {
                type: 'number',
                description:
                  'Maximum number of lines per file (default: BITBUCKET_DIFF_MAX_LINES_PER_FILE). Set to 0 for no limit.',
              },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'get_reviews',
          description: 'Fetch review history and approval status for a pull request.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get reviews for.' },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'get_activities',
          description: 'Retrieve activity timeline for a pull request including comments and reviews.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get activities for.' },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'get_comments',
          description: 'Retrieve only the comments from a pull request.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get comments for.' },
            },
            required: ['repository', 'prId'],
          },
        },
        {
          name: 'search',
          description: 'Search for code or files across repositories using the Bitbucket search API.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query string.' },
              project: { type: 'string', description: 'Project key to limit search scope.' },
              repository: { type: 'string', description: 'Repository slug to limit search scope.' },
              type: { type: 'string', enum: ['code', 'file'], description: 'Search mode optimization.' },
              limit: { type: 'number', description: 'Results to return (default: 25, max: 100).' },
              start: { type: 'number', description: 'Start index for pagination (default: 0).' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_file_content',
          description: 'Retrieve file contents with pagination support.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the file.' },
              filePath: { type: 'string', description: 'Path to the file in the repository.' },
              branch: { type: 'string', description: 'Branch or commit hash (optional).' },
              limit: { type: 'number', description: 'Lines per request (default: 100, max: 1000).' },
              start: { type: 'number', description: 'Starting line number (0-based, default: 0).' },
            },
            required: ['repository', 'filePath'],
          },
        },
        {
          name: 'browse_repository',
          description: 'Browse files and directories in a repository.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key (optional if default project configured).' },
              repository: { type: 'string', description: 'Repository slug containing the path.' },
              path: { type: 'string', description: 'Directory path to browse (default: root).' },
              branch: { type: 'string', description: 'Branch or commit hash (optional).' },
              limit: { type: 'number', description: 'Maximum items to return (default: 50).' },
            },
            required: ['repository'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const authError = buildAuthError(this.config);
      if (authError) {
        return authError;
      }

      if (this.config.readOnly && !readOnlyTools.includes(request.params.name)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'Read-only mode enabled',
                  message: 'Write operations are disabled via BITBUCKET_READ_ONLY=true',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      try {
        const args = request.params.arguments ?? {};
        const projectKey = resolveProject(args.project as string, this.config.defaultProject);

        switch (request.params.name) {
          case 'list_projects':
            return await this.listProjects({
              limit: args.limit as number,
              start: args.start as number,
            });

          case 'list_repositories':
            return await this.listRepositories({
              project: args.project as string,
              limit: args.limit as number,
              start: args.start as number,
            });

          case 'create_pull_request':
            return await this.createPullRequest({
              project: projectKey,
              repository: args.repository as string,
              title: args.title as string,
              description: args.description as string,
              sourceBranch: args.sourceBranch as string,
              targetBranch: args.targetBranch as string,
              reviewers: args.reviewers as string[],
            });

          case 'get_pull_request':
            return await this.getPullRequest({
              project: projectKey,
              repository: args.repository as string,
              prId: args.prId as number,
            });

          case 'merge_pull_request':
            return await this.mergePullRequest(
              {
                project: projectKey,
                repository: args.repository as string,
                prId: args.prId as number,
              },
              {
                message: args.message as string,
                strategy: args.strategy as MergeOptions['strategy'],
              }
            );

          case 'decline_pull_request':
            return await this.declinePullRequest(
              {
                project: projectKey,
                repository: args.repository as string,
                prId: args.prId as number,
              },
              args.message as string
            );

          case 'add_comment':
            return await this.addComment(
              {
                project: projectKey,
                repository: args.repository as string,
                prId: args.prId as number,
              },
              {
                text: args.text as string,
                parentId: args.parentId as number,
              }
            );

          case 'add_comment_inline':
            return await this.addCommentInline(
              {
                project: projectKey,
                repository: args.repository as string,
                prId: args.prId as number,
              },
              {
                text: args.text as string,
                parentId: args.parentId as number,
                filePath: args.filePath as string,
                line: args.line as number,
                lineType: args.lineType as InlineCommentOptions['lineType'],
              }
            );

          case 'get_diff':
            return await this.getDiff(
              {
                project: projectKey,
                repository: args.repository as string,
                prId: args.prId as number,
              },
              args.contextLines as number,
              args.maxLinesPerFile as number
            );

          case 'get_reviews':
            return await this.getReviews({
              project: projectKey,
              repository: args.repository as string,
              prId: args.prId as number,
            });

          case 'get_activities':
            return await this.getActivities({
              project: projectKey,
              repository: args.repository as string,
              prId: args.prId as number,
            });

          case 'get_comments':
            return await this.getComments({
              project: projectKey,
              repository: args.repository as string,
              prId: args.prId as number,
            });

          case 'search':
            return await this.search({
              query: args.query as string,
              project: args.project as string,
              repository: args.repository as string,
              type: args.type as SearchOptions['type'],
              limit: args.limit as number,
              start: args.start as number,
            });

          case 'get_file_content':
            return await this.getFileContent({
              project: projectKey,
              repository: args.repository as string,
              filePath: args.filePath as string,
              branch: args.branch as string,
              limit: args.limit as number,
              start: args.start as number,
            });

          case 'browse_repository':
            return await this.browseRepository({
              project: projectKey,
              repository: args.repository as string,
              path: args.path as string,
              branch: args.branch as string,
              limit: args.limit as number,
            });

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        logger.error('Tool execution error', { error });
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Bitbucket API error: ${error.response?.data?.message ?? error.message}`
          );
        }
        throw error;
      }
    });
  }

  private requireProject(project?: string, repository?: string, prId?: number): asserts project is string {
    if (!project) {
      throw new McpError(ErrorCode.InvalidParams, 'Project is required (set BITBUCKET_DEFAULT_PROJECT or pass project).');
    }
    if (repository === '') {
      throw new McpError(ErrorCode.InvalidParams, 'Repository is required.');
    }
    if (prId !== undefined && Number.isNaN(prId)) {
      throw new McpError(ErrorCode.InvalidParams, 'prId must be a number.');
    }
  }

  private async listProjects(options: ListOptions = {}) {
    const api = this.getApi();
    const { limit = 25, start = 0 } = options;
    const response = await api.get('/projects', { params: { limit, start } });

    const projects = response.data.values || [];
    const summary = {
      total: response.data.size || projects.length,
      showing: projects.length,
      projects: projects.map((project: { key: string; name: string; description?: string; public: boolean; type: string }) => ({
        key: project.key,
        name: project.name,
        description: project.description,
        public: project.public,
        type: project.type,
      })),
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }

  private async listRepositories(options: ListRepositoriesOptions = {}) {
    const api = this.getApi();
    const { project, limit = 25, start = 0 } = options;
    const params = { limit, start };

    let endpoint = '/repos';
    const projectKey = resolveProject(project, this.config.defaultProject);
    if (projectKey) {
      endpoint = `/projects/${projectKey}/repos`;
    }

    const response = await api.get(endpoint, { params });
    const repositories = response.data.values || [];

    const summary = {
      project: projectKey || 'all',
      total: response.data.size || repositories.length,
      showing: repositories.length,
      repositories: repositories.map(
        (repo: {
          slug: string;
          name: string;
          description?: string;
          project?: { key: string };
          public: boolean;
          links?: { clone?: { name: string; href: string }[] };
          state: string;
        }) => ({
          slug: repo.slug,
          name: repo.name,
          description: repo.description,
          project: repo.project?.key,
          public: repo.public,
          cloneUrl: repo.links?.clone?.find((link: { name: string; href: string }) => link.name === 'http')?.href,
          state: repo.state,
        })
      ),
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }

  private async createPullRequest(input: PullRequestInput) {
    this.requireProject(input.project, input.repository);
    if (!input.repository) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository is required');
    }

    const api = this.getApi();
    const response = await api.post(`/projects/${input.project}/repos/${input.repository}/pull-requests`, {
      title: input.title,
      description: input.description ?? '',
      fromRef: {
        id: `refs/heads/${input.sourceBranch}`,
        repository: {
          slug: input.repository,
          project: { key: input.project },
        },
      },
      toRef: {
        id: `refs/heads/${input.targetBranch}`,
        repository: {
          slug: input.repository,
          project: { key: input.project },
        },
      },
      reviewers: input.reviewers?.map((username) => ({ user: { name: username } })),
    });

    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async getPullRequest(params: PullRequestParams) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.get(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}`);
    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async mergePullRequest(params: PullRequestParams, options: MergeOptions = {}) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.post(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/merge`, {
      version: -1,
      message: options.message,
      strategy: options.strategy || 'merge-commit',
    });

    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async declinePullRequest(params: PullRequestParams, message?: string) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.post(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/decline`, {
      version: -1,
      message,
    });

    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async addComment(params: PullRequestParams, options: CommentOptions) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.post(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/comments`, {
      text: options.text,
      parent: options.parentId ? { id: options.parentId } : undefined,
    });

    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async addCommentInline(params: PullRequestParams, options: InlineCommentOptions) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId || !options.filePath || !options.line || !options.lineType) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Repository, prId, filePath, line, and lineType are required'
      );
    }

    const api = this.getApi();
    const response = await api.post(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/comments`, {
      text: options.text,
      parent: options.parentId ? { id: options.parentId } : undefined,
      anchor: {
        path: options.filePath,
        lineType: options.lineType,
        line: options.line,
        diffType: 'EFFECTIVE',
        fileType: 'TO',
      },
    });

    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async getDiff(params: PullRequestParams, contextLines = 10, maxLinesPerFile?: number) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.get(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/diff`, {
      params: { contextLines },
      headers: { Accept: 'text/plain' },
    });

    const effectiveMaxLines = maxLinesPerFile !== undefined ? maxLinesPerFile : this.config.maxLinesPerFile;
    const diffContent = effectiveMaxLines ? truncateDiff(response.data, effectiveMaxLines) : response.data;

    return { content: [{ type: 'text', text: diffContent }] };
  }

  private async getReviews(params: PullRequestParams) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.get(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/activities`);

    const reviews = response.data.values.filter(
      (activity: BitbucketActivity) => activity.action === 'APPROVED' || activity.action === 'REVIEWED'
    );

    return { content: [{ type: 'text', text: JSON.stringify(reviews, null, 2) }] };
  }

  private async getActivities(params: PullRequestParams) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.get(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/activities`);

    return { content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }] };
  }

  private async getComments(params: PullRequestParams) {
    this.requireProject(params.project, params.repository, params.prId);
    if (!params.repository || !params.prId) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and prId are required');
    }

    const api = this.getApi();
    const response = await api.get(`/projects/${params.project}/repos/${params.repository}/pull-requests/${params.prId}/activities`);

    const comments = response.data.values.filter((activity: BitbucketActivity) => activity.action === 'COMMENTED');

    return { content: [{ type: 'text', text: JSON.stringify(comments, null, 2) }] };
  }

  private async search(options: SearchOptions) {
    const { query, project, repository, type, limit = 25, start = 0 } = options;
    if (!query) {
      throw new McpError(ErrorCode.InvalidParams, 'Query parameter is required');
    }

    let searchQuery = query;
    if (project) {
      searchQuery = `${searchQuery} project:${project}`;
    }
    if (repository && project) {
      searchQuery = `${searchQuery} repo:${project}/${repository}`;
    }

    if (type === 'file') {
      if (!query.includes('ext:') && !query.startsWith('"')) {
        searchQuery = `"${query}"`;
        if (project) searchQuery += ` project:${project}`;
        if (repository && project) searchQuery += ` repo:${project}/${repository}`;
      }
    }

    const requestBody = {
      query: searchQuery,
      entities: {
        code: {
          start,
          limit: Math.min(limit, 100),
        },
      },
    };

    try {
      const searchUrl = `${this.config.baseUrl}/rest/search/latest/search`;
      const response = await axios.post(searchUrl, requestBody, {
        headers: this.config.token
          ? { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }
          : { 'Content-Type': 'application/json' },
        auth:
          this.config.username && this.config.password
            ? { username: this.config.username, password: this.config.password }
            : undefined,
        httpAgent,
        httpsAgent,
      });

      const codeResults = response.data.code || {};
      const searchResults = {
        query: searchQuery,
        originalQuery: query,
        project: project || 'global',
        repository: repository || 'all',
        type: type || 'code',
        scope: response.data.scope || {},
        total: codeResults.count || 0,
        showing: codeResults.values?.length || 0,
        isLastPage: codeResults.isLastPage || true,
        nextStart: codeResults.nextStart || null,
        results:
          codeResults.values?.map((result: any) => ({
            repository: result.repository,
            file: result.file,
            hitCount: result.hitCount || 0,
            pathMatches: result.pathMatches || [],
            hitContexts: result.hitContexts || [],
          })) || [],
      };

      return { content: [{ type: 'text', text: JSON.stringify(searchResults, null, 2) }] };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new McpError(ErrorCode.InternalError, 'Search API endpoint not available on this Bitbucket instance');
        }
        const errorData = error.response?.data as { errors?: { message?: string }[] } | undefined;
        if (errorData?.errors?.length) {
          const firstError = errorData.errors[0];
          throw new McpError(ErrorCode.InvalidParams, `Search error: ${firstError.message || 'Invalid search query'}`);
        }
      }
      throw error;
    }
  }

  private async getFileContent(options: FileContentOptions) {
    this.requireProject(options.project, options.repository);
    if (!options.repository || !options.filePath) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository and filePath are required');
    }

    const api = this.getApi();
    const { project, repository, filePath, branch, limit = 100, start = 0 } = options;
    const params: Record<string, string | number> = {
      limit: Math.min(limit, 1000),
      start,
    };

    if (branch) {
      params.at = branch;
    }

    const response = await api.get(`/projects/${project}/repos/${repository}/browse/${filePath}`, { params });
    const fileContent = {
      project,
      repository,
      filePath,
      branch: branch || 'default',
      isLastPage: response.data.isLastPage,
      size: response.data.size,
      showing: response.data.lines?.length || 0,
      startLine: start,
      lines: response.data.lines?.map((line: { text: string }) => line.text) || [],
    };

    return { content: [{ type: 'text', text: JSON.stringify(fileContent, null, 2) }] };
  }

  private async browseRepository(options: { project?: string; repository?: string; path?: string; branch?: string; limit?: number }) {
    this.requireProject(options.project, options.repository);
    if (!options.repository) {
      throw new McpError(ErrorCode.InvalidParams, 'Repository is required');
    }

    const api = this.getApi();
    const { project, repository, path = '', branch, limit = 50 } = options;
    const params: Record<string, string | number> = { limit };

    if (branch) {
      params.at = branch;
    }

    const browsePath = path ? `/${path}` : '';
    const response = await api.get(`/projects/${project}/repos/${repository}/browse${browsePath}`, { params });

    const children = response.data.children || {};
    const browseResults = {
      project,
      repository,
      path: path || 'root',
      branch: branch || response.data.revision || 'default',
      isLastPage: children.isLastPage || false,
      size: children.size || 0,
      showing: children.values?.length || 0,
      items:
        children.values?.map((item: { path: { name: string; toString: string }; type: string; size?: number }) => ({
          name: item.path.name,
          path: item.path.toString,
          type: item.type,
          size: item.size,
        })) || [],
    };

    return { content: [{ type: 'text', text: JSON.stringify(browseResults, null, 2) }] };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Stash MCP server running on stdio');
  }
}

export const internal = {
  buildAuthError,
  resolveProject,
  truncateDiff,
};

export function createServer() {
  return new StashServer();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = new StashServer();
  server.run().catch((error) => {
    logger.error('Server error', error);
    process.exit(1);
  });
}
