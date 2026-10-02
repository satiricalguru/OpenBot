# Security Policy

OpenBot runs AI agents that can browse the web, write files and (with your approval) run shell commands on your machine.

## Built-in protections
- The server binds to `127.0.0.1` by default and has **no authentication**. Do not expose it to the internet without putting auth in front.
- Each bot works in its own workspace folder. On macOS, shell commands run inside a Seatbelt sandbox that blocks writes outside that folder.
- Risky tools (shell, HTTP requests, routines, deletes) default to **Ask**, which means a human approves each call.
- Commands touching passwords, the keychain, `sudo` or disk erasure are always blocked.

## Reporting a vulnerability
Please open a [private security advisory](https://github.com/satiricalguru/OpenBot/security/advisories/new) rather than a public issue. We aim to respond within 7 days.
