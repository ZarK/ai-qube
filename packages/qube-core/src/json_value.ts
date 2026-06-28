export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;