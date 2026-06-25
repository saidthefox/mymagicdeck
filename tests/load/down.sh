#!/usr/bin/env bash
# Tear down the load-test instance and wipe its throwaway data. (Prod is untouched regardless.)
set -euo pipefail
docker rm -f mmd-loadtest-api >/dev/null 2>&1 || true
rm -f /srv/data/mmd-loadtest/*.db /srv/data/mmd-loadtest/users.json 2>/dev/null || true
echo "torn down. (image mmd-loadtest-api left cached; 'docker rmi mmd-loadtest-api' to remove)"
