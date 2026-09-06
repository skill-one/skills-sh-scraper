#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/internal-proxy-env.sh [--settings FILE] [--status] [--token] [--codex-config]

Print shell exports for routing local agent clients through the running
EvoMap Proxy. Intended usage:

  eval "$(scripts/internal-proxy-env.sh)"

The script reads ~/.evolver/settings.json by default and never writes files.
--token prints only the proxy token for command-backed auth.
--codex-config prints a user-level ~/.codex/config.toml snippet without the token.
EOF
}

settings_file="${EVOLVER_SETTINGS_FILE:-}"
status_only=0
token_only=0
codex_config=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --settings)
      if [[ $# -lt 2 ]]; then
        echo "missing value for --settings" >&2
        exit 2
      fi
      settings_file="$2"
      shift 2
      ;;
    --status)
      status_only=1
      shift
      ;;
    --token)
      token_only=1
      shift
      ;;
    --codex-config)
      codex_config=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$settings_file" ]]; then
  settings_dir="${EVOLVER_SETTINGS_DIR:-$HOME/.evolver}"
  settings_file="$settings_dir/settings.json"
fi

script_path="${BASH_SOURCE[0]}"

node - "$settings_file" "$status_only" "$token_only" "$codex_config" "$script_path" <<'NODE'
'use strict';

const fs = require('fs');
const path = require('path');

const settingsFile = process.argv[2];
const statusOnly = process.argv[3] === '1';
const tokenOnly = process.argv[4] === '1';
const codexConfig = process.argv[5] === '1';
const scriptPath = process.argv[6];

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch (err) {
  die(`cannot read proxy settings at ${settingsFile}; start evolver with EVOMAP_PROXY=1 first`);
}

const proxy = parsed && parsed.proxy ? parsed.proxy : null;
if (!proxy || typeof proxy.url !== 'string' || typeof proxy.token !== 'string') {
  die(`no active proxy.url/proxy.token found in ${settingsFile}; start evolver with EVOMAP_PROXY=1 first`);
}

if (statusOnly) {
  console.log(`proxy_url=${proxy.url}`);
  if (proxy.pid != null) console.log(`proxy_pid=${proxy.pid}`);
  if (proxy.started_at) console.log(`proxy_started_at=${proxy.started_at}`);
  process.exit(0);
}

if (tokenOnly) {
  console.log(proxy.token);
  process.exit(0);
}

if (codexConfig) {
  const baseUrl = String(proxy.url).replace(/\/+$/, '') + '/v1';
  const absSettingsFile = path.resolve(settingsFile);
  const absScript = scriptPath ? path.resolve(scriptPath) : '';
  const indexPath = absScript
    ? path.resolve(path.dirname(absScript), '..', 'index.js')
    : path.resolve('index.js');
  console.log('# Add this to user-level ~/.codex/config.toml, then restart Codex.');
  console.log('# The Evolver daemon still needs EVOMAP_OPENAI_API_KEY or OPENAI_API_KEY for upstream.');
  console.log('model_provider = "evomap-proxy"');
  console.log('');
  console.log('[model_providers.evomap-proxy]');
  console.log('name = "EvoMap Proxy"');
  console.log(`base_url = ${JSON.stringify(baseUrl)}`);
  console.log('wire_api = "responses"');
  console.log('');
  console.log('[model_providers.evomap-proxy.auth]');
  console.log(`command = ${JSON.stringify(process.execPath)}`);
  console.log(`args = ${JSON.stringify([indexPath, 'proxy-token', '--settings', absSettingsFile])}`);
  console.log('timeout_ms = 5000');
  console.log('refresh_interval_ms = 300000');
  process.exit(0);
}

console.log(`export ANTHROPIC_BASE_URL=${quote(proxy.url)}`);
console.log(`export ANTHROPIC_AUTH_TOKEN=${quote(proxy.token)}`);
console.log(`export CUSTOM_API_KEY=${quote(proxy.token)}`);
console.log(`export EVOMAP_PROXY_URL=${quote(proxy.url)}`);
NODE
