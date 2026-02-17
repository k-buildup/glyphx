import * as readline from "readline";
import chalk from "chalk";

// ══════════════════════════════════════════════════════════════════════════════
//  § 1. ABSTRACTIONS  (Dependency Inversion + Interface Segregation)
// ══════════════════════════════════════════════════════════════════════════════

// ── I/O abstraction ──────────────────────────────────────────────────────────

/** DIP: all rendering depends on this interface, not on process.stdout directly. */
export interface ITerminalWriter {
    moveTo(row: number, col: number): void;
    write(text: string): void;
}

// ── Widget interfaces (ISP: granular, composable) ────────────────────────────

/** Describes how many lines / columns a widget occupies. */
export interface IDimensional {
    lineCount(): number;
    naturalWidth(): number;
}

/** Describes how a widget draws itself. */
export interface IRenderable {
    renderLine(
        lineIndex: number,
        termRow: number,
        termCol: number,
        maxWidth: number,
        scrollX?: number,
    ): void;
}

/** ISP: keyboard handling is separated from focus bookkeeping. */
export interface IKeyConsumer {
    /** Return true if the key was fully consumed; false/void to let parent act. */
    handleKey(key: readline.Key): boolean | void;
}

/** ISP: focus state is separated from the key-handling logic. */
export interface IFocusTarget {
    isFocused(): boolean;
    focus(): void;
    blur(): void;
    /**
     * Optional hint for Container auto-scroll: the line index *within this
     * widget* (0-based) that should stay inside the viewport.
     */
    activeLineHint?(): number;
}

/** Convenience union: a widget that is both focusable and can handle keys. */
export type IFocusable = IFocusTarget & IKeyConsumer;

// ── Button variant strategy (OCP) ────────────────────────────────────────────

/** OCP: new button styles can be added without modifying the Button class. */
export interface IButtonRenderer {
    render(
        writer: ITerminalWriter,
        row: number,
        col: number,
        width: number,
        label: string,
        focused: boolean,
        pressed: boolean,
    ): void;
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 2. INFRASTRUCTURE  (concrete I/O implementations)
// ══════════════════════════════════════════════════════════════════════════════

/** Default ITerminalWriter backed by process.stdout + ANSI escape codes. */
export class TerminalWriter implements ITerminalWriter {
    moveTo(row: number, col: number): void {
        process.stdout.write(`\x1b[${row};${col}H`);
    }
    write(text: string): void {
        process.stdout.write(text);
    }
}

/** Module-level singleton; injected into every widget by default. */
const defaultWriter: ITerminalWriter = new TerminalWriter();

// ── Screen ───────────────────────────────────────────────────────────────────

export class Screen {
    private active = false;

    enter(): void {
        if (this.active) return;
        this.active = true;
        process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    }

    exit(): void {
        if (!this.active) return;
        this.active = false;
        process.stdout.write("\x1b[?1049l");
    }
}

// ── Legacy static Cursor (kept for external callers) ─────────────────────────

export class Cursor {
    static moveTo(row: number, col: number): void {
        defaultWriter.moveTo(row, col);
    }
    static hide(): void {
        process.stdout.write("\x1b[?25l");
    }
    static show(): void {
        process.stdout.write("\x1b[?25h");
    }
}

// ── Event ────────────────────────────────────────────────────────────────────

export interface SubEvent {
    name: string;
    next(key: readline.Key): void;
}

export class Event {
    subEvents: SubEvent[] = [];

    constructor(
        private proc: NodeJS.Process,
        private screen: Screen,
    ) {
        readline.emitKeypressEvents(proc.stdin);
        proc.stdin.resume();
    }

    setup(): void {
        this.proc.stdin.on("keypress", (_str, key) => {
            if (key?.ctrl && key.name === "c") {
                this.screen.exit();
                this.proc.exit(0);
            }
            [...this.subEvents].forEach((e) => e.next(key));
        });
        ["SIGINT", "SIGTERM"].forEach((sig) => {
            this.proc.on(sig, () => {
                this.screen.exit();
                this.proc.exit(0);
            });
        });
    }

    add(sub: SubEvent): void {
        if (!this.subEvents.find((e) => e.name === sub.name))
            this.subEvents.push(sub);
    }

    remove(name: string): void {
        this.subEvents = this.subEvents.filter((e) => e.name !== name);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 3. STATE HELPERS  (SRP: each class owns exactly one concern)
// ══════════════════════════════════════════════════════════════════════════════

// ── FocusManager  (SRP: focus-index bookkeeping extracted from Container) ────

export class FocusManager {
    private _idx = -1;

    constructor(private readonly _focusables: IFocusable[]) {}

    get index(): number {
        return this._idx;
    }
    get current(): IFocusable | undefined {
        return this._focusables[this._idx];
    }
    get hasFocus(): boolean {
        return this._idx >= 0;
    }

    focusAt(i: number): void {
        this._blurActive();
        this._idx = Math.max(0, Math.min(i, this._focusables.length - 1));
        this.current?.focus();
    }

    cycle(direction: 1 | -1): void {
        const len = this._focusables.length;
        if (len === 0) return;
        this._blurActive();
        this._idx = (this._idx + direction + len) % len;
        this.current?.focus();
    }

    clear(): void {
        this._blurActive();
        this._idx = -1;
    }

    initFirst(): void {
        if (this._focusables.length > 0 && this._idx < 0) this.focusAt(0);
    }

    private _blurActive(): void {
        this.current?.blur();
    }
}

// ── ScrollState  (SRP: 2-D scroll math extracted from Container & Textarea) ──

export class ScrollState {
    private _x = 0;
    private _y = 0;

    get x(): number {
        return this._x;
    }
    get y(): number {
        return this._y;
    }

    setX(value: number, max: number): void {
        this._x = Math.max(0, Math.min(value, max));
    }
    setY(value: number, max: number): void {
        this._y = Math.max(0, Math.min(value, max));
    }

    /** Ensure a cursor column stays within a viewport of `viewportWidth`. */
    clampHorizontal(cursor: number, viewportWidth: number): void {
        if (cursor < this._x) this._x = cursor;
        if (cursor >= this._x + viewportWidth)
            this._x = cursor - viewportWidth + 1;
        this._x = Math.max(0, this._x);
    }

    /** Ensure a cursor row stays within a viewport of `viewportHeight`. */
    clampVertical(
        cursor: number,
        viewportHeight: number,
        maxScroll: number,
    ): void {
        if (cursor < this._y) this._y = cursor;
        if (cursor >= this._y + viewportHeight)
            this._y = cursor - viewportHeight + 1;
        this._y = Math.max(0, Math.min(this._y, maxScroll));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 4. WIDGET BASE  (LSP: all concrete widgets honour the contract)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Abstract base satisfying IDimensional + IRenderable.
 * Concrete subclasses must implement lineCount() and renderLine().
 * naturalWidth() defaults to 0 (override when meaningful).
 *
 * Every widget receives an ITerminalWriter at construction time (DIP).
 */
export abstract class Widget implements IDimensional, IRenderable {
    constructor(protected readonly writer: ITerminalWriter = defaultWriter) {}

    abstract lineCount(): number;

    naturalWidth(): number {
        return 0;
    }

    abstract renderLine(
        lineIndex: number,
        termRow: number,
        termCol: number,
        maxWidth: number,
        scrollX?: number,
    ): void;
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 5. SIMPLE DISPLAY WIDGETS
// ══════════════════════════════════════════════════════════════════════════════

// ── Label ────────────────────────────────────────────────────────────────────

export class Label extends Widget {
    constructor(
        private text: string,
        private color = "white",
        writer?: ITerminalWriter,
    ) {
        super(writer);
    }

    lineCount() {
        return 1;
    }
    naturalWidth() {
        return this.text.length;
    }

    renderLine(
        _li: number,
        row: number,
        col: number,
        maxWidth: number,
        scrollX = 0,
    ): void {
        this.writer.moveTo(row, col);
        if (!this.text.length) return;

        const slice = this.text.slice(scrollX);
        if (slice.length > maxWidth) {
            this.writer.write(
                chalk`{${this.color} ${slice.slice(0, maxWidth - 2)}}` +
                    chalk`{gray ..}`,
            );
        } else {
            this.writer.write(chalk`{${this.color} ${slice}}`);
        }
    }
}

// ── Command ──────────────────────────────────────────────────────────────────

const KEY_SYMBOLS: Record<string, string> = {
    backspace: "⌫",
    ctrl: "⌃",
    shift: "⇧",
    alt: "⌥",
    enter: "↵",
    escape: "⎋",
    tab: "⇥",
    space: "␣",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
};

type SegColour = "cyan" | "gray" | "white";

interface Seg {
    plain: string;
    colour: SegColour;
}

export class Command extends Widget {
    constructor(
        private label: string,
        private shortcut: string[],
        writer?: ITerminalWriter,
    ) {
        super(writer);
    }

    lineCount() {
        return 1;
    }

    private _segs(): Seg[] {
        const out: Seg[] = [];
        for (let i = 0; i < this.shortcut.length; i++) {
            const lo = (this.shortcut[i] ?? "").toLowerCase();
            const sym = KEY_SYMBOLS[lo] ?? this.shortcut[i] ?? "";
            out.push({
                plain: sym,
                colour: lo in KEY_SYMBOLS ? "cyan" : "gray",
            });
            if (i < this.shortcut.length - 1)
                out.push({ plain: " ", colour: "gray" });
        }
        out.push({ plain: " " + this.label, colour: "white" });
        return out;
    }

    naturalWidth(): number {
        return this._segs().reduce((s, seg) => s + seg.plain.length, 0);
    }

    renderLine(
        _li: number,
        row: number,
        col: number,
        maxWidth: number,
        scrollX = 0,
    ): void {
        let skip = scrollX;
        let used = 0;
        let out = "";

        for (const seg of this._segs()) {
            if (skip >= seg.plain.length) {
                skip -= seg.plain.length;
                continue;
            }
            const visible = seg.plain.slice(skip);
            skip = 0;
            const fits = maxWidth - used;
            if (visible.length > fits) {
                const cut = visible.slice(0, Math.max(0, fits - 2));
                if (cut) out += chalk`{${seg.colour} ${cut}}`;
                out += chalk`{gray ..}`;
                // eslint-disable-next-line no-useless-assignment
                used = maxWidth;
                break;
            }
            out += chalk`{${seg.colour} ${visible}}`;
            used += visible.length;
            if (used >= maxWidth) break;
        }

        if (!out) return;
        this.writer.moveTo(row, col);
        this.writer.write(out);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 6. INTERACTIVE WIDGETS  (IDimensional + IRenderable + IFocusable)
// ══════════════════════════════════════════════════════════════════════════════

// ── Input ────────────────────────────────────────────────────────────────────

export type InputType = "text" | "password";

export class Input extends Widget implements IFocusable {
    private _value = "";
    private _cursor = 0;
    private _scroll: ScrollState;
    private _focused = false;

    constructor(
        private width: number,
        private placeholder = "",
        private type: InputType = "text",
        private onChange?: (value: string) => void,
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._scroll = new ScrollState();
    }

    lineCount() {
        return 1;
    }
    naturalWidth() {
        return this.width;
    }

    getValue() {
        return this._value;
    }
    setValue(v: string) {
        this._value = v;
        this._cursor = v.length;
        this._clampScroll();
    }

    isFocused() {
        return this._focused;
    }
    focus() {
        this._focused = true;
    }
    blur() {
        this._focused = false;
    }

    handleKey(key: readline.Key): boolean {
        const n = key.name;

        if (n === "left") {
            this._cursor = Math.max(0, this._cursor - 1);
        } else if (n === "right") {
            this._cursor = Math.min(this._value.length, this._cursor + 1);
        } else if (n === "home") {
            this._cursor = 0;
        } else if (n === "end") {
            this._cursor = this._value.length;
        } else if (n === "backspace") {
            if (this._cursor > 0) {
                this._value =
                    this._value.slice(0, this._cursor - 1) +
                    this._value.slice(this._cursor);
                this._cursor--;
                this.onChange?.(this._value);
            }
            this._clampScroll();
            return true;
        } else if (n === "delete") {
            if (this._cursor < this._value.length) {
                this._value =
                    this._value.slice(0, this._cursor) +
                    this._value.slice(this._cursor + 1);
                this.onChange?.(this._value);
            }
        } else if (
            n !== "return" &&
            n !== "escape" &&
            n !== "tab" &&
            key.sequence &&
            !key.ctrl &&
            !key.meta &&
            key.sequence.length === 1
        ) {
            this._value =
                this._value.slice(0, this._cursor) +
                key.sequence +
                this._value.slice(this._cursor);
            this._cursor++;
            this.onChange?.(this._value);
        } else {
            return false;
        }

        this._clampScroll();
        return true;
    }

    private _clampScroll(): void {
        this._scroll.clampHorizontal(this._cursor, this.width - 2);
    }

    private _display(): string {
        return this.type === "password"
            ? "*".repeat(this._value.length)
            : this._value;
    }

    renderLine(_li: number, row: number, col: number, maxWidth: number): void {
        const w = Math.min(this.width, maxWidth);
        const inner = w - 2;
        const bc = this._focused ? "white" : "gray";

        const display = this._display();
        const visible = display.slice(this._scroll.x, this._scroll.x + inner);
        const relCursor = this._cursor - this._scroll.x;

        let content: string;

        if (!this._value.length && !this._focused) {
            content = chalk.gray(
                this.placeholder.slice(0, inner).padEnd(inner),
            );
        } else {
            const padded = visible.padEnd(inner);
            if (this._focused) {
                const before = padded.slice(0, relCursor);
                const cur = padded[relCursor] ?? " ";
                const after = padded.slice(relCursor + 1);
                content =
                    chalk.white(before) +
                    chalk.bgWhite.black(cur) +
                    chalk.white(after);
            } else {
                content = chalk.white(padded);
            }
        }

        this.writer.moveTo(row, col);
        this.writer.write(
            chalk.keyword(bc)("[") + content + chalk.keyword(bc)("]"),
        );
    }
}

// ── Select ───────────────────────────────────────────────────────────────────

export class Select extends Widget implements IFocusable {
    private _open = false;
    private _focused = false;
    private _hovered: number;
    private _selected: number;

    constructor(
        private width: number,
        private options: string[],
        initialIndex = 0,
        private onChange?: (index: number, value: string) => void,
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._selected = Math.max(
            0,
            Math.min(initialIndex, options.length - 1),
        );
        this._hovered = this._selected;
    }

    lineCount() {
        return this._open ? 1 + this.options.length : 1;
    }
    naturalWidth() {
        return this.width;
    }

    getIndex() {
        return this._selected;
    }
    getValue() {
        return this.options[this._selected] ?? "";
    }

    isFocused() {
        return this._focused;
    }
    focus() {
        this._focused = true;
    }
    blur() {
        this._focused = false;
        this._open = false;
    }

    handleKey(key: readline.Key): boolean {
        const n = key.name;

        if (!this._open) {
            if (n === "return" || n === "space") {
                this._open = true;
                this._hovered = this._selected;
                return true;
            }
            return false;
        }

        if (n === "up") {
            this._hovered = Math.max(0, this._hovered - 1);
            return true;
        } else if (n === "down") {
            this._hovered = Math.min(
                this.options.length - 1,
                this._hovered + 1,
            );
            return true;
        } else if (n === "return") {
            this._selected = this._hovered;
            this._open = false;
            this.onChange?.(this._selected, this.options[this._selected] ?? "");
            return true;
        } else if (n === "escape") {
            this._open = false;
            return true;
        }

        return false;
    }

    activeLineHint(): number {
        return this._open ? 1 + this._hovered : 0;
    }

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        const w = Math.min(this.width, maxWidth);

        if (li === 0) {
            const inner = w - 4;
            const label = (this.options[this._selected] ?? "(none)")
                .slice(0, inner)
                .padEnd(inner);
            const arrow = this._open ? "▴" : "▾";
            const bc = this._focused
                ? this._open
                    ? "white"
                    : "yellow"
                : "gray";

            this.writer.moveTo(row, col);
            this.writer.write(
                chalk.keyword(bc)("[") +
                    chalk.white(" " + label) +
                    chalk.keyword(bc)(arrow + "]"),
            );
        } else {
            const optIdx = li - 1;
            const opt = this.options[optIdx] ?? "";
            const isHovered = optIdx === this._hovered;
            const isSelected = optIdx === this._selected;
            const inner = w - 3;
            const label = opt.slice(0, inner).padEnd(inner);
            const dot = isSelected ? "●" : "○";

            this.writer.moveTo(row, col);
            if (isHovered) {
                this.writer.write(
                    chalk.bgYellow.black(` ${dot} ${label.slice(0, w - 3)}`),
                );
            } else {
                this.writer.write(
                    chalk.gray(` ${dot} `) + chalk.white(label.slice(0, w - 3)),
                );
            }
        }
    }
}

// ── Radio ────────────────────────────────────────────────────────────────────

export class Radio extends Widget implements IFocusable {
    private _focused = false;
    private _hovered: number;
    private _selected: number;

    constructor(
        private options: string[],
        initialIndex = 0,
        private onChange?: (index: number, value: string) => void,
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._selected = Math.max(
            0,
            Math.min(initialIndex, options.length - 1),
        );
        this._hovered = this._selected;
    }

    lineCount() {
        return this.options.length;
    }
    naturalWidth() {
        return 3 + this.options.reduce((m, o) => Math.max(m, o.length), 0);
    }

    getIndex() {
        return this._selected;
    }
    getValue() {
        return this.options[this._selected] ?? "";
    }

    isFocused() {
        return this._focused;
    }
    focus() {
        this._focused = true;
    }
    blur() {
        this._focused = false;
    }

    handleKey(key: readline.Key): boolean {
        const n = key.name;
        if (n === "up") {
            this._hovered = Math.max(0, this._hovered - 1);
            return true;
        } else if (n === "down") {
            this._hovered = Math.min(
                this.options.length - 1,
                this._hovered + 1,
            );
            return true;
        } else if (n === "return" || n === "space") {
            this._selected = this._hovered;
            this.onChange?.(this._selected, this.options[this._selected] ?? "");
            return true;
        }
        return false;
    }

    activeLineHint(): number {
        return this._hovered;
    }

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        const opt = this.options[li] ?? "";
        const isSelected = li === this._selected;
        const isHovered = this._focused && li === this._hovered;
        const dot = isSelected ? "◉" : "○";
        const label = opt.slice(0, maxWidth - 3);

        this.writer.moveTo(row, col);

        if (isHovered && isSelected) {
            this.writer.write(
                chalk.yellow(`${dot} `) + chalk.bgYellow.black(label),
            );
        } else if (isHovered) {
            this.writer.write(chalk.yellow(`${dot} `) + chalk.yellow(label));
        } else if (isSelected) {
            this.writer.write(chalk.cyan(`${dot} `) + chalk.white(label));
        } else {
            this.writer.write(chalk.gray(`${dot} `) + chalk.gray(label));
        }
    }
}

// ── CheckBox ─────────────────────────────────────────────────────────────────

export class CheckBox extends Widget implements IFocusable {
    private _focused = false;
    private _checked: boolean;

    constructor(
        private label: string,
        initialChecked = false,
        private onChange?: (checked: boolean) => void,
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._checked = initialChecked;
    }

    lineCount() {
        return 1;
    }
    naturalWidth() {
        return 4 + this.label.length;
    }

    isChecked() {
        return this._checked;
    }
    setChecked(v: boolean) {
        this._checked = v;
    }

    isFocused() {
        return this._focused;
    }
    focus() {
        this._focused = true;
    }
    blur() {
        this._focused = false;
    }

    handleKey(key: readline.Key): boolean {
        if (key.name === "return" || key.name === "space") {
            this._checked = !this._checked;
            this.onChange?.(this._checked);
            return true;
        }
        return false;
    }

    renderLine(_li: number, row: number, col: number, maxWidth: number): void {
        const bc = this._focused ? "yellow" : "gray";
        const mark = this._checked ? chalk.green("✓") : " ";
        const label = this.label.slice(0, maxWidth - 4);
        const labelColor = this._focused ? "white" : "gray";

        this.writer.moveTo(row, col);
        this.writer.write(
            chalk.keyword(bc)("[") +
                mark +
                chalk.keyword(bc)("]") +
                " " +
                chalk.keyword(labelColor)(label),
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 7. BUTTON  —  OCP via IButtonRenderer strategy
// ══════════════════════════════════════════════════════════════════════════════

// ── Built-in variant renderers ────────────────────────────────────────────────

/** Default bordered button:  [ Label ] */
export class DefaultButtonRenderer implements IButtonRenderer {
    render(
        writer: ITerminalWriter,
        row: number,
        col: number,
        w: number,
        label: string,
        focused: boolean,
        pressed: boolean,
    ): void {
        const bc = pressed ? "green" : focused ? "white" : "gray";
        const inner = w - 2;
        const prefix = pressed ? chalk.green("▶") : " ";
        const maxLabel = inner - 2;
        const labelText = label.slice(0, maxLabel).padEnd(maxLabel);
        const labelColour = focused || pressed ? "white" : "gray";

        writer.moveTo(row, col);
        writer.write(
            chalk.keyword(bc)("[") +
                prefix +
                chalk.keyword(labelColour)(labelText) +
                chalk.keyword(bc)("]"),
        );
    }
}

/** Filled primary button:  ▐ Label ▌ */
export class PrimaryButtonRenderer implements IButtonRenderer {
    render(
        writer: ITerminalWriter,
        row: number,
        col: number,
        w: number,
        label: string,
        _focused: boolean,
        pressed: boolean,
    ): void {
        const inner = w - 4;
        const labelText = label.slice(0, inner).padEnd(inner);

        writer.moveTo(row, col);
        writer.write(
            pressed
                ? chalk.bgGreen.black(`▐ ${labelText} ▌`)
                : chalk.bgWhite.black(`▐ ${labelText} ▌`),
        );
    }
}

/** Danger button:  [ Label ] in red */
export class DangerButtonRenderer implements IButtonRenderer {
    render(
        writer: ITerminalWriter,
        row: number,
        col: number,
        w: number,
        label: string,
        focused: boolean,
        pressed: boolean,
    ): void {
        const bc = pressed ? "white" : focused ? "red" : "gray";
        const inner = w - 2;
        const prefix = pressed ? chalk.white("!") : " ";
        const maxLabel = inner - 2;
        const labelText = label.slice(0, maxLabel).padEnd(maxLabel);
        const labelColour = focused ? (pressed ? "white" : "red") : "gray";

        writer.moveTo(row, col);
        writer.write(
            chalk.keyword(bc)("[") +
                prefix +
                chalk.keyword(labelColour)(labelText) +
                chalk.keyword(bc)("]"),
        );
    }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export type ButtonVariant = "default" | "primary" | "danger";

const BUTTON_RENDERERS: Record<ButtonVariant, IButtonRenderer> = {
    default: new DefaultButtonRenderer(),
    primary: new PrimaryButtonRenderer(),
    danger: new DangerButtonRenderer(),
};

// ── Button widget ─────────────────────────────────────────────────────────────

export class Button extends Widget implements IFocusable {
    private _focused = false;
    private _pressed = false;
    private readonly _variantRenderer: IButtonRenderer;

    constructor(
        private width: number,
        private label: string,
        variantOrRenderer: ButtonVariant | IButtonRenderer = "default",
        private onClick?: () => void,
        private onRender?: () => void,
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._variantRenderer =
            typeof variantOrRenderer === "string"
                ? BUTTON_RENDERERS[variantOrRenderer]
                : variantOrRenderer;
    }

    lineCount() {
        return 1;
    }
    naturalWidth() {
        return this.width;
    }

    isFocused() {
        return this._focused;
    }
    focus() {
        this._focused = true;
    }
    blur() {
        this._focused = false;
        this._pressed = false;
    }

    handleKey(key: readline.Key): boolean {
        if (key.name === "return" || key.name === "space") {
            this._pressed = true;
            this.onClick?.();
            setTimeout(() => {
                this._pressed = false;
                this.onRender?.();
            }, 120);
            return true;
        }
        return false;
    }

    renderLine(_li: number, row: number, col: number, maxWidth: number): void {
        this._variantRenderer.render(
            this.writer,
            row,
            col,
            Math.min(this.width, maxWidth),
            this.label,
            this._focused,
            this._pressed,
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 8. TEXTAREA
// ══════════════════════════════════════════════════════════════════════════════

export class Textarea extends Widget implements IFocusable {
    private _lines: string[];
    private _cursorRow = 0;
    private _cursorCol = 0;
    private _scroll: ScrollState;
    private _focused = false;

    constructor(
        private width: number,
        private height: number,
        initialValue = "",
        private placeholder = "",
        private onChange?: (value: string) => void,
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._lines = initialValue.length > 0 ? initialValue.split("\n") : [""];
        this._scroll = new ScrollState();
    }

    private iw(): number {
        return this.width - 2;
    }
    private ih(): number {
        return this.height - 2;
    }

    lineCount(): number {
        return this.height;
    }
    naturalWidth(): number {
        return this.width;
    }

    getValue(): string {
        return this._lines.join("\n");
    }
    setValue(v: string): void {
        this._lines = v.length > 0 ? v.split("\n") : [""];
        this._cursorRow = 0;
        this._cursorCol = 0;
        this._scroll = new ScrollState();
    }

    isFocused(): boolean {
        return this._focused;
    }
    focus(): void {
        this._focused = true;
    }
    blur(): void {
        this._focused = false;
    }

    activeLineHint(): number {
        return 1 + (this._cursorRow - this._scroll.y);
    }

    handleKey(key: readline.Key): boolean {
        const n = key.name;

        if (n === "tab" || n === "escape") return false;

        if (n === "left") this._moveCursorLeft();
        else if (n === "right") this._moveCursorRight();
        else if (n === "up") this._moveCursorUp();
        else if (n === "down") this._moveCursorDown();
        else if (n === "home") {
            this._cursorCol = key.ctrl ? (this._cursorRow = 0) : 0;
        } else if (n === "end") {
            if (key.ctrl) {
                this._cursorRow = this._lines.length - 1;
            }
            this._cursorCol = this._currentLine().length;
        } else if (n === "backspace") {
            this._deleteBackward();
            this.onChange?.(this.getValue());
        } else if (n === "delete") {
            this._deleteForward();
            this.onChange?.(this.getValue());
        } else if (n === "return") {
            this._insertNewline();
            this.onChange?.(this.getValue());
        } else if (
            key.sequence &&
            !key.ctrl &&
            !key.meta &&
            key.sequence.length === 1
        ) {
            this._insertChar(key.sequence);
            this.onChange?.(this.getValue());
        } else {
            return false;
        }

        this._clampScroll();
        return true;
    }

    // ── Cursor helpers ────────────────────────────────────────────────────────

    private _currentLine(): string {
        return this._lines[this._cursorRow] ?? "";
    }

    private _moveCursorLeft(): void {
        if (this._cursorCol > 0) {
            this._cursorCol--;
        } else if (this._cursorRow > 0) {
            this._cursorRow--;
            this._cursorCol = this._currentLine().length;
        }
    }

    private _moveCursorRight(): void {
        const line = this._currentLine();
        if (this._cursorCol < line.length) {
            this._cursorCol++;
        } else if (this._cursorRow < this._lines.length - 1) {
            this._cursorRow++;
            this._cursorCol = 0;
        }
    }

    private _moveCursorUp(): void {
        if (this._cursorRow > 0) {
            this._cursorRow--;
            this._cursorCol = Math.min(
                this._cursorCol,
                this._currentLine().length,
            );
        }
    }

    private _moveCursorDown(): void {
        if (this._cursorRow < this._lines.length - 1) {
            this._cursorRow++;
            this._cursorCol = Math.min(
                this._cursorCol,
                this._currentLine().length,
            );
        }
    }

    // ── Edit helpers ──────────────────────────────────────────────────────────

    private _insertChar(ch: string): void {
        const line = this._currentLine();
        this._lines[this._cursorRow] =
            line.slice(0, this._cursorCol) + ch + line.slice(this._cursorCol);
        this._cursorCol++;
    }

    private _insertNewline(): void {
        const line = this._currentLine();
        this._lines[this._cursorRow] = line.slice(0, this._cursorCol);
        this._lines.splice(this._cursorRow + 1, 0, line.slice(this._cursorCol));
        this._cursorRow++;
        this._cursorCol = 0;
    }

    private _deleteBackward(): void {
        if (this._cursorCol > 0) {
            const line = this._currentLine();
            this._lines[this._cursorRow] =
                line.slice(0, this._cursorCol - 1) +
                line.slice(this._cursorCol);
            this._cursorCol--;
        } else if (this._cursorRow > 0) {
            const prevLine = this._lines[this._cursorRow - 1] ?? "";
            this._cursorCol = prevLine.length;
            this._lines[this._cursorRow - 1] = prevLine + this._currentLine();
            this._lines.splice(this._cursorRow, 1);
            this._cursorRow--;
        }
    }

    private _deleteForward(): void {
        const line = this._currentLine();
        if (this._cursorCol < line.length) {
            this._lines[this._cursorRow] =
                line.slice(0, this._cursorCol) +
                line.slice(this._cursorCol + 1);
        } else if (this._cursorRow < this._lines.length - 1) {
            this._lines[this._cursorRow] =
                line + (this._lines[this._cursorRow + 1] ?? "");
            this._lines.splice(this._cursorRow + 1, 1);
        }
    }

    private _clampScroll(): void {
        const maxScrollY = Math.max(0, this._lines.length - this.ih());
        this._scroll.clampVertical(this._cursorRow, this.ih(), maxScrollY);
        this._scroll.clampHorizontal(this._cursorCol, this.iw());
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        const w = Math.min(this.width, maxWidth);
        const iw = w - 2;
        const bc = this._focused ? "white" : "gray";
        const b = (s: string) => chalk.keyword(bc)(s);
        const isEmpty = this._lines.length === 1 && this._lines[0] === "";

        if (li === 0) {
            this.writer.moveTo(row, col);
            this.writer.write(b("┌" + "─".repeat(iw) + "┐"));
            return;
        }

        if (li === this.height - 1) {
            this.writer.moveTo(row, col);
            this.writer.write(b("└" + "─".repeat(iw) + "┘"));
            return;
        }

        const visRow = li - 1;
        const absRow = this._scroll.y + visRow;
        const lineText = this._lines[absRow];

        this.writer.moveTo(row, col);

        if (lineText === undefined) {
            this.writer.write(b("│") + " ".repeat(iw) + b("│"));
            return;
        }

        if (isEmpty && !this._focused && visRow === 0) {
            this.writer.write(
                b("│") +
                    chalk.gray(this.placeholder.slice(0, iw).padEnd(iw)) +
                    b("│"),
            );
            return;
        }

        const padded = lineText
            .slice(this._scroll.x, this._scroll.x + iw)
            .padEnd(iw);

        if (this._focused && absRow === this._cursorRow) {
            const relCol = this._cursorCol - this._scroll.x;
            this.writer.write(
                b("│") +
                    chalk.white(padded.slice(0, relCol)) +
                    chalk.bgWhite.black(padded[relCol] ?? " ") +
                    chalk.white(padded.slice(relCol + 1)) +
                    b("│"),
            );
        } else {
            this.writer.write(b("│") + chalk.white(padded) + b("│"));
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 9. Chart
// ══════════════════════════════════════════════════════════════════════════════

export interface ITerminalWriter {
    moveTo(row: number, col: number): void;
    write(text: string): void;
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 1.  BrailleCanvas  ─ 픽셀 ↔ 점자 변환 엔진
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 점자 코드포인트 기준 도트 비트 배치
 *
 *   col→   0      1
 * row↓
 *   0    bit0   bit3
 *   1    bit1   bit4
 *   2    bit2   bit5
 *   3    bit6   bit7
 *
 * U+2800 (⠀) + bits → 점자 문자
 * 각 터미널 셀 1칸 = 가로 2픽셀 × 세로 4픽셀
 */
const BRAILLE_BITS: number[][] = [
    [0x01, 0x08], // row 0
    [0x02, 0x10], // row 1
    [0x04, 0x20], // row 2
    [0x40, 0x80], // row 3
];

class BrailleCanvas {
    /** 픽셀 버퍼: pixels[py][px] */
    private pixels: boolean[][];
    /** 컬러 버퍼: colors[py][px] (chalk 색상 이름) */
    private colors: (string | null)[][];

    constructor(
        /** 터미널 문자 열 수 */
        readonly cols: number,
        /** 터미널 문자 행 수 */
        readonly rows: number,
    ) {
        const ph = rows * 4;
        const pw = cols * 2;
        this.pixels = Array.from({ length: ph }, () =>
            new Array<boolean>(pw).fill(false),
        );
        this.colors = Array.from({ length: ph }, () =>
            new Array<string | null>(pw).fill(null),
        );
    }

    get pixelWidth() {
        return this.cols * 2;
    }
    get pixelHeight() {
        return this.rows * 4;
    }

    clear(): void {
        for (const row of this.pixels) row.fill(false);
        for (const row of this.colors) row.fill(null);
    }

    setPixel(px: number, py: number, color: string | null = "white"): void {
        if (px < 0 || px >= this.pixelWidth || py < 0 || py >= this.pixelHeight)
            return;
        this.pixels[py]![px] = true;
        this.colors[py]![px] = color;
    }

    /** 지정 터미널 셀(col, row)의 점자 문자 + 대표 색상 반환 */
    getCell(col: number, row: number): { ch: string; color: string } {
        let bits = 0;
        let color = "gray";
        let found = false;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 2; c++) {
                const py = row * 4 + r;
                const px = col * 2 + c;
                if (this.pixels[py]?.[px]) {
                    bits |= BRAILLE_BITS[r]![c]!;
                    if (!found) {
                        color = this.colors[py]?.[px] ?? "white";
                        found = true;
                    }
                }
            }
        }
        return { ch: String.fromCharCode(0x2800 + bits), color };
    }

    /**
     * 터미널 행 전체를 chalk 컬러 문자열로 반환.
     * 인접한 같은 색 셀은 묶어서 출력 효율을 높입니다.
     */
    getRow(row: number): string {
        let out = "";
        let runColor = "";
        let runStr = "";
        const flush = () => {
            if (runStr) out += chalk.keyword(runColor)(runStr);
            runStr = "";
        };
        for (let col = 0; col < this.cols; col++) {
            const { ch, color } = this.getCell(col, row);
            if (color !== runColor) {
                flush();
                runColor = color;
            }
            runStr += ch;
        }
        flush();
        return out;
    }

    // ── 드로잉 프리미티브 ──────────────────────────────────────────────────────

    /** Bresenham 직선 */
    drawLine(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        color = "white",
    ): void {
        const dx = Math.abs(x1 - x0),
            dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1,
            sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        for (;;) {
            this.setPixel(x0, y0, color);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    }

    /** 원형 점 (반지름 r 픽셀) */
    drawDot(cx: number, cy: number, r = 1, color = "white"): void {
        for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++)
                if (dx * dx + dy * dy <= r * r)
                    this.setPixel(cx + dx, cy + dy, color);
    }

    /** 채워진 수직 막대: (x, bottom) ~ (x, top) */
    drawBar(
        x: number,
        bottom: number,
        top: number,
        w: number,
        color = "white",
    ): void {
        for (let px = x; px < x + w; px++)
            for (let py = top; py <= bottom; py++) this.setPixel(px, py, color);
    }

    /**
     * 채워진 파이 섹터
     * @param cx, cy  중심 픽셀
     * @param r       반지름 픽셀
     * @param a0, a1  시작/끝 라디안 (0 = 우측, 반시계)
     */
    drawSector(
        cx: number,
        cy: number,
        r: number,
        a0: number,
        a1: number,
        color = "white",
    ): void {
        for (let py = -r; py <= r; py++) {
            for (let px = -r; px <= r; px++) {
                if (px * px + py * py > r * r) continue;
                const ang = Math.atan2(py, px);
                // 범위를 a0~a1 으로 정규화 (wrap-around 처리)
                let da = ang - a0;
                while (da < 0) da += Math.PI * 2;
                while (da > Math.PI * 2) da -= Math.PI * 2;
                let span = a1 - a0;
                while (span < 0) span += Math.PI * 2;
                while (span > Math.PI * 2) span -= Math.PI * 2;
                if (da <= span) this.setPixel(cx + px, cy + py, color);
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 2.  공용 타입 / 헬퍼
// ══════════════════════════════════════════════════════════════════════════════

/** 단일 시리즈 데이터 */
export interface Series {
    values: number[];
    label?: string;
    color?: string;
}

/** 산점도 점 */
export interface Point {
    x: number;
    y: number;
}

export interface ScatterSeries {
    points: Point[];
    label?: string;
    color?: string;
}

/** 원 그래프 슬라이스 */
export interface Slice {
    value: number;
    label?: string;
    color?: string;
}

const PALETTE = ["cyan", "yellow", "green", "magenta", "red", "blue", "white"];
const color = (i: number, override?: string) =>
    override ?? PALETTE[i % PALETTE.length]!;

/** 테두리 그리기 공통 헬퍼 */
function renderBorder(
    writer: ITerminalWriter,
    li: number,
    row: number,
    col: number,
    w: number,
    h: number,
    title: string,
): boolean {
    if (li === 0) {
        const inner = w - 1;
        const t = title.slice(0, inner - 2);
        const pad = "─".repeat(Math.max(0, inner - t.length - 2));
        writer.moveTo(row, col);
        writer.write(
            chalk.gray("┌─") + chalk.white.bold(t) + chalk.gray(pad + "┐"),
        );
        return true;
    }
    if (li === h - 1) {
        writer.moveTo(row, col);
        writer.write(chalk.gray("└" + "─".repeat(w - 2) + "┘"));
        return true;
    }
    return false;
}

/** 축 레이블 (최솟값 / 최댓값) */
function axisLabels(min: number, max: number, w: number): string {
    const lo = formatNum(min);
    const hi = formatNum(max);
    const space = Math.max(0, w - lo.length - hi.length);
    return chalk.gray(lo + " ".repeat(space) + hi);
}

function formatNum(n: number): string {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 3.  LineChart  —  꺾은선 그래프
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 꺾은선 그래프
 *
 * 레이아웃 (height 행):
 *  row 0         : 타이틀 테두리
 *  row 1 ~ h-3   : 브레일 캔버스 (ih = height-3 행)
 *  row h-2       : X축 레이블
 *  row h-1       : 하단 테두리
 */
export class LineChart extends Widget {
    private _canvas: BrailleCanvas;
    private _dirty = true;
    private _min = 0;
    private _max = 1;

    constructor(
        private readonly width: number,
        private readonly height: number,
        private series: Series[],
        private title = "Line Chart",
        writer?: ITerminalWriter,
    ) {
        super(writer);
        const canvasCols = width - 2; // 테두리 좌우 1씩
        const canvasRows = height - 3; // 테두리 상하 + 축 레이블
        this._canvas = new BrailleCanvas(canvasCols, canvasRows);
    }

    lineCount() {
        return this.height;
    }
    naturalWidth() {
        return this.width;
    }

    /** 런타임에 데이터 교체 */
    setSeries(s: Series[]): void {
        this.series = s;
        this._dirty = true;
    }

    private _render(): void {
        if (!this._dirty) return;
        this._dirty = false;
        this._canvas.clear();

        const all = this.series.flatMap((s) => s.values);
        if (all.length === 0) return;

        this._min = Math.min(...all);
        this._max = Math.max(...all);
        const range = this._max - this._min || 1;

        const pw = this._canvas.pixelWidth;
        const ph = this._canvas.pixelHeight;

        const toX = (i: number, len: number) =>
            Math.round((i / Math.max(len - 1, 1)) * (pw - 1));
        const toY = (v: number) =>
            Math.round((1 - (v - this._min) / range) * (ph - 1));

        for (let si = 0; si < this.series.length; si++) {
            const s = this.series[si]!;
            const c = color(si, s.color);
            for (let i = 1; i < s.values.length; i++) {
                this._canvas.drawLine(
                    toX(i - 1, s.values.length),
                    toY(s.values[i - 1]!),
                    toX(i, s.values.length),
                    toY(s.values[i]!),
                    c,
                );
            }
            // 마지막 점 강조
            const last = s.values.length - 1;
            this._canvas.drawDot(
                toX(last, s.values.length),
                toY(s.values[last]!),
                2,
                c,
            );
        }
    }

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        this._render();
        const w = Math.min(this.width, maxWidth);
        const h = this.height;

        if (renderBorder(this.writer, li, row, col, w, h, this.title)) return;

        // 축 레이블 행 (h-2)
        if (li === h - 2) {
            this.writer.moveTo(row, col);
            this.writer.write(
                chalk.gray("│") +
                    axisLabels(this._min, this._max, w - 2) +
                    chalk.gray("│"),
            );
            return;
        }

        // 캔버스 행 (1 ~ h-3)
        const canvasRow = li - 1;
        this.writer.moveTo(row, col);
        this.writer.write(
            chalk.gray("│") + this._canvas.getRow(canvasRow) + chalk.gray("│"),
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 4.  ScatterChart  —  산점도 그래프
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 산점도 그래프
 *
 * 각 점을 작은 원(반지름 1px)으로 표시합니다.
 */
export class ScatterChart extends Widget {
    private _canvas: BrailleCanvas;
    private _dirty = true;
    private _xMin = 0;
    private _xMax = 1;
    private _yMin = 0;
    private _yMax = 1;

    constructor(
        private readonly width: number,
        private readonly height: number,
        private series: ScatterSeries[],
        private title = "Scatter Chart",
        writer?: ITerminalWriter,
    ) {
        super(writer);
        const canvasCols = width - 2;
        const canvasRows = height - 4; // 위 테두리 + 아래 테두리 + X레이블 + Y레이블
        this._canvas = new BrailleCanvas(canvasCols, canvasRows);
    }

    lineCount() {
        return this.height;
    }
    naturalWidth() {
        return this.width;
    }

    setSeries(s: ScatterSeries[]): void {
        this.series = s;
        this._dirty = true;
    }

    private _render(): void {
        if (!this._dirty) return;
        this._dirty = false;
        this._canvas.clear();

        const allX = this.series.flatMap((s) => s.points.map((p) => p.x));
        const allY = this.series.flatMap((s) => s.points.map((p) => p.y));
        if (allX.length === 0) return;

        this._xMin = Math.min(...allX);
        this._xMax = Math.max(...allX);
        this._yMin = Math.min(...allY);
        this._yMax = Math.max(...allY);
        const xRange = this._xMax - this._xMin || 1;
        const yRange = this._yMax - this._yMin || 1;

        const pw = this._canvas.pixelWidth;
        const ph = this._canvas.pixelHeight;

        const toX = (x: number) =>
            Math.round(((x - this._xMin) / xRange) * (pw - 1));
        const toY = (y: number) =>
            Math.round((1 - (y - this._yMin) / yRange) * (ph - 1));

        for (let si = 0; si < this.series.length; si++) {
            const s = this.series[si]!;
            const c = color(si, s.color);
            for (const p of s.points)
                this._canvas.drawDot(toX(p.x), toY(p.y), 1, c);
        }
    }

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        this._render();
        const w = Math.min(this.width, maxWidth);
        const h = this.height;
        const iw = w - 2;

        if (renderBorder(this.writer, li, row, col, w, h, this.title)) return;

        // X 축 레이블 (h-2)
        if (li === h - 2) {
            this.writer.moveTo(row, col);
            this.writer.write(
                chalk.gray("│") +
                    axisLabels(this._xMin, this._xMax, iw) +
                    chalk.gray("│"),
            );
            return;
        }

        // 범례 행 (h-3)  — 시리즈명 나열
        if (li === h - 3) {
            let legend = "";
            for (let si = 0; si < this.series.length; si++) {
                const s = this.series[si]!;
                const c = color(si, s.color);
                const lbl = (s.label ?? `S${si + 1}`).slice(0, 8);
                legend += chalk.keyword(c)(`● ${lbl}  `);
            }
            const pad = Math.max(
                0,
                // eslint-disable-next-line no-control-regex
                iw - legend.replace(/\x1b\[[^m]*m/g, "").length,
            );
            this.writer.moveTo(row, col);
            this.writer.write(
                chalk.gray("│") + legend + " ".repeat(pad) + chalk.gray("│"),
            );
            return;
        }

        // 캔버스 행 (1 ~ h-4)
        const canvasRow = li - 1;
        this.writer.moveTo(row, col);
        this.writer.write(
            chalk.gray("│") + this._canvas.getRow(canvasRow) + chalk.gray("│"),
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 5.  BarChart  —  막대 그래프
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 수직 막대 그래프
 *
 * 각 막대 = 1 터미널 문자 폭 (= 2픽셀)
 * 막대 사이 간격 = 1 터미널 문자
 */
export class BarChart extends Widget {
    private _canvas: BrailleCanvas;
    private _dirty = true;
    private _max = 1;

    constructor(
        private readonly width: number,
        private readonly height: number,
        private values: number[],
        private labels: string[],
        private title = "Bar Chart",
        private barColor = "cyan",
        writer?: ITerminalWriter,
    ) {
        super(writer);
        const canvasCols = width - 2;
        const canvasRows = height - 3;
        this._canvas = new BrailleCanvas(canvasCols, canvasRows);
    }

    lineCount() {
        return this.height;
    }
    naturalWidth() {
        return this.width;
    }

    setData(values: number[], labels: string[]): void {
        this.values = values;
        this.labels = labels;
        this._dirty = true;
    }

    private _render(): void {
        if (!this._dirty) return;
        this._dirty = false;
        this._canvas.clear();

        if (this.values.length === 0) return;

        this._max = Math.max(...this.values, 0.001);
        const pw = this._canvas.pixelWidth;
        const ph = this._canvas.pixelHeight;
        const n = this.values.length;

        // 막대 폭(픽셀) 과 간격을 균등 분배
        const totalPx = pw;
        const barPx = Math.max(1, Math.floor(totalPx / (n * 2))); // 막대 1개 픽셀 폭
        const gapPx = Math.max(0, Math.floor((totalPx - barPx * n) / (n + 1)));

        let x = gapPx;
        for (let i = 0; i < n; i++) {
            const barH = Math.round((this.values[i]! / this._max) * (ph - 1));
            const top = ph - 1 - barH;
            // 막대 색상: 같은 색이나 팔레트에서 순환 가능
            const c = PALETTE[i % PALETTE.length]!;
            this._canvas.drawBar(x, ph - 1, top, barPx, c);
            x += barPx + gapPx;
        }
    }

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        this._render();
        const w = Math.min(this.width, maxWidth);
        const h = this.height;
        const iw = w - 2;

        if (renderBorder(this.writer, li, row, col, w, h, this.title)) return;

        // 레이블 행 (h-2)
        if (li === h - 2) {
            const n = this.values.length;
            // 균등 분배 레이블
            const slot = Math.max(1, Math.floor(iw / n));
            let lbl = "";
            for (let i = 0; i < n; i++) {
                const c = PALETTE[i % PALETTE.length]!;
                const t = (this.labels[i] ?? `${i + 1}`)
                    .slice(0, slot - 1)
                    .padEnd(slot);
                lbl += chalk.keyword(c)(t);
            }
            // eslint-disable-next-line no-control-regex
            const raw = lbl.replace(/\x1b\[[^m]*m/g, "");
            lbl += " ".repeat(Math.max(0, iw - raw.length));
            this.writer.moveTo(row, col);
            this.writer.write(chalk.gray("│") + lbl + chalk.gray("│"));
            return;
        }

        // 캔버스 행 (1 ~ h-3)
        const canvasRow = li - 1;
        this.writer.moveTo(row, col);
        this.writer.write(
            chalk.gray("│") + this._canvas.getRow(canvasRow) + chalk.gray("│"),
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 6.  PieChart  —  원 그래프
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 원 그래프
 *
 * 픽셀 종횡비(2:1) 보정을 위해 Y 반지름을 X 반지름의 절반으로 씁니다.
 */
export class PieChart extends Widget {
    private _canvas: BrailleCanvas;
    private _dirty = true;
    private _legendLines: string[] = [""];

    constructor(
        private readonly width: number,
        private readonly height: number,
        private slices: Slice[],
        private title = "Pie Chart",
        writer?: ITerminalWriter,
    ) {
        super(writer);
        const canvasCols = width - 2;
        const canvasRows = height - 3; // 테두리 상하 + 범례
        this._canvas = new BrailleCanvas(canvasCols, canvasRows);
    }

    lineCount() {
        return this.height;
    }
    naturalWidth() {
        return this.width;
    }

    setSlices(s: Slice[]): void {
        this.slices = s;
        this._dirty = true;
    }

    private _computeLegend(iw: number): string[] {
        const total = this.slices.reduce((s, sl) => s + sl.value, 0);
        const lines: string[] = [];
        let currentLine = "";
        let currentRawLen = 0;

        for (let si = 0; si < this.slices.length; si++) {
            const sl = this.slices[si]!;
            const c = color(si, sl.color);
            const pct =
                total > 0 ? ((sl.value / total) * 100).toFixed(0) + "%" : "0%";
            const lbl = (sl.label ?? `S${si + 1}`).slice(0, 8);
            const segment = `⬤ ${lbl} ${pct}  `;

            if (currentRawLen + segment.length > iw && currentLine) {
                lines.push(currentLine);
                currentLine = chalk.keyword(c)(segment);
                currentRawLen = segment.length;
            } else {
                currentLine += chalk.keyword(c)(segment);
                currentRawLen += segment.length;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines.length > 0 ? lines : [""];
    }

    private _render(): void {
        if (!this._dirty) return;
        this._dirty = false;

        const iw = this.width - 2;
        this._legendLines = this._computeLegend(iw);

        // 범례 줄 수에 맞춰 캔버스 재생성
        const canvasCols = this.width - 2;
        const canvasRows = Math.max(
            1,
            this.height - 2 - this._legendLines.length,
        );
        this._canvas = new BrailleCanvas(canvasCols, canvasRows);

        const total = this.slices.reduce((s, sl) => s + sl.value, 0);
        if (total === 0) return;

        const pw = this._canvas.pixelWidth;
        const ph = this._canvas.pixelHeight;
        const cx = Math.floor(pw / 2);
        const cy = Math.floor(ph / 2);
        const rx = Math.floor(Math.min(pw, ph * 2) / 2) - 1;

        let angle = -Math.PI / 2;
        for (let si = 0; si < this.slices.length; si++) {
            const sl = this.slices[si]!;
            const span = (sl.value / total) * Math.PI * 2;
            const c = color(si, sl.color);
            const a0 = angle;
            for (let py = -rx; py <= rx; py++) {
                for (let px = -rx; px <= rx; px++) {
                    const ey = py * 2;
                    if (px * px + ey * ey > rx * rx) continue;
                    const ang = Math.atan2(ey, px);
                    let da = ang - a0;
                    while (da < 0) da += Math.PI * 2;
                    while (da >= Math.PI * 2) da -= Math.PI * 2;
                    let sp = span;
                    while (sp < 0) sp += Math.PI * 2;
                    if (da <= sp) this._canvas.setPixel(cx + px, cy + py, c);
                }
            }
            angle += span;
        }
    }

    renderLine(li: number, row: number, col: number, maxWidth: number): void {
        this._render();
        const w = Math.min(this.width, maxWidth);
        const h = this.height;
        const iw = w - 2;

        if (renderBorder(this.writer, li, row, col, w, h, this.title)) return;

        // 범례 행들: (h - 1 - legendCount) ~ (h - 2)
        const legendCount = this._legendLines.length;
        const legendStart = h - 1 - legendCount;

        if (li >= legendStart && li <= h - 2) {
            const legendIdx = li - legendStart;
            const line = this._legendLines[legendIdx] ?? "";
            // eslint-disable-next-line no-control-regex
            const raw = line.replace(/\x1b\[[^m]*m/g, "");
            const pad = Math.max(0, iw - raw.length);
            this.writer.moveTo(row, col);
            this.writer.write(
                chalk.gray("│") + line + " ".repeat(pad) + chalk.gray("│"),
            );
            return;
        }

        // 캔버스 행 (1 ~ legendStart - 1)
        const canvasRow = li - 1;
        this.writer.moveTo(row, col);
        this.writer.write(
            chalk.gray("│") + this._canvas.getRow(canvasRow) + chalk.gray("│"),
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 10. CONTAINER
//       SRP: rendering, focus management, and scrolling are now separate.
// ══════════════════════════════════════════════════════════════════════════════

export type ContainerState = "default" | "select" | "focus";

export interface ContainerStyle {
    width: number;
    height: number;
}

export class Container extends Widget {
    private state: ContainerState = "default";
    private readonly _scroll: ScrollState;
    private readonly _focus: FocusManager;

    constructor(
        private style: ContainerStyle,
        private children: Widget[],
        writer?: ITerminalWriter,
    ) {
        super(writer);
        this._scroll = new ScrollState();

        const focusables = children.flatMap((c) =>
            "isFocused" in c ? [c as unknown as IFocusable] : [],
        );
        this._focus = new FocusManager(focusables);
    }

    // ── Viewport helpers ──────────────────────────────────────────────────────

    private iw(): number {
        return this.style.width - 4;
    }
    private ih(): number {
        return this.style.height - 3;
    }
    private contentWidth(): number {
        return this.iw() - 2;
    }

    private _totalLines(): number {
        return this.children.reduce((s, c) => s + c.lineCount(), 0);
    }
    private _maxLineWidth(): number {
        return this.children.reduce((m, c) => Math.max(m, c.naturalWidth()), 0);
    }
    private _maxScrollY(): number {
        return Math.max(0, this._totalLines() - this.ih());
    }
    private _maxScrollX(): number {
        return Math.max(0, this._maxLineWidth() - this.contentWidth());
    }

    // ── Public API ────────────────────────────────────────────────────────────

    lineCount() {
        return this.style.height;
    }
    getState() {
        return this.state;
    }
    setState(s: ContainerState) {
        this.state = s;
    }

    // ── Key handling ──────────────────────────────────────────────────────────

    handleKey(key: readline.Key): void {
        if (this.state === "focus") {
            this._handleFocusMode(key);
        } else if (this.state === "select" && key.name === "return") {
            this.state = "focus";
            this._focus.initFirst();
            this._scrollToFocused();
        }
    }

    private _handleFocusMode(key: readline.Key): void {
        const n = key.name;
        const active = this._focus.current;

        // Delegate to focused child first
        if (active) {
            const consumed = active.handleKey(key);
            if (consumed) {
                this._scrollToFocused();
                return;
            }
        }

        // Tab / Shift+Tab: cycle focus
        if (n === "tab") {
            this._focus.cycle(key.shift ? -1 : 1);
            this._scrollToFocused();
            return;
        }

        // Escape: blur child → or exit focus mode
        if (n === "escape") {
            if (this._focus.hasFocus) {
                this._focus.clear();
            } else {
                this.state = "select";
            }
            return;
        }

        // No child focused: scroll container
        if (!this._focus.hasFocus) {
            if (n === "up")
                this._scroll.setY(this._scroll.y - 1, this._maxScrollY());
            if (n === "down")
                this._scroll.setY(this._scroll.y + 1, this._maxScrollY());
            if (n === "left")
                this._scroll.setX(this._scroll.x - 1, this._maxScrollX());
            if (n === "right")
                this._scroll.setX(this._scroll.x + 1, this._maxScrollX());
        }
    }

    /**
     * SRP: scroll logic now lives here, using ScrollState's helpers.
     * The FocusManager provides the target widget; we compute its line offset
     * within the children list and delegate clamping to ScrollState.
     */
    private _scrollToFocused(): void {
        const target = this._focus.current;
        if (!target) return;

        let lineOffset = 0;
        for (const child of this.children) {
            if ((child as unknown as IFocusable) === target) {
                const hint = target.activeLineHint?.() ?? 0;
                const targetLine = lineOffset + hint;
                const topAnchor = lineOffset;
                const ih = this.ih();

                if (targetLine < this._scroll.y) {
                    this._scroll.setY(
                        Math.min(targetLine, topAnchor),
                        this._maxScrollY(),
                    );
                } else if (targetLine >= this._scroll.y + ih) {
                    const desired = targetLine - ih + 1;
                    this._scroll.setY(
                        Math.min(desired, topAnchor),
                        this._maxScrollY(),
                    );
                }

                return;
            }
            lineOffset += child.lineCount();
        }
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    renderLine(_li: number, row: number, col: number): void {
        this._renderAt(row, col);
    }

    /** Convenience entry point when you know the absolute terminal position. */
    renderAt(row: number, col: number): void {
        this._renderAt(row, col);
    }

    private _renderAt(row: number, col: number): void {
        const w = this.style.width;
        const ih = this.ih();
        const iw = this.iw();
        const tl = this._totalLines();
        const cw = this.contentWidth();
        const msY = this._maxScrollY();
        const msX = this._maxScrollX();
        const mlw = this._maxLineWidth();

        const bc =
            this.state === "focus"
                ? "white"
                : this.state === "select"
                  ? "yellow"
                  : "gray";
        const b = (s: string) => chalk.keyword(bc)(s);

        // ── Top border ────────────────────────────────────────────────────────

        const [tagChalk, tagLen] =
            this.state === "focus"
                ? [chalk.red("⎋") + chalk.white("quit"), 5]
                : [chalk.green("↵") + chalk.white("enter"), 6];

        this.writer.moveTo(row, col);
        this.writer.write(
            b("┌──┐") +
                tagChalk +
                b("┌" + "─".repeat(w - 4 - tagLen - 2) + "┐"),
        );

        // ── Content rows + vertical scrollbar ────────────────────────────────

        // Compute vertical thumb geometry only when scrollable
        const vThumbH =
            msY > 0 ? Math.max(1, Math.round((ih / Math.max(tl, 1)) * ih)) : 0;
        const vThumbTop =
            msY > 0 ? Math.round((this._scroll.y / msY) * (ih - vThumbH)) : 0;

        for (let i = 0; i < ih; i++) {
            const isThumb =
                msY > 0 && i >= vThumbTop && i < vThumbTop + vThumbH;
            // Show scrollbar track/thumb only when content overflows vertically
            const sbChar =
                msY > 0 ? (isThumb ? chalk.white("┃") : chalk.gray("║")) : " ";
            this.writer.moveTo(row + 1 + i, col);
            this.writer.write(b("│") + " ".repeat(iw) + sbChar + " " + b("│"));
        }

        const contentCol = col + 3;
        let absLine = 0;

        for (const child of this.children) {
            for (let li = 0; li < child.lineCount(); li++) {
                const vis = absLine - this._scroll.y;
                if (vis >= 0 && vis < ih) {
                    child.renderLine(
                        li,
                        row + 1 + vis,
                        contentCol,
                        cw,
                        this._scroll.x,
                    );
                }
                absLine++;
            }
        }

        // ── Horizontal scrollbar ──────────────────────────────────────────────

        const hTrackLen = iw - 1;

        // Build horizontal scrollbar row: show bar only when scrollable
        let bar = "";
        if (msX > 0) {
            const hThumbLen =
                mlw > 0
                    ? Math.max(1, Math.round((cw / mlw) * hTrackLen))
                    : hTrackLen;
            const hThumbPos = Math.round(
                (this._scroll.x / msX) * (hTrackLen - hThumbLen),
            );
            for (let i = 0; i < hTrackLen; i++) {
                bar +=
                    i >= hThumbPos && i < hThumbPos + hThumbLen
                        ? chalk.white("━")
                        : chalk.gray("═");
            }
        } else {
            bar = " ".repeat(hTrackLen);
        }
        bar += chalk.gray("╝");

        this.writer.moveTo(row + 1 + ih, col);
        this.writer.write(b("│") + " " + bar + " " + b("│"));

        // ── Bottom border ─────────────────────────────────────────────────────

        this.writer.moveTo(row + 2 + ih, col);
        this.writer.write(b("└" + "─".repeat(w - 2) + "┘"));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  § 11. CONTAINER GROUP
// ══════════════════════════════════════════════════════════════════════════════

export class ContainerGroup {
    private _sel = -1;

    constructor(private containers: Container[]) {}

    handleKey(key: readline.Key): void {
        // If any container is in focus mode, delegate to it exclusively
        const focusedIdx = this.containers.findIndex(
            (c) => c.getState() === "focus",
        );
        if (focusedIdx !== -1) {
            this.containers[focusedIdx]!.handleKey(key);
            return;
        }

        if (this._sel === -1) {
            if (key.name === "right" || key.name === "tab") {
                this._moveSel(key.shift ? this.containers.length - 1 : 0);
            }
            return;
        }

        const n = key.name;

        if (n === "return") {
            this.containers[this._sel]!.handleKey(key);
        } else if (n === "right" || (n === "tab" && !key.shift)) {
            this._moveSel((this._sel + 1) % this.containers.length);
        } else if (n === "left" || (n === "tab" && key.shift)) {
            this._moveSel(
                (this._sel - 1 + this.containers.length) %
                    this.containers.length,
            );
        } else if (n === "escape") {
            this._clearSel();
        }
    }

    private _moveSel(i: number): void {
        if (this._sel >= 0) this.containers[this._sel]!.setState("default");
        this._sel = i;
        this.containers[i]!.setState("select");
    }

    private _clearSel(): void {
        if (this._sel >= 0) this.containers[this._sel]!.setState("default");
        this._sel = -1;
    }
}
