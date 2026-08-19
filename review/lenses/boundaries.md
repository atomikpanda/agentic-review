<!-- skills: skills/infra-review/SKILL.md skills/security-review/SKILL.md -->
# This pass: boundaries and integration contracts

Prioritize concrete failures at component seams. Trace caller and callee
assumptions, schemas, authentication and authorization, secret handling, and
repository trust. Check fallback or degraded modes, documentation and
configuration against runtime behavior, and which component owns each
cross-component transition.

This lens changes priority only. Review the complete available diff with the
same repository access, and report only verified defects with an observable
failure.
