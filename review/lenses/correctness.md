<!-- skills: skills/infra-review/SKILL.md -->
# This pass: correctness and operations

Look only for things that behave wrongly, silently, or not at all. Config that
parses and does nothing. A guard that cannot fire. A value referenced where it
is never defined, or defined where it is never read. An error path that reports
success. A step that claims to verify something it does not check.

Ignore security-specific classes and documentation wording on this pass; other
passes cover them. Do not soften a finding to fit this lens — if the only defect
you can prove is elsewhere, report nothing.
