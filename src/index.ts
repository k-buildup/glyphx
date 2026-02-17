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
//  § 9. CONTAINER
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

        const vThumbH = Math.max(1, Math.round((ih / Math.max(tl, 1)) * ih));
        const vThumbTop =
            msY > 0 ? Math.round((this._scroll.y / msY) * (ih - vThumbH)) : 0;

        for (let i = 0; i < ih; i++) {
            const isThumb = i >= vThumbTop && i < vThumbTop + vThumbH;
            const sbChar = isThumb ? chalk.white("┃") : chalk.gray("║");
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
        const hThumbLen =
            mlw > 0
                ? Math.max(1, Math.round((cw / mlw) * hTrackLen))
                : hTrackLen;
        const hThumbPos =
            msX > 0
                ? Math.round((this._scroll.x / msX) * (hTrackLen - hThumbLen))
                : 0;

        let bar = "";
        for (let i = 0; i < hTrackLen; i++) {
            bar +=
                i >= hThumbPos && i < hThumbPos + hThumbLen
                    ? chalk.white("━")
                    : chalk.gray("═");
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
//  § 10. CONTAINER GROUP
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
