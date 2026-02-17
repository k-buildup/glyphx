// ══════════════════════════════════════════════════════════════════════════════
//  Demo
// ══════════════════════════════════════════════════════════════════════════════

import {
    Cursor,
    Screen,
    Input,
    Button,
    Container,
    ContainerGroup,
    Select,
    Radio,
    CheckBox,
    Label,
    Event,
    ContainerStyle,
    Textarea,
    LineChart,
    ScatterChart,
    BarChart,
    PieChart,
} from "../src";
import * as readline from "readline";
import chalk from "chalk";

const screen = new Screen();
screen.enter();
process.stdin.setRawMode(true);
Cursor.hide();

const S: ContainerStyle = { width: 32, height: 16 };

// ─── Container 1 : Input fields ───────────────────────────────────────────────
const inputName = new Input(24, "e.g. Jane Doe");
const inputEmail = new Input(24, "e.g. hello@example.com");
const inputPass = new Input(24, "password", "password");
const inputBio = new Textarea(24, 6, "", "Input your bio");
const submitBtn = new Button(24, "Submit", "primary", () => {}, render);

const c1 = new Container(S, [
    new Label(""),
    new Label("# Input", "white"),
    new Label(""),
    new Label("Name", "gray"),
    inputName,
    new Label(""),
    new Label("Email", "gray"),
    inputEmail,
    new Label(""),
    new Label("Password", "gray"),
    inputPass,
    new Label(""),
    new Label("Bio", "gray"),
    inputBio,
    new Label(""),
    submitBtn,
]);

// ─── Container 2 : Select + Radio ─────────────────────────────────────────────
const selectLang = new Select(
    24,
    ["TypeScript", "Rust", "Go", "Python", "C++"],
    0,
);

const radioTheme = new Radio(["Light", "Dark", "System"], 1);

const c2 = new Container(S, [
    new Label(""),
    new Label("# Select", "white"),
    new Label(""),
    new Label("Language", "gray"),
    selectLang,
    new Label(""),
    new Label("# Radio", "white"),
    new Label(""),
    new Label("Theme", "gray"),
    radioTheme,
]);

// ─── Container 3 : CheckBoxes ──────────────────────────────────────────────────
const checks = [
    new CheckBox("Auto-save", true),
    new CheckBox("Word wrap", true),
    new CheckBox("Line numbers", true),
    new CheckBox("Spell check", false),
    new CheckBox("Minimap", false),
    new CheckBox("Bracket match", true),
    new CheckBox("Format on save", false),
    new CheckBox("Tab completion", true),
];

const c3 = new Container(S, [
    new Label(""),
    new Label("# CheckBox", "white"),
    new Label(""),
    ...checks,
]);

const allContainers = [c1, c2, c3];
const group = new ContainerGroup(allContainers);

const COLS = [1, 34, 67] as const;

// ── 꺾은선 ────────────────────────────────────────────────────────────────
const lineChart = new LineChart(24, 8, [
    {
        values: [3, 7, 2, 9, 5, 11, 8, 14, 6, 12],
        label: "Sales",
        color: "cyan",
    },
    {
        values: [1, 4, 6, 3, 8, 5, 9, 7, 10, 8],
        label: "Profit",
        color: "yellow",
    },
]);

// ── 산점도 ────────────────────────────────────────────────────────────────
const scatter = new ScatterChart(24, 8, [
    {
        points: Array.from({ length: 20 }, () => ({
            x: Math.random() * 10,
            y: Math.random() * 10,
        })),
        label: "A",
        color: "green",
    },
    {
        points: Array.from({ length: 15 }, () => ({
            x: Math.random() * 10 + 2,
            y: Math.random() * 5 + 3,
        })),
        label: "B",
        color: "magenta",
    },
]);

// ── 막대 ──────────────────────────────────────────────────────────────────
const bar = new BarChart(
    24,
    8,
    [42, 87, 35, 68, 91, 54, 76, 23],
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"],
);

// ── 원 ────────────────────────────────────────────────────────────────────
const pie = new PieChart(24, 8, [
    { value: 35, label: "Chrome", color: "cyan" },
    { value: 28, label: "Safari", color: "yellow" },
    { value: 18, label: "Firefox", color: "green" },
    { value: 11, label: "Edge", color: "magenta" },
    { value: 8, label: "Others", color: "gray" },
]);

function render(): void {
    for (let i = 0; i < allContainers.length; i++) {
        allContainers[i]!.renderAt(1, COLS[i] ?? 1);
    }

    for (let i = 0; i < lineChart.lineCount(); i++)
        lineChart.renderLine(i, 1 + i, 100, 80);
    for (let i = 0; i < scatter.lineCount(); i++)
        scatter.renderLine(i, 9 + i, 100, 80);
    for (let i = 0; i < bar.lineCount(); i++) bar.renderLine(i, 1 + i, 125, 80);
    for (let i = 0; i < pie.lineCount(); i++) pie.renderLine(i, 9 + i, 125, 80);

    Cursor.moveTo(process.stdout.columns - 1, 1);
    process.stdout.write(
        chalk`{gray  ←/→ }{white  switch panels }{gray  ↵ }{white  enter panel }{gray  ⇥ }{white  next field }{gray  ⎋ }{white  back }{gray  ⌃C }{white  quit }`,
    );
}

render();

const event = new Event(process, screen);
event.add({
    name: "main",
    next(key: readline.Key) {
        group.handleKey(key);
        render();
    },
});
event.setup();
