---
name: infra-review
description: Use when reviewing infrastructure-as-code — Caddy, cloud-init, Terraform, Docker Compose, shell setup scripts, GitHub Actions. Encodes tool-default behaviours that look correct in a diff but fail silently in production.
---

# Infrastructure review — silent-failure catalogue

Every item below is a real defect that shipped to a review, passed a reading of
the diff, and was only caught because someone knew how the tool behaves. None
are discoverable from the diff alone.

**The unifying failure mode: config that looks correct and does nothing.** When
reviewing, ask of each change — *if this silently did nothing, what would the
symptom be?* If the answer is "nothing visible", flag it.

## Caddy / reverse proxies

- **`trusted_proxies` without `trusted_proxies_strict` is an auth bypass.**
  Caddy takes the **leftmost** `X-Forwarded-For` entry as `client_ip`. CDNs
  *append* the real client to whatever XFF the caller sent, so any attacker can
  prepend an allowlisted IP and satisfy a `client_ip` matcher. If a config
  trusts proxy ranges and matches on `client_ip`, strict mode is mandatory.
- **`remote_ip` vs `client_ip`.** Behind any proxy, `remote_ip` is the proxy.
  Source-IP rules must use `client_ip` *and* declare `trusted_proxies`.
- **Never `encode` an SSE endpoint**, and set `flush_interval -1`. Compression
  and proxy buffering make long-lived event streams stall — the symptom is a
  client that hangs rather than an error.
- **Matcher order decides exposure.** A public rule listed before a restrictive
  one wins. Where a route has a wildcard path segment (`/:user/thing`), verify
  it cannot match an admin path such as `/api/thing`.

## cloud-init

- **`runcmd` runs as `/bin/sh` with no `set -e`.** Every failure is logged and
  stepped over; bootstrap "succeeds" regardless. Any cloud-config whose runcmd
  lacks `set -e` cannot claim a failure is fatal.
- **`final_message` prints even when runcmd aborted.** It cannot be used as a
  success signal — require a marker file written as the last verified step.
- **`user_data` is readable for the droplet's lifetime** from the metadata
  service by *any* process, including containers running third-party code.
  Never place a long-lived credential there; one-off/single-use tokens only.
- **`|| true` on a clone or install hides real failures.** Guard on the specific
  idempotent case (`test -d …/.git ||`) instead of blanket-suppressing.
- **Changing user_data does nothing to a running instance** — first boot only.

## Terraform

- **A gitignored `terraform.tfvars` does not exist in CI.** Every variable
  without a default must then come from `TF_VAR_*`, or plan/apply fails — and
  `-input=false` means it cannot prompt.
- **`TF_VAR_` names are case-sensitive** and must match the variable exactly.
  `TF_VAR_MY_VAR` does not bind `variable "my_var"`.
- **Backends cannot use variables.** A hardcoded bucket is a manual edit for
  every user; prefer a generated `-backend-config` file.
- **List variables passed via environment must be valid HCL/JSON.** A bare
  string is a type error.
- **Commit `.terraform.lock.hcl`** so CI resolves the tested provider versions.

## Firewalls and overlay networks

- **A cloud firewall filters the public interface only.** WireGuard-based
  overlays (Tailscale etc.) arrive as UDP and are decapsulated *inside* the
  host, past the firewall. A rule like `tcp/22 from 100.64.0.0/10` therefore
  matches nothing — a packet claiming that source on the public interface is a
  martian. Tailnet-only SSH means opening **no** port, not a narrow one.
- **An overlay IP range only appears when traffic arrives over the overlay.**
  Connecting to a public hostname presents the client's public address, so a
  `100.64.0.0/10` allowlist rejects the very admins it was meant to admit
  unless split DNS points the hostname at the overlay address.
- **Two firewalls means two sources of truth.** If a cloud firewall owns
  ingress, host firewalls must be disabled, not merely unused.

## Agents, bouncers, and anything with a shared key

- **Installed ≠ enforcing.** A package that installs and auto-starts with a
  default key will sit `active` while failing authentication — enforcing
  nothing while `systemctl is-active` reports success. If a component needs a
  shared secret it cannot have at install time, it must be left **stopped and
  disabled**, and started only after the key is written.

## Shell and setup scripts

- **`printf "$var"` treats data as a format string.** Any `%s` in user content
  (an SSH key comment, a path) silently mutates output. Use `printf '%s'` or a
  serializer such as `jq`.
- **`.` / `source` searches `PATH` when the argument contains no slash.** A
  bare relative filename like `.setup.env` must be given a `./` prefix — but an
  absolute path must not be.
- **Never `eval` a user-supplied path.** An apostrophe aborts the script. Expand
  a leading `~` explicitly.
- **Writing shell values with raw single quotes breaks on apostrophes.** Use
  `printf '%q'`, and read back by sourcing so the escaping round-trips.
- **A validation step that writes `.env` then deletes it destroys real
  secrets.** Only create what does not exist; only remove what you created.
- **S3-compatible APIs: `BucketAlreadyOwnedByYou` is idempotent success.
  `BucketAlreadyExists` means another account owns the name** — treating it as
  success points config at an unreadable bucket.

## Docker

- **`COPY` dereferences symlinks.** Copying a global npm binary produces a real
  file outside its package, so `require` resolves from the wrong directory. The
  image builds and fails only at runtime. Recreate the link instead.
- **Native-module installs fall back to compiling from source** when a prebuilt
  binary cannot be downloaded. A slim base with no toolchain then fails
  intermittently, only under poor network. Give the builder stage a toolchain.
- **A single-file bind mount over a config the app rewrites** works only if the
  app writes in place; an atomic rename-based write breaks it.

## CI/CD

- **`workflow_run` does not deploy the commit that passed.** `git reset --hard
  origin/main` ships whatever the tip is now; if another commit landed while
  validation ran, unvalidated code deploys. Use `workflow_run.head_sha`.
- **A health check that tests `State.Status` only** passes a container that is
  `running` but `unhealthy`. Evaluate `State.Health.Status`, and allow a settle
  period so `starting` is not misread.
- **A GitHub environment with no protection rule is not a gate.** It exists,
  approves nothing, and the job runs unattended.
- **Path-based secret scanning that excludes `*.example` or `.github/**`** will
  miss a real key pasted there. Detect placeholder *content* instead.

## CLI tools invoked from scripts and CI

- **"It reads stdin" is an assumption, not a fact — verify it.** A CLI that
  takes a prompt or payload may only read piped stdin behind a guard like
  `if (process.stdin.isTTY !== false) return`. On both node and bun that
  property is `undefined` for a redirect *or* a pipe — it is never `false` —
  so the guard always returns early and the input is silently discarded. The
  program then has no work, does it successfully, and **exits 0 having produced
  nothing**. `cmd < input.txt` in a workflow is worth checking against the
  tool's actual argument handling; the alternative is usually a positional
  argument or an `@file` form.
- **Exit 0 with empty output is not success.** Any step that captures a
  command's stdout to a file must assert the file is non-empty before treating
  it as a result. Without that assertion, "produced a correct empty answer" and
  "never ran" are the same green check — and the second is far more likely.
- **Check what an approval or confirmation flag actually maps to.** A name like
  `always-ask` can be the *tightest* setting rather than an interactive one
  (auto-approving a read tier while blocking write and exec), and the default
  when the flag is omitted can be the most permissive one. Read the mapping
  before assuming the safe-sounding name is the safe behaviour.
- **A runtime is a hard dependency when the entrypoint names it.** A `#!/usr/bin/env bun`
  shebang plus `bun:` imports means node cannot run the tool at all — a
  `node`/`npx` fallback in a script is dead code that fails with an error
  pointing nowhere near the cause. Honour `engines` too: a too-old runtime can
  surface as a minified `SyntaxError`.

## Documentation is reviewable

Two real defects were found in prose, not code: an API token scope that was
insufficient for a call made in a script three directories away, and a
documented default that could never work. **Instructions that cannot succeed
are bugs.** Check that stated credentials, scopes, and commands match what the
code actually requires — and that referenced commands exist.
