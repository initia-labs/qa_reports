# QA Test Reports Dashboard

Centralized dashboard for collecting, analyzing, and visualizing test reports from all QA projects with AI-powered insights and trend analysis.

## Features

- **Multi-View Dashboard**: Project card view and timeline view
- **AI-Powered Analysis**: Automatic analysis of test reports and trend detection
- **Historical Tracking**: Complete test history with trend visualization
- **Report Management**: Manual deletion of invalid reports

## Architecture

```
qa_reports/
├── reports/              # All test reports (auto-collected)
│   ├── {project}/
│   │   └── {timestamp}/
│   │       ├── report.html
│   │       ├── metadata.json
│   │       └── artifacts/
│
├── analysis/             # AI-generated analyses
│   └── {project}/
│       ├── latest-analysis.md
│       ├── trend-analysis.md
│       └── insights.json
│
└── website/              # GitHub Pages site (auto-generated)
    ├── index.html        # Main dashboard
    ├── timeline.html     # Timeline view
    └── projects/         # Project detail pages
```

## Quick Start

### For QA Projects (Pushing Reports)

Add this step to your test workflow:

```yaml
- name: Push Report to qa_reports
  run: |
    git clone https://x-access-token:${{ secrets.QA_REPORTS_TOKEN }}@github.com/initia-labs/qa_reports.git

    # Create report directory
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    REPORT_DIR="qa_reports/reports/${{ github.event.repository.name }}/$TIMESTAMP"
    mkdir -p "$REPORT_DIR"

    # Copy test reports
    cp -r test-results/* "$REPORT_DIR/"

    # Create metadata
    cat > "$REPORT_DIR/metadata.json" << EOF
    {
      "project": "${{ github.event.repository.name }}",
      "timestamp": "$TIMESTAMP",
      "run_number": "${{ github.run_number }}",
      "commit": "${{ github.sha }}",
      "branch": "${{ github.ref_name }}",
      "status": "${{ job.status }}",
      "total_tests": 100,
      "passed": 95,
      "failed": 5,
      "pass_rate": 95.0
    }
    EOF

    # Push to qa_reports
    cd qa_reports
    git config user.name "QA Bot"
    git config user.email "qa@initia.com"
    git add .
    git commit -m "Add report from ${{ github.event.repository.name }} run #${{ github.run_number }}"
    git push
```

### Setting Up Secrets

Each QA project needs a GitHub token:

```bash
gh secret set QA_REPORTS_TOKEN --repo initia-labs/qa-{project}
```

For AI analysis, set up Anthropic API key:

```bash
gh secret set ANTHROPIC_API_KEY --repo initia-labs/qa_reports
```

## Dashboard Views

- **Main Dashboard**: Real-time status of all projects with latest metrics
- **Timeline View**: Chronological test runs with filters
- **Project Detail**: Complete history with trend charts and AI analysis

## AI Analysis

- **Single Report Analysis**: Triggered automatically for each new report
- **Trend Analysis**: Runs weekly for comprehensive historical analysis

## Managing Reports

Delete invalid reports via GitHub Actions:

1. Go to Actions → "Delete Invalid Report"
2. Enter project name and timestamp
3. Provide reason for deletion

## Configuration

Edit `config/dashboard-config.yml` to customize:

```yaml
site:
  title: "QA Test Reports Dashboard"
  update_interval: 300

retention:
  max_reports_per_project: 100
  auto_delete_after_days: 90
```
