#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "No systemd user session. Use 'just update' manually or install a host timer." >&2
  exit 1
fi
command -v flock >/dev/null || { echo "flock required for update locking" >&2; exit 1; }
mkdir -p "$HOME/.config/systemd/user"
# WorkingDirectory is a path setting, not an ExecStart command line.
# Quotes around its value can become literal path characters.
repo_dir="$PWD"
if [[ "$repo_dir" == *'"'* || "$repo_dir" == *'%'* ]]; then
  echo "Unsupported quote/percent character in repository path" >&2
  exit 1
fi
cat > "$HOME/.config/systemd/user/evade-update.service" <<EOF
[Unit]
Description=EvaDE safe Git + Compose update
[Service]
Type=oneshot
WorkingDirectory=$repo_dir
ExecStart=/usr/bin/bash "$repo_dir/scripts/update.sh"
EOF
cat > "$HOME/.config/systemd/user/evade-update.timer" <<'EOF'
[Unit]
Description=Check EvaDE updates every minute
[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
AccuracySec=1s
RandomizedDelaySec=0
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemd-analyze --user verify "$HOME/.config/systemd/user/evade-update.service"
systemctl --user enable --now evade-update.timer
echo "[+] Every-minute user timer enabled. Check: systemctl --user list-timers evade-update.timer"
echo "[!] For timer execution while logged out, enable lingering: loginctl enable-linger \"$USER\" (may require administrator privileges)."
