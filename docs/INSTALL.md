# Installing Cortextrace

## Windows 10 / 11

1. Run `Cortextrace-x.y.z-win-x64.exe`. It installs per user into `%LOCALAPPDATA%\Programs\cortextrace` and needs no administrator rights. The `.msi` suits managed deployment (`msiexec /i Cortextrace-x.y.z-win-x64.msi /qn`).
2. Unsigned builds show a SmartScreen prompt; choose *More info → Run anyway*. Official releases are Authenticode-signed.
3. Silent install/uninstall: `Cortextrace-x.y.z-win-x64.exe /S`, `"%LOCALAPPDATA%\Programs\cortextrace\Uninstall Cortextrace.exe" /S`.

## macOS 12+

1. Open the `.dmg` and drag Cortextrace to Applications, or run the `.pkg`.
2. Notarized releases open normally. For local unsigned builds: right-click → Open.
3. Notifications: allow when prompted (System Settings → Notifications → Cortextrace).
4. The process and connection list use `ps` and `lsof` and need no extra permissions. Cortextrace never asks for Full Disk Access. If you want file-change events for workspaces under protected folders (Desktop, Documents), macOS may prompt for access to those folders.

## Linux

| Package | Install |
|---|---|
| AppImage | `chmod +x Cortextrace-*.AppImage && ./Cortextrace-*.AppImage` |
| Debian/Ubuntu | `sudo apt install ./Cortextrace-*-linux-amd64.deb` |
| Fedora/RHEL | `sudo dnf install ./Cortextrace-*-linux-x86_64.rpm` |

- The system tray needs a StatusNotifier host (GNOME: the *AppIndicator* extension).
- **Start at login:** copy the desktop file to `~/.config/autostart/` and add `--hidden` to `Exec`:
  ```bash
  mkdir -p ~/.config/autostart
  sed 's|^Exec=\(.*\)$|Exec=\1 --hidden|' /usr/share/applications/cortextrace.desktop > ~/.config/autostart/cortextrace.desktop
  ```
- Large repositories may hit the inotify watch limit: `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-cortextrace.conf && sudo sysctl --system`.

## First run

The onboarding screen:

1. discloses every data source;
2. lists the agents detected on the machine, where you can connect their hooks or telemetry (each change backs up the agent's config file first);
3. offers start-at-login.

Restart an agent after connecting an integration.

## Headless / server mode

```bash
git clone … && cd cortextrace && npm ci
npm run engine -- --data-dir /var/lib/cortextrace          # collectors + API + OTLP
npm run engine -- --data-dir ./data --no-collectors        # ingest-only (CI, containers)
```

## Ports

| Port | Purpose | Change in |
|---|---|---|
| 127.0.0.1:47631 | local API + hooks | `config.json` → `api.port` |
| 127.0.0.1:4318 | OTLP/HTTP JSON receiver | `monitoring.otlp.port` (disable if another collector owns 4318) |

## Connecting agents manually

| Agent | What the integration writes |
|---|---|
| Claude Code | `~/.claude/settings.json`: `hooks` entries calling `curl … /v1/hooks/claude-code/<Event>`; optionally `env` with `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` |
| Cursor | `~/.cursor/hooks.json`: `version: 1` hooks for prompt, shell, MCP, file read/edit and stop events |
| Codex | `~/.codex/hooks.json` hooks, and/or an `[otel]` block in `~/.codex/config.toml` with an `otlp-http` JSON exporter |
| Gemini CLI | `~/.gemini/settings.json`: `telemetry.enabled`, `target: local`, `otlpEndpoint`, `otlpProtocol: http`, `logPrompts: false` |
| Anything with OTLP | point an OTLP/HTTP **JSON** exporter at `http://127.0.0.1:4318` |
| Anything else | `POST /v1/events` (see [ADAPTERS.md](ADAPTERS.md)) |

## Uninstall and data removal

Uninstalling keeps your data. To remove it, first disconnect integrations (Settings → Integrations → Remove), then delete the data directory listed in [PRIVACY.md](PRIVACY.md).
