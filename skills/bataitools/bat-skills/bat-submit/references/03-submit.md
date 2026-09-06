# Step 3 — Pack and Submit

Once all 28 language JSON files (`i18n/*.json`) and metadata files (`base.json`) are finalized, perform packing, validation, and submission.

---

## 3.1 Authentication

Before submitting, you must authenticate using the CLI (pick one):
- Guest (no browser): `bat-cli login guest`
- Formal account (OAuth, like `gh auth login`): `bat-cli login`
- API key (CI): `bat-cli login --key <your-api-key>`

---

## 3.2 CLI Commands

You can run each sub-step individually or execute them in a single command.

### Option A: Manual Step-by-Step (Recommended for debugging)

1. **Pack the directory** into a single bundle file:
   ```bash
   bat-cli pack <submit-dir> -o <submit-dir>/submit.bundle.json
   ```
2. **Validate the bundle file** against API schemas and platform constraints:
   ```bash
   bat-cli validate -f <submit-dir>/submit.bundle.json
   ```
3. **Submit the bundle file** to the platform:
   ```bash
   bat-cli submit -f <submit-dir>/submit.bundle.json
   ```

### Option B: All-in-One Command

To execute packing, validation, and submission in a single run:
```bash
bat-cli submit --dir <submit-dir>
```

---

## 3.3 Asset Handling

Logo and website screenshot are **optional** in the Agent submit bundle. The BAT server automatically enriches missing assets asynchronously after the product is published (via `bat-crawl`).

---

## 3.4 Check Submission Status

Once submitted, retrieve the submission ID (`submitId`) from the command output, and poll the processing status:

```bash
bat-cli status --id <submitId>
```

The platform will review and process the bundle. Make sure to monitor this status until it is marked as processed or returns an error.

---

## 3.5 Troubleshooting & Failure Diagnostics

If `bat-cli submit` fails (due to validation errors, API permissions, `NO_CHANGES_DETECTED`, etc.):

1. `bat-cli` automatically writes a detailed error report to `<submit-dir>/last-error.json` (and appends to `<submit-dir>/error.log`).
2. Run `bat-cli log <submit-dir>` to print formatted error diagnostics directly in the terminal:
   ```bash
   bat-cli log <submit-dir>
   ```
3. Coding Agents must inspect `<submit-dir>/last-error.json` or run `bat-cli log <submit-dir>` when a submission fails to read the exact error code, validation details, and recommended steps (`What to do`) for self-correction.

