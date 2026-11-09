import { z } from "zod";
import { publishedRequestSchema } from "../../services/commands/commands.js";

const Effect = z
  .enum(["none", "applied", "unknown"])
  .describe("What happened to the page: nothing, a change, or a possible change.");

const ErrorInfo = z.object({
  code: z.string().describe("Error code, such as stale_ref or not_actionable."),
  message: z.string(),
  reason: z.string().optional().describe("More detail, such as covered or detached."),
});

const Dialog = z.object({
  id: z.string(),
  tab: z.string(),
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string(),
  defaultPrompt: z.string().optional(),
});

const resultBase = {
  ok: z.boolean(),
  effect: Effect,
  error: ErrorInfo.optional(),
};

const interrupts = {
  dialog: Dialog.optional().describe(
    "A dialog that the command opened. It blocks the tab until it closes.",
  ),
  loading: z
    .boolean()
    .optional()
    .describe("The command started a navigation that was still loading when it returned."),
};

const visited = {
  navigated: z.boolean().optional().describe("False when there was no history entry."),
  url: z.string().optional(),
};

const RESULT_FIELDS = {
  navigate: { url: z.string().optional() },
  back: visited,
  forward: visited,
  reload: { url: z.string().optional() },
  snapshot: { snapshotId: z.string().optional(), snapshot: z.string().optional() },
  click: interrupts,
  dblclick: interrupts,
  hover: { dialog: interrupts.dialog },
  focus: {},
  type: interrupts,
  fill: interrupts,
  press: interrupts,
  keydown: interrupts,
  keyup: interrupts,
  mouse: interrupts,
  select: {
    selected: z.array(z.string()).optional().describe("The values of the selected options."),
    ...interrupts,
  },
  check: { checked: z.boolean().optional(), ...interrupts },
  uncheck: { checked: z.boolean().optional(), ...interrupts },
  upload: { files: z.array(z.string()).optional(), ...interrupts },
  drag: interrupts,
  get: {
    value: z
      .unknown()
      .optional()
      .describe(
        "A string for text, html, markdown, value, attr, title, and url. A number for count. { x, y, width, height } or null for box. A list of locators for locator.",
      ),
    masked: z.boolean().optional().describe("The value is a secret, so it is left out."),
  },
  is: { value: z.boolean().optional() },
  wait: {
    waited: z.enum(["ms", "target", "text", "url", "load", "download"]).optional(),
    file: z.string().optional().describe("The downloaded file, for download."),
    bytes: z.number().int().optional(),
  },
  screenshot: { format: z.enum(["png", "jpeg", "webp"]).optional(), data: z.string().optional() },
  eval: {
    value: z.unknown().optional().describe("The result of the script as JSON."),
    ...interrupts,
  },
  pdf: { format: z.literal("pdf").optional(), data: z.string().optional() },
  scroll: {
    moved: z.boolean().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  find: {
    count: z.number().int().optional(),
    matches: z.array(z.object({ ref: z.string(), role: z.string(), name: z.string() })).optional(),
  },
  tab: {
    tabs: z.array(z.object({ tab: z.string(), url: z.string(), title: z.string() })).optional(),
    tab: z.string().optional(),
  },
  script: {
    value: z.unknown().optional().describe("The value the script returned, as JSON."),
    emitted: z
      .array(z.unknown())
      .optional()
      .describe("Values passed to emit(). They are kept when the script fails."),
    logs: z.array(z.string()).optional().describe("Output of console.log."),
    logsTruncated: z.boolean().optional(),
    calls: z.number().int().optional().describe("Commands the script ran."),
    trace: z
      .array(
        z.object({
          line: z.number().int().optional(),
          call: z.string(),
          ok: z.boolean(),
          effect: Effect,
          ms: z.number(),
        }),
      )
      .optional()
      .describe("The last commands the script ran."),
    traceOmitted: z.number().int().optional(),
    error: ErrorInfo.extend({
      line: z.number().int().optional().describe("The line of the script that failed."),
      call: z.string().optional().describe("The command that failed."),
      effect: Effect.optional().describe("What the failed command did to the page."),
    }).optional(),
  },
};

type ResultName = keyof typeof RESULT_FIELDS;

function resultOf<N extends ResultName>(name: N) {
  return z.object({ command: z.literal(name), ...resultBase, ...RESULT_FIELDS[name] }).strict();
}

const RESULTS = (Object.keys(RESULT_FIELDS) as ResultName[]).map(resultOf);

export const CommandResult = z
  .discriminatedUnion("command", RESULTS as unknown as [z.ZodObject, ...z.ZodObject[]])
  .describe("Result of one command, with the fields of that command.");

export const CommandResponse = z.object({
  id: z
    .string()
    .describe(
      "The id of this execution. Use it in GET /v1/sessions/{sessionId}/commands/executions/{executionId} and POST /v1/sessions/{sessionId}/commands/executions/{executionId}/cancel.",
    ),
  next: z.string().optional().describe("Send it as after in the next request."),
  epochChanged: z
    .boolean()
    .optional()
    .describe(
      "Whether another commands client, a quick action, or a browser restart changed the session since after.",
    ),
  page: z
    .object({ tab: z.string(), url: z.string(), title: z.string() })
    .nullable()
    .describe("The tab the execution used."),
  execution: z.object({
    id: z.string(),
    state: z.enum(["queued", "running", "completed", "failed", "cancelled", "timeout", "expired"]),
    effect: Effect,
    replayed: z.boolean(),
    ran: z.number().int().describe("Commands started."),
    error: ErrorInfo.optional(),
  }),
  results: z.array(CommandResult),
  observe: z
    .object({
      snapshotId: z.string(),
      snapshot: z.string(),
      base: z.string(),
      diff: z.string(),
      additions: z.number().int(),
      removals: z.number().int(),
      full: z.boolean(),
      error: ErrorInfo,
    })
    .partial()
    .optional(),
  dialog: Dialog.optional().describe(
    "A dialog that is open on the tab and blocks it until it closes.",
  ),
  bodyExpired: z.boolean().optional(),
});

const CommandRequestError = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .passthrough();

const CommandsSchemaResponse = z.object({
  version: z.number().int(),
  schema: z.record(z.string(), z.unknown()).describe("JSON Schema of the request body."),
});

export const commandsSchemas = {
  CommandRequest: publishedRequestSchema,
  CommandResponse,
  CommandRequestError,
  CommandsSchemaResponse,
};

export default commandsSchemas;
