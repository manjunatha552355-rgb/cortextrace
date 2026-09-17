# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately through GitHub Security Advisories ("Report a vulnerability" on the repository's Security tab) or by email to [Manjunatha@aiandmlconsultants.com](mailto:Manjunatha@aiandmlconsultants.com).

Include the affected version and OS, reproduction steps, and the impact. We aim to acknowledge reports within 3 working days, give an initial assessment within 10, and ship a fix or mitigation for high/critical issues within 30 days. We credit reporters in the release notes unless they ask us not to.

## Supported versions

The latest minor release receives security fixes.

## Scope

In scope: the desktop app, the headless engine, the local API and OTLP receiver, hook installers, detection bypasses caused by a bug (not by a documented limitation), and packaging.

Out of scope: attacks that require code execution as the same OS user (see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)), missed detections for techniques listed as limitations, and unsigned community builds.

## Safe harbour

We welcome good-faith research that respects user privacy, avoids destroying data and gives us reasonable time to fix issues before disclosure. We will not take legal action over such research.
