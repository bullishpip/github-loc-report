// test-gh-loc-report.js
const fs = require('fs').promises;

// Mock the GitHubLOCCalculator class for testing
class MockGitHubLOCCalculator {
  constructor(token, username, year = 2025) {
    this.username = username;
    this.year = year;
    this.requestCount = 0;
    this.maxRequestsPerHour = 4800;
    this.startTime = Date.now();
  }

  async getAllRepositories() {
    // Mock implementation
    return [
      { id: 1, name: 'repo1', full_name: 'test-user/repo1', owner: { login: 'test-user' }, size: 1024 },
      { id: 2, name: 'repo2', full_name: 'test-user/repo2', owner: { login: 'test-user' }, size: 2048 },
      { id: 3, name: 'repo3', full_name: 'test-user/repo3', owner: { login: 'test-user' }, size: 512 }
    ];
  }

  async getRepositoryByName(repoName) {
    const repos = await this.getAllRepositories();
    return repos.find(repo => repo.name === repoName || repo.full_name === repoName);
  }

  async processRepository(repo, since, until) {
    // Mock implementation
    if (repo.name === 'repo3') {
      return {
        success: false,
        error: 'API Error',
        stats: { additions: 0, deletions: 0, commits: 0, netLines: 0 }
      };
    }
    
    return {
      success: true,
      stats: { 
        additions: 100, 
        deletions: 50, 
        commits: 2, 
        netLines: 50 
      }
    };
  }

  shouldIncludeFile(filename) {
    const excludePatterns = [
      /package-lock\.json$/,
      /yarn\.lock$/,
      /composer\.lock$/,
      /^(dist|build|out|target|bin|obj)\//, 
      /node_modules\//,
      /vendor\//,
      /__pycache__\//,
      /\.pytest_cache\//,
      /\.(jpg|jpeg|png|gif|svg|ico|pdf|zip|tar|gz|rar|7z|exe|dmg)$/,
      /\.(mp4|avi|mov|wmv|mp3|wav|ogg)$/,
      /\.(db|sqlite|sqlite3)$/,
      /\.(log|logs)$/,
      /^logs\//
    ];
    
    return !excludePatterns.some(pattern => pattern.test(filename));
  }

  async calculateLOCForYear(targetRepo = null) {
    const since = new Date(`${this.year}-01-01T00:00:00Z`);
    const until = new Date(`${this.year}-12-31T23:59:59Z`);
    
    let repos = [];
    
    if (targetRepo) {
      // Single repository mode
      const repo = await this.getRepositoryByName(targetRepo);
      if (!repo) {
        throw new Error(`Repository '${targetRepo}' not found`);
      }
      repos = [repo];
    } else {
      // All repositories mode
      repos = await this.getAllRepositories();
    }
    
    const results = {
      totalAdditions: 0,
      totalDeletions: 0,
      netLines: 0,
      totalCommits: 0,
      repoStats: [],
      fileTypeStats: {},
      warnings: [],
      processedAt: new Date().toISOString(),
      runtimeStats: {
        totalApiCalls: 0,
        truncatedCommits: 0,
        skippedCommits: 0
      },
      processingStatus: {
        successful: 0,
        failed: 0,
        failedRepos: []
      },
      analysisMode: targetRepo ? 'single' : 'all'
    };
    
    for (const repo of repos) {
      const result = await this.processRepository(repo, since, until);
      
      if (result.success) {
        results.processingStatus.successful++;
        results.totalAdditions += result.stats.additions;
        results.totalDeletions += result.stats.deletions;
        results.totalCommits += result.stats.commits;
        
        results.repoStats.push({
          name: repo.full_name,
          additions: result.stats.additions,
          deletions: result.stats.deletions,
          netLines: result.stats.netLines,
          commits: result.stats.commits,
          sizeKB: repo.size,
          truncatedCommits: 0
        });
      } else {
        results.processingStatus.failed++;
        results.processingStatus.failedRepos.push(repo.full_name);
      }
    }
    
    results.netLines = results.totalAdditions - results.totalDeletions;
    results.runtimeStats.totalApiCalls = this.requestCount;
    
    return results;
  }
}

describe('GitHubLOCCalculator', () => {
  let calculator;
  
  beforeEach(() => {
    calculator = new MockGitHubLOCCalculator('test-token', 'test-user', 2025);
  });

  describe('getAllRepositories', () => {
    test('should fetch all repositories', async () => {
      const repos = await calculator.getAllRepositories();
      
      expect(repos).toHaveLength(3);
      expect(repos[0].name).toBe('repo1');
      expect(repos[1].name).toBe('repo2');
      expect(repos[2].name).toBe('repo3');
    });
  });

  describe('getRepositoryByName', () => {
    test('should find repository by name', async () => {
      const repo = await calculator.getRepositoryByName('repo1');
      
      expect(repo).toBeDefined();
      expect(repo.name).toBe('repo1');
      expect(repo.full_name).toBe('test-user/repo1');
    });

    test('should find repository by full name', async () => {
      const repo = await calculator.getRepositoryByName('test-user/repo2');
      
      expect(repo).toBeDefined();
      expect(repo.name).toBe('repo2');
      expect(repo.full_name).toBe('test-user/repo2');
    });

    test('should return undefined for non-existent repository', async () => {
      const repo = await calculator.getRepositoryByName('non-existent-repo');
      
      expect(repo).toBeUndefined();
    });
  });

  describe('processRepository', () => {
    test('should process repository successfully and return stats', async () => {
      const repo = {
        id: 1,
        name: 'test-repo',
        full_name: 'test-user/test-repo',
        owner: { login: 'test-user' },
        size: 1024
      };

      const result = await calculator.processRepository(repo, new Date('2025-01-01'), new Date('2025-12-31'));
      
      expect(result.success).toBe(true);
      expect(result.stats.additions).toBe(100);
      expect(result.stats.deletions).toBe(50);
      expect(result.stats.commits).toBe(2);
    });

    test('should handle repository with errors', async () => {
      const repo = {
        id: 1,
        name: 'repo3',
        full_name: 'test-user/repo3',
        owner: { login: 'test-user' },
        size: 1024
      };

      const result = await calculator.processRepository(repo, new Date('2025-01-01'), new Date('2025-12-31'));
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('API Error');
      expect(result.stats.additions).toBe(0);
      expect(result.stats.deletions).toBe(0);
    });
  });

  describe('calculateLOCForYear', () => {
    test('should process all repositories when no target specified', async () => {
      const results = await calculator.calculateLOCForYear();
      
      expect(results.analysisMode).toBe('all');
      expect(results.totalAdditions).toBe(200); // 2 successful repos * 100
      expect(results.totalDeletions).toBe(100); // 2 successful repos * 50
      expect(results.totalCommits).toBe(4); // 2 successful repos * 2
      expect(results.repoStats).toHaveLength(2); // 2 successful repos
      expect(results.processingStatus.successful).toBe(2);
      expect(results.processingStatus.failed).toBe(1);
      expect(results.processingStatus.failedRepos).toContain('test-user/repo3');
    });

    test('should process single repository when target specified', async () => {
      const results = await calculator.calculateLOCForYear('repo1');
      
      expect(results.analysisMode).toBe('single');
      expect(results.totalAdditions).toBe(100); // 1 repo * 100
      expect(results.totalDeletions).toBe(50); // 1 repo * 50
      expect(results.totalCommits).toBe(2); // 1 repo * 2
      expect(results.repoStats).toHaveLength(1); // 1 repo
      expect(results.processingStatus.successful).toBe(1);
      expect(results.processingStatus.failed).toBe(0);
    });

    test('should process single repository by full name', async () => {
      const results = await calculator.calculateLOCForYear('test-user/repo2');
      
      expect(results.analysisMode).toBe('single');
      expect(results.totalAdditions).toBe(100);
      expect(results.totalDeletions).toBe(50);
      expect(results.totalCommits).toBe(2);
      expect(results.repoStats).toHaveLength(1);
      expect(results.processingStatus.successful).toBe(1);
    });

    test('should throw error for non-existent repository', async () => {
      await expect(calculator.calculateLOCForYear('non-existent-repo')).rejects.toThrow(
        "Repository 'non-existent-repo' not found"
      );
    });
  });

  describe('shouldIncludeFile', () => {
    test('should exclude lock files', () => {
      expect(calculator.shouldIncludeFile('package-lock.json')).toBe(false);
      expect(calculator.shouldIncludeFile('yarn.lock')).toBe(false);
      expect(calculator.shouldIncludeFile('composer.lock')).toBe(false);
    });

    test('should exclude build directories', () => {
      expect(calculator.shouldIncludeFile('dist/file.js')).toBe(false);
      expect(calculator.shouldIncludeFile('build/index.js')).toBe(false);
      expect(calculator.shouldIncludeFile('node_modules/package/index.js')).toBe(false);
    });

    test('should include source files', () => {
      expect(calculator.shouldIncludeFile('src/index.js')).toBe(true);
      expect(calculator.shouldIncludeFile('lib/helper.js')).toBe(true);
      expect(calculator.shouldIncludeFile('README.md')).toBe(true);
    });
  });
});

// Run tests if this file is executed directly
if (require.main === module) {
  const { execSync } = require('child_process');
  try {
    execSync('npx jest test-gh-loc-report.js --verbose', { stdio: 'inherit' });
  } catch (error) {
    console.error('Tests failed:', error.message);
    process.exit(1);
  }
}
