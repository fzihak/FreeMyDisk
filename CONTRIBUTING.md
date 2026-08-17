# Contributing to FreeMyDisk

Thank you for your interest in contributing to FreeMyDisk!

## Developer Certificate of Origin (DCO)

All contributions (commits, pull requests, patches) to FreeMyDisk require a Developer Certificate of Origin sign-off line. By adding this line to your commit message, you certify the following:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### How to Sign Your Commits
To add the DCO sign-off, run git commit with the `-s` / `--signoff` flag:
```bash
git commit -s -m "feat(storage): implement adaptive parallel traversal"
```
This appends a trailer formatted as:
```
Signed-off-by: Your Name <your.email@example.com>
```

## Operating Guidelines
1. **Zero Stubbing**: No placeholder functions, no `unimplemented!()`, and no dummy mock UI.
2. **Test-Gated**: Every feature must have corresponding unit or integration tests passing before merging.
3. **Safety First**: Never bypass or weaken the safety invariants defined in the FreeMyDisk Master Implementation Plan.
