# Security reporting

If you find a problem in this harness that could also affect the real Agent Passport gateway, please report it privately:

https://github.com/agent-passport-system/agent-passport-gateway/security/advisories/new

Include the gateway commit recorded in `PIN`, the steps or scenario that reproduces the problem and what happened.

Please do not publish a working exploit in a public issue or pull request before it has been reviewed.

If the problem affects only the harness, such as an incorrect fake-node response or a broken test assertion, you can open a normal issue or pull request.

The public gateway currently has Nano payment publishing disabled in source. The harness uses a fake node and does not send transactions to the live Nano network.
