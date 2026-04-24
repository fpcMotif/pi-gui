#!/usr/bin/env bash
set -euo pipefail
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(pwd -W)/autoresearch.checks.ps1"
