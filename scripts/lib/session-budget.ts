import {
  inputResponseSchema,
  isInputRequest,
  type ClientSession,
  type ClientSessions,
  type InputRequest,
  type MessageResponse,
  type MessageResult,
  type SendTurnInput,
  type SendTurnOptions,
} from "eve/client";

const SESSION_LIMIT_TOOL_NAME = "session_limit_continuation";
const CONTINUE_OPTION_ID = "continue";
const STOP_OPTION_ID = "stop";

export const MAX_BACKGROUND_TOKEN_CONTINUATIONS = 2;
export const BACKGROUND_SESSION_TOKEN_LIMITS = Object.freeze({
  input: 300_000,
  output: 20_000,
});

// Durable sessions created before 2026-08-25 retain the old input limit for
// their 90-day lifetime. Remove this compatibility value after 2026-11-23.
const LEGACY_BACKGROUND_INPUT_TOKEN_LIMIT = 150_000;

type BudgetKind = keyof typeof BACKGROUND_SESSION_TOKEN_LIMITS;

export interface BackgroundContinuationMetadata {
  kind: BudgetKind;
  limit: number;
  usedTokens: number;
  continuationsGranted: number;
  maxContinuations: number;
}

interface BackgroundBudgetErrorOptions extends BackgroundContinuationMetadata {
  stopConfirmed: boolean;
}

export class BackgroundTokenBudgetExceededError extends Error {
  readonly code = "BACKGROUND_TOKEN_BUDGET_EXCEEDED";
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly usedTokens: number;
  readonly continuationsGranted: number;
  readonly maxContinuations: number;
  readonly stopConfirmed: boolean;

  constructor(options: BackgroundBudgetErrorOptions) {
    super(
      `Background session exhausted its ${options.kind} token budget after ` +
        `${options.continuationsGranted} continuation(s); Stop was submitted.`,
    );
    this.name = "BackgroundTokenBudgetExceededError";
    this.kind = options.kind;
    this.limit = options.limit;
    this.usedTokens = options.usedTokens;
    this.continuationsGranted = options.continuationsGranted;
    this.maxContinuations = options.maxContinuations;
    this.stopConfirmed = options.stopConfirmed;
  }
}

export class UnexpectedBackgroundInputRequestError extends Error {
  readonly code = "UNEXPECTED_BACKGROUND_INPUT_REQUEST";
  readonly reason: string;
  readonly requestCount: number;

  constructor(reason: string, requestCount: number) {
    super(
      `Background session stopped on an unsupported input request (${reason}).`,
    );
    this.name = "UnexpectedBackgroundInputRequestError";
    this.reason = reason;
    this.requestCount = requestCount;
  }
}

interface BackgroundSessionLimitUpgradeOptions {
  kind: BudgetKind;
  limit: number;
  usedTokens: number;
  stopConfirmed: boolean;
}

export class BackgroundSessionLimitUpgradeRequiredError extends Error {
  readonly code = "BACKGROUND_SESSION_LIMIT_UPGRADE_REQUIRED";
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly usedTokens: number;
  readonly stopConfirmed: boolean;

  constructor(options: BackgroundSessionLimitUpgradeOptions) {
    super(
      `Background session uses a legacy ${options.kind} token limit; Stop was requested before rotation.`,
    );
    this.name = "BackgroundSessionLimitUpgradeRequiredError";
    this.kind = options.kind;
    this.limit = options.limit;
    this.usedTokens = options.usedTokens;
    this.stopConfirmed = options.stopConfirmed;
  }
}

export function isUnconfirmedBackgroundStopError(
  error: unknown,
): error is
  | BackgroundSessionLimitUpgradeRequiredError
  | BackgroundTokenBudgetExceededError {
  return (
    (error instanceof BackgroundSessionLimitUpgradeRequiredError ||
      error instanceof BackgroundTokenBudgetExceededError) &&
    !error.stopConfirmed
  );
}

function unexpected(
  reason: string,
  requestCount: number,
): UnexpectedBackgroundInputRequestError {
  return new UnexpectedBackgroundInputRequestError(reason, requestCount);
}

interface ParsedSessionLimitRequest {
  requestId: string;
  kind: BudgetKind;
  limit: number;
  usedTokens: number;
  requiresUpgrade: boolean;
}

function isBudgetKind(value: unknown): value is BudgetKind {
  return value === "input" || value === "output";
}

function parseSessionLimitRequest(
  requests: readonly InputRequest[],
): ParsedSessionLimitRequest {
  if (requests.length !== 1) {
    throw unexpected("invalid_request_count", requests.length);
  }

  const request: unknown = requests[0];
  if (!isInputRequest(request)) {
    throw unexpected("malformed_input_request", 1);
  }

  const input = request.action.input;
  const inputKeys = Object.keys(input).sort();
  const kind = input.kind;
  const limit = input.limit;
  const usedTokens = input.usedTokens;
  const options = request.options;
  const validKind = isBudgetKind(kind);
  const exactInput =
    inputKeys.length === 3 &&
    inputKeys[0] === "kind" &&
    inputKeys[1] === "limit" &&
    inputKeys[2] === "usedTokens";
  const exactOptions =
    Array.isArray(options) &&
    options.length === 2 &&
    options.some((option) => option.id === CONTINUE_OPTION_ID) &&
    options.some((option) => option.id === STOP_OPTION_ID) &&
    new Set(options.map((option) => option.id)).size === 2;
  const validLimit =
    validKind &&
    typeof limit === "number" &&
    Number.isSafeInteger(limit) &&
    (limit === BACKGROUND_SESSION_TOKEN_LIMITS[kind] ||
      (kind === "input" && limit === LEGACY_BACKGROUND_INPUT_TOKEN_LIMIT));
  const validUsage =
    typeof usedTokens === "number" &&
    Number.isSafeInteger(usedTokens) &&
    typeof limit === "number" &&
    usedTokens >= limit;

  if (
    request.kind !== "session-limit" ||
    request.action.kind !== "tool-call" ||
    request.action.toolName !== SESSION_LIMIT_TOOL_NAME ||
    request.action.callId !== request.requestId ||
    request.allowFreeform !== false ||
    request.display !== "confirmation" ||
    !exactInput ||
    !exactOptions ||
    !validKind ||
    !validLimit ||
    !validUsage
  ) {
    throw unexpected("malformed_session_limit_request", 1);
  }

  return {
    requestId: request.requestId,
    kind,
    limit,
    usedTokens,
    requiresUpgrade: limit !== BACKGROUND_SESSION_TOKEN_LIMITS[kind],
  };
}

function inputResponse(requestId: string, optionId: string) {
  return inputResponseSchema.parse({ requestId, optionId });
}

type BackgroundClientSession = Pick<ClientSession, "send" | "respond">;
type BackgroundMessageInput = SendTurnInput["message"] | SendTurnInput;

function messageDispatch(input: BackgroundMessageInput): {
  message: SendTurnInput["message"];
  options: SendTurnOptions;
  signal: AbortSignal | undefined;
} {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "message" in input
  ) {
    const { message, ...options } = input;
    return { message, options, signal: options.signal };
  }
  return {
    message: input,
    options: {},
    signal: undefined,
  };
}

async function resolveTracked(
  response: MessageResponse,
  signal: AbortSignal | undefined,
  hooks: BackgroundBudgetSendHooks,
  session?: ClientSession,
): Promise<MessageResult> {
  const result = response.result();
  hooks.onAccepted?.(result);
  if (session) hooks.onAcceptedSession?.(session, result);
  const resolved = await result;
  signal?.throwIfAborted();
  hooks.validateResult?.(resolved);
  return resolved;
}

async function sendTracked(
  session: BackgroundClientSession,
  input: BackgroundMessageInput,
  hooks: BackgroundBudgetSendHooks,
): Promise<MessageResult> {
  const { message, options, signal } = messageDispatch(input);
  signal?.throwIfAborted();
  hooks.onSendStart?.("message");

  let response: MessageResponse;
  try {
    response = await session.send(message, options);
  } catch (error) {
    // Diagnostic only: a rejected client promise does not prove that the
    // server failed to accept the POST and must never authorize a fresh writer.
    hooks.onSendRejected?.();
    throw error;
  }
  return resolveTracked(response, signal, hooks);
}

async function createTracked(
  sessions: Pick<ClientSessions, "create">,
  input: BackgroundMessageInput,
  hooks: BackgroundBudgetSendHooks,
): Promise<{ session: ClientSession; result: MessageResult }> {
  const { message, options, signal } = messageDispatch(input);
  signal?.throwIfAborted();
  hooks.onSendStart?.("message");

  let created;
  try {
    created = await sessions.create({ message, ...options });
  } catch (error) {
    hooks.onSendRejected?.();
    throw error;
  }
  return {
    session: created.session,
    result: await resolveTracked(
      created.response,
      signal,
      hooks,
      created.session,
    ),
  };
}

async function respondTracked(
  session: BackgroundClientSession,
  responses: ReturnType<typeof inputResponse>[],
  signal: AbortSignal | undefined,
  hooks: BackgroundBudgetSendHooks,
  kind: Exclude<BackgroundDispatchKind, "message">,
): Promise<MessageResult> {
  signal?.throwIfAborted();
  hooks.onSendStart?.(kind);
  let response: MessageResponse;
  try {
    response = await session.respond(responses, signal ? { signal } : {});
  } catch (error) {
    hooks.onSendRejected?.();
    throw error;
  }
  return resolveTracked(response, signal, hooks);
}

async function stopSessionLimitRequest(
  session: BackgroundClientSession,
  requestId: string,
  signal: AbortSignal | undefined,
  hooks: BackgroundBudgetSendHooks,
): Promise<boolean> {
  try {
    const stopped = await respondTracked(
      session,
      [inputResponse(requestId, STOP_OPTION_ID)],
      signal,
      hooks,
      "stop",
    );
    // A replayed durable cursor can surface an older waiting boundary after the
    // Stop response. Only the Stop contract's terminal sequence proves that the
    // request we just answered cancelled its writer: turn.cancelled -> waiting.
    return (
      stopped.status === "waiting" &&
      stopped.inputRequests.length === 0 &&
      stopped.events.some((event) => event.type === "turn.cancelled")
    );
  } catch (error) {
    if (isRollupDispatchProofMismatch(error)) throw error;
    return false;
  }
}

function isRollupDispatchProofMismatch(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ROLLUP_DISPATCH_PROOF_MISMATCH"
  );
}

export type BackgroundDispatchKind = "continue" | "message" | "stop";

export interface BackgroundBudgetSendHooks {
  /** Runs synchronously before each initial, Continue, or Stop send. */
  onSendStart?: (kind: BackgroundDispatchKind) => void;
  onAccepted?: (result: Promise<MessageResult>) => void;
  onAcceptedSession?: (
    session: ClientSession,
    result: Promise<MessageResult>,
  ) => void;
  onSendRejected?: () => void;
  validateResult?: (result: MessageResult) => void;
}

export interface BackgroundSessionBudget {
  readonly continuationsGranted: number;
  create(
    sessions: Pick<ClientSessions, "create">,
    input: BackgroundMessageInput,
    hooks?: BackgroundBudgetSendHooks,
  ): Promise<{ session: ClientSession; result: MessageResult }>;
  send(
    session: BackgroundClientSession,
    input: BackgroundMessageInput,
    hooks?: BackgroundBudgetSendHooks,
  ): Promise<MessageResult>;
}

export interface CreateBackgroundSessionBudgetOptions {
  maxContinuations?: number;
  onContinuation?: (
    metadata: Readonly<BackgroundContinuationMetadata>,
  ) => void | Promise<void>;
}

export function createBackgroundSessionBudget(
  options: CreateBackgroundSessionBudgetOptions = {},
): BackgroundSessionBudget {
  const {
    maxContinuations = MAX_BACKGROUND_TOKEN_CONTINUATIONS,
    onContinuation,
  } = options;
  if (
    !Number.isInteger(maxContinuations) ||
    maxContinuations < 0 ||
    maxContinuations > MAX_BACKGROUND_TOKEN_CONTINUATIONS
  ) {
    throw new RangeError(
      `maxContinuations must be an integer from 0 to ${MAX_BACKGROUND_TOKEN_CONTINUATIONS}`,
    );
  }

  let continuationsGranted = 0;

  return {
    get continuationsGranted() {
      return continuationsGranted;
    },

    async create(sessions, input, hooks = {}) {
      const signal = messageDispatch(input).signal;
      const created = await createTracked(sessions, input, hooks);
      return {
        session: created.session,
        result: await settleBackgroundRequests(
          created.session,
          created.result,
          signal,
          hooks,
          () => continuationsGranted,
          (value) => {
            continuationsGranted = value;
          },
          maxContinuations,
          onContinuation,
        ),
      };
    },

    async send(session, input, hooks = {}) {
      const signal = messageDispatch(input).signal;
      const result = await sendTracked(session, input, hooks);
      return settleBackgroundRequests(
        session,
        result,
        signal,
        hooks,
        () => continuationsGranted,
        (value) => {
          continuationsGranted = value;
        },
        maxContinuations,
        onContinuation,
      );
    },
  };
}

async function settleBackgroundRequests(
  session: BackgroundClientSession,
  initialResult: MessageResult,
  signal: AbortSignal | undefined,
  hooks: BackgroundBudgetSendHooks,
  continuationsGranted: () => number,
  setContinuationsGranted: (value: number) => void,
  maxContinuations: number,
  onContinuation:
    | ((
        metadata: Readonly<BackgroundContinuationMetadata>,
      ) => void | Promise<void>)
    | undefined,
): Promise<MessageResult> {
  let result = initialResult;

  while (result.inputRequests.length > 0) {
    const request = parseSessionLimitRequest(result.inputRequests);
    const granted = continuationsGranted();
    const metadata = Object.freeze({
      kind: request.kind,
      limit: request.limit,
      usedTokens: request.usedTokens,
      continuationsGranted: granted,
      maxContinuations,
    });

    if (request.requiresUpgrade) {
      const stopConfirmed = await stopSessionLimitRequest(
        session,
        request.requestId,
        signal,
        hooks,
      );
      throw new BackgroundSessionLimitUpgradeRequiredError({
        kind: request.kind,
        limit: request.limit,
        usedTokens: request.usedTokens,
        stopConfirmed,
      });
    }

    if (granted >= maxContinuations) {
      const stopConfirmed = await stopSessionLimitRequest(
        session,
        request.requestId,
        signal,
        hooks,
      );

      throw new BackgroundTokenBudgetExceededError({
        ...metadata,
        stopConfirmed,
      });
    }

    const nextGranted = granted + 1;
    setContinuationsGranted(nextGranted);
    const continued = Object.freeze({
      ...metadata,
      continuationsGranted: nextGranted,
    });
    if (onContinuation) {
      try {
        await onContinuation(continued);
      } catch {
        // Observability must not leave an approved background turn parked.
      }
    }

    result = await respondTracked(
      session,
      [inputResponse(request.requestId, CONTINUE_OPTION_ID)],
      signal,
      hooks,
      "continue",
    );
  }

  return result;
}
