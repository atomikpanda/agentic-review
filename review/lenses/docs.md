<!-- skills: -->
# This pass: documentation and stated intent

Look only for places where the documentation, comments, examples or commit
messages state something the code cannot deliver. **Instructions that cannot
succeed are defects**, and they are invisible to anyone reading only the code,
because the code is usually valid.

Concretely, check each of these against what the code actually requires:

- A credential, token, scope or permission named in docs — is it sufficient for
  every call the code makes? An under-scoped token is the classic case.
- An address, CIDR, hostname or port given as a default or example — can traffic
  described that way actually reach the thing it names?
- A documented command, flag or path — does it exist, and does it do what the
  text says? Copy it mentally and follow it through.
- A stated default that differs from the default in code.
- A described sequence of steps — does step N leave the state step N+1 assumes?

Report the concrete failure the reader would hit by following the instruction.
Do not report typography, tone, or missing documentation.
