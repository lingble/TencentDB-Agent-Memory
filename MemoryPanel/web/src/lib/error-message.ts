import i18n from '@/i18n';

export interface ErrorEnvelopeLike {
  code?: number | string;
  message?: string;
  request_id?: string;
}

/**
 * Set of known error codes - the source of error.* keys in the locale files.
 * The list is kept to quickly check whether a code is valid (more explicit than i18n.exists).
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNAUTHORIZED', 'INVALID_USER_KEY', 'MISSING_USER_KEY', 'MISSING_INSTANCE_ID',
  'INVALID_INSTANCE', 'NOT_TEAM_MEMBER', 'PERMISSION_DENIED', 'FORBIDDEN',
  'NOT_FOUND', 'ALREADY_EXISTS', 'MEMBER_ALREADY_EXISTS', 'CONFLICT',
  'KERNEL_UNAVAILABLE', 'UPSTREAM_ERROR', 'UNKNOWN_META_ACTION', 'NOT_IN_SCOPE',
  'MISSING_TEAM_ID', 'MISSING_AGENT_ID', 'AGENT_NOT_FOUND', 'NOT_YOUR_AGENT',
  'AGENT_NOT_IN_TEAM', 'MISSING_TASK_ID', 'MISSING_ASSET_ID', 'ASSET_NOT_FOUND',
  'ASSET_NOT_SHARED', 'ASSET_TYPE_MISMATCH', 'MISSING_BLOCK_ID', 'BLOCK_NOT_FOUND',
  'NOT_CHAT_MEMORY', 'TEAM_MISMATCH', 'INVALID_SCOPE',
  'CANNOT_ALLOCATE_SELF_CHAT_MEMORY', 'CANNOT_UNBIND_SELF_CHAT_MEMORY',
  'ALREADY_ALLOCATED', 'IMPORT_LIMIT_EXCEEDED', 'ASSET_PRIVATE_INACCESSIBLE',
  'ASSET_NOT_BINDABLE', 'INVALID_TITLE', 'MISSING_MESSAGES', 'TOO_MANY_MESSAGES',
  'NO_VALID_MESSAGES', 'MISSING_WIKI_ID', 'WIKI_NOT_FOUND', 'WIKI_EMPTY_NO_SOURCES',
  'MISSING_FILES', 'TOO_MANY_FILES', 'FILE_TOO_LARGE', 'TOTAL_TOO_LARGE',
  'MISSING_CODE_GRAPH_ID', 'CODE_GRAPH_NOT_FOUND', 'KNOWLEDGE_NOT_FOUND',
  'INVALID_ARGUMENT', 'VALIDATION_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR',
  // Account creation failure on first login with a self-held user_key. Must be registered explicitly, otherwise it falls through to the regex fallback below
  // and gets mismatched by the unauthorized: invalid_user_key pattern as "invalid key", which has nothing to do with the real cause (account creation failure)
  // and seriously misleads troubleshooting.
  'USER_CREATE_FAILED',
]);

/**
 * Look up localized text by error code.
 * Translated dynamically through the i18n instance, following the user's current language.
 */
function lookupErrorCode(code: string): string | null {
  if (KNOWN_ERROR_CODES.has(code)) return i18n.t('error.' + code);
  // Normalize snake_case: the backend may return lowercase
  if (/^[a-z][a-z0-9_]+$/.test(code)) {
    const upper = code.toUpperCase();
    if (KNOWN_ERROR_CODES.has(upper)) return i18n.t('error.' + upper);
  }
  return null;
}

function getMessagePatterns(): Array<[RegExp, string]> {
  return [
    [/unauthorized:\s*invalid_user_key/i, i18n.t('error.INVALID_USER_KEY')],
    [/user_id or user_key is required/i, i18n.t('error.MISSING_USER_KEY')],
    [/missing.*team_id/i, i18n.t('error.MISSING_TEAM_ID')],
    [/missing.*agent_id/i, i18n.t('error.MISSING_AGENT_ID')],
    [/not team member/i, i18n.t('error.NOT_TEAM_MEMBER')],
    // Note: asset_not_bindable / visibility_restricted are matched earlier in PRIORITY_MESSAGE_PATTERNS,
    // because they would otherwise be swallowed by the permission_denied prefix.
    [/permission[_\s-]?denied/i, i18n.t('error.PERMISSION_DENIED')],
    [/fetch failed|networkerror|failed to fetch/i, i18n.t('error.network')],
    [/timeout|aborted/i, i18n.t('error.timeout')],
    [/empty .* response/i, i18n.t('error.emptyResponse')],
    [/internal server error/i, i18n.t('error.INTERNAL_ERROR')],
  ];
}

/**
 * Semantic patterns matched first - run before the extractCodeLike fallback extraction.
 *
 * Scenario: kernel error messages look like `permission_denied: visibility_restricted` - the `permission_denied` prefix
 * would be extracted by extractCodeLike as `PERMISSION_DENIED` and hit the generic text directly, masking the trailing `visibility_restricted`
 * semantic keyword. So every "generic error code + specific sub-reason" combination must be matched precisely here.
 */
function getPriorityPatterns(): Array<[RegExp, string]> {
  return [
    [/visibility[_\s-]?restricted/i, i18n.t('error.ASSET_PRIVATE_INACCESSIBLE')],
    [/asset_not_bindable/i, i18n.t('error.ASSET_NOT_BINDABLE')],
  ];
}

/**
 * Chinese sentences the Panel backend puts directly into `message` (not CODE enums;
 * see panel-api-doc.md §4.2). The Chinese literals below are a protocol contract with
 * the backend and must stay in Chinese; they are mapped to English en-US text so the
 * raw server sentence is never shown to users.
 */
function mapBackendChineseMessage(text: string): string | null {
  if (!text) return null;
  // meta/* create duplicate check (409): "已存在同名{entity}「{name}」，请更换名称后重试。"
  const dup = text.match(/已存在同名(.*?)「(.*)」，请更换名称后重试/);
  if (dup) {
    const entityKey = dup[1] === '用户' ? 'user' : dup[1] === '团队' ? 'team' : 'other';
    return i18n.t('error.DUPLICATE_NAME', {
      entity: i18n.t(`error.DUPLICATE_NAME.entity.${entityKey}`),
      name: dup[2],
    });
  }
  // chat-memory/allocate duplicate allocation (409)
  if (text.includes('这条记忆已经分配给该 Agent，无需重复分配。')) {
    return i18n.t('error.ALREADY_ALLOCATED_MEMORY');
  }
  // chat-memory/allocate self-allocation (400)
  if (text.includes('不能把该 Agent 自己的记忆再分配给自己。')) {
    return i18n.t('error.CANNOT_ALLOCATE_SELF_CHAT_MEMORY');
  }
  return null;
}

function tryParseJson(input: string): unknown | null {
  const text = input.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractCodeLike(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const exact = trimmed.match(/^[A-Z][A-Z0-9_]{2,}$/);
  if (exact) return exact[0];
  const lowerPrefix = trimmed.match(/^([a-z][a-z0-9_]{2,})\s*:/);
  if (lowerPrefix) return lowerPrefix[1].toUpperCase();
  const upperInside = trimmed.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return upperInside?.[1] ?? null;
}

function stripTechnicalPrefix(message: string): string {
  return message
    .replace(/^(skill|knowledge)\s+\d+\s*:\s*/i, '')
    .replace(/^\d{3}\s+[A-Za-z ]+\s*·\s*/, '')
    .trim();
}

function isJsonLike(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function mapErrorCode(codeOrMessage: number | string | undefined, fallbackMessage?: string): string | null {
  const raw = String(codeOrMessage ?? '').trim();
  const text = fallbackMessage ?? raw;

  const backendChinese = mapBackendChineseMessage(text) ?? mapBackendChineseMessage(raw);
  if (backendChinese) return backendChinese;

  // Run the priority patterns first: prevents extractCodeLike from swallowing the sub-reason keyword via the `permission_denied` prefix.
  for (const [pattern, message] of getPriorityPatterns()) {
    if (pattern.test(text) || pattern.test(raw)) return message;
  }

  const direct = lookupErrorCode(raw);
  if (direct) return direct;

  const fromMessage = extractCodeLike(fallbackMessage ?? raw);
  if (fromMessage) {
    const mapped = lookupErrorCode(fromMessage);
    if (mapped) return mapped;
  }

  for (const [pattern, message] of getMessagePatterns()) {
    if (pattern.test(text)) return message;
  }
  return null;
}

export function formatApiErrorMessage(input: {
  code?: number | string;
  message?: string;
  requestId?: string;
  httpStatus?: number;
  httpStatusText?: string;
  body?: string;
  fallback?: string;
}): string {
  const bodyJson = input.body ? tryParseJson(input.body) : null;
  const env = bodyJson && !Array.isArray(bodyJson) ? bodyJson as ErrorEnvelopeLike : null;
  const code = input.code ?? env?.code ?? input.httpStatus;
  const rawMessage = env?.message ?? input.message ?? input.httpStatusText ?? input.body ?? input.fallback ?? '';

  const mapped = mapErrorCode(code, rawMessage) ?? mapErrorCode(rawMessage);
  if (mapped) return mapped;

  const clean = stripTechnicalPrefix(rawMessage);
  if (clean && !isJsonLike(clean)) return clean;

  if (input.httpStatus === 401) return i18n.t('error.UNAUTHORIZED');
  if (input.httpStatus === 403) return i18n.t('error.PERMISSION_DENIED');
  if (input.httpStatus === 404) return i18n.t('error.NOT_FOUND');
  if (input.httpStatus && input.httpStatus >= 500) return i18n.t('error.INTERNAL_ERROR');
  return input.fallback ?? i18n.t('error.fallback');
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'ApiError') {
    const apiErr = err as Error & {
      status: number;
      statusText: string;
      body: string;
      code?: number | string;
      requestId?: string;
      rawMessage?: string;
    };
    return formatApiErrorMessage({
      code: apiErr.code,
      message: apiErr.rawMessage ?? apiErr.message,
      requestId: apiErr.requestId,
      httpStatus: apiErr.status,
      httpStatusText: apiErr.statusText,
      body: apiErr.body,
      fallback: apiErr.message,
    });
  }
  if (err instanceof Error) return formatApiErrorMessage({ message: err.message, fallback: err.message });
  if (typeof err === 'string') return formatApiErrorMessage({ message: err, fallback: err });
  return i18n.t('error.fallback');
}
