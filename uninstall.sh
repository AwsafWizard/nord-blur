#!/usr/bin/env bash
# Reverses install.sh: disables and unlinks the extension, removes the GTK
# stylesheet links (restoring any .bak) and restores the dock's old colours.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="nord-blur@awsaf"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE="$HERE/.dock-settings-backup"

unlink_restore() { # unlink_restore <dest>
    if [ -L "$1" ]; then
        rm "$1"
        [ -e "$1.bak" ] && mv "$1.bak" "$1"
    fi
    return 0
}

gnome-extensions disable "$UUID" 2>/dev/null || true
unlink_restore "$HOME/.local/share/gnome-shell/extensions/$UUID"
unlink_restore "$CONFIG/gtk-3.0/gtk.css"
unlink_restore "$CONFIG/gtk-4.0/gtk.css"

if [ -f "$STATE" ]; then
    while read -r key value; do
        gsettings set org.gnome.shell.extensions.dash-to-dock "$key" "$value"
    done < "$STATE"
    rm "$STATE"
fi

TERM_STATE="$HERE/.terminal-settings-backup"
if [ -f "$TERM_STATE" ]; then
    TERM_SCHEMA="$(sed -n 's/^schema //p' "$TERM_STATE")"
    grep -v '^schema ' "$TERM_STATE" | while read -r key value; do
        gsettings set "$TERM_SCHEMA" "$key" "$value"
    done
    rm "$TERM_STATE"
fi

echo "Uninstalled. Restart GNOME Shell and reopen apps to finish."
