const fs = require('fs');
const path = require('path');
const https = require('https');
const yaml = require('js-yaml');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '');
  options[key] = args[i + 1];
}

const { project, timestamp, type, period } = options;

if (!project || !type) {
  console.error('Usage: node ai-analyzer.js --project <name> --type <single|trend> [--timestamp <ts>] [--period <days>]');
  process.exit(1);
}

// Load configuration
const promptsConfig = yaml.load(fs.readFileSync('config/ai-prompts.yml', 'utf8'));

// Paths
const REPORTS_DIR = 'reports';
const ANALYSIS_DIR = 'analysis';

// Ensure analysis directory exists
const projectAnalysisDir = path.join(ANALYSIS_DIR, project);
if (!fs.existsSync(projectAnalysisDir)) {
  fs.mkdirSync(projectAnalysisDir, { recursive: true });
}

// Call Anthropic API
async function callAnthropicAPI(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable not set');
  }

  const payload = JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt
      }
    ]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
          return;
        }

        try {
          const response = JSON.parse(data);
          resolve(response.content[0].text);
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`API request error: ${e.message}`));
    });

    req.write(payload);
    req.end();
  });
}

// Analyze single report
async function analyzeSingleReport() {
  if (!timestamp) {
    console.error('--timestamp is required for single report analysis');
    process.exit(1);
  }

  console.log(`Analyzing single report: ${project}/${timestamp}`);

  const metadataPath = path.join(REPORTS_DIR, project, timestamp, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    console.error(`Metadata not found: ${metadataPath}`);
    process.exit(1);
  }

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

  // Get previous report for comparison
  const allReports = fs.readdirSync(path.join(REPORTS_DIR, project))
    .filter(name => fs.statSync(path.join(REPORTS_DIR, project, name)).isDirectory())
    .sort()
    .reverse();

  const currentIndex = allReports.indexOf(timestamp);
  let previousMetadata = null;
  if (currentIndex > 0) {
    const previousPath = path.join(REPORTS_DIR, project, allReports[currentIndex + 1], 'metadata.json');
    if (fs.existsSync(previousPath)) {
      previousMetadata = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
    }
  }

  const previousPassRate = previousMetadata ? (previousMetadata.pass_rate || 0) : 0;
  const passRateChange = (metadata.pass_rate || 0) - previousPassRate;

  // Build failed tests details
  let failedTestsDetails = '';
  if (metadata.failed > 0) {
    failedTestsDetails = `\nFailed Tests: ${metadata.failed}\n`;
    if (metadata.failed_tests && Array.isArray(metadata.failed_tests)) {
      failedTestsDetails += metadata.failed_tests.slice(0, 5).map(t => `- ${t}`).join('\n');
      if (metadata.failed_tests.length > 5) {
        failedTestsDetails += `\n... and ${metadata.failed_tests.length - 5} more`;
      }
    }
  }

  // Build prompt from template
  const userPrompt = promptsConfig.single_report.user_prompt_template
    .replace('{project}', project)
    .replace('{timestamp}', timestamp)
    .replace('{run_number}', metadata.run_number || 'N/A')
    .replace('{branch}', metadata.branch || 'N/A')
    .replace('{total_tests}', metadata.total_tests || 0)
    .replace('{passed}', metadata.passed || 0)
    .replace('{failed}', metadata.failed || 0)
    .replace('{pass_rate}', (metadata.pass_rate || 0).toFixed(1))
    .replace('{previous_pass_rate}', previousPassRate.toFixed(1))
    .replace('{pass_rate_change}', (passRateChange > 0 ? '+' : '') + passRateChange.toFixed(1))
    .replace('{failed_tests_details}', failedTestsDetails);

  console.log('Calling Anthropic API...');
  const analysis = await callAnthropicAPI(
    promptsConfig.single_report.system_prompt,
    userPrompt
  );

  // Save analysis
  const analysisPath = path.join(projectAnalysisDir, 'latest-analysis.md');
  const fullAnalysis = `# Analysis for ${project} - Run #${metadata.run_number || 'N/A'}

**Timestamp:** ${timestamp}
**Branch:** ${metadata.branch || 'N/A'}
**Status:** ${metadata.status}
**Pass Rate:** ${(metadata.pass_rate || 0).toFixed(1)}% (${metadata.passed}/${metadata.total_tests})

---

${analysis}

---

*Generated at ${new Date().toISOString()}*
`;

  fs.writeFileSync(analysisPath, fullAnalysis);
  console.log(`✓ Analysis saved to ${analysisPath}`);

  // Also save insights JSON
  const insightsPath = path.join(projectAnalysisDir, 'insights.json');
  const insights = {
    timestamp: new Date().toISOString(),
    project,
    report_timestamp: timestamp,
    metadata,
    analysis_summary: analysis.split('\n')[0], // First line as summary
    pass_rate_change: passRateChange
  };

  fs.writeFileSync(insightsPath, JSON.stringify(insights, null, 2));
  console.log(`✓ Insights saved to ${insightsPath}`);
}

// Analyze trend
async function analyzeTrend() {
  const periodDays = parseInt(period) || 30;
  console.log(`Analyzing trend for ${project} over ${periodDays} days`);

  const projectDir = path.join(REPORTS_DIR, project);
  if (!fs.existsSync(projectDir)) {
    console.error(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  // Get all reports
  const allReports = fs.readdirSync(projectDir)
    .filter(name => fs.statSync(path.join(projectDir, name)).isDirectory())
    .map(timestamp => {
      const metadataPath = path.join(projectDir, timestamp, 'metadata.json');
      if (!fs.existsSync(metadataPath)) return null;

      try {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch (e) {
        return null;
      }
    })
    .filter(m => m !== null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // Oldest first

  if (allReports.length === 0) {
    console.error('No reports found for trend analysis');
    process.exit(1);
  }

  // Filter by period
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const recentReports = allReports.filter(report => {
    const year = report.timestamp.substr(0, 4);
    const month = report.timestamp.substr(4, 2);
    const day = report.timestamp.substr(6, 2);
    const reportDate = new Date(`${year}-${month}-${day}`);
    return reportDate >= cutoffDate;
  });

  if (recentReports.length === 0) {
    console.error(`No reports found in the last ${periodDays} days`);
    process.exit(1);
  }

  // Calculate statistics
  const passRates = recentReports.map(r => r.pass_rate || 0);
  const avgPassRate = passRates.reduce((a, b) => a + b, 0) / passRates.length;
  const sortedRates = [...passRates].sort((a, b) => a - b);
  const medianPassRate = sortedRates[Math.floor(sortedRates.length / 2)];
  const maxPassRate = Math.max(...passRates);
  const minPassRate = Math.min(...passRates);

  const maxReport = recentReports.find(r => (r.pass_rate || 0) === maxPassRate);
  const minReport = recentReports.find(r => (r.pass_rate || 0) === minPassRate);

  // Calculate standard deviation
  const variance = passRates.reduce((sum, rate) => sum + Math.pow(rate - avgPassRate, 2), 0) / passRates.length;
  const stdDev = Math.sqrt(variance);

  // Build historical data string
  const historicalData = recentReports.map(r => {
    const date = `${r.timestamp.substr(0, 4)}-${r.timestamp.substr(4, 2)}-${r.timestamp.substr(6, 2)}`;
    return `${date}: ${(r.pass_rate || 0).toFixed(1)}% (${r.passed}/${r.total_tests})`;
  }).join('\n');

  // Build prompt from template
  const userPrompt = promptsConfig.trend_analysis.user_prompt_template
    .replace('{project}', project)
    .replace('{period_days}', periodDays)
    .replace('{total_runs}', recentReports.length)
    .replace('{historical_data}', historicalData)
    .replace('{avg_pass_rate}', avgPassRate.toFixed(1))
    .replace('{median_pass_rate}', medianPassRate.toFixed(1))
    .replace('{std_dev}', stdDev.toFixed(1))
    .replace('{max_pass_rate}', maxPassRate.toFixed(1))
    .replace('{max_date}', maxReport ? maxReport.timestamp : 'N/A')
    .replace('{min_pass_rate}', minPassRate.toFixed(1))
    .replace('{min_date}', minReport ? minReport.timestamp : 'N/A');

  console.log('Calling Anthropic API...');
  const analysis = await callAnthropicAPI(
    promptsConfig.trend_analysis.system_prompt,
    userPrompt
  );

  // Save trend analysis
  const analysisPath = path.join(projectAnalysisDir, 'trend-analysis.md');
  const fullAnalysis = `# Trend Analysis for ${project}

**Period:** Last ${periodDays} days
**Total Runs:** ${recentReports.length}
**Average Pass Rate:** ${avgPassRate.toFixed(1)}%
**Standard Deviation:** ${stdDev.toFixed(1)}%

---

${analysis}

---

*Generated at ${new Date().toISOString()}*
`;

  fs.writeFileSync(analysisPath, fullAnalysis);
  console.log(`✓ Trend analysis saved to ${analysisPath}`);
}

// Main execution
(async () => {
  try {
    if (type === 'single') {
      await analyzeSingleReport();
    } else if (type === 'trend') {
      await analyzeTrend();
    } else {
      console.error(`Unknown analysis type: ${type}`);
      process.exit(1);
    }

    console.log('Analysis complete!');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();
