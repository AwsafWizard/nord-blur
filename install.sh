#!/usr/bin/env bash
# Installs Nord Blur:
#  - links the shell extension into the user's extensions dir and enables it
#  - links the GTK3/GTK4 stylesheets that make app title bars translucent
#  - gives the dock a translucent Nord background so its blur shows through
# Everything is linked rather than copied, so edits here apply directly.
# GNOME 42 only loads a new or changed extension after a shell restart:
# on X11 press Alt+F2, type r, Enter; on Wayland log out and back in.
# Undo with ./uninstall.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="nord-blur@awsaf"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE="$HERE/.dock-settings-backup"

link() { # link <source> <dest>
    mkdir -p "$(dirname "$2")"
    if [ -e "$2" ] && [ ! -L "$2" ]; then
        echo "$2 exists and isn't a link; moving it to $2.bak"
        mv "$2" "$2.bak"
    fi
    ln -sfn "$1" "$2"
}

link "$HERE/$UUID" "$HOME/.local/share/gnome-shell/extensions/$UUID"
link "$HERE/gtk-3.0/gtk.css" "$CONFIG/gtk-3.0/gtk.css"
link "$HERE/gtk-4.0/gtk.css" "$CONFIG/gtk-4.0/gtk.css"

ENABLED="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$ENABLED" != *"'$UUID'"* ]]; then
    gsettings set org.gnome.shell enabled-extensions "${ENABLED%]}, '$UUID']"
fi

DOCK=org.gnome.shell.extensions.dash-to-dock
if gsettings list-keys "$DOCK" >/dev/null 2>&1; then
    if [ ! -f "$STATE" ]; then
        for key in custom-background-color background-color background-opacity transparency-mode; do
            echo "$key $(gsettings get "$DOCK" "$key")"
        done > "$STATE"
    fi
    gsettings set "$DOCK" custom-background-color true
    gsettings set "$DOCK" background-color '#121212'
    gsettings set "$DOCK" background-opacity 0.55
    gsettings set "$DOCK" transparency-mode 'FIXED'
fi

# GNOME Terminal is frosted as a whole, so its default profile's background
# has to be translucent.
TERM_STATE="$HERE/.terminal-settings-backup"
PROFILE="$(gsettings get org.gnome.Terminal.ProfilesList default 2>/dev/null | tr -d "'")"
if [ -n "$PROFILE" ]; then
    TERM_SCHEMA="org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:$PROFILE/"
    if [ ! -f "$TERM_STATE" ]; then
        {
            echo "schema $TERM_SCHEMA"
            for key in use-transparent-background background-transparency-percent background-color; do
                echo "$key $(gsettings get "$TERM_SCHEMA" "$key")"
            done
        } > "$TERM_STATE"
    fi
    gsettings set "$TERM_SCHEMA" use-transparent-background true
    gsettings set "$TERM_SCHEMA" background-transparency-percent 25
    gsettings set "$TERM_SCHEMA" background-color '#121212'
fi

echo "Installed. Restart GNOME Shell (X11: Alt+F2, r, Enter) and reopen apps."
