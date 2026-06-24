# Spawn anvil forking mainnet, run the fork-test suite against it under the
# `fork` foundry profile, then clean up. Requires MAINNET_RPC_URL pointing at
# an upstream mainnet RPC (Alchemy, Infura, Kiln eRPC, …).
#
# Usage:
#   export MAINNET_RPC_URL='https://eth-mainnet.example.com/...'
#   just forge-test-fork
forge-test-fork:
    @bash -c '\
      : "${MAINNET_RPC_URL:?MAINNET_RPC_URL must be set — point at an upstream mainnet RPC}"; \
      anvil --fork-url "$MAINNET_RPC_URL" --port 8546 --quiet & \
      ANVIL_PID=$!; \
      trap "kill $ANVIL_PID 2>/dev/null" EXIT; \
      for i in 1 2 3 4 5 6 7 8 9 10; do \
        if curl -s -o /dev/null -X POST -H "Content-Type: application/json" \
          --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}" \
          http://127.0.0.1:8546; then break; fi; \
        sleep 1; \
      done; \
      cd foundry && FOUNDRY_PROFILE=fork RPC_URL=http://127.0.0.1:8546 forge test -vvv \
    '
