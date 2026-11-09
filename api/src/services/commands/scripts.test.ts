import { describe, expect, test } from "vitest";
import type { Command } from "./commands.js";
import type { CommandResult } from "./records.js";
import { runScript, type ScriptHost } from "./scripts.js";

function fakeHost(reply: (command: Command) => CommandResult, remainingMs = 10_000) {
  const commands: Command[] = [];
  let running = 0;
  let overlapped = false;
  const host: ScriptHost = {
    now: () => Date.now(),
    remainingMs: () => remainingMs,
    async step(command) {
      running += 1;
      overlapped ||= running > 1;
      commands.push(command);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return { result: reply(command), page: { url: "https://example.com/", title: "Example" } };
    },
  };
  return { host, commands, overlapped: () => overlapped };
}

const ok = (fields: Record<string, unknown> = {}): CommandResult => ({
  ok: true,
  effect: "none",
  ...fields,
});

describe("runScript", () => {
  test("turns page calls into commands and returns the value", async () => {
    const { host, commands } = fakeHost((command) =>
      command.command === "get" ? ok({ value: "Hello" }) : ok({ effect: "applied" }),
    );
    const result = await runScript(
      [
        'await page.goto("https://example.com")',
        'await page.getByRole("button", { name: "Save" }).click()',
        'return { text: await page.locator("#out").innerText(), url: page.url() }',
      ].join("\n"),
      host,
    );
    expect(commands).toEqual([
      { command: "navigate", url: "https://example.com" },
      { command: "click", target: { role: "button", name: "Save" } },
      { command: "get", what: "text", target: "#out" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      effect: "applied",
      calls: 3,
      value: { text: "Hello", url: "https://example.com/" },
    });
  });

  test("stops at a failed call and reports its line, effect, and emitted values", async () => {
    const { host } = fakeHost((command) =>
      command.command === "click"
        ? {
            ok: false,
            effect: "none",
            error: { code: "not_actionable", reason: "covered", message: "covered" },
          }
        : ok({ effect: "applied" }),
    );
    const result = await runScript(
      [
        'await page.goto("https://example.com")',
        'emit("first")',
        'await page.click("#next")',
        'emit("never")',
      ].join("\n"),
      host,
    );
    expect(result).toMatchObject({
      ok: false,
      effect: "applied",
      emitted: ["first"],
      error: { code: "not_actionable", reason: "covered", line: 3, call: "click", effect: "none" },
    });
  });

  test("reads every match with count and nth", async () => {
    const { host, commands } = fakeHost((command) => {
      if (command.command === "get" && command.what === "count") return ok({ value: 3 });
      const target = (command as { target?: { nth?: number } }).target;
      return ok({ value: `item ${target?.nth}` });
    });
    const result = await runScript('return await page.locator(".item").allInnerTexts()', host);
    expect(result.value).toEqual(["item 0", "item 1", "item 2"]);
    expect(commands).toHaveLength(4);
  });

  test("runs calls one at a time", async () => {
    const fake = fakeHost(() => ok({ value: "t" }));
    const result = await runScript(
      "return await Promise.all([page.title(), page.title(), page.title()])",
      fake.host,
    );
    expect(result.value).toEqual(["t", "t", "t"]);
    expect(fake.overlapped()).toBe(false);
  });

  test("rejects invalid commands before they run", async () => {
    const { host, commands } = fakeHost(() => ok());
    const result = await runScript('await page.waitForTimeout("soon")', host);
    expect(commands).toHaveLength(0);
    expect(result.error).toMatchObject({ code: "invalid_argument", line: 1, call: "wait" });
  });

  test("reports compile errors with a line", async () => {
    const { host } = fakeHost(() => ok());
    const result = await runScript("const a = 1\nawait page.goto(", host);
    expect(result).toMatchObject({
      ok: false,
      calls: 0,
      error: { code: "compile_error", line: 2 },
    });
  });

  test("keeps host objects out of reach", async () => {
    const { host } = fakeHost(() => ok());
    const probes = [
      'return page.goto.constructor("return process")()',
      'return this.constructor.constructor("return process")()',
      "return eval('1 + 1')",
      "return typeof process",
      "return typeof require",
    ];
    const results = await Promise.all(probes.map((code) => runScript(code, host)));
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(false);
    expect(results[3].value).toBe("undefined");
    expect(results[4].value).toBe("undefined");
  });

  test("stops a script that never finishes", async () => {
    const { host } = fakeHost(() => ok(), 50);
    const result = await runScript("await new Promise(() => {})", host);
    expect(result.error).toMatchObject({ code: "limit_exceeded", reason: "timeout" });
  });

  test("stops a script that never awaits", async () => {
    const { host } = fakeHost(() => ok());
    const result = await runScript("while (true) {}", host);
    expect(result.error).toMatchObject({ code: "limit_exceeded", reason: "cpu" });
  });
});
