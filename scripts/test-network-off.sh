#!/bin/sh
set -eu
# A network namespace with only loopback also contains test subprocesses. Drop back to the
# invoking account before Vitest so filesystem permission tests run as a normal user.
test_account="$(id -un)"
test_node="$(command -v node)"
test_npm="$(command -v npm)"
if [ "$(uname -s)" != Linux ] || [ "$(id -u)" = 0 ]; then
  echo 'test-network-off.sh requires Linux and a normal invoking user' >&2
  exit 1
fi
sudo unshare --net /bin/sh -eu -c '
  ip link set lo up
  exec runuser -u "$1" -- env PATH="$2" GITHUB_ACTIONS="$5" CI="$6" VIBECTX_REQUIRE_NETWORK_ISOLATION=1 "$3" "$4" test
' sh "$test_account" "$PATH" "$test_node" "$test_npm" "${GITHUB_ACTIONS-}" "${CI-}"
