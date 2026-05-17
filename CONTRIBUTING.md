# Contributing to CrabMeat

Thanks for your interest. CrabMeat is security-first, and that shapes how contributions
are reviewed. This isn't meant to be gatekeeping; it's meant to keep the project honest
about what it promises.

---

## Ways to contribute

1. **File a bug report** — anything the gateway does that contradicts the README.
2. **File a security report** — see the section below.
3. **Request a tool** — see the tool request template below.
4. **Submit a PR** — for tools, bug fixes, tests, or docs.

---

## Security reports

If you've found something that looks like a security issue (auth bypass, sandbox escape,
prompt injection primitive that gets past the existing rails, SSRF regression, secret leak
in output), please open an issue and tag it as a security report. If the issue is sensitive
enough that public disclosure would hurt users, say so in the first line of the issue and
hold off on details until a maintainer replies with a private channel.

Red team reports are welcome and encouraged. CrabMeat was built assuming adversarial LLMs,
adversarial inputs, and adversarial tool outputs; proving those assumptions wrong is a
gift.

---

## Requesting a tool

Open an issue titled `Tool request: <name>` and include all of the following. Issues
missing any of these sections will be asked to fill them in before review.

### Template

```markdown
## Tool name
<short identifier, e.g. `pdf_extract`>

## What it does
<one paragraph: what the LLM can accomplish with this tool>

## Effect class
<one of: read, write, exec, network, none>

Justify the choice. If it touches the filesystem, the network, or a subprocess, say so
explicitly.

## Why existing tools don't cover this
<which built-ins come close, and what's missing>

## Threat model
Answer each of these:

1. What happens if the LLM is compromised and calls this tool with adversarial arguments?
2. What happens if the tool's *output* contains a prompt injection?
3. Does this tool introduce any new trust boundaries (new network destinations, new
   filesystem locations, new subprocesses)?
4. Can this tool be misused to exfiltrate session context or secrets?
5. What's the blast radius if the worst case happens?

## Proposed default
<on-by-default, opt-in, or opt-in with warning, and why>

## Dependencies
<any new npm packages, native binaries, or external services required>
```

### What gets accepted

A tool is likely to be accepted if:

- It fits cleanly into an existing effect class
- Its default is "off" or "safe on"
- Its failure modes are bounded (size caps, timeouts, jailed paths, SSRF filters)
- It doesn't require the LLM to be trusted
- It has a clear reason the existing built-ins don't already cover the use case

A tool is likely to be rejected if:

- It requires the LLM to enforce its own safety
- Its "safe" version is dramatically less useful than its "unsafe" version (a sign the
  abstraction is wrong)
- It phones home to a remote service by default
- It introduces auto-execution of remote code
- Its failure mode is "ships user context somewhere unexpected"

---

## Submitting a PR

- Run `npm run typecheck && npm test` before pushing. CI won't accept anything red.
- New tools must ship with tests, including at least one adversarial test (malformed
  args, path traversal attempt, SSRF attempt, whichever applies).
- New security-relevant code needs a comment explaining *why* the check exists, not just
  what it does. Six months from now someone will be tempted to simplify it; the comment
  is for them.
- Keep PRs focused. A tool addition is one PR. A refactor is a different PR. Bundled
  changes get harder to review and harder to revert.
- Don't add features, refactors, or "improvements" outside the scope of your PR.

### Commit style

Short, imperative subject lines. Explain the *why* in the body if it isn't obvious.

```
Add pdf_extract tool with size cap and page limit

Needed for document ingestion workflows. Wrapped in `read` effect class;
path traversal blocked via existing jailPath(). 50MB size cap, 200-page
cap, timeout 10s. Tests cover malformed PDFs and oversized inputs.
```

---

## Code of conduct

Be technical, be direct, be kind. Disagree with ideas, not people. If a maintainer says
no to something, ask for the reasoning. Don't assume bad faith. The reasoning should
always be available; if it isn't, that's a bug in the review process and worth flagging.

---

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers the rest of the project.
