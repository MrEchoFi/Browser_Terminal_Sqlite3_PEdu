"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Database,
  Download,
  FileText,
  Folder,
  Info,
  RotateCcw,
  Save,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

type FSNode = {
  type: "file" | "dir";
  content?: string;
  children?: Record<string, FSNode>;
};

type PathState = string[];
type HistoryItem = { cmd: string; output: string[] };
type SqliteMode = "ascii" | "box" | "column" | "csv" | "json" | "line" | "list" | "markdown";

type SqliteSettings = {
  filename: string;
  readonly: boolean;
  echo: boolean;
  batch: boolean;
  headers: boolean;
  nullValue: string;
  separator: string;
  mode: SqliteMode;
  preCommands: string[];
};

type ManPage = {
  name: string;
  synopsis: string;
  description: string[];
  examples: string[];
  notes?: string[];
};

const DB_STORAGE_PREFIX = "browser-terminal-sqlite:";
const SQLITE_WASM_PATH = "/sql-wasm.wasm";

const initialFS: FSNode = {
  type: "dir",
  children: {
    home: {
      type: "dir",
      children: {
        tanjib: {
          type: "dir",
          children: {
            "readme.txt": {
              type: "file",
              content: "Welcome to the browser terminal. Type 'help' or 'man help'.",
            },
            projects: {
              type: "dir",
              children: {
                "notes.txt": {
                  type: "file",
                  content: "This is a virtual filesystem running in the browser.",
                },
              },
            },
          },
        },
      },
    },
    etc: {
      type: "dir",
      children: {
        os_release: { type: "file", content: 'NAME="BrowserOS"\nVERSION="1.0"' },
      },
    },
  },
};

const SHELL_COMMANDS = [
  "help",
  "clear",
  "pwd",
  "ls",
  "tree",
  "cd",
  "cat",
  "echo",
  "date",
  "uname",
  "whoami",
  "mkdir",
  "touch",
  "rm",
  "rmdir",
  "cp",
  "mv",
  "grep",
  "head",
  "tail",
  "history",
  "env",
  "which",
  "man",
  "nano",
  "sqlite3",
  "info",
  "reset",
];

const SQLITE_DOT_COMMANDS = [
  ".help",
  ".tables",
  ".schema",
  ".indexes",
  ".indices",
  ".databases",
  ".show",
  ".dump",
  ".mode",
  ".headers",
  ".nullvalue",
  ".separator",
  ".open",
  ".save",
  ".read",
  ".archive",
  ".version",
  ".exit",
  ".quit",
];

const MAN_PAGES: Record<string, ManPage> = {
  help: {
    name: "help",
    synopsis: "help",
    description: [
      "Show the built-in shell commands available in this browser terminal.",
      "This terminal is sandboxed, so commands operate on the virtual filesystem and browser SQLite engine.",
    ],
    examples: ["help", "man help"],
  },
  man: {
    name: "man",
    synopsis: "man TOPIC",
    description: [
      "Open a manual page in the right-hand help panel.",
      "The panel is searchable and keeps command documentation visible while you work.",
    ],
    examples: ["man sqlite3", "man nano"],
  },
  nano: {
    name: "nano",
    synopsis: "nano FILE",
    description: [
      "Open a browser-based text editor for a file in the virtual filesystem.",
      "Create new files, edit content, and save back to the sandboxed filesystem.",
    ],
    examples: ["nano notes.txt", "nano /home/tanjib/projects/todo.txt"],
    notes: ["Ctrl+S saves, Ctrl+X closes the editor."],
  },
  sqlite3: {
    name: "sqlite3",
    synopsis: "sqlite3 [OPTIONS] [FILENAME]",
    description: [
      "Enter the SQLite shell backed by sql.js (SQLite compiled to WebAssembly).",
      "Supports file names, :memory:, common output modes, dot-commands, persistence, and export.",
    ],
    examples: ["sqlite3", "sqlite3 mydata.db", "sqlite3 -column mydata.db"],
    notes: ["Use .tables, .schema, .mode, .headers, .dump, .open, .save."],
  },
  ls: {
    name: "ls",
    synopsis: "ls [PATH]",
    description: ["List files and directories in the virtual filesystem."],
    examples: ["ls", "ls /home/tanjib"],
  },
  cd: {
    name: "cd",
    synopsis: "cd [PATH]",
    description: ["Change the current directory in the virtual filesystem."],
    examples: ["cd /home/tanjib/projects", "cd .."],
  },
  cat: {
    name: "cat",
    synopsis: "cat FILE",
    description: ["Display file content from the virtual filesystem."],
    examples: ["cat readme.txt"],
  },
  grep: {
    name: "grep",
    synopsis: "grep PATTERN FILE",
    description: ["Search file content for matching lines."],
    examples: ["grep note notes.txt"],
  },
  "sqlite3-options": {
    name: "sqlite3 options",
    synopsis: "sqlite3 [OPTIONS] [FILENAME]",
    description: [
      "Supported compatibility flags include -help, -version, -column, -csv, -json, -line, -list, -box, -table, -markdown, -headers, -separator, -nullvalue, -cmd, -echo, -batch, and -readonly.",
      "This browser build accepts common flags and maps them to the WebAssembly SQLite shell behavior.",
    ],
    examples: ["sqlite3 -help", "sqlite3 -csv mydata.db"],
  },
};

function cloneFS<T>(value: T): T {
  return structuredClone(value);
}

function pathToString(path: PathState) {
  return "/" + path.join("/");
}

function getNode(root: FSNode, path: PathState): FSNode | null {
  let node: FSNode = root;
  for (const part of path) {
    if (node.type !== "dir" || !node.children?.[part]) return null;
    node = node.children[part];
  }
  return node;
}

function resolvePath(current: PathState, input: string) {
  const absolute = input.startsWith("/");
  const parts = (absolute ? input.slice(1) : input).split("/").filter(Boolean);
  const out = absolute ? [] : [...current];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

function splitInput(input: string) {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function listDir(node: FSNode | null) {
  if (!node || node.type !== "dir" || !node.children) return [] as string[];
  return Object.keys(node.children).sort((a, b) => a.localeCompare(b));
}

function treeLines(node: FSNode | null, name = ".", prefix = ""): string[] {
  if (!node) return [];
  const lines = [`${prefix}${name}${node.type === "dir" ? "/" : ""}`];
  if (node.type === "dir" && node.children) {
    const entries = Object.entries(node.children).sort(([a], [b]) => a.localeCompare(b));
    entries.forEach(([childName, childNode], idx) => {
      const isLast = idx === entries.length - 1;
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${childName}${childNode.type === "dir" ? "/" : ""}`);
      if (childNode.type === "dir" && childNode.children) {
        lines.push(...treeLines(childNode, childName, prefix + (isLast ? "    " : "│   ")).slice(1));
      }
    });
  }
  return lines;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeCsv(value: unknown, nullValue: string) {
  const s = value === null || value === undefined ? nullValue : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function formatRows(columns: string[], rows: unknown[][], nullValue: string) {
  const data = rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? nullValue : String(cell))));
  return { columns, data };
}

function formatColumnOutput(columns: string[], rows: unknown[][], nullValue: string) {
  const { data } = formatRows(columns, rows, nullValue);
  const widths = columns.map((col, i) => Math.max(col.length, ...data.map((row) => row[i]?.length ?? 0)));
  const pad = (v: string, width: number) => v + " ".repeat(Math.max(0, width - v.length));
  return [columns.map((c, i) => pad(c, widths[i])).join("  "), ...data.map((row) => row.map((c, i) => pad(c, widths[i])).join("  "))];
}

function formatBoxOutput(columns: string[], rows: unknown[][], headers: boolean, nullValue: string) {
  const { data } = formatRows(columns, rows, nullValue);
  const widths = columns.map((col, i) => Math.max(col.length, ...data.map((row) => row[i]?.length ?? 0), 3));
  const rowLine = (cells: string[]) => "│" + cells.map((cell, i) => ` ${cell}${" ".repeat(widths[i] - cell.length + 1)}`).join("│") + "│";
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const mid = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bottom = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  const out: string[] = [top];
  if (headers) {
    out.push(rowLine(columns));
    if (data.length) out.push(mid);
  }
  data.forEach((row) => out.push(rowLine(row)));
  out.push(bottom);
  return out;
}

function formatMarkdownOutput(columns: string[], rows: unknown[][], nullValue: string) {
  const { data } = formatRows(columns, rows, nullValue);
  return [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...data.map((row) => `| ${row.join(" | ")} |`)];
}

function formatCsvOutput(columns: string[], rows: unknown[][], headers: boolean, nullValue: string) {
  const out: string[] = [];
  if (headers) out.push(columns.map((c) => escapeCsv(c, nullValue)).join(","));
  rows.forEach((row) => out.push(row.map((v) => escapeCsv(v, nullValue)).join(",")));
  return out;
}

function formatListOutput(_columns: string[], rows: unknown[][], separator: string, nullValue: string) {
  return rows.length ? rows.map((row) => row.map((v) => (v === null || v === undefined ? nullValue : String(v))).join(separator)) : [""];
}

function formatLineOutput(columns: string[], rows: unknown[][], nullValue: string) {
  const out: string[] = [];
  rows.forEach((row) => {
    columns.forEach((col, idx) => {
      const val = row[idx] === null || row[idx] === undefined ? nullValue : String(row[idx]);
      out.push(`${col} = ${val}`);
    });
    out.push("");
  });
  return out.length ? out : [""];
}

function formatJsonOutput(columns: string[], rows: unknown[][]) {
  const data = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx] ?? null;
    });
    return obj;
  });
  return [JSON.stringify(data, null, 2)];
}

function findCommandAutocomplete(prefix: string, sqliteMode: boolean) {
  const commands = sqliteMode ? SQLITE_DOT_COMMANDS : SHELL_COMMANDS;
  return commands.filter((cmd) => cmd.startsWith(prefix));
}

function getManPage(topic: string) {
  return MAN_PAGES[topic] || MAN_PAGES[topic.toLowerCase()] || null;
}

export default function BrowserTerminal() {
  const [fs, setFs] = useState<FSNode>(() => cloneFS(initialFS));
  const [cwd, setCwd] = useState<PathState>(["home", "tanjib"]);
  const [history, setHistory] = useState<HistoryItem[]>([
    {
      cmd: "",
      output: [
        "Browser Terminal ready.",
        "Type 'help' or 'man help'.",
        "Type 'sqlite3' to enter the SQLite shell.",
      ],
    },
  ]);
  const [input, setInput] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [dark, setDark] = useState(true);
  const [lastStatus, setLastStatus] = useState("Ready");
  const [sqliteReady, setSqliteReady] = useState(false);
  const [sqliteMode, setSqliteMode] = useState(false);
  const [sqliteInfo, setSqliteInfo] = useState("Loading SQLite engine...");
  const [sqliteFilename, setSqliteFilename] = useState(":memory:");
  const [sqliteSettings, setSqliteSettings] = useState<SqliteSettings>({
    filename: ":memory:",
    readonly: false,
    echo: false,
    batch: false,
    headers: true,
    nullValue: "",
    separator: "|",
    mode: "column",
    preCommands: [],
  });
  const [nanoOpen, setNanoOpen] = useState(false);
  const [nanoPath, setNanoPath] = useState<PathState | null>(null);
  const [nanoText, setNanoText] = useState("");
  const [nanoDirty, setNanoDirty] = useState(false);
  const [manTopic, setManTopic] = useState("help");
  const [manSearch, setManSearch] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteItems, setAutocompleteItems] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const dbRef = useRef<any>(null);
  const SQLRef = useRef<any>(null);
  const nanoTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const prompt = sqliteMode ? "sqlite>" : `tanjib@browser:${pathToString(cwd)}$`;

  const manTopics = useMemo(() => Object.keys(MAN_PAGES).sort(), []);
  const filteredManTopics = useMemo(() => {
    const q = manSearch.trim().toLowerCase();
    if (!q) return manTopics;
    return manTopics.filter((topic) => topic.toLowerCase().includes(q) || (getManPage(topic)?.synopsis.toLowerCase().includes(q) ?? false));
  }, [manSearch, manTopics]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        //const initSqlJs = (await import("sql.js")).default;
        const initSqlJs = (await import("sql.js") as any).default;
        const SQL = await initSqlJs({
          locateFile: (file: string) => (file.endsWith(".wasm") ? SQLITE_WASM_PATH : `/${file}`),
        });
        if (!mounted) return;
        SQLRef.current = SQL;
        setSqliteReady(true);
        setSqliteInfo("SQLite WASM loaded successfully.");
        const db = new SQL.Database();
        db.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO users (name, email)
          SELECT 'Alice', 'alice@example.com'
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'alice@example.com');
          INSERT INTO users (name, email)
          SELECT 'Bob', 'bob@example.com'
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'bob@example.com');
        `);
        dbRef.current = db;
        persistDb(":memory:", db);
      } catch (err: any) {
        setSqliteInfo(`SQLite init failed: ${err?.message || String(err)}`);
      }
    })();
    return () => {
      mounted = false;
      try {
        dbRef.current?.close?.();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, sqliteMode]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [sqliteMode]);

  useEffect(() => {
    nanoTextAreaRef.current?.focus();
  }, [nanoOpen]);

  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed) {
      setAutocompleteItems([]);
      setAutocompleteOpen(false);
      return;
    }
    const endsWithSpace = /\s$/.test(input);
    const parts = input.split(/\s+/).filter(Boolean);
    const first = parts[0] || "";
    let items: string[] = [];
    if (!sqliteMode) {
      if (parts.length === 1 && !endsWithSpace) {
        items = findCommandAutocomplete(first, false);
      } else if (["cd", "cat", "nano", "man", "ls", "tree", "rm", "rmdir", "cp", "mv", "grep", "head", "tail"].includes(first)) {
        const currentToken = endsWithSpace ? "" : parts[parts.length - 1] || "";
        const entries = listDir(getNode(fs, cwd));
        items = entries.filter((entry) => entry.startsWith(currentToken)).map((entry) => (currentToken ? input.slice(0, input.length - currentToken.length) + entry : input + entry));
      }
    } else {
      if (parts.length === 1 && first.startsWith(".")) {
        items = findCommandAutocomplete(first, true);
      }
    }
    setAutocompleteItems(items.slice(0, 8));
    setAutocompleteOpen(items.length > 0);
    setAutocompleteIndex(0);
  }, [input, sqliteMode, cwd, fs]);

  function persistDb(filename: string, db: any) {
    if (typeof window === "undefined" || filename === ":memory:") return;
    const bytes = db.export();
    window.localStorage.setItem(`${DB_STORAGE_PREFIX}${filename}`, bytesToBase64(bytes));
    setSqliteInfo(`Saved ${filename} (${bytes.length} bytes) to browser storage.`);
  }

  function seedDatabase(db: any) {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users (name, email)
      SELECT 'Alice', 'alice@example.com'
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'alice@example.com');
      INSERT INTO users (name, email)
      SELECT 'Bob', 'bob@example.com'
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'bob@example.com');
    `);
  }

  function openDb(filename: string) {
    if (!SQLRef.current) return { db: null, created: false };
    if (filename === ":memory:") return { db: new SQLRef.current.Database(), created: true };
    const key = `${DB_STORAGE_PREFIX}${filename}`;
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (saved) return { db: new SQLRef.current.Database(base64ToBytes(saved)), created: false };
    return { db: new SQLRef.current.Database(), created: true };
  }

  function saveCurrentDb(filename = sqliteFilename) {
    if (!dbRef.current || filename === ":memory:") return;
    persistDb(filename, dbRef.current);
  }

  function exportCurrentDb() {
    if (!dbRef.current) return;
    const bytes = dbRef.current.export();
    const blob = new Blob([bytes], { type: "application/x-sqlite3" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sqliteFilename === ":memory:" ? "terminal.db" : sqliteFilename;
    a.click();
    URL.revokeObjectURL(url);
    setSqliteInfo(`Exported ${sqliteFilename} as a .db file.`);
  }

  function resetSqliteDb() {
    if (!SQLRef.current) return;
    const db = new SQLRef.current.Database();
    seedDatabase(db);
    dbRef.current = db;
    setSqliteFilename(":memory:");
    setSqliteSettings((prev) => ({ ...prev, filename: ":memory:" }));
    setSqliteInfo("SQLite database reset to :memory:.");
    setLastStatus("sqlite reset");
  }

  function openMan(topic: string) {
    const page = getManPage(topic);
    if (!page) return [`man: no manual entry for ${topic}`];
    setManTopic(topic);
    return [`Manual page opened: ${page.name}`];
  }

  function openNano(pathText: string) {
    const resolved = resolvePath(cwd, pathText);
    if (!resolved.length) return ["nano: missing file operand"];
    const node = getNode(fs, resolved);
    if (node && node.type === "dir") return [`nano: ${pathText}: Is a directory`];
    setNanoPath(resolved);
    setNanoText(node?.type === "file" ? node.content || "" : "");
    setNanoDirty(false);
    setNanoOpen(true);
    return [`Opened nano ${pathToString(resolved)}`];
  }

  function saveNano() {
    if (!nanoPath) return;
    const nextFS = cloneFS(fs);
    const parent = getNode(nextFS, nanoPath.slice(0, -1));
    const name = nanoPath[nanoPath.length - 1];
    if (parent?.type !== "dir" || !parent.children) return;
    parent.children[name] = { type: "file", content: nanoText };
    setFs(nextFS);
    setNanoDirty(false);
    setHistory((prev) => [...prev, { cmd: `nano ${pathToString(nanoPath)}`, output: [`Saved ${pathToString(nanoPath)}`] }]);
    setLastStatus("nano saved");
  }

  function closeNano() {
    setNanoOpen(false);
    setNanoPath(null);
    setNanoText("");
    setNanoDirty(false);
  }

  function runSqliteDotCommand(line: string) {
    const parts = splitInput(line.trim());
    const dot = (parts[0] || "").toLowerCase();
    switch (dot) {
      case ".help":
        return [
          "SQLite shell dot-commands:",
          ".tables, .schema, .indexes/.indices, .databases, .show, .dump, .mode, .headers, .nullvalue, .separator, .open, .save, .read, .archive, .version, .exit/.quit",
        ];
      case ".tables": {
        const res = dbRef.current.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
        if (!res.length || !res[0].values.length) return [""];
        return [res[0].values.map((row: any[]) => String(row[0])).join("  ")];
      }
      case ".schema": {
        const table = parts.slice(1).join(" ");
        if (!table) {
          const res = dbRef.current.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
          if (!res.length || !res[0].values.length) return [""];
          return res[0].values.map((row: any[]) => String(row[0] || "")).filter(Boolean);
        }
        const stmt = dbRef.current.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?;");
        stmt.bind([table]);
        const out: string[] = [];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          if (row.sql) out.push(String(row.sql));
        }
        stmt.free();
        return out.length ? out : [`Table not found: ${table}`];
      }
      case ".indexes":
      case ".indices": {
        const table = parts[1];
        const sql = table
          ? "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name;"
          : "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;";
        const res = table ? dbRef.current.exec(sql, [table]) : dbRef.current.exec(sql);
        if (!res.length || !res[0].values.length) return [""];
        return [res[0].values.map((row: any[]) => String(row[0])).join("  ")];
      }
      case ".databases":
        return [`main | ${sqliteFilename}`];
      case ".show":
        return [
          `echo: ${sqliteSettings.echo ? "on" : "off"}`,
          `headers: ${sqliteSettings.headers ? "on" : "off"}`,
          `mode: ${sqliteSettings.mode}`,
          `nullvalue: ${JSON.stringify(sqliteSettings.nullValue)}`,
          `separator: ${JSON.stringify(sqliteSettings.separator)}`,
          `filename: ${sqliteFilename}`,
        ];
      case ".version":
        return ["SQLite 3.x (browser WASM build)"];
      case ".headers": {
        const value = (parts[1] || "").toLowerCase();
        if (!["on", "off", "1", "0", "true", "false"].includes(value)) return ["Usage: .headers on|off"];
        const on = value === "on" || value === "1" || value === "true";
        setSqliteSettings((prev) => ({ ...prev, headers: on }));
        return [`headers ${on ? "on" : "off"}`];
      }
      case ".nullvalue": {
        const value = parts.slice(1).join(" ");
        setSqliteSettings((prev) => ({ ...prev, nullValue: value }));
        return [`nullvalue = ${JSON.stringify(value)}`];
      }
      case ".separator": {
        const value = parts.slice(1).join(" ") || "|";
        setSqliteSettings((prev) => ({ ...prev, separator: value }));
        return [`separator = ${JSON.stringify(value)}`];
      }
      case ".mode": {
        const value = (parts[1] || "").toLowerCase();
        const allowed: SqliteMode[] = ["ascii", "box", "column", "csv", "json", "line", "list", "markdown"];
        if (!allowed.includes(value as SqliteMode)) return [`Unknown mode: ${parts[1] || ""}`, `Supported modes: ${allowed.join(", ")}`];
        setSqliteSettings((prev) => ({ ...prev, mode: value as SqliteMode }));
        return [`mode = ${value}`];
      }
      case ".dump": {
        const dump: string[] = ["BEGIN TRANSACTION;"];
        const tables = dbRef.current.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;");
        if (tables.length) {
          for (const row of tables[0].values as any[][]) {
            const tableName = String(row[0]);
            const createSql = String(row[1] || "");
            if (createSql) dump.push(`${createSql};`);
            const rows = dbRef.current.exec(`SELECT * FROM \"${tableName.replace(/\"/g, '\\\"')}\";`);
            if (rows.length) {
              const cols = rows[0].columns;
              for (const values of rows[0].values) {
                const escaped = values.map((v: any) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`));
                dump.push(`INSERT INTO \"${tableName}\" (${cols.map((c: string) => `\"${c}\"`).join(", ")}) VALUES (${escaped.join(", ")});`);
              }
            }
          }
        }
        dump.push("COMMIT;");
        return dump;
      }
      case ".open": {
        const filename = parts[1] || ":memory:";
        const { db, created } = openDb(filename);
        if (!db) return ["SQLite engine is not ready yet."];
        dbRef.current = db;
        setSqliteFilename(filename);
        setSqliteSettings((prev) => ({ ...prev, filename }));
        if (created) seedDatabase(db);
        saveCurrentDb(filename);
        return [`opened ${filename}`];
      }
      case ".save": {
        const target = parts[1] || sqliteFilename;
        saveCurrentDb(target);
        if (target !== sqliteFilename && target !== ":memory:") setSqliteFilename(target);
        return [`saved ${target}`];
      }
      case ".read":
        return [".read is not mounted in the browser build. Use .open, .save, or SQL directly."];
      case ".archive":
        return [".archive is accepted for compatibility in this browser build."];
      case ".quit":
      case ".exit":
        setSqliteMode(false);
        setLastStatus("left sqlite");
        return ["Leaving sqlite shell."];
      default:
        return [`Unknown dot-command: ${parts[0] || ""}`];
    }
  }

  function runSqliteSql(sql: string) {
    if (!dbRef.current) return ["SQLite database is not open."];
    try {
      const result = dbRef.current.exec(sql);
      if (!result.length) {
        saveCurrentDb();
        return ["Statement executed successfully."];
      }
      const first = result[0];
      const columns = first.columns;
      const rows = first.values;
      let out: string[] = [];
      switch (sqliteSettings.mode) {
        case "csv":
          out = formatCsvOutput(columns, rows, sqliteSettings.headers, sqliteSettings.nullValue);
          break;
        case "json":
          out = formatJsonOutput(columns, rows);
          break;
        case "line":
          out = formatLineOutput(columns, rows, sqliteSettings.nullValue);
          break;
        case "list":
          out = formatListOutput(columns, rows, sqliteSettings.separator, sqliteSettings.nullValue);
          break;
        case "markdown":
          out = formatMarkdownOutput(columns, rows, sqliteSettings.nullValue);
          break;
        case "box":
        case "ascii":
        case "column":
        default:
          out = sqliteSettings.mode === "column" ? formatColumnOutput(columns, rows, sqliteSettings.nullValue) : formatBoxOutput(columns, rows, sqliteSettings.headers, sqliteSettings.nullValue);
          break;
      }
      saveCurrentDb();
      return out.length ? out : ["(no rows)"];
    } catch (err: any) {
      return [err?.message || String(err)];
    }
  }

  function enterSqliteShell(argv: string[]) {
    if (!sqliteReady) return ["SQLite engine is still loading."];
    const opts = {
      filename: ":memory:",
      readonly: false,
      echo: false,
      batch: false,
      headers: true,
      nullValue: "",
      separator: "|",
      mode: "column" as SqliteMode,
      preCommands: [] as string[],
    };

    let treatRestAsArgs = false;
    let filenameCaptured = false;
    const cliOutput: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (!treatRestAsArgs && arg === "--") {
        treatRestAsArgs = true;
        continue;
      }
      if (!treatRestAsArgs && arg.startsWith("-")) {
        switch (arg) {
          case "-help":
          case "--help":
            return [
              "FILENAME is the name of an SQLite database. A new database is created if the file does not previously exist. Defaults to :memory:.",
              "",
              "OPTIONS include:",
              "   -help   show this message",
              "   -version show version",
              "   -column  set output mode to 'column'",
              "   -csv     set output mode to 'csv'",
              "   -json    set output mode to 'json'",
              "   -line    set output mode to 'line'",
              "   -list    set output mode to 'list'",
              "   -box     set output mode to 'box'",
              "   -table   set output mode to 'box'",
              "   -markdown set output mode to 'markdown'",
              "   -headers  on|off",
              "   -separator SEP",
              "   -nullvalue TEXT",
              "   -cmd COMMAND",
              "   -echo",
              "   -readonly",
              "   -batch",
              "   -cmd COMMAND",
            ];
          case "-version":
            return ["SQLite 3.x (browser WASM build)"];
          case "-readonly":
            opts.readonly = true;
            break;
          case "-echo":
            opts.echo = true;
            break;
          case "-batch":
            opts.batch = true;
            break;
          case "-column":
            opts.mode = "column";
            break;
          case "-csv":
            opts.mode = "csv";
            break;
          case "-json":
            opts.mode = "json";
            break;
          case "-line":
            opts.mode = "line";
            break;
          case "-list":
            opts.mode = "list";
            break;
          case "-box":
          case "-table":
            opts.mode = "box";
            break;
          case "-ascii":
            opts.mode = "ascii";
            break;
          case "-markdown":
            opts.mode = "markdown";
            break;
          case "-header":
            opts.headers = true;
            break;
          case "-noheader":
            opts.headers = false;
            break;
          case "-separator":
            if (argv[i + 1]) opts.separator = argv[++i];
            break;
          case "-nullvalue":
            if (argv[i + 1]) opts.nullValue = argv[++i];
            break;
          case "-cmd":
            if (argv[i + 1]) opts.preCommands.push(argv[++i]);
            break;
          default:
            cliOutput.push(`Ignored option: ${arg}`);
        }
        continue;
      }
      if (!filenameCaptured) {
        opts.filename = arg;
        filenameCaptured = true;
        continue;
      }
      opts.preCommands.push(arg);
    }

    const { db, created } = openDb(opts.filename);
    if (!db) return ["SQLite engine is not ready yet."];
    dbRef.current = db;
    setSqliteFilename(opts.filename);
    setSqliteSettings({
      filename: opts.filename,
      readonly: opts.readonly,
      echo: opts.echo,
      batch: opts.batch,
      headers: opts.headers,
      nullValue: opts.nullValue,
      separator: opts.separator,
      mode: opts.mode,
      preCommands: opts.preCommands,
    });
    setSqliteMode(true);
    if (created) seedDatabase(db);
    saveCurrentDb(opts.filename);

    const out = [`Opened ${opts.filename}`, "Enter SQL or dot-commands like .tables, .schema, .dump, .mode, .exit"];
    if (opts.readonly) out.push("Read-only requested; browser sandbox still controls actual persistence.");
    if (opts.echo) out.push("Echo enabled.");
    for (const pre of opts.preCommands) {
      out.push(...runSqliteLine(pre));
    }
    return [...cliOutput, ...out];
  }

  function runSqliteLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return [""];
    if (trimmed.startsWith(".")) return runSqliteDotCommand(trimmed);
    return sqliteSettings.echo ? [trimmed, ...runSqliteSql(trimmed)] : runSqliteSql(trimmed);
  }

  function runShellCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (sqliteMode) {
      const output = runSqliteLine(trimmed);
      setHistory((prev) => [...prev, { cmd: trimmed, output }]);
      setHistoryIndex(-1);
      setLastStatus(trimmed.startsWith(".") ? trimmed : "sqlite sql");
      setInput("");
      return;
    }

    const parts = splitInput(trimmed);
    const [command, ...rest] = parts;
    let output: string[] = [];
    let nextFS = fs;
    let nextCwd = cwd;

    switch (command) {
      case "help":
        output = [
          "Available commands:",
          SHELL_COMMANDS.join(", "),
          "Use 'man TOPIC' for a detailed manual page.",
        ];
        break;
      case "clear":
        setHistory([]);
        setHistoryIndex(-1);
        setLastStatus("Cleared");
        setInput("");
        return;
      case "pwd":
        output = [pathToString(cwd)];
        break;
      case "ls": {
        const target = getNode(fs, rest[0] ? resolvePath(cwd, rest[0]) : cwd);
        output = !target || target.type !== "dir" ? [`ls: cannot access '${rest[0] || "."}': No such file or directory`] : [listDir(target).join("  ")];
        break;
      }
      case "tree": {
        const target = getNode(fs, rest[0] ? resolvePath(cwd, rest[0]) : cwd);
        output = !target ? [`tree: '${rest[0] || "."}': No such file or directory`] : treeLines(target, rest[0] || ".");
        break;
      }
      case "cd": {
        const dest = rest[0] ? resolvePath(cwd, rest[0]) : ["home", "tanjib"];
        const target = getNode(fs, dest);
        if (!target || target.type !== "dir") output = [`cd: no such file or directory: ${rest[0] || "~"}`];
        else {
          nextCwd = dest;
          setCwd(dest);
        }
        break;
      }
      case "cat": {
        const path = rest[0];
        if (!path) {
          output = ["cat: missing file operand"];
          break;
        }
        const target = getNode(fs, resolvePath(cwd, path));
        output = !target || target.type !== "file" ? [`cat: ${path}: No such file`] : [target.content || ""];
        break;
      }
      case "echo":
        output = [rest.join(" ")];
        break;
      case "date":
        output = [new Date().toString()];
        break;
      case "uname":
        output = ["Linux browser-host 6.8.0-virtual #1 SMP PREEMPT Browser Terminal"];
        break;
      case "whoami":
        output = ["tanjib"];
        break;
      case "mkdir": {
        const name = rest[0];
        if (!name) {
          output = ["mkdir: missing operand"];
          break;
        }
        const current = getNode(fs, cwd);
        if (!current || current.type !== "dir" || !current.children) {
          output = ["mkdir: current directory not accessible"];
          break;
        }
        if (current.children[name]) {
          output = [`mkdir: cannot create directory '${name}': File exists`];
          break;
        }
        nextFS = cloneFS(fs);
        const parent = getNode(nextFS, cwd);
        if (parent?.type === "dir" && parent.children) {
          parent.children[name] = { type: "dir", children: {} };
          setFs(nextFS);
        }
        break;
      }
      case "touch": {
        const name = rest[0];
        if (!name) {
          output = ["touch: missing file operand"];
          break;
        }
        nextFS = cloneFS(fs);
        const parent = getNode(nextFS, cwd);
        if (parent?.type === "dir" && parent.children) {
          parent.children[name] = { type: "file", content: "" };
          setFs(nextFS);
        }
        break;
      }
      case "rm": {
        const name = rest[0];
        if (!name) {
          output = ["rm: missing operand"];
          break;
        }
        nextFS = cloneFS(fs);
        const parent = getNode(nextFS, cwd);
        if (!parent || parent.type !== "dir" || !parent.children?.[name]) output = [`rm: cannot remove '${name}': No such file or directory`];
        else {
          delete parent.children[name];
          setFs(nextFS);
        }
        break;
      }
      case "rmdir": {
        const name = rest[0];
        if (!name) {
          output = ["rmdir: missing operand"];
          break;
        }
        const parent = getNode(fs, cwd);
        const target = parent && parent.type === "dir" ? parent.children?.[name] : undefined;
        if (!target || target.type !== "dir") {
          output = [`rmdir: failed to remove '${name}': No such directory`];
        } else if (target.children && Object.keys(target.children).length > 0) {
          output = [`rmdir: failed to remove '${name}': Directory not empty`];
        } else {
          nextFS = cloneFS(fs);
          const nextParent = getNode(nextFS, cwd);
          if (nextParent?.type === "dir" && nextParent.children) {
            delete nextParent.children[name];
            setFs(nextFS);
          }
        }
        break;
      }
      case "cp": {
        const [src, dst] = rest;
        if (!src || !dst) {
          output = ["cp: usage: cp SOURCE DEST"];
          break;
        }
        const srcNode = getNode(fs, resolvePath(cwd, src));
        if (!srcNode) {
          output = [`cp: cannot stat '${src}': No such file or directory`];
          break;
        }
        nextFS = cloneFS(fs);
        const destParent = getNode(nextFS, cwd);
        if (destParent?.type === "dir" && destParent.children) {
          destParent.children[dst] = cloneFS(srcNode);
          setFs(nextFS);
        }
        break;
      }
      case "mv": {
        const [src, dst] = rest;
        if (!src || !dst) {
          output = ["mv: usage: mv SOURCE DEST"];
          break;
        }
        const srcPath = resolvePath(cwd, src);
        const srcName = srcPath[srcPath.length - 1];
        const srcParentPath = srcPath.slice(0, -1);
        const srcParent = getNode(fs, srcParentPath);
        if (!srcParent || srcParent.type !== "dir" || !srcParent.children?.[srcName]) {
          output = [`mv: cannot stat '${src}': No such file or directory`];
          break;
        }
        nextFS = cloneFS(fs);
        const nextSrcParent = getNode(nextFS, srcParentPath);
        const node = nextSrcParent?.type === "dir" && nextSrcParent.children ? nextSrcParent.children[srcName] : undefined;
        if (!node || !nextSrcParent?.children) break;
        delete nextSrcParent.children[srcName];
        const destParent = getNode(nextFS, cwd);
        if (destParent?.type === "dir" && destParent.children) {
          destParent.children[dst] = node;
          setFs(nextFS);
        }
        break;
      }
      case "grep": {
        const [pattern, file] = rest;
        if (!pattern || !file) {
          output = ["grep: usage: grep PATTERN FILE"];
          break;
        }
        const target = getNode(fs, resolvePath(cwd, file));
        if (!target || target.type !== "file") {
          output = [`grep: ${file}: No such file`];
          break;
        }
        output = (target.content || "").split(/\r?\n/).filter((line) => line.includes(pattern));
        if (!output.length) output = [""];
        break;
      }
      case "head": {
        const file = rest.find((x) => !x.startsWith("-"));
        const nIndex = rest.indexOf("-n");
        const n = nIndex >= 0 && rest[nIndex + 1] ? Number(rest[nIndex + 1]) : 10;
        if (!file) {
          output = ["head: missing file operand"];
          break;
        }
        const target = getNode(fs, resolvePath(cwd, file));
        output = !target || target.type !== "file" ? [`head: ${file}: No such file`] : (target.content || "").split(/\r?\n/).slice(0, n);
        break;
      }
      case "tail": {
        const file = rest.find((x) => !x.startsWith("-"));
        const nIndex = rest.indexOf("-n");
        const n = nIndex >= 0 && rest[nIndex + 1] ? Number(rest[nIndex + 1]) : 10;
        if (!file) {
          output = ["tail: missing file operand"];
          break;
        }
        const target = getNode(fs, resolvePath(cwd, file));
        if (!target || target.type !== "file") output = [`tail: ${file}: No such file`];
        else {
          const lines = (target.content || "").split(/\r?\n/);
          output = lines.slice(Math.max(0, lines.length - n));
        }
        break;
      }
      case "history":
        output = history.filter((h) => h.cmd).map((h, idx) => `${idx + 1}  ${h.cmd}`);
        break;
      case "env":
        output = ["SHELL=/bin/bash", `PWD=${pathToString(cwd)}`, "USER=tanjib", "TERM=xterm-256color"];
        break;
      case "which": {
        const target = rest[0];
        if (!target) {
          output = ["which: missing operand"];
          break;
        }
        output = SHELL_COMMANDS.includes(target) ? [`${target}: shell builtin`] : [`${target} not found`];
        break;
      }
      case "man": {
        const topic = rest[0] || "help";
        output = openMan(topic);
        break;
      }
      case "nano": {
        const file = rest[0];
        if (!file) {
          output = ["nano: missing file operand"];
          break;
        }
        output = openNano(file);
        break;
      }
      case "sqlite3":
        output = enterSqliteShell(rest);
        break;
      case "info":
        output = [
          "This is a browser terminal emulator.",
          "SQLite is powered by sql.js (SQLite compiled to WebAssembly).",
          "Browser storage persists databases; .db export gives you a portable file.",
          "This build is designed to run on Vercel as a frontend app.",
        ];
        break;
      case "reset":
        setFs(cloneFS(initialFS));
        setCwd(["home", "tanjib"]);
        setHistory([{ cmd: "", output: ["Filesystem reset."] }]);
        setHistoryIndex(-1);
        setLastStatus("Reset");
        setInput("");
        return;
      default:
        output = [`${command}: command not found`];
    }

    setHistory((prev) => [...prev, { cmd: trimmed, output }]);
    setHistoryIndex(-1);
    setLastStatus(command || "Ready");
    if (nextCwd !== cwd) setCwd(nextCwd);
    if (nextFS !== fs) setFs(nextFS);
    setInput("");
  }

  function acceptAutocomplete() {
    if (!autocompleteItems.length) return;
    const selected = autocompleteItems[autocompleteIndex] || autocompleteItems[0];
    setInput(selected);
    setAutocompleteOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      acceptAutocomplete();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const cmds = history.filter((h) => h.cmd).map((h) => h.cmd);
      if (!cmds.length) return;
      const nextIdx = historyIndex < 0 ? cmds.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIdx);
      setInput(cmds[nextIdx] || "");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const cmds = history.filter((h) => h.cmd).map((h) => h.cmd);
      if (!cmds.length || historyIndex < 0) return;
      const nextIdx = Math.min(cmds.length - 1, historyIndex + 1);
      if (nextIdx >= cmds.length - 1) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(nextIdx);
        setInput(cmds[nextIdx] || "");
      }
      return;
    }
    if (e.key === "Escape") {
      setAutocompleteOpen(false);
      return;
    }
    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setHistory([]);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    runShellCommand(input);
  }

  const manPage = getManPage(manTopic) || MAN_PAGES.help;

  return (
    <div className={`${dark ? "dark" : ""} min-h-screen bg-slate-950 text-slate-100`}>
      <div className="mx-auto max-w-7xl p-4 md:p-8">
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">Net Wraith Shell: Browser Bash Terminal + SQLite</h1>
            <p className="mt-1 text-sm text-slate-400"></p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setDark((v) => !v)} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm hover:bg-slate-800">
              {dark ? "Dark Mode" : "Dark Mode"}
            </button>
            <button onClick={() => setHistory([])} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm hover:bg-slate-800">
              <Trash2 className="mr-2 inline h-4 w-4" /> Clear Screen
            </button>
            <button onClick={() => setFs(cloneFS(initialFS))} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm hover:bg-slate-800">
              <RotateCcw className="mr-2 inline h-4 w-4" /> Reset FS
            </button>
            <button onClick={resetSqliteDb} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm hover:bg-slate-800" disabled={!sqliteReady}>
              <Database className="mr-2 inline h-4 w-4" /> Reset SQLite
            </button>
            <button onClick={exportCurrentDb} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm hover:bg-slate-800" disabled={!sqliteReady}>
              <Download className="mr-2 inline h-4 w-4" /> Export .db
            </button>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.45fr_0.85fr]">
          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl">
            <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-950/70 px-4 py-3 text-sm font-medium">
              <Terminal className="h-4 w-4" /> Terminal
              <span className="ml-auto text-xs text-slate-400">{lastStatus}</span>
            </div>
            <div className="relative h-[72vh] overflow-y-auto p-4 font-mono text-sm leading-6" onClick={() => inputRef.current?.focus()}>
              {history.map((entry, idx) => (
                <div key={idx} className="mb-3 whitespace-pre-wrap break-words">
                  {entry.cmd && (
                    <div className="text-emerald-400">
                      <span className="text-sky-400">{sqliteMode ? "sqlite>" : prompt}</span> {entry.cmd}
                    </div>
                  )}
                  {entry.output.map((line, i) => (
                    <div key={i} className="text-slate-100">
                      {line || "\u00a0"}
                    </div>
                  ))}
                </div>
              ))}

              <form onSubmit={onSubmit} className="flex items-start gap-2">
                <span className="shrink-0 text-sky-400">{sqliteMode ? "sqlite>" : prompt}</span>
                <div className="relative flex-1">
                  <input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full border-0 bg-transparent p-0 font-mono text-sm outline-none placeholder:text-slate-600"
                    placeholder={sqliteMode ? "Enter SQL or .help" : "Type a command..."}
                  />
                  {autocompleteOpen && autocompleteItems.length > 0 && (
                    <div className="absolute z-20 mt-2 max-h-48 w-full overflow-auto rounded-xl border border-slate-700 bg-slate-950/95 p-2 text-xs shadow-xl">
                      {autocompleteItems.map((item, idx) => (
                        <button
                          key={item}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setInput(item);
                            setAutocompleteOpen(false);
                            inputRef.current?.focus();
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-800 ${idx === autocompleteIndex ? "bg-slate-800" : ""}`}
                        >
                          <Search className="h-3 w-3 text-slate-400" />
                          <span className="font-mono">{item}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </form>
              <div ref={endRef} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl">
              <div className="border-b border-slate-800 px-4 py-3 text-sm font-medium">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4" /> Filesystem
                </div>
              </div>
              <div className="space-y-3 p-4 text-sm text-slate-300">
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wider text-slate-500">Current Path</div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-sky-300">{pathToString(cwd)}</div>
                </div>
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wider text-slate-500">Current Directory</div>
                  <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    {listDir(getNode(fs, cwd)).map((name) => {
                      const node = getNode(fs, cwd);
                      const child = node?.type === "dir" ? node.children?.[name] : undefined;
                      return (
                        <div key={name} className="flex items-center gap-2">
                          {child?.type === "dir" ? <Folder className="h-4 w-4 text-sky-400" /> : <FileText className="h-4 w-4 text-emerald-400" />}
                          <span className="font-mono">{name}</span>
                        </div>
                      );
                    })}
                    {!listDir(getNode(fs, cwd)).length && <div className="text-slate-500">Empty directory</div>}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl">
              <div className="border-b border-slate-800 px-4 py-3 text-sm font-medium">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4" /> Man Page
                </div>
              </div>
              <div className="space-y-3 p-4 text-sm text-slate-300">
                <input
                  value={manSearch}
                  onChange={(e) => setManSearch(e.target.value)}
                  placeholder="Search topics..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm outline-none placeholder:text-slate-600"
                />
                <div className="max-h-36 overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-2 text-xs">
                  {filteredManTopics.map((topic) => (
                    <button
                      key={topic}
                      type="button"
                      onClick={() => setManTopic(topic)}
                      className={`block w-full rounded-lg px-2 py-1 text-left hover:bg-slate-800 ${manTopic === topic ? "bg-slate-800" : ""}`}
                    >
                      {topic}
                    </button>
                  ))}
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <div className="font-semibold text-slate-100">NAME</div>
                  <div className="mt-1 text-sky-300">{manPage.name}</div>
                  <div className="mt-3 font-semibold text-slate-100">SYNOPSIS</div>
                  <div className="mt-1 font-mono text-xs text-slate-300">{manPage.synopsis}</div>
                  <div className="mt-3 font-semibold text-slate-100">DESCRIPTION</div>
                  <div className="mt-1 space-y-2 text-slate-300">
                    {manPage.description.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                  <div className="mt-3 font-semibold text-slate-100">EXAMPLES</div>
                  <div className="mt-1 space-y-1 font-mono text-xs text-slate-300">
                    {manPage.examples.map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                  {manPage.notes?.length ? (
                    <>
                      <div className="mt-3 font-semibold text-slate-100">NOTES</div>
                      <div className="mt-1 space-y-1 text-slate-300">
                        {manPage.notes.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl">
              <div className="border-b border-slate-800 px-4 py-3 text-sm font-medium">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4" /> SQLite
                </div>
              </div>
              <div className="space-y-2 p-4 text-sm text-slate-300">
                <p>Status: {sqliteReady ? "Ready" : "Loading..."}</p>
                <p>Database: {sqliteFilename}</p>
                <p className="text-slate-400">{sqliteInfo}</p>
                <p>Use <span className="font-mono text-sky-300">sqlite3</span> to enter the shell.</p>
                <p>Example: <span className="font-mono text-sky-300">sqlite3 -column mydata.db</span></p>
                <p>Copy <span className="font-mono text-sky-300">sql-wasm.wasm</span> into <span className="font-mono text-sky-300">public/</span>.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {nanoOpen && nanoPath ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-700 bg-slate-950 px-4 py-3 text-sm font-medium">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4" /> Nano: {pathToString(nanoPath)}
                {nanoDirty ? <span className="text-amber-400">*modified</span> : null}
              </div>
              <button onClick={closeNano} className="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800">
                <X className="mr-1 inline h-3 w-3" /> Close
              </button>
            </div>
            <div className="flex-1 p-4">
              <textarea
                ref={nanoTextAreaRef}
                value={nanoText}
                onChange={(e) => {
                  setNanoText(e.target.value);
                  setNanoDirty(true);
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    saveNano();
                  }
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
                    e.preventDefault();
                    closeNano();
                  }
                }}
                spellCheck={false}
                className="h-full w-full resize-none rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-sm leading-6 outline-none"
                placeholder="Start typing..."
              />
            </div>
            <div className="flex items-center justify-between border-t border-slate-700 px-4 py-3 text-xs text-slate-400">
              <div>Ctrl+S save · Ctrl+X close</div>
              <div className="flex gap-2">
                <button onClick={saveNano} className="rounded-lg border border-slate-700 px-3 py-1 hover:bg-slate-800">
                  <Save className="mr-1 inline h-3 w-3" /> Save
                </button>
                <button onClick={closeNano} className="rounded-lg border border-slate-700 px-3 py-1 hover:bg-slate-800">
                  <X className="mr-1 inline h-3 w-3" /> Exit
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
