# Security Policy

FreeMyDisk deletes files and can run actions with administrator rights, so we treat security reports as our highest priority.

## Supported versions

| Version | Supported |
| :--- | :--- |
| Latest release | ✅ |
| Older releases | ❌ — please update (FreeMyDisk updates itself after you approve) |

## Reporting a vulnerability

**Please do not report security problems in public issues, discussions or pull requests.**

Report privately through GitHub: **[Report a vulnerability](https://github.com/fzihak/FreeMyDisk/security/advisories/new)** (Security tab → *Report a vulnerability*).

Please include:

- what an attacker could do, and under which conditions;
- steps to reproduce or a proof of concept;
- the FreeMyDisk and Windows versions you tested.

## What to expect

| | Target |
| :--- | :--- |
| Acknowledgement | within 3 days |
| First assessment | within 7 days |
| Fix for a confirmed critical issue | as fast as possible, usually within 30 days |

We'll keep you updated, agree on a disclosure date with you, and credit you in the advisory and release notes (unless you prefer to stay anonymous).

## Especially in scope

- Anything that makes FreeMyDisk delete, move or expose files it shouldn't (protected paths, path traversal, links and junctions).
- The elevated helper (`freemydisk-elevated`): running anything beyond its allow-listed operations, or abusing its inputs.
- The update chain: installing an update that isn't signed with the FreeMyDisk key.
- IPC between the UI and the engine.

## Out of scope

- Issues that require an attacker to already have administrator rights on the machine.
- Denial of service by filling the disk or by scanning very large folders.
- Findings from automated scanners without a demonstrated impact.

## Verifying releases

Every installer is built by GitHub Actions from this repository and carries a build-provenance attestation:

```powershell
gh attestation verify .\FreeMyDisk-Setup-x64.exe --repo fzihak/FreeMyDisk
```

In-app updates are verified against the public key built into FreeMyDisk before they are installed.
