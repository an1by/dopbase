// HTTP client for API tests and factories. Each client is one session:
// anonymous, a browser session (cookie plus CSRF header), or a bearer token.
import {
  expect,
  request,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { recordHit } from "./record.ts";

export type ApiResult<T = any> = {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or the raw text when it isn't JSON. */
  body: any;
  /** `body.data` from the `{ success, message, data }` envelope. */
  data: T;
  headers: Record<string, string>;
  /** `name=value` of each Set-Cookie header. */
  cookies: string[];
};

export type ApiCall = {
  method: string;
  path: string;
  requestBody?: unknown;
  status: number;
  responseBody: unknown;
};

export type SendOptions = {
  headers?: Record<string, string>;
  /** false for setup calls that must not count toward coverage. */
  record?: boolean;
};

const PREFIX = "/api/v1";

/** `/projects` → `/api/v1/projects`; full `/api/...` paths pass through. */
export function apiPath(path: string): string {
  if (path.startsWith("/api/") || path === "/api") return path;
  return `${PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
}

export class ApiClient {
  readonly label: string;
  private readonly context: APIRequestContext;
  private readonly calls: ApiCall[];

  constructor(label: string, context: APIRequestContext, calls: ApiCall[]) {
    this.label = label;
    this.context = context;
    this.calls = calls;
  }

  static async create(
    baseURL: string,
    label: string,
    calls: ApiCall[],
    headers: Record<string, string> = {},
  ): Promise<ApiClient> {
    const context = await request.newContext({
      baseURL,
      extraHTTPHeaders: headers,
    });
    return new ApiClient(label, context, calls);
  }

  /**
   * A browser session (cookie plus CSRF header) signed in with a password.
   * Some writes, such as adding people, only take this kind of session.
   */
  static async signIn(
    baseURL: string,
    account: { email: string; password: string },
    calls: ApiCall[] = [],
  ): Promise<ApiClient> {
    const anonymous = await ApiClient.create(baseURL, account.email, calls);
    const login = await anonymous.send(
      "POST",
      "/auth/login",
      {
        email: account.email,
        password: account.password,
        sessionKind: "browser",
      },
      { record: false },
    );
    await anonymous.dispose();
    if (!login.ok) {
      throw new Error(
        `Signing in ${account.email} failed: ${login.status} ${JSON.stringify(login.body)}`,
      );
    }
    return ApiClient.create(baseURL, account.email, calls, {
      "x-dopbase-csrf": login.data.csrfToken,
      cookie: login.cookies.join("; "),
    });
  }

  async send<T = any>(
    method: string,
    path: string,
    body?: unknown,
    opts: SendOptions = {},
  ): Promise<ApiResult<T>> {
    const url = apiPath(path);
    // Setup calls (sign-in, factories) don't count toward coverage.
    if (opts.record !== false)
      recordHit("api", `${method} ${url.split("?")[0]}`);
    const response: APIResponse = await this.context.fetch(url, {
      method,
      headers: opts.headers ?? {},
      data: body === undefined ? undefined : body,
    });
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: keep the text.
    }
    this.calls.push({
      method,
      path: url,
      requestBody: body,
      status: response.status(),
      responseBody: parsed,
    });
    if (this.calls.length > 10) this.calls.shift();
    return {
      status: response.status(),
      ok: response.ok(),
      body: parsed,
      data: parsed?.data as T,
      headers: response.headers(),
      cookies: response
        .headersArray()
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value.split(";")[0]!),
    };
  }

  get<T = any>(path: string) {
    return this.send<T>("GET", path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.send<T>("POST", path, body ?? {});
  }
  put<T = any>(path: string, body?: unknown) {
    return this.send<T>("PUT", path, body ?? {});
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.send<T>("PATCH", path, body ?? {});
  }
  delete<T = any>(path: string, body?: unknown) {
    return this.send<T>("DELETE", path, body);
  }

  /** Sends and asserts a 2xx status, then returns `data`. */
  async must<T = any>(
    method: string,
    path: string,
    body?: unknown,
    opts: SendOptions = {},
  ): Promise<T> {
    const result = await this.send<T>(method, path, body, opts);
    expect(
      result.ok,
      `${this.label}: ${method} ${apiPath(path)} returned ${result.status}\n${JSON.stringify(result.body, null, 2)}`,
    ).toBe(true);
    return result.data;
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }
}
