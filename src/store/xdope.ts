// Cliente mínimo de xdopestore-api (login, attachments, atributos, categorías y productos).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiAttribute {
  id: string;
  name: string;
  style?: string;
  attribute_values: Array<{ id: string; value: string; hex_color?: string }>;
}

export class XdopeApi {
  private token: string | null = null;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  async login(email: string, password: string) {
    const data = await this.request<{ access_token: string }>("POST", "/login", { email, password });
    this.token = data.access_token;
  }

  async request<T = any>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
    const headers: Record<string, string> = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.base}${url}`, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new ApiError(`${method} ${url} → ${res.status}: ${data?.message ?? text.slice(0, 200)}`, res.status);
    return data as T;
  }

  // Los listados vienen paginados ({ data: [...] }) o como arreglo.
  async list<T = any>(url: string): Promise<T[]> {
    const data = await this.request<any>("GET", url);
    return (Array.isArray(data) ? data : (data?.data ?? [])).map(withId);
  }

  async uploadImage(data: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("attachments", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), filename);
    const res = await this.request<any>("POST", "/attachment", undefined, form);
    const created = withId(res?.data ? res.data[0] : res);
    if (!created?.id) throw new Error("POST /attachment no devolvió el id");
    return created.id;
  }

  async productBySlug(slug: string): Promise<{ id: string; tags?: string[] } | null> {
    try {
      return withId(await this.request("GET", `/product/slug/${encodeURIComponent(slug)}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  async categories(): Promise<Array<{ id: string; name: string; slug?: string }>> {
    return this.list("/category?paginate=500");
  }

  async attributes(): Promise<ApiAttribute[]> {
    const list = await this.list<ApiAttribute>("/attribute?paginate=100");
    return list.map((a) => ({ ...a, attribute_values: (a.attribute_values ?? []).map(withId) }));
  }
}

// Mongo devuelve _id; algunos endpoints agregan id.
function withId<T>(x: T): T & { id: string } {
  const o = x as any;
  return o && typeof o === "object" ? { ...o, id: String(o.id ?? o._id) } : o;
}
