---
"byollm": patch
---

Windows supervision no longer needs administrator rights. The scheduled task
now names its user and runs at least privilege, which is what it always meant
to be — an unscoped logon trigger is a machine-wide task, and that is why
`install` answered "Access is denied" on ordinary accounts.
