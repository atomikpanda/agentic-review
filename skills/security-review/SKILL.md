---
name: security-review
description: Use when reviewing application code for security defects — services, APIs, mobile and web clients. Vulnerability classes stated as trigger plus the evidence that confirms them, with an explicit bar for what must not be reported.
---

# Security review — classes, and what confirms them

Each entry below is a **trigger** (what makes the class possible) and a
**confirmation** (what you must be able to point at before reporting it). The
confirmation is the load-bearing half. Naming a class is not a finding; a path
from attacker-controlled input to a wrong outcome is.

Three rules govern everything here:

1. **State the failure before the class.** Write the input or condition and the
   wrong behaviour that results. Only then name the class, if it helps. A report
   that leads with a class name and never reaches a concrete path is noise.
2. **Trace to a source you can name.** "Untrusted input" means you can say where
   it enters: a request parameter, a filename in an archive, an environment
   variable, a field in a webhook body, a file in the repository under review.
   If you cannot name the entry point, you have a code smell, not a finding.
3. **Say what an attacker can actually do.** If exploiting it requires
   privileges that would already let them do the damage directly, it is not a
   finding. Harm must land on someone other than the attacker.

## Injection — command, SQL, template, argument
<!-- when: *.py, *.ts, *.tsx, *.js, *.jsx, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift, *.sh -->

- **Trigger.** A string reaches an interpreter: a shell, a SQL engine, a
  template renderer, an `exec`/`spawn` argument list, an `eval`.
- **Confirms it.** The interpolated value originates outside the program and is
  not escaped by the mechanism actually used. Parameterised queries and argv
  arrays are not vulnerable merely because a variable appears in them — the
  question is whether the value can change the *structure* of what is executed.
- **Not a finding.** A constant, a value the program itself just produced, or a
  value already validated against an allowlist on every reachable path.

## Argument and option injection
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift, *.sh, *.mjs -->

- **Trigger.** Attacker-influenced text placed in an argument list, even without
  a shell.
- **Confirms it.** The value can begin with `-` or `--` and the target program
  has a flag that changes behaviour dangerously, or the list lacks a `--`
  terminator before positional arguments. This survives "we avoided the shell".

## Path traversal and unsafe extraction
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift, *.sh, *.mjs -->

- **Trigger.** A path is built from input: an upload name, an archive entry, a
  URL path segment, a config value.
- **Confirms it.** The joined path can escape its intended root — `..`, an
  absolute path, a symlink in an extracted archive, or normalisation that runs
  *before* validation. Check the order: validating a path and then resolving it
  is the wrong way round.

## TOCTOU and race conditions
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift, *.sh, *.mjs -->

- **Trigger.** A check followed by a use of the same resource: `exists` then
  `open`, permission test then act, read-modify-write on shared state.
- **Confirms it.** You can name **what changes in the window** and **who can
  change it**. For files: another process or a symlink swap between check and
  use. For shared memory: two callers reaching the same mutable state without a
  lock, and the interleaving that produces a wrong value.
- **Not a finding.** Any check-then-use where the resource is process-local and
  nothing else can reach it. This class is heavily over-reported; the window and
  the actor are mandatory.

## Authorization gaps
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift -->

- **Trigger.** More than one code path reaches the same resource, or an
  identifier from the request selects a record.
- **Confirms it.** One path performs the check and another does not, and you can
  name both. Or: the handler uses an id from the request without constraining it
  to the caller's scope. Authentication answers *who*; this class is about
  *whether they may* — a route behind login can still expose another tenant.

## Server-side request forgery and unvalidated redirects
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift -->

- **Trigger.** A URL, host or port from input reaches a fetch, a webhook, a
  redirect, or a metadata lookup.
- **Confirms it.** The destination is not constrained to an allowlist, and
  reaching internal addresses has consequence — cloud metadata endpoints,
  internal services, or loopback admin ports. Note that a check on the *original*
  URL does not survive a redirect the client follows.

## Deserialization and dynamic loading
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift -->

- **Trigger.** Untrusted bytes become objects, or a name from input selects code
  to load: pickle, Java/`ObjectInputStream`, YAML with arbitrary tags, `NSCoding`
  without secure coding, reflection on a class name, a plugin path.
- **Confirms it.** The format can instantiate arbitrary types or invoke code
  during construction, and the input can reach it. Safe-by-default parsers
  (`yaml.safe_load`, JSON) are not this class.

## Configuration that names something to execute
<!-- when: .github/workflows/**, *.sh, *.json, *.yml, *.yaml, *.toml, *.mjs -->

- **Trigger.** A tool reads configuration **from a directory that untrusted
  content controls**, and that configuration can name a command, a plugin, a
  language server, an MCP server, a hook, or a script.
- **Confirms it.** The tool spawns what the config names. This is arbitrary
  execution, and it usually bypasses whatever sandbox or allowlist the tool
  advertises, because it happens at configuration load — before any permission
  check the tool applies to its own operations.
- **Why it earns its own entry.** It was found live in this project's own
  reviewer: a pull request committing `.omp/mcp.json` executed a command on the
  runner, defeating a read-only tool allowlist entirely. Ask of any tool run
  against untrusted code: *which directory does it treat as "the project", and
  what in there can name a program?*

## Secret exposure
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift, *.sh, *.yml, *.yaml, *.env*, .github/workflows/** -->

- **Trigger.** A credential is placed somewhere with a wider audience than the
  process: a log line, an error message, a URL query string, a build artifact, a
  cloud instance's user-data, a client bundle, a crash report.
- **Confirms it.** Name the reader who should not have it. Cloud metadata is
  readable by every process on the host, including third-party containers; log
  aggregators are usually readable by a wider group than the service's operators.

## Cryptography and randomness
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift -->

- **Trigger.** Hand-rolled crypto, a comparison of secrets, a token generator, a
  key or IV that is constant.
- **Confirms it.** A non-constant-time comparison on a secret, a
  non-cryptographic RNG producing a token or id, a reused IV/nonce, or a
  primitive used outside its contract. Report the consequence — forgeable token,
  distinguishable ciphertext — not the mere presence of a primitive.

## Resource exhaustion
<!-- when: *.py, *.ts, *.js, *.go, *.rb, *.php, *.java, *.kt, *.cs, *.swift -->

- **Trigger.** Input controls an allocation, an iteration count, a recursion
  depth, a decompression ratio, or a regex evaluated against attacker text.
- **Confirms it.** No bound exists on a reachable path, and a modest input
  produces disproportionate work. For regexes, identify the nested quantifier or
  the alternation that backtracks.

## Memory and lifetime (Swift, Kotlin, C-family)
<!-- when: *.swift, *.kt, *.kts, *.c, *.cc, *.cpp, *.h, *.hpp, *.m, *.mm, *.rs -->

- **Trigger.** Unsafe pointer APIs, manual buffer arithmetic, `unowned`
  references, force-unwraps on values crossing a boundary, and concurrency
  primitives around shared mutable state.
- **Confirms it.** A concrete sequence where the referent is gone, the index is
  out of range, or two tasks touch the same state without synchronisation.
  Nullability and force-unwrap complaints are only findings when you can name the
  input that produces the nil.

## What must not be reported

These are the documented failure modes of automated security review, and they
are what makes a reviewer get muted:

- **Class-name findings.** "Potential SQL injection" with no traced value.
- **Pedantic over-checking.** Flagging intermediate variables, or demanding
  validation of a value that was validated one frame up. Follow the call path
  before asking for a check.
- **Findings that require the attacker to already have the outcome.** Root, repo
  write access, or a stolen credential as a precondition for a break that yields
  the same power.
- **Restating a linter.** Anything shellcheck, actionlint, hadolint, tflint,
  trivy, gitleaks or a compiler warning already reports.
- **Unfalsifiable claims.** If you cannot say what evidence would show the
  finding is wrong, it is not ready to report.

## Before reporting anything

Try to refute it. Look for the sanitizer, the guard on the other path, the
framework default, the type constraint that makes the input impossible. Reviews
that skip this step are wrong roughly half the time. If it survives a genuine
attempt at refutation, report it — and say what you checked.
