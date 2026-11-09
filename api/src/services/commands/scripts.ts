import vm from "node:vm";
import { parseCommand, type Command } from "./commands.js";
import type { CommandEffect } from "./errors.js";
import type { CommandResult, ErrorInfo } from "./records.js";
import { combine } from "./results.js";

export const MAX_SCRIPT_CALLS = 1000;
const MAX_JSON_CHARS = 100_000;
const MAX_LOGS = 200;
const MAX_LOG_CHARS = 2_000;
const TRACE_TAIL = 20;
const SYNC_LIMIT_MS = 1_000;
const DEADLINE_GRACE_MS = 1_000;

export interface ScriptStep {
  result: CommandResult;
  page: { url: string; title: string } | null;
}

export interface ScriptHost {
  step(command: Command): Promise<ScriptStep | undefined>;
  remainingMs(): number;
  now(): number;
}

interface ScriptError extends ErrorInfo {
  line?: number;
  call?: string;
  effect?: CommandEffect;
}

interface TraceEntry {
  line?: number;
  call: string;
  ok: boolean;
  effect: CommandEffect;
  ms: number;
}

interface Bridge {
  call(
    command: string,
    line: number | undefined,
    resolve: (json: string) => void,
    reject: (json: string) => void,
  ): void;
  emit(json: string): boolean;
  log(text: string): void;
}

interface Globals {
  page: unknown;
  emit: unknown;
  console: unknown;
}

const FACADE = String.raw`(function install(bridge) {
  "use strict";
  var lastUrl = "";
  var mouseAt = { x: 400, y: 300 };
  function lineOf() {
    var match = /script\.js:(\d+)/.exec(String(new Error().stack));
    return match ? Number(match[1]) : undefined;
  }
  function fail(info) {
    var error = new Error(String(info.message || info.code));
    error.name = "CommandError";
    for (var key in info) error[key] = info[key];
    return error;
  }
  function run(command, line) {
    return new Promise(function (resolve, reject) {
      bridge.call(JSON.stringify(command), line, function (json) {
        var reply = JSON.parse(json);
        if (reply.page && typeof reply.page.url === "string") lastUrl = reply.page.url;
        resolve(reply.result);
      }, function (json) {
        reject(fail(JSON.parse(json)));
      });
    });
  }
  function clean(object) {
    var out = {};
    for (var key in object) if (object[key] !== undefined) out[key] = object[key];
    return out;
  }
  function isRef(target) {
    return typeof target === "string" && /^(@|ref=)?e\d+$/.test(target);
  }
  function hasNth(target) {
    return typeof target === "object" && target !== null && target.nth !== undefined;
  }
  function unsupported(what) {
    throw fail({ code: "unsupported", message: what + " is not supported. Locators cannot be chained or filtered; use page.evaluate or page.$$eval for structured data." });
  }
  function source(fn, arg) {
    if (typeof fn === "string") return fn;
    if (typeof fn !== "function") throw fail({ code: "invalid_argument", message: "evaluate takes a function or a string." });
    return "(" + String(fn) + ")(" + (arg === undefined ? "" : JSON.stringify(arg)) + ")";
  }
  function star(pattern) {
    if (typeof pattern !== "string") throw fail({ code: "unsupported", message: "waitForURL takes a string pattern with * wildcards." });
    return pattern.replace(/\*\*/g, "*");
  }
  function locator(target) {
    var base = typeof target === "string" && !isRef(target) ? { css: target } : target;
    function nth(index) {
      if (isRef(target)) return locator(target);
      return locator(Object.assign({}, base, { nth: index }));
    }
    function act(command, extra) {
      return run(Object.assign({ command: command, target: target }, extra || {}), lineOf());
    }
    async function read(what, extra) {
      return (await act("get", Object.assign({ what: what }, extra || {}))).value;
    }
    async function is(what) {
      return (await act("is", { what: what })).value;
    }
    async function typing(text, options) {
      await act("type", clean({ text: String(text), delay: options && options.delay }));
    }
    var self = {
      click: async function () { await act("click"); },
      dblclick: async function () { await act("dblclick"); },
      hover: async function () { await act("hover"); },
      focus: async function () { await act("focus"); },
      fill: async function (value) { await act("fill", { value: String(value) }); },
      clear: async function () { await act("fill", { value: "" }); },
      pressSequentially: typing,
      type: typing,
      press: async function (key) { await act("press", { key: String(key) }); },
      check: async function () { await act("check"); },
      uncheck: async function () { await act("uncheck"); },
      selectOption: async function (values) {
        var picked = Array.isArray(values)
          ? values.map(String)
          : String(values && typeof values === "object" ? values.value || values.label : values);
        await act("select", { values: picked });
      },
      innerText: function () { return read("text"); },
      textContent: function () { return read("text"); },
      inputValue: function () { return read("value"); },
      innerHTML: function () { return read("html"); },
      getAttribute: function (name) { return read("attr", { attribute: String(name) }); },
      count: function () { return read("count"); },
      isVisible: function () { return is("visible"); },
      isEnabled: function () { return is("enabled"); },
      isChecked: function () { return is("checked"); },
      waitFor: async function (options) {
        options = options || {};
        await act("wait", clean({ state: options.state || "visible", timeout: options.timeout }));
      },
      nth: nth,
      first: function () { return nth(0); },
      last: function () { return nth(-1); },
      all: async function () {
        var line = lineOf();
        if (isRef(target) || hasNth(target)) return [self];
        var total = (await run({ command: "get", what: "count", target: base }, line)).value;
        var list = [];
        for (var i = 0; i < total; i++) list.push(locator(Object.assign({}, base, { nth: i })));
        return list;
      },
      allInnerTexts: async function () {
        var line = lineOf();
        if (isRef(target) || hasNth(target)) return [(await run({ command: "get", what: "text", target: target }, line)).value];
        var total = (await run({ command: "get", what: "count", target: base }, line)).value;
        var texts = [];
        for (var i = 0; i < total; i++) {
          texts.push((await run({ command: "get", what: "text", target: Object.assign({}, base, { nth: i }) }, line)).value);
        }
        return texts;
      },
      locator: function () { unsupported("locator.locator()"); },
      filter: function () { unsupported("locator.filter()"); },
      getByRole: function () { unsupported("locator.getByRole()"); },
      getByText: function () { unsupported("locator.getByText()"); },
      getByLabel: function () { unsupported("locator.getByLabel()"); },
      getByTestId: function () { unsupported("locator.getByTestId()"); }
    };
    self.allTextContents = self.allInnerTexts;
    return self;
  }
  function byKind(kind) {
    return function (text, options) {
      var spec = {};
      spec[kind] = String(text);
      spec.exact = options && options.exact;
      return locator(clean(spec));
    };
  }
  async function mouse(action, extra) {
    await run(Object.assign({ command: "mouse", action: action }, extra), lineOf());
  }
  var page = {
    goto: async function (url) { await run({ command: "navigate", url: String(url) }, lineOf()); },
    goBack: async function () { await run({ command: "back" }, lineOf()); },
    goForward: async function () { await run({ command: "forward" }, lineOf()); },
    reload: async function () { await run({ command: "reload" }, lineOf()); },
    url: function () { return lastUrl; },
    title: async function () { return (await run({ command: "get", what: "title" }, lineOf())).value; },
    snapshot: async function (options) {
      options = options || {};
      return (await run(clean({ command: "snapshot", interactive: options.interactive, compact: options.compact, depth: options.depth }), lineOf())).snapshot;
    },
    markdown: async function () { return (await run({ command: "get", what: "markdown" }, lineOf())).value; },
    content: async function () { return (await run({ command: "get", what: "html" }, lineOf())).value; },
    getByRole: function (role, options) {
      options = options || {};
      return locator(clean({ role: String(role), name: options.name, exact: options.exact }));
    },
    getByText: byKind("text"),
    getByLabel: byKind("label"),
    getByPlaceholder: byKind("placeholder"),
    getByAltText: byKind("alt"),
    getByTitle: byKind("title"),
    getByTestId: function (id) { return locator({ testid: String(id) }); },
    locator: function (selector) {
      selector = String(selector);
      if (/^(text|xpath|role)=/.test(selector) || selector.indexOf("//") === 0) unsupported('The selector "' + selector + '"');
      return locator(selector);
    },
    ref: function (ref) { return locator(String(ref)); },
    waitForLoadState: async function (state) { await run({ command: "wait", load: state || "load" }, lineOf()); },
    waitForURL: async function (pattern, options) {
      await run(clean({ command: "wait", url: star(pattern), timeout: options && options.timeout }), lineOf());
    },
    waitForTimeout: async function (ms) { await run({ command: "wait", ms: Math.min(Number(ms), 30000) }, lineOf()); },
    waitForSelector: async function (selector, options) {
      options = options || {};
      await run(clean({ command: "wait", target: String(selector), state: options.state || "visible", timeout: options.timeout }), lineOf());
      return locator(String(selector));
    },
    evaluate: async function (fn, arg) { return (await run({ command: "eval", script: source(fn, arg) }, lineOf())).value; },
    $$eval: async function (selector, fn, arg) {
      var input = arg === undefined ? "" : ", " + JSON.stringify(arg);
      var script = "(" + String(fn) + ")(Array.from(document.querySelectorAll(" + JSON.stringify(String(selector)) + "))" + input + ")";
      return (await run({ command: "eval", script: script }, lineOf())).value;
    },
    $eval: async function (selector, fn, arg) {
      var input = arg === undefined ? "" : ", " + JSON.stringify(arg);
      var css = JSON.stringify(String(selector));
      var script = "(() => { const element = document.querySelector(" + css + "); if (!element) throw new Error('No element matches ' + " + css + "); return (" + String(fn) + ")(element" + input + "); })()";
      return (await run({ command: "eval", script: script }, lineOf())).value;
    },
    click: function (selector) { return locator(String(selector)).click(); },
    fill: function (selector, value) { return locator(String(selector)).fill(value); },
    type: function (selector, text) { return locator(String(selector)).pressSequentially(text); },
    press: function (selector, key) { return locator(String(selector)).press(key); },
    textContent: function (selector) { return locator(String(selector)).textContent(); },
    innerText: function (selector) { return locator(String(selector)).innerText(); },
    isVisible: function (selector) { return locator(String(selector)).isVisible(); },
    screenshot: async function (options) {
      options = options || {};
      return (await run(clean({ command: "screenshot", fullPage: options.fullPage }), lineOf())).data;
    },
    keyboard: {
      press: async function (key) { await run({ command: "press", key: String(key) }, lineOf()); },
      type: async function (text) { await run({ command: "type", target: { css: ":focus" }, text: String(text) }, lineOf()); },
      down: async function (key) { await run({ command: "keydown", key: String(key) }, lineOf()); },
      up: async function (key) { await run({ command: "keyup", key: String(key) }, lineOf()); }
    },
    mouse: {
      move: async function (x, y) { mouseAt = { x: Number(x), y: Number(y) }; await mouse("move", mouseAt); },
      click: async function (x, y) { mouseAt = { x: Number(x), y: Number(y) }; await mouse("click", mouseAt); },
      down: async function () { await mouse("down", {}); },
      up: async function () { await mouse("up", {}); },
      wheel: async function (deltaX, deltaY) {
        await mouse("wheel", { x: mouseAt.x, y: mouseAt.y, deltaX: Number(deltaX), deltaY: Number(deltaY) });
      }
    },
    on: function (event) {
      if (event === "dialog") throw fail({ code: "unsupported", message: "Commands cannot answer dialogs." });
      return page;
    }
  };
  page.once = page.on;
  function format(value) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }
  function write() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(format(arguments[i]));
    bridge.log(parts.join(" "));
  }
  return {
    page: page,
    emit: function (value) {
      var json = JSON.stringify(value === undefined ? null : value);
      if (!bridge.emit(json === undefined ? "null" : json)) {
        throw fail({ code: "too_large", message: "emit() received more than 100000 characters of JSON in total." });
      }
    },
    console: { log: write, info: write, warn: write, error: write }
  };
})`;

let facade: vm.Script | undefined;

const TIMED_OUT = Symbol("timed out");

function lineOf(stack: unknown): number | undefined {
  const match = /script\.js:(\d+)/.exec(String(stack ?? ""));
  return match ? Number(match[1]) : undefined;
}

function field<T>(record: Record<string, unknown>, key: string, type: string): T | undefined {
  try {
    const value = record[key];
    return typeof value === type ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function describe(thrown: unknown): ScriptError {
  if (thrown === TIMED_OUT) {
    return {
      code: "limit_exceeded",
      reason: "timeout",
      message: "The script did not finish before its execution ran out of time.",
    };
  }
  const record = (typeof thrown === "object" && thrown !== null ? thrown : {}) as Record<
    string,
    unknown
  >;
  const stack = field<string>(record, "stack", "string");
  if (field<string>(record, "code", "string") === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return {
      code: "limit_exceeded",
      reason: "cpu",
      message: `The script ran without awaiting for more than ${SYNC_LIMIT_MS} ms.`,
    };
  }
  if (field<string>(record, "name", "string") === "CommandError") {
    const code = field<string>(record, "code", "string") ?? "script_error";
    const error: ScriptError = {
      code,
      message: field<string>(record, "message", "string") ?? code,
      line: field<number>(record, "line", "number") ?? lineOf(stack),
    };
    const reason = field<string>(record, "reason", "string");
    const call = field<string>(record, "call", "string");
    const effect = field<CommandEffect>(record, "effect", "string");
    return {
      ...error,
      ...(reason ? { reason } : {}),
      ...(call ? { call } : {}),
      ...(effect ? { effect } : {}),
    };
  }
  return {
    code: "script_error",
    message: field<string>(record, "message", "string") ?? String(thrown),
    line: lineOf(stack),
  };
}

export async function runScript(code: string, host: ScriptHost): Promise<CommandResult> {
  const trace: TraceEntry[] = [];
  const emitted: unknown[] = [];
  const logs: string[] = [];
  let emittedChars = 0;
  let logsTruncated = false;
  let calls = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (callback: (json: string) => void, value: unknown) => {
    try {
      callback(JSON.stringify(value));
    } catch {}
  };

  const perform = async (
    json: string,
    line: number | undefined,
    resolve: (json: string) => void,
    reject: (json: string) => void,
  ) => {
    let call = "unknown";
    try {
      if (stopped) {
        deliver(reject, { code: "aborted", message: "The script was stopped.", line });
        return;
      }
      const parsed = parseCommand(JSON.parse(json));
      call = parsed.name;
      if (!parsed.ok) {
        deliver(reject, { code: "invalid_argument", message: parsed.message, line, call });
        return;
      }
      if (parsed.command.command === "script") {
        deliver(reject, {
          code: "invalid_argument",
          message: "A script cannot run a script.",
          line,
          call,
        });
        return;
      }
      calls += 1;
      if (calls > MAX_SCRIPT_CALLS) {
        deliver(reject, {
          code: "limit_exceeded",
          reason: "calls",
          message: `A script can make at most ${MAX_SCRIPT_CALLS} calls.`,
          line,
          call,
        });
        return;
      }
      const started = host.now();
      const step = await host.step(parsed.command);
      if (!step) {
        stopped = true;
        deliver(reject, {
          code: "execution_ended",
          message: "The execution ended before the script finished.",
          line,
          call,
        });
        return;
      }
      const { result } = step;
      trace.push({ line, call, ok: result.ok, effect: result.effect, ms: host.now() - started });
      if (!result.ok) {
        deliver(reject, { ...result.error, line, call, effect: result.effect });
        return;
      }
      deliver(resolve, { result, page: step.page });
    } catch (error) {
      deliver(reject, { code: "internal_error", message: String(error), line, call });
    }
  };

  const bridge: Bridge = {
    call(json, line, resolve, reject) {
      chain = chain.then(() =>
        perform(String(json), typeof line === "number" ? line : undefined, resolve, reject),
      );
    },
    emit(json) {
      const text = String(json);
      if (emittedChars + text.length > MAX_JSON_CHARS) {
        return false;
      }
      emittedChars += text.length;
      emitted.push(JSON.parse(text));
      return true;
    },
    log(text) {
      if (logs.length >= MAX_LOGS) {
        logsTruncated = true;
        return;
      }
      logs.push(String(text).slice(0, MAX_LOG_CHARS));
    },
  };

  let script: vm.Script;
  try {
    script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: "script.js",
      lineOffset: -1,
    });
  } catch (error) {
    const record = error as { message?: unknown; stack?: unknown };
    const line = lineOf(record.stack);
    const compileError: ScriptError = {
      code: "compile_error",
      message: String(record.message ?? error),
      line: line === undefined ? undefined : Math.min(line, code.split("\n").length),
    };
    return { ok: false, effect: "none", calls: 0, error: compileError };
  }

  const sandbox = Object.create(null) as Record<string, unknown>;
  const context = vm.createContext(sandbox, {
    name: "commands-script",
    codeGeneration: { strings: false, wasm: false },
  });
  facade ??= new vm.Script(FACADE, { filename: "facade.js" });
  const install = facade.runInContext(context) as (bridge: Bridge) => Globals;
  const globals = install(bridge);
  sandbox.page = globals.page;
  sandbox.emit = globals.emit;
  sandbox.console = globals.console;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(
      () => resolve(TIMED_OUT),
      Math.max(0, host.remainingMs()) + DEADLINE_GRACE_MS,
    );
  });

  let value: unknown;
  let error: ScriptError | undefined;
  try {
    const pending = script.runInContext(context, { timeout: SYNC_LIMIT_MS }) as Promise<unknown>;
    const settled = await Promise.race([pending, deadline]);
    if (settled === TIMED_OUT) {
      throw TIMED_OUT;
    }
    const serialized = JSON.stringify(settled);
    if (serialized !== undefined && serialized.length > MAX_JSON_CHARS) {
      error = {
        code: "invalid_argument",
        reason: "too_large",
        message: `The return value is ${serialized.length} characters of JSON. Return at most ${MAX_JSON_CHARS}.`,
      };
    } else {
      value = serialized === undefined ? undefined : JSON.parse(serialized);
    }
  } catch (thrown) {
    error = describe(thrown);
  } finally {
    clearTimeout(timer);
    stopped = true;
  }

  return {
    ok: !error,
    effect: trace.length ? combine(trace) : "none",
    ...(value !== undefined ? { value } : {}),
    ...(emitted.length ? { emitted } : {}),
    ...(logs.length ? { logs } : {}),
    ...(logsTruncated ? { logsTruncated: true } : {}),
    calls,
    trace: trace.slice(-TRACE_TAIL),
    ...(trace.length > TRACE_TAIL ? { traceOmitted: trace.length - TRACE_TAIL } : {}),
    ...(error ? { error } : {}),
  };
}
