# GitHub Lines of Code Report

A Node.js tool to calculate lines of code contributed to GitHub repositories in a given year.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   # Copy the example environment file
   cp env.example .env
   
   # Edit .env with your GitHub credentials
   nano .env
   ```

3. **Get your GitHub Personal Access Token:**
   - Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
   - Generate a new token with the following scopes:
     - `repo` (Full control of private repositories)
     - `user` (Update ALL user data)
   - Copy the token to your `.env` file

4. **Set your GitHub username:**
   - Add your GitHub username to the `.env` file

## Usage

### Analyze All Repositories
Run the analysis on all your repositories:
```bash
node gh-loc-report.js
```

### Analyze Single Repository
Run the analysis on a specific repository:
```bash
# By repository name
node gh-loc-report.js my-repo-name

# By full repository name
node gh-loc-report.js username/my-repo-name
```

The tool will:
- Fetch all your repositories (handles large numbers of repositories)
- Analyze commits for the specified year (default: 2025)
- Calculate lines of code added/deleted
- Track processing status for each repository
- Generate detailed JSON and summary text files in the `./reports` directory

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | Your GitHub Personal Access Token |
| `GITHUB_USERNAME` | Yes | Your GitHub username |
| `ANALYSIS_YEAR` | No | Year to analyze (defaults to 2025) |

## Output Files

All output files are saved to the `./reports` directory:
- `github-loc-{username}-{year}-{timestamp}.json` - Detailed analysis results
- `github-loc-summary-{username}-{year}-{timestamp}.txt` - Human-readable summary

## Features

### Analysis Modes
- **All Repositories Mode**: Analyzes all repositories in your GitHub account
- **Single Repository Mode**: Analyzes only the specified repository
- **Flexible Repository Naming**: Supports both repository name and full repository name (username/repo-name)

### Repository Processing
- **Comprehensive Repository Discovery**: Fetches all repositories across multiple pages (up to 1000 pages)
- **Repository Search**: Efficiently finds specific repositories by name or full name
- **Processing Status Tracking**: Tracks which repositories were successfully processed vs. failed
- **Error Handling**: Gracefully handles API errors and continues processing other repositories
- **Progress Reporting**: Shows real-time progress as repositories are processed

### Large Repository Support
- **Increased Commit Limits**: Handles up to 5,000 commits per repository (vs. previous 2,000)
- **Rate Limiting Protection**: Built-in rate limiting to avoid GitHub API limits
- **Large Commit Handling**: Properly handles commits with 240,000+ lines of code
- **Truncation Detection**: Identifies and reports when commit data is truncated

### File Filtering
- **Smart File Exclusion**: Automatically excludes generated files, lock files, build artifacts
- **Source Code Focus**: Only counts actual source code files
- **File Type Statistics**: Provides breakdown by file extension

### Performance & Reliability
- **Retry Logic**: Automatic retries for failed API calls
- **Progress Tracking**: Real-time progress updates during processing
- **Memory Efficient**: Processes repositories one at a time to manage memory usage
- **Comprehensive Logging**: Detailed logs for debugging and monitoring

## Testing

Run the test suite:
```bash
npm test
```

Run tests in watch mode:
```bash
npm run test:watch
```

## Processing Status

The tool now tracks processing status for each repository:

- **✅ Successfully Processed**: Repositories that were analyzed completely
- **❌ Failed to Process**: Repositories that encountered errors (with error details)
- **Progress Tracking**: Real-time percentage completion
- **Error Reporting**: Detailed error messages for failed repositories

## Large Repository Handling

The script is optimized for repositories with:
- 240,000+ lines of code
- 5,000+ commits
- Multiple large files
- Complex file structures

## Error Handling

The tool handles various error scenarios:
- API rate limiting
- Network timeouts
- Repository access issues
- Large commit processing
- File truncation
- Non-existent repository errors

All errors are logged and the tool continues processing other repositories.

## Examples

### Analyze all repositories for 2024
```bash
ANALYSIS_YEAR=2024 node gh-loc-report.js
```

### Analyze a specific repository
```bash
node gh-loc-report.js my-awesome-project
```

### Analyze a repository by full name
```bash
node gh-loc-report.js username/my-awesome-project
```

### Analyze all repositories for current year
```bash
node gh-loc-report.js
```
