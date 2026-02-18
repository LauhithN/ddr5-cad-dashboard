# DDR5 CAD Price Dashboard

Open `index.html` directly in your browser.

## Data source (free)
This dashboard uses two free sources:

1. `RAM Pricing` DDR5 benchmark page (USD baseline)
2. `Bank of Canada` FXUSDCAD daily rates (USD -> CAD conversion)

No paid API key is required.

## Manual refresh
If you want to refresh the data bundle manually:

```bash
python3 build_ddr5_data.py
```

## Monthly auto-refresh (GitHub Actions)
This repo includes:

- `.github/workflows/monthly-data-refresh.yml`
- `.github/workflows/deploy-pages.yml`

How it works:

1. On the 1st day of each month (10:00 UTC), the refresh workflow runs `python ddr5-prices/build_ddr5_data.py`.
2. If `ddr5-prices/ddr5-data.js` changed, it commits and pushes to your default branch.
3. Any push under `ddr5-prices/**` triggers the GitHub Pages deploy workflow.

You can also trigger both workflows manually from the **Actions** tab using **Run workflow**.

## GitHub Pages setup
In your GitHub repo:

1. Go to `Settings -> Pages`
2. Under **Build and deployment**, set **Source** to **GitHub Actions**
3. Push this repo to GitHub

After that, deployments are automatic.
