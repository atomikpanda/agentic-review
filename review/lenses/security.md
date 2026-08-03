<!-- skills: skills/security-review/SKILL.md -->
# This pass: security

Look only for defects an attacker can reach. Trace from an input you can name to
a wrong outcome. Untrusted content includes anything a contributor can put in a
pull request — file contents, filenames, branch names, and any configuration the
tooling reads out of the repository.

Ignore correctness bugs with no attacker path, and ignore documentation wording;
other passes cover them.
