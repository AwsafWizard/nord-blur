/* exported init */
const { Clutter, GLib, GObject, Meta, Shell, St } = imports.gi;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const OsdWindow = imports.ui.osdWindow;
const PopupMenu = imports.ui.popupMenu;

// Blur strength in logical pixels; scaled by the monitor scale factor.
const SIGMA = 28;

// Corner radius of GTK windows (Pop GTK3 is 4px on top only, libadwaita 12px
// all round); the window blur is cut to it so it doesn't show past the curve.
// Rounding it at the bottom too only leaves a sliver unblurred under GTK3's
// square bottom corners, which is far less visible than blur poking out from
// under libadwaita's rounded ones.
const WINDOW_CORNER = 10;

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function cornerRadius(widget) {
    const node = widget.get_theme_node();
    return node ? node.get_border_radius(St.Corner.TOPLEFT) : 0;
}

// GJS turns whole numbers into int GValues, which float uniforms ignore.
function asFloat(value) {
    return value + 1e-4;
}

// While it paints the window group, Mutter clips the wallpaper and each
// window to the part of this frame's redraw region that nothing opaque
// covers, skipping actors that have an effect. Window glasses copy them in
// that pass, so without an effect their blur would cache only the strip
// being redrawn (or nothing under an opaque window) and later frames would
// show the sharp wallpaper there. This effect just paints its actor.
const NoCull = GObject.registerClass(
class NordBlurNoCull extends Clutter.Effect {});

// Keeps a NoCull effect on each actor that some window glass copies.
const Unculled = new class {
    constructor() {
        this._held = new Map(); // actor -> { effect, count, destroyId }
    }

    hold(actor) {
        let entry = this._held.get(actor);
        if (!entry) {
            const effect = new NoCull();
            actor.add_effect(effect);
            const destroyId = actor.connect('destroy', () => this._held.delete(actor));
            entry = { effect, count: 0, destroyId };
            this._held.set(actor, entry);
        }
        entry.count++;
    }

    release(actor) {
        const entry = this._held.get(actor);
        if (!entry || --entry.count > 0)
            return;
        this._held.delete(actor);
        actor.disconnect(entry.destroyId);
        actor.remove_effect(entry.effect);
    }
}();

// Cuts rounded corners out of whatever its actor draws.
const RoundedMask = GObject.registerClass(
class NordBlurRoundedMask extends Clutter.ShaderEffect {
    _init(skipInClones) {
        super._init({ shader_type: Clutter.ShaderType.FRAGMENT_SHADER });
        this._skipInClones = skipInClones;
        this.set_shader_source(`
            uniform sampler2D tex;
            uniform float width;
            uniform float height;
            uniform float radius;
            uniform float radius_bottom;

            void main() {
                vec2 size = vec2(width, height);
                vec2 p = cogl_tex_coord_in[0].st * size;
                float r = p.y < size.y * 0.5 ? radius : radius_bottom;
                vec2 q = abs(p - size * 0.5) - (size * 0.5 - vec2(r));
                // Signed distance to the rounded rectangle's edge (negative
                // inside), so pixels away from the corners are fully opaque
                // even when r is 0.
                float dist = length(max(q, 0.0)) +
                             min(max(q.x, q.y), 0.0) - r;
                float inside = clamp(0.5 - dist, 0.0, 1.0);
                cogl_color_out = texture2D(tex, cogl_tex_coord_in[0].st) *
                                 cogl_color_in * inside;
            }`);
        this.setGeometry(1, 1, 0, 0);
    }

    vfunc_paint(node, paintContext, flags) {
        if (this._skipInClones && this.get_actor().is_in_clone_paint())
            return;
        super.vfunc_paint(node, paintContext, flags);
    }

    setGeometry(width, height, radius, radiusBottom) {
        this.set_uniform_value('width', asFloat(width));
        this.set_uniform_value('height', asFloat(height));
        this.set_uniform_value('radius', asFloat(radius));
        this.set_uniform_value('radius_bottom', asFloat(radiusBottom));
        this.queue_repaint();
    }
});

// Keeps every Glass's copy of the desktop current each frame: lined up with
// the screen whatever its parents do (menus slide in, the dock slides out,
// banners drop down), and holding just the windows behind it.
const GlassTracker = new class {
    constructor() {
        this._glasses = new Set();
        this._ids = null;
    }

    add(glass) {
        this._glasses.add(glass);
        if (this._ids)
            return;
        // Clones are only added before layout, so they get allocated in
        // the same frame; after it, glasses only catch up with moves.
        this._ids = [
            global.stage.connect('before-update',
                () => this._glasses.forEach(g => g.sync(true))),
            global.stage.connect('after-update',
                () => this._glasses.forEach(g => g.sync(false))),
        ];
    }

    remove(glass) {
        this._glasses.delete(glass);
        if (this._glasses.size === 0 && this._ids) {
            this._ids.forEach(id => global.stage.disconnect(id));
            this._ids = null;
        }
    }
}();

// A frosted backdrop. Rather than reading back the screen (Shell.BlurMode.
// BACKGROUND), which leaves stale stripes whenever only part of the screen is
// redrawn, it blurs its own copy of the desktop offscreen and masks it to a
// rounded rectangle. The copy is the wallpaper plus one clone per window:
// cloning global.window_group as a whole draws nothing on GNOME 42.
const Glass = GObject.registerClass(
class NordBlurGlass extends St.Widget {
    // below: only copy windows stacked under this window actor (for a glass
    // inside that window). skipInClones: don't draw inside window previews.
    _init({ below = null, skipInClones = false, ...params } = {}) {
        super._init({
            name: 'nord-blur-glass',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            ...params,
        });

        this._blurred = new St.Widget({
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        this._blurred.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            sigma: SIGMA * scaleFactor(),
            brightness: 1.0,
        }));
        this.add_child(this._blurred);

        // Laid out in screen coordinates, shifted so the part behind the
        // glass lands inside it. Menus, the dock and banners aren't windows,
        // so the copy never contains a glass.
        this._scene = new Clutter.Actor();
        this._scene.add_child(new Clutter.Clone({
            source: Main.layoutManager._backgroundGroup,
        }));
        this._blurred.add_child(this._scene);
        this._scenePos = [0, 0];
        // Only windows behind the glass are cloned: every clone redraws the
        // glass whenever its window changes, wherever that window is.
        this._windows = [];
        this._windowClones = [];

        // Only window glasses paint inside the window group, where the
        // wallpaper and windows they copy need to be left unculled.
        this._below = below;
        if (below)
            Unculled.hold(Main.layoutManager._backgroundGroup);
        this._mask = new RoundedMask(skipInClones);
        this.add_effect(this._mask);
        this._radii = [0, 0]; // top, bottom

        this.connect('notify::allocation', () => this._updateMask());
        this.connect('destroy', () => {
            GlassTracker.remove(this);
            if (below) {
                this._windows.forEach(actor => Unculled.release(actor));
                Unculled.release(Main.layoutManager._backgroundGroup);
            }
        });
        GlassTracker.add(this);
    }

    set radius(radius) {
        this.setRadii(radius, radius);
    }

    setRadii(top, bottom) {
        if (top === this._radii[0] && bottom === this._radii[1])
            return;
        this._radii = [top, bottom];
        this._updateMask();
    }

    _updateMask() {
        const [width, height] = this.get_size();
        // Pill shapes use border-radius: 999px; the mask needs the real one.
        const max = Math.min(width, height) / 2;
        const [top, bottom] = this._radii.map(r => Math.min(r, max));
        this._mask.setGeometry(width, height, top, bottom);
    }

    _setWindows(windows) {
        this._windowClones.forEach(clone => clone.destroy());
        if (this._below) {
            // Hold the new ones first so windows in both lists keep theirs.
            windows.forEach(actor => Unculled.hold(actor));
            this._windows.forEach(actor => Unculled.release(actor));
        }
        this._windows = windows;
        this._windowClones = windows.map(actor => {
            const clone = new Clutter.Clone({ source: actor });
            clone.add_constraint(new Clutter.BindConstraint({
                source: actor,
                coordinate: Clutter.BindCoordinate.POSITION,
            }));
            this._scene.add_child(clone);
            return clone;
        });
    }

    sync(canRebuild) {
        if (!this.is_mapped())
            return;
        let x, y, w, h;
        if (this._below) {
            // Inside a window: read the window's and our own set positions,
            // which are already current before layout. The on-screen position
            // only catches up after layout, so using it would leave the copy
            // a frame behind whenever the window moves.
            x = this._below.x + this.x;
            y = this._below.y + this.y;
            [w, h] = [this.width, this.height];
        } else {
            if (!this.has_allocation())
                return;
            [x, y] = this.get_transformed_position();
            [w, h] = this.get_transformed_size();
        }
        if (![x, y, w, h].every(Number.isFinite))
            return;

        // Visible windows overlapping the glass, bottom to top. Hidden ones
        // (minimized, other workspaces) and stacking changes are caught here.
        let windows = global.get_window_actors();
        if (this._below) {
            const index = windows.indexOf(this._below);
            windows = index < 0 ? [] : windows.slice(0, index);
        }
        const behind = windows.filter(a => a.visible &&
            a.x < x + w && a.x + a.width > x && a.y < y + h && a.y + a.height > y);
        if (canRebuild && (behind.length !== this._windows.length ||
            behind.some((a, i) => a !== this._windows[i])))
            this._setWindows(behind);

        const sx = -Math.round(x), sy = -Math.round(y);
        if (sx !== this._scenePos[0] || sy !== this._scenePos[1]) {
            this._scenePos = [sx, sy];
            this._scene.set_position(sx, sy);
        }
    }

    // The clone would otherwise ask for the whole screen.
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }
});

// Menus: the glass goes under the menu's content box, sharing its parent.
class MenuBlur {
    enable() {
        this._undo = new Map(); // menu -> undo

        const self = this;
        this._origOpen = PopupMenu.PopupMenu.prototype.open;
        PopupMenu.PopupMenu.prototype.open = function (...args) {
            self._blur(this);
            return self._origOpen.apply(this, args);
        };
    }

    disable() {
        PopupMenu.PopupMenu.prototype.open = this._origOpen;
        this._undo.forEach(undo => undo());
        this._undo = null;
    }

    _blur(menu) {
        const bin = menu._boxPointer?.bin;
        const box = menu.box;
        if (this._undo.has(menu) || !bin || bin.get_child() !== box)
            return;

        const glass = new Glass();
        const wrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        bin.set_child(null);
        wrapper.add_child(glass);
        wrapper.add_child(box);
        bin.set_child(wrapper);

        const updateRadius = () => (glass.radius = cornerRadius(box));
        const styleId = box.connect('style-changed', updateRadius);
        updateRadius();

        const destroyId = menu.connect('destroy', () => this._undo?.delete(menu));
        this._undo.set(menu, () => {
            menu.disconnect(destroyId);
            box.disconnect(styleId);
            // On shell shutdown the menu may already be partly torn down.
            if (bin.get_child() === wrapper)
                bin.set_child(null);
            if (box.get_parent() === wrapper) {
                wrapper.remove_child(box);
                bin.set_child(box);
            }
            wrapper.destroy();
        });
    }
}

// Gives its actor the source's position and size, like a BindConstraint.
// A glass sits below its source, so the parent lays it out first, and if the
// source is due a new layout too (the OSD is on every show), its size then is
// just its preferred size, margins included: Pop's OSD margin-bottom stretched
// the glass 150px below the pill. So in that case it takes the source's
// preferred size minus margins (what a FixedLayout gives it) and relays out
// again next frame, once the source has its real box.
const FollowConstraint = GObject.registerClass(
class NordBlurFollowConstraint extends Clutter.Constraint {
    _init(source) {
        super._init();
        this._source = source;
        this._laterId = 0;
        this._retried = false;
    }

    vfunc_update_allocation(actor, box) {
        const src = this._source;
        let [x, y] = src.get_position();
        let [w, h] = src.get_size();
        if (src.has_allocation()) {
            this._retried = false;
        } else {
            x += src.margin_left;
            y += src.margin_top;
            w -= src.margin_left + src.margin_right;
            h -= src.margin_top + src.margin_bottom;
            // Once per miss, so a source that never gets laid out can't
            // keep relayouts going every frame.
            if (!this._retried && !this._laterId) {
                this._retried = true;
                this._laterId = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._laterId = 0;
                    this.get_actor()?.queue_relayout();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        box.init_rect(x, y, Math.max(w, 0), Math.max(h, 0));
    }

    cancel() {
        if (this._laterId)
            Meta.later_remove(this._laterId);
        this._laterId = 0;
    }
});

// Puts a Glass under `target`, bound to its size and position. `parent` must
// lay out children with a BinLayout or FixedLayout so the glass can sit
// underneath.
function glassUnder(target, parent) {
    const glass = new Glass();
    const follow = new FollowConstraint(target);
    glass.add_constraint(follow);
    glass.connect('destroy', () => follow.cancel());
    parent.insert_child_below(glass, target);
    const updateRadius = () => (glass.radius = cornerRadius(target));
    const styleId = target.connect('style-changed', updateRadius);
    updateRadius();
    glass.connect('destroy', () => target.disconnect(styleId));
    return glass;
}

class DockBlur {
    enable() {
        this._glasses = new Map(); // dash -> glass

        // Dash to Dock (and Pop's cosmic-dock fork) rebuilds its docks when
        // monitors or settings change, so watch for new ones.
        this._addedId = Main.uiGroup.connect('actor-added', (_, actor) => {
            if (actor.get_name() === 'dashtodockContainer')
                this._blur(actor);
        });
        Main.uiGroup.get_children()
            .filter(a => a.get_name() === 'dashtodockContainer')
            .forEach(a => this._blur(a));
    }

    disable() {
        Main.uiGroup.disconnect(this._addedId);
        [...this._glasses.values()].forEach(glass => glass.destroy());
        this._glasses = null;
    }

    _blur(container) {
        const dash = container.dash;
        if (!dash?._background || this._glasses.has(dash))
            return;
        const glass = glassUnder(dash._background, dash);
        this._glasses.set(dash, glass);
        glass.connect('destroy', () => this._glasses?.delete(dash));
    }
}

class BannerBlur {
    enable() {
        const bin = Main.messageTray._bannerBin;
        this._glasses = new Map(); // banner -> glass
        this._ids = [
            bin.connect('actor-added', (_, actor) => {
                if (!(actor instanceof Glass))
                    this._glasses.set(actor, glassUnder(actor, bin));
            }),
            bin.connect('actor-removed', (_, actor) => {
                this._glasses.get(actor)?.destroy();
                this._glasses.delete(actor);
            }),
        ];
        const banner = Main.messageTray._banner;
        if (banner)
            this._glasses.set(banner, glassUnder(banner, bin));
    }

    disable() {
        const bin = Main.messageTray._bannerBin;
        this._ids.forEach(id => bin.disconnect(id));
        [...this._glasses.values()].forEach(glass => glass.destroy());
        this._glasses = null;
    }
}

// Shell modal dialogs, which includes Pop's Super-key launcher. The dialog
// box sits centred in a BinLayout, so the glass can go right under it.
class DialogBlur {
    enable() {
        this._glasses = new Map(); // dialog -> glass

        const self = this;
        this._origOpen = ModalDialog.ModalDialog.prototype.open;
        ModalDialog.ModalDialog.prototype.open = function (...args) {
            self._blur(this);
            return self._origOpen.apply(this, args);
        };
    }

    disable() {
        ModalDialog.ModalDialog.prototype.open = this._origOpen;
        [...this._glasses.values()].forEach(glass => glass.destroy());
        this._glasses = null;
    }

    _blur(dialog) {
        const layout = dialog.dialogLayout;
        const box = layout?._dialog;
        if (!box || this._glasses.has(dialog))
            return;
        const glass = glassUnder(box, layout);
        this._glasses.set(dialog, glass);
        glass.connect('destroy', () => this._glasses?.delete(dialog));
    }
}

// Volume/brightness OSD pills, one per monitor. Their glass sits beside the
// pill in the OsdWindow (a FixedLayout), bound to it, and fades with it.
// Windows are recreated when monitors change, so they're picked up on show().
class OsdBlur {
    enable() {
        this._glasses = new Map(); // osd window -> glass

        const self = this;
        this._origShow = OsdWindow.OsdWindow.prototype.show;
        OsdWindow.OsdWindow.prototype.show = function (...args) {
            self._blur(this);
            return self._origShow.apply(this, args);
        };
        Main.osdWindowManager._osdWindows.forEach(w => w && this._blur(w));
    }

    disable() {
        OsdWindow.OsdWindow.prototype.show = this._origShow;
        [...this._glasses.values()].forEach(glass => glass.destroy());
        this._glasses = null;
    }

    _blur(osd) {
        const box = osd._hbox;
        if (!box || this._glasses.has(osd))
            return;
        const glass = glassUnder(box, osd);
        this._glasses.set(osd, glass);
        glass.connect('destroy', () => this._glasses?.delete(osd));
    }
}

// Puts a blurred backdrop under the whole of every GTK window with client-side
// decorations. It only shows where the app itself is translucent, which the
// gtk.css files in this project make the headerbar and window background
// (GNOME Terminal's profile is made translucent by install.sh).
class WindowBlur {
    enable() {
        this._strips = new Map(); // window actor -> { holder, signals }

        this._mapId = global.window_manager.connect('map',
            (_, actor) => this._track(actor));
        global.get_window_actors().forEach(a => this._track(a));
    }

    disable() {
        global.window_manager.disconnect(this._mapId);
        for (const actor of [...this._strips.keys()])
            this._untrack(actor);
        this._strips = null;
    }

    _wants(win) {
        const type = win.get_window_type();
        if (type !== Meta.WindowType.NORMAL &&
            type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG)
            return false;
        if (!win.is_client_decorated())
            return false;
        // GTK draws its own shadow, so its buffer is bigger than the visible
        // frame. Electron/Chrome title bars don't, and they're opaque anyway.
        const buf = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        return buf.width > frame.width || buf.height > frame.height ||
            win.get_gtk_application_id() !== null;
    }

    _track(actor) {
        const win = actor.meta_window;
        if (!win || this._strips.has(actor) || !this._wants(win))
            return;

        // Same frosted glass as menus, copying only the windows under this
        // one. Window previews skip it: a preview of a window below already
        // sits inside this glass's copy, so drawing its glass again is waste.
        const holder = new Glass({
            name: 'nord-blur-window',
            below: actor,
            skipInClones: true,
            x_expand: false,
            y_expand: false,
        });
        actor.insert_child_at_index(holder, 0);

        const update = () => {
            const buf = win.get_buffer_rect();
            const frame = win.get_frame_rect();
            holder.set_position(frame.x - buf.x, frame.y - buf.y);
            holder.set_size(frame.width, frame.height);
            holder.radius = win.get_maximized() ? 0 : WINDOW_CORNER * scaleFactor();
            holder.visible = !win.fullscreen && frame.height > 0;
        };
        update();

        const signals = [
            [win, win.connect('size-changed', update)],
            [win, win.connect('notify::fullscreen', update)],
            [actor, actor.connect('destroy', () => this._strips?.delete(actor))],
        ];
        this._strips.set(actor, { holder, signals });
    }

    _untrack(actor) {
        const { holder, signals } = this._strips.get(actor);
        signals.forEach(([obj, id]) => obj.disconnect(id));
        holder.destroy();
        this._strips.delete(actor);
    }
}

class Extension {
    enable() {
        this._parts = [
            new MenuBlur(), new DockBlur(), new BannerBlur(),
            new DialogBlur(), new OsdBlur(), new WindowBlur(),
        ];
        this._parts.forEach(p => p.enable());
    }

    disable() {
        this._parts.forEach(p => p.disable());
        this._parts = null;
    }
}

function init() {
    return new Extension();
}
