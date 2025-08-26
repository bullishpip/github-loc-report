// gh-loc-report.js
require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;

class GitHubLOCCalculator {
  constructor(token, username, year = 2025) {
    this.octokit = new Octokit({ 
      auth: token,
      request: {
        timeout: 30000, // 30 second timeout for large requests
      }
    });
    this.username = username;
    this.year = year;
    this.requestCount = 0;
    this.maxRequestsPerHour = 4800; // Conservative limit under 5000
    this.startTime = Date.now();
  }

  async rateLimitCheck() {
    this.requestCount++;
    
    // Check if we're approaching rate limits
    const elapsedHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
    const requestsPerHour = this.requestCount / elapsedHours;
    
    if (requestsPerHour > this.maxRequestsPerHour) {
      const waitTime = (this.requestCount / this.maxRequestsPerHour) * 60 * 60 * 1000 - (Date.now() - this.startTime);
      if (waitTime > 0) {
        // Only log every 5 seconds to reduce noise
        const now = Date.now();
        if (!this.lastWaitLog || now - this.lastWaitLog >= 5000) {
          const timeString = new Date().toLocaleString();
          console.log(`[${timeString}] Rate limit protection hit. Waiting...`);
          this.lastWaitLog = now;
        }
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // Progressive delay based on request count
    const baseDelay = this.requestCount > 100 ? 150 : 100;
    await new Promise(resolve => setTimeout(resolve, baseDelay));
  }

  async getAllRepositories() {
    console.log('Fetching all repositories...');
    const repos = [];
    let page = 1;
    let totalFetched = 0;
    
    while (true) {
      await this.rateLimitCheck();
      
      try {
        const response = await this.octokit.rest.repos.listForAuthenticatedUser({
          per_page: 100,
          page: page,
          sort: 'updated',
          direction: 'desc'
        });
        
        if (response.data.length === 0) break;
        
        repos.push(...response.data);
        totalFetched += response.data.length;
        page++;
        
        console.log(`  Fetched ${totalFetched} repositories so far...`);
        
        // Safety limit to prevent infinite loops
        if (page > 1000) {
          console.warn('Stopped at page 1000 to prevent excessive API calls');
          break;
        }
      } catch (error) {
        console.error(`Error fetching repositories page ${page}:`, error.message);
        break;
      }
    }
    
    console.log(`Found ${repos.length} total repositories`);
    return repos;
  }

  async getRepositoryByName(repoName) {
    console.log(`Searching for repository: ${repoName}`);
    const repos = await this.getAllRepositories();
    const repo = repos.find(repo => 
      repo.name === repoName || 
      repo.full_name === repoName ||
      repo.full_name === `${this.username}/${repoName}`
    );
    
    if (repo) {
      console.log(`Found repository: ${repo.full_name}`);
    } else {
      console.log(`Repository '${repoName}' not found`);
    }
    
    return repo;
  }

  async processRepository(repo, since, until) {
    try {
      console.log(`\nProcessing repository: ${repo.full_name}`);
      console.log(`Repository size: ${(repo.size / 1024).toFixed(2)} MB`);
      
      const commits = await this.getCommitsForRepo(repo.owner.login, repo.name, since, until);
      
      if (commits.length === 0) {
        console.log(`  No commits found for ${repo.name} in ${this.year}`);
        return {
          success: true,
          stats: {
            additions: 0,
            deletions: 0,
            commits: 0,
            netLines: 0
          }
        };
      }
      
      console.log(`  Found ${commits.length} commits to analyze`);
      
      let repoAdditions = 0;
      let repoDeletions = 0;
      let repoCommits = 0;
      let truncatedCommits = 0;
      let commitProgress = 0;
      
      for (const commit of commits) {
        commitProgress++;
        if (commitProgress % 50 === 0) {
          console.log(`    Processing commit ${commitProgress}/${commits.length}...`);
        }
        
        const stats = await this.getCommitStatsWithRetry(
          repo.owner.login, 
          repo.name, 
          commit.sha
        );
        
        if (stats.truncated) {
          truncatedCommits++;
        }
        
        // Filter files and recalculate stats for large repositories
        let filteredAdditions = 0;
        let filteredDeletions = 0;
        
        if (stats.files.length > 0) {
          // Process files individually for accurate filtering
          for (const file of stats.files) {
            if (this.shouldIncludeFile(file.filename)) {
              const additions = file.additions || 0;
              const deletions = file.deletions || 0;
              
              filteredAdditions += additions;
              filteredDeletions += deletions;
            }
          }
        } else if (stats.total > 0) {
          // For truncated commits where we don't have file details,
          // use the total stats but add a warning
          filteredAdditions = stats.additions;
          filteredDeletions = stats.deletions;
        }
        
        repoAdditions += filteredAdditions;
        repoDeletions += filteredDeletions;
        repoCommits++;
      }
      
      if (truncatedCommits > 0) {
        console.warn(`  Warning: ${truncatedCommits} commits had truncated file lists`);
      }
      
      const netLines = repoAdditions - repoDeletions;
      console.log(`  ${repo.name}: +${repoAdditions.toLocaleString()} -${repoDeletions.toLocaleString()} (${repoCommits} commits)`);
      
      return {
        success: true,
        stats: {
          additions: repoAdditions,
          deletions: repoDeletions,
          commits: repoCommits,
          netLines: netLines,
          truncatedCommits: truncatedCommits
        }
      };
      
    } catch (error) {
      console.error(`Error processing repository ${repo.full_name}:`, error.message);
      return {
        success: false,
        error: error.message,
        stats: {
          additions: 0,
          deletions: 0,
          commits: 0,
          netLines: 0
        }
      };
    }
  }

  async getCommitsForRepo(owner, repo, since, until) {
    try {
      const commits = [];
      let page = 1;
      let totalFetched = 0;
      const maxCommitsPerRepo = 5000; // Increased limit for large repositories
      
      console.log(`  Fetching commits for ${repo}...`);
      
      while (totalFetched < maxCommitsPerRepo) {
        await this.rateLimitCheck();
        
        const response = await this.octokit.rest.repos.listCommits({
          owner,
          repo,
          author: this.username,
          since: since.toISOString(),
          until: until.toISOString(),
          per_page: 100,
          page: page
        });
        
        if (response.data.length === 0) break;
        
        commits.push(...response.data);
        totalFetched += response.data.length;
        page++;
        
        if (totalFetched % 500 === 0) {
          console.log(`    Fetched ${totalFetched} commits so far...`);
        }
      }
      
      if (totalFetched >= maxCommitsPerRepo) {
        console.warn(`    Limited to ${maxCommitsPerRepo} commits for ${repo} to prevent API exhaustion`);
      }
      
      return commits;
    } catch (error) {
      console.error(`Error fetching commits for ${owner}/${repo}:`, error.message);
      return [];
    }
  }

  async getCommitStatsWithRetry(owner, repo, sha, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.rateLimitCheck();
        
        const response = await this.octokit.rest.repos.getCommit({
          owner,
          repo,
          ref: sha
        });
        
        // Handle large commits that might be truncated
        const stats = response.data.stats || { additions: 0, deletions: 0, total: 0 };
        const files = response.data.files || [];
        
        // If files array is truncated (GitHub truncates at 300 files)
        if (files.length >= 300) {
          console.warn(`    Commit ${sha.substring(0, 8)} has ${files.length}+ files (may be truncated)`);
        }
        
        // If total changes are very large, GitHub might not show individual file stats
        if (stats.total > 50000) {
          console.warn(`    Commit ${sha.substring(0, 8)} has ${stats.total} total changes (large commit)`);
        }
        
        return {
          additions: stats.additions || 0,
          deletions: stats.deletions || 0,
          total: stats.total || 0,
          files: files,
          truncated: files.length >= 300 || stats.total > 50000
        };
      } catch (error) {
        if (error.status === 409 || error.status === 404) {
          // Commit might be a merge commit or deleted
          console.warn(`    Skipping commit ${sha.substring(0, 8)}: ${error.message}`);
          return { additions: 0, deletions: 0, total: 0, files: [], truncated: false };
        }
        
        if (attempt === maxRetries) {
          console.error(`    Failed to fetch commit ${sha.substring(0, 8)} after ${maxRetries} attempts:`, error.message);
          return { additions: 0, deletions: 0, total: 0, files: [], truncated: false };
        }
        
        console.warn(`    Retry ${attempt}/${maxRetries} for commit ${sha.substring(0, 8)}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  shouldIncludeFile(filename) {
    // Enhanced filtering for large repositories
    const excludePatterns = [
      // Lock files
      /package-lock\.json$/,
      /yarn\.lock$/,
      /pnpm-lock\.yaml$/,
      /composer\.lock$/,
      /Gemfile\.lock$/,
      /poetry\.lock$/,
      /Pipfile\.lock$/,
      
      // Minified files
      /\.min\.(js|css)$/,
      /\.bundle\.(js|css)$/,
      
      // Source maps
      /\.map$/,
      
      // Build/dist directories
      /^(dist|build|out|target|bin|obj)\//, 
      /node_modules\//,
      /vendor\//,
      /__pycache__\//,
      /\.pytest_cache\//,
      
      // Generated files
      /\.generated\./,
      /\.auto\./,
      /^generated\//,
      
      // Documentation builds
      /^docs\/_build\//,
      /^site\//,
      
      // IDE files
      /\.vscode\//,
      /\.idea\//,
      
      // Large data files that shouldn't count as code
      /\.(jpg|jpeg|png|gif|svg|ico|pdf|zip|tar|gz|rar|7z|exe|dmg)$/,
      /\.(mp4|avi|mov|wmv|mp3|wav|ogg)$/,
      
      // Database files
      /\.(db|sqlite|sqlite3)$/,
      
      // Log files
      /\.(log|logs)$/,
      /^logs\//
    ];
    
    return !excludePatterns.some(pattern => pattern.test(filename));
  }

  async calculateLOCForYear(targetRepo = null) {
    const since = new Date(`${this.year}-01-01T00:00:00Z`);
    const until = new Date(`${this.year}-12-31T23:59:59Z`);
    
    console.log(`Calculating lines of code for ${this.year}...`);
    console.log(`Date range: ${since.toISOString()} to ${until.toISOString()}`);
    console.log(`Rate limiting: max ${this.maxRequestsPerHour} requests/hour\n`);
    
    let repos = [];
    let analysisMode = 'all';
    
    if (targetRepo) {
      // Single repository mode
      analysisMode = 'single';
      console.log(`Single repository mode: ${targetRepo}`);
      const repo = await this.getRepositoryByName(targetRepo);
      if (!repo) {
        throw new Error(`Repository '${targetRepo}' not found`);
      }
      repos = [repo];
    } else {
      // All repositories mode
      console.log(`All repositories mode`);
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
      analysisMode: analysisMode
    };
    
    console.log(`\nProcessing ${repos.length} repository${repos.length === 1 ? '' : 'ies'}...\n`);
    
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      const progress = ((i + 1) / repos.length * 100).toFixed(1);
      console.log(`\n[${progress}%] Repository ${i + 1}/${repos.length}`);
      
      const result = await this.processRepository(repo, since, until);
      
      if (result.success) {
        results.processingStatus.successful++;
        results.totalAdditions += result.stats.additions;
        results.totalDeletions += result.stats.deletions;
        results.totalCommits += result.stats.commits;
        results.runtimeStats.truncatedCommits += result.stats.truncatedCommits || 0;
        
        results.repoStats.push({
          name: repo.full_name,
          additions: result.stats.additions,
          deletions: result.stats.deletions,
          netLines: result.stats.netLines,
          commits: result.stats.commits,
          sizeKB: repo.size,
          truncatedCommits: result.stats.truncatedCommits || 0
        });
      } else {
        results.processingStatus.failed++;
        results.processingStatus.failedRepos.push(repo.full_name);
        console.error(`  ❌ Failed to process ${repo.full_name}: ${result.error}`);
      }
    }
    
    results.netLines = results.totalAdditions - results.totalDeletions;
    results.runtimeStats.totalApiCalls = this.requestCount;
    
    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PROCESSING SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Analysis mode: ${analysisMode}`);
    console.log(`Total repositories: ${repos.length}`);
    console.log(`Successfully processed: ${results.processingStatus.successful}`);
    console.log(`Failed to process: ${results.processingStatus.failed}`);
    
    if (results.processingStatus.failed > 0) {
      console.log(`\nFailed repositories:`);
      results.processingStatus.failedRepos.forEach(repo => {
        console.log(`  - ${repo}`);
      });
    }
    
    return results;
  }

  async saveResults(results) {
    // Create reports directory if it doesn't exist
    const reportsDir = './reports';
    try {
      await fs.mkdir(reportsDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error('Error creating reports directory:', error.message);
      }
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${reportsDir}/github-loc-${this.username}-${this.year}-${timestamp}.json`;
    
    await fs.writeFile(filename, JSON.stringify(results, null, 2));
    console.log(`\nDetailed results saved to: ${filename}`);
    
    // Also save a summary file
    const summaryFilename = `${reportsDir}/github-loc-summary-${this.username}-${this.year}-${timestamp}.txt`;
    const summary = this.generateTextSummary(results);
    await fs.writeFile(summaryFilename, summary);
    console.log(`Summary saved to: ${summaryFilename}`);
    
    return { detailsFile: filename, summaryFile: summaryFilename };
  }

  generateTextSummary(results) {
    let summary = `GitHub Lines of Code Analysis for ${this.username} (${this.year})\n`;
    summary += '='.repeat(60) + '\n\n';
    
    summary += `Analysis Date: ${results.processedAt}\n`;
    summary += `Analysis Mode: ${results.analysisMode === 'single' ? 'Single Repository' : 'All Repositories'}\n`;
    summary += `Total API Calls Made: ${results.runtimeStats.totalApiCalls.toLocaleString()}\n\n`;
    
    summary += `OVERALL STATISTICS:\n`;
    summary += `- Total Lines Added: ${results.totalAdditions.toLocaleString()}\n`;
    summary += `- Total Lines Deleted: ${results.totalDeletions.toLocaleString()}\n`;
    summary += `- Net Lines of Code: ${results.netLines.toLocaleString()}\n`;
    summary += `- Total Commits: ${results.totalCommits.toLocaleString()}\n`;
    summary += `- Repositories Analyzed: ${results.repoStats.length}\n\n`;
    
    // Processing status
    if (results.processingStatus) {
      summary += `PROCESSING STATUS:\n`;
      summary += `- Successfully processed: ${results.processingStatus.successful} repositories\n`;
      summary += `- Failed to process: ${results.processingStatus.failed} repositories\n\n`;
      
      if (results.processingStatus.failed > 0) {
        summary += `FAILED REPOSITORIES:\n`;
        results.processingStatus.failedRepos.forEach(repo => {
          summary += `- ${repo}\n`;
        });
        summary += `\n`;
      }
    }
    
    if (results.runtimeStats.truncatedCommits > 0) {
      summary += `WARNINGS:\n`;
      summary += `- ${results.runtimeStats.truncatedCommits} commits had truncated data due to size\n\n`;
    }
    
    summary += `TOP 10 REPOSITORIES BY LINES ADDED:\n`;
    const topRepos = results.repoStats
      .sort((a, b) => b.additions - a.additions)
      .slice(0, 10);
    
    topRepos.forEach((repo, index) => {
      summary += `${index + 1}. ${repo.name}: +${repo.additions.toLocaleString()} lines (${repo.commits} commits)\n`;
    });
    
    summary += `\nTOP 10 FILE TYPES BY LINES ADDED:\n`;
    const topFileTypes = Object.entries(results.fileTypeStats)
      .sort(([,a], [,b]) => b.additions - a.additions)
      .slice(0, 10);
    
    topFileTypes.forEach(([ext, stats], index) => {
      summary += `${index + 1}. .${ext}: +${stats.additions.toLocaleString()} lines\n`;
    });
    
    return summary;
  }

  printSummary(results) {
    console.log('\n' + '='.repeat(60));
    console.log(`GITHUB LINES OF CODE SUMMARY FOR ${this.year}`);
    console.log('='.repeat(60));
    
    // Analysis mode
    if (results.analysisMode) {
      console.log(`Analysis Mode: ${results.analysisMode === 'single' ? 'Single Repository' : 'All Repositories'}`);
    }
    
    console.log(`Total Lines Added: ${results.totalAdditions.toLocaleString()}`);
    console.log(`Total Lines Deleted: ${results.totalDeletions.toLocaleString()}`);
    console.log(`Net Lines of Code: ${results.netLines.toLocaleString()}`);
    console.log(`Total Commits: ${results.totalCommits.toLocaleString()}`);
    console.log(`Repositories Analyzed: ${results.repoStats.length}`);
    console.log(`Total API Calls: ${results.runtimeStats.totalApiCalls.toLocaleString()}`);
    
    // Processing status
    if (results.processingStatus) {
      console.log(`\nProcessing Status:`);
      console.log(`✅ Successfully processed: ${results.processingStatus.successful} repositories`);
      console.log(`❌ Failed to process: ${results.processingStatus.failed} repositories`);
      
      if (results.processingStatus.failed > 0) {
        console.log(`\nFailed repositories:`);
        results.processingStatus.failedRepos.forEach(repo => {
          console.log(`  - ${repo}`);
        });
      }
    }
    
    if (results.runtimeStats.truncatedCommits > 0) {
      console.log(`\n⚠️  ${results.runtimeStats.truncatedCommits} commits had truncated data`);
    }
    
    console.log('\nTop Repositories by Lines Added:');
    const topRepos = results.repoStats
      .sort((a, b) => b.additions - a.additions)
      .slice(0, 10);
    
    topRepos.forEach((repo, index) => {
      const sizeInfo = repo.sizeKB ? ` (${(repo.sizeKB / 1024).toFixed(1)} MB)` : '';
      const truncatedInfo = repo.truncatedCommits > 0 ? ` ⚠️${repo.truncatedCommits} truncated` : '';
      console.log(`${index + 1}. ${repo.name}: +${repo.additions.toLocaleString()} lines${sizeInfo}${truncatedInfo}`);
    });
    
    console.log('\nTop File Types by Lines Added:');
    const topFileTypes = Object.entries(results.fileTypeStats)
      .sort(([,a], [,b]) => b.additions - a.additions)
      .slice(0, 10);
    
    topFileTypes.forEach(([ext, stats], index) => {
      console.log(`${index + 1}. .${ext}: +${stats.additions.toLocaleString()} lines`);
    });
  }
}

// Main execution function
async function main() {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
  const ANALYSIS_YEAR = process.env.ANALYSIS_YEAR || '2025';
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  const targetRepo = args[0] || null;
  
  if (!GITHUB_TOKEN || !GITHUB_USERNAME) {
    console.error('❌ Missing required environment variables!');
    console.error('');
    console.error('Please configure your GitHub credentials:');
    console.error('');
    console.error('Option 1 - Using .env file (recommended):');
    console.error('1. Copy env.example to .env');
    console.error('2. Edit .env and set your credentials:');
    console.error('   GITHUB_TOKEN=your_github_token_here');
    console.error('   GITHUB_USERNAME=your_github_username');
    console.error('');
    console.error('Option 2 - Using environment variables:');
    console.error('export GITHUB_TOKEN=your_github_token_here');
    console.error('export GITHUB_USERNAME=your_github_username');
    console.error('');
    console.error('Get your GitHub token at: https://github.com/settings/tokens');
    process.exit(1);
  }
  
  try {
    console.log('GitHub Large Repository LOC Calculator');
    console.log('====================================');
    console.log(`Target user: ${GITHUB_USERNAME}`);
    console.log(`Analysis year: ${ANALYSIS_YEAR}`);
    if (targetRepo) {
      console.log(`Target repository: ${targetRepo}`);
    } else {
      console.log(`Target: All repositories`);
    }
    console.log(`Start time: ${new Date().toISOString()}\n`);
    
    const calculator = new GitHubLOCCalculator(GITHUB_TOKEN, GITHUB_USERNAME, parseInt(ANALYSIS_YEAR));
    const results = await calculator.calculateLOCForYear(targetRepo);
    
    calculator.printSummary(results);
    await calculator.saveResults(results);
    
    const duration = (Date.now() - calculator.startTime) / 1000 / 60;
    console.log(`\nAnalysis completed in ${duration.toFixed(1)} minutes`);
    
  } catch (error) {
    console.error('Error during analysis:', error);
    if (error.status === 403) {
      console.error('\nThis might be a rate limiting issue. Try running again later or with a higher rate limit.');
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = GitHubLOCCalculator;